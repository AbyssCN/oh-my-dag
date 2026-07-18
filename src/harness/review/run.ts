/**
 * src/harness/review/run —— 对抗审查编排 (单一真理源, dag-review CLI + dag-build 内嵌 review 共用)。
 *
 * 不重造: 组合 buildReviewPrompt (多维度证伪) + screenFinding (软筛 slop) + resolveReviewModel。
 * 每维度一条对抗 prompt, **diff 在前 (共享前缀 → provider prefix-cache 命中)** + 维度 prompt 在后,
 * parallel callModel → screen → 收集 finding 清单 (不综合不 graft, finding≠ground truth, 调用方终裁)。
 *
 * 全文落盘 (零丢失), 返回结构化 finding 供调用方 (CLI 打印 / build 内嵌摘要进报告)。
 */
import { buildReviewPrompt, screenFinding, resolveReviewModel, type ReviewDimension, type ReviewGate } from './index';
import { verifyFindings, type VerifiedFinding } from './verify';
import { send } from '../../model/gateway';

/** reasoning_effort 档 (send 的 thinkingLevel; high/xhigh → deepseek reasoning_effort high/max)。 */
type ReviewEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** 每维度 gate 默认镜头 (G1 契约/边界 · G2 +正确性/安全 · G3 全)。 */
export const DIMS_BY_GATE: Record<ReviewGate, ReviewDimension[]> = {
  G1: ['contract', 'boundary'],
  G2: ['correctness', 'security', 'boundary'],
  G3: ['correctness', 'security', 'boundary', 'contract'],
};

export interface ReviewFinding {
  dimension: ReviewDimension;
  text: string;
  /** 疑似 slop (无 file:line/repro)。 */
  likelySlop: boolean;
  /** 含真信号 (file:line/repro)。 */
  hasRealSignal: boolean;
}

export interface RunReviewResult {
  findings: ReviewFinding[];
  /** 收敛层裁决 (opts.verify 时有; CONFIRMED/UNVERIFIED = 真伤候选, REFUTED = 已证伪留档)。 */
  verified?: VerifiedFinding[];
  /** 全文落盘路径 (零丢失)。 */
  outPath: string;
  model: string;
}

export interface RunReviewOpts {
  /** 改动 diff (审查依据)。 */
  diff: string;
  /** 审查范围描述 (改动文件清单, 进 prompt scope)。 */
  scope: string;
  gate: ReviewGate;
  /** 显式维度 (覆盖 gate 默认)。 */
  dims?: ReviewDimension[];
  /** 额外对抗接缝 (如承重点)。 */
  extraFocus?: string[];
  /** find 层模型 (默认 env OMD_REVIEW_FIND_MODEL → routing → ds-pro; 宽/并行/找 bug 靠召回)。 */
  model?: string;
  /** verify 判决层模型 (默认 env OMD_REVIEW_VERIFY_MODEL → 回落 findModel; 窄/高风险/跨模型)。 */
  verifyModel?: string;
  /** 全文落盘路径 (默认 /tmp/omd-review-<gate>-<ts>.md)。 */
  outPath?: string;
  /** 收敛层 (extract→仓库取证→证伪裁决; 不加发散加收敛)。 */
  verify?: boolean;
  /** 取证 cwd (默认 process.cwd(), 即被审仓库根)。 */
  cwd?: string;
}

/**
 * 跑一轮对抗审查。providers 须已注册 (bootstrapModelRuntime / registerProvidersFromEnv)。
 * 返回 finding 清单 + 落盘路径; 不打印 (调用方决定 CLI 打印 / 报告摘要)。
 */
export async function runReview(opts: RunReviewOpts): Promise<RunReviewResult> {
  const dims = opts.dims ?? DIMS_BY_GATE[opts.gate];
  const env = process.env;
  // find 层 (宽/并行/找 bug 靠召回): model + effort 各 env 可调。默认 effort=high。
  const findModel = opts.model ?? env.OMD_REVIEW_FIND_MODEL ?? resolveReviewModel(opts.gate) ?? 'deepseek:deepseek-v4-pro';
  const findEffort = (env.OMD_REVIEW_FIND_EFFORT as ReviewEffort) || 'high';
  // verify 判决层 (窄/高风险/一锤定音): 默认回落 findModel(env 未设 = 单模型)。
  // 设 OMD_REVIEW_VERIFY_MODEL=<另一模型> + EFFORT=xhigh → 跨模型 + max 推理。
  const verifyModel = opts.verifyModel ?? env.OMD_REVIEW_VERIFY_MODEL ?? findModel;
  const verifyEffort = (env.OMD_REVIEW_VERIFY_EFFORT as ReviewEffort) || undefined;
  const diffBlock = `===== 改动 diff (审查依据) =====\n\`\`\`diff\n${opts.diff}\n\`\`\``;

  const findings = await Promise.all(
    dims.map(async (dimension): Promise<ReviewFinding> => {
      const prompt = buildReviewPrompt({ dimension, scope: opts.scope, gate: opts.gate, extraFocus: opts.extraFocus });
      // diff 在前 (共享前缀 → prefix-cache) + 维度 prompt 在后。
      const res = await send({
        model: findModel,
        messages: [{ role: 'user', content: `${diffBlock}\n\n${prompt}` }],
        thinkingLevel: findEffort,
      });
      const screen = screenFinding(res.text);
      return { dimension, text: res.text, likelySlop: screen.likelySlop, hasRealSignal: screen.hasRealSignal };
    }),
  );

  // 收敛层:find 层散文 → 结构化 finding → 仓库取证 → 证伪裁决(误报在 fleet 内部消化)
  let verified: VerifiedFinding[] | undefined;
  if (opts.verify) {
    verified = await verifyFindings(
      findings.map((f) => ({ dimension: f.dimension, text: f.text })),
      { model: verifyModel, cwd: opts.cwd, verdictEffort: verifyEffort },
    );
  }

  const doc: string[] = [`# 对抗审查 [${opts.gate}] ${opts.scope.split('\n')[0]}`, ''];
  if (verified) {
    const c = verified.filter((v) => v.verdict === 'CONFIRMED').length;
    const r = verified.filter((v) => v.verdict === 'REFUTED').length;
    const u = verified.filter((v) => v.verdict === 'UNVERIFIED').length;
    doc.push(
      '## ⚖️ 收敛层裁决',
      `> 提取 ${verified.length} 条 · CONFIRMED ${c} · REFUTED ${r} · UNVERIFIED ${u} —— **全部逐条裁决,无静默丢弃**。`,
      `> REFUTED 也留档在此(下方各 lens 段为完整来源);安全/authz 敏感 diff 建议连 REFUTED 一起过一眼(证伪也可能误判)。`,
      '',
    );
    for (const v of verified) {
      doc.push(`- **${v.verdict}** [${v.severity}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`, `  依据: ${v.reason}`);
    }
    if (verified.length === 0) doc.push('- (extract 未产出成立的 P0/P1 finding)');
    doc.push('');
  }
  for (const r of findings) {
    doc.push(`## [${r.dimension}]${r.likelySlop ? ' ⚠️疑似slop(无file:line/repro)' : ''}`, '', r.text, '');
  }
  const outPath = opts.outPath ?? `/tmp/omd-review-${opts.gate}-${Date.now()}.md`;
  await Bun.write(outPath, doc.join('\n'));

  return { findings, verified, outPath, model: findModel };
}
