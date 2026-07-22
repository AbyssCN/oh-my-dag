/**
 * src/harness/review/run —— 对抗审查编排 (单一真理源, dag-review CLI + dag-build 内嵌 review 共用)。
 *
 * 不重造: 组合 buildReviewPrompt (多维度证伪) + screenFinding (软筛 slop) + resolveReviewModel。
 * 每维度一条对抗 prompt, **diff 在前 (共享前缀 → provider prefix-cache 命中)** + 维度 prompt 在后,
 * parallel callModel → screen → 收集 finding 清单 (不综合不 graft, finding≠ground truth, 调用方终裁)。
 *
 * 双轴 (Matt Pocock): **Standards 轴** (correctness/security/boundary/contract… — 代码写得对不对)
 * × **Spec 轴** (spec 维度 — 做的是不是 SDD 说该做的事)。Spec 轴对照 findLatestSdd(cwd/docs/plan)
 * 的最新 SDD; 无 SDD → 报"spec 轴跳过"(非失败)。G3 强制含 spec。收敛层 (verify) 两轴共用。
 *
 * 全文落盘 (零丢失), 返回结构化 finding 供调用方 (CLI 打印 / build 内嵌摘要进报告)。
 */
import { join } from 'node:path';
import { buildReviewPrompt, buildSpecReviewPrompt, screenFinding, type ReviewDimension, type ReviewGate } from './index';
import { verifyFindings, type VerifiedFinding, type ReviewSendFn } from './verify';
import { findLatestSdd } from '../execute-extension';
import { send } from '../../model/gateway';
import { roleModelWithFallback } from '../../model/role-fallback';
import { resolveRoleModel } from '../../model/role-models';

/**
 * review 模型解析(单一真源, baseline + 单 agent 共用)。**无硬编码完整坐标** —— 走角色系统:
 *  - find → `review` 角色(env OMD_REVIEW_MODEL / config / fallback);
 *  - verify → `verifier` 角色(专为跨模型对抗校验设计),可 OMD_REVIEW_VERIFY_MODEL 单独覆盖。
 * 不假设用户 key:坐标无凭证 → roleModelWithFallback 顺延已注册 provider。
 */
export function resolveReviewModels(
  opts: Pick<RunReviewOpts, 'model' | 'verifyModel'>,
  env: Record<string, string | undefined> = process.env,
): { findModel: string; verifyModel: string } {
  const findModel = roleModelWithFallback(opts.model ?? resolveRoleModel('review', env), 'review', env);
  const verifyModel = roleModelWithFallback(
    opts.verifyModel ?? env.OMD_REVIEW_VERIFY_MODEL ?? resolveRoleModel('verifier', env),
    'verifier',
    env,
  );
  return { findModel, verifyModel };
}

/** reasoning_effort 档 (send 的 thinkingLevel; high/xhigh → deepseek reasoning_effort high/max)。 */
type ReviewEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** 每维度 gate 默认镜头 (G1 契约/边界 · G2 +正确性/安全 · G3 全 + **spec 强制**)。 */
export const DIMS_BY_GATE: Record<ReviewGate, ReviewDimension[]> = {
  G1: ['contract', 'boundary'],
  G2: ['correctness', 'security', 'boundary'],
  G3: ['correctness', 'security', 'boundary', 'contract', 'spec'],
};

export interface ReviewFinding {
  dimension: ReviewDimension;
  text: string;
  /** 疑似 slop (无 file:line/repro)。 */
  likelySlop: boolean;
  /** 含真信号 (file:line/repro)。 */
  hasRealSignal: boolean;
  /** spec 轴无 SDD 时跳过 (非失败, 未发模型调用)。 */
  skipped?: boolean;
}

export interface RunReviewResult {
  findings: ReviewFinding[];
  /** 收敛层裁决 (opts.verify 时有; CONFIRMED/UNVERIFIED = 真伤候选, REFUTED = 已证伪留档)。两轴共用。 */
  verified?: VerifiedFinding[];
  /** 全文落盘路径 (零丢失)。 */
  outPath: string;
  model: string;
  /** spec 轴对照的 SDD 文件 (spec 在 dims 且找到时有)。 */
  sddPath?: string;
  /** spec 在 dims 但无 SDD → true (轴跳过, 非失败)。 */
  specSkipped?: boolean;
}

/** 注入依赖 (测试 fake generate 用; 默认真实现)。 */
export interface RunReviewDeps {
  /** 模型调用 (默认 gateway send)。 */
  send?: ReviewSendFn;
  /** SDD 定位 (默认 execute-extension 的 findLatestSdd)。 */
  findSdd?: (planDir: string) => { path: string; text: string } | null;
  /** env (默认 process.env; 测 OMD_REVIEW_SPEC_MODEL 等不污染进程)。 */
  env?: Record<string, string | undefined>;
  /** 注入式 verifyFindings (单 agent 路径测试用; 默认真实现,避免测试打 live 模型 / grep)。 */
  verifyFindings?: (
    dimTexts: { dimension: string; text: string }[],
    opts: { model: string; cwd?: string; verdictEffort?: ReviewEffort; send?: ReviewSendFn },
  ) => Promise<VerifiedFinding[]>;
  /** 注入式单 agent runner (arm C 测试用; 默认 createAgentLeafRunner)。 */
  agentRun?: (input: { prompt: string; model: string }) => Promise<{ text: string }>;
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
  /** 取证 cwd (默认 process.cwd(), 即被审仓库根; spec 轴也在 <cwd>/docs/plan 找 SDD)。 */
  cwd?: string;
  /** 深审 opt-in:单 agent review(读全仓 + 实测 → 确定性 verify)。默认 opts.single ?? OMD_REVIEW_SINGLE==='1';off → 老 Promise.all。 */
  single?: boolean;
  /** 注入依赖 (测试用)。 */
  deps?: RunReviewDeps;
}

/** spec 轴无 SDD 时的跳过说明 (非失败; 不进收敛层)。 */
export const SPEC_SKIPPED_NOTE = '无 SDD (docs/plan 下未找到 .md) — spec 轴跳过 (非失败, 未发模型调用)。';

/**
 * 跑一轮对抗审查。providers 须已注册 (bootstrapModelRuntime / registerProvidersFromEnv)。
 * 返回 finding 清单 + 落盘路径; 不打印 (调用方决定 CLI 打印 / 报告摘要)。
 */
export async function runReview(opts: RunReviewOpts): Promise<RunReviewResult> {
  const dims = opts.dims ?? DIMS_BY_GATE[opts.gate];
  const env = opts.deps?.env ?? process.env;
  // 分流(动态 import 破循环): 单 agent 深审 opt-in > 老 Promise.all(默认,dag-build 零风险)。
  // (DAG 分解路径 3 轮实测败给单 agent — 召回不加、精度更差、故障模式更多 — 已删,见 SDD。)
  if (opts.single ?? env.OMD_REVIEW_SINGLE === '1') {
    const { runReviewSingle } = await import('./run-single');
    return runReviewSingle(opts);
  }
  const sendFn = opts.deps?.send ?? send;
  const findSdd = opts.deps?.findSdd ?? findLatestSdd;
  const cwd = opts.cwd ?? process.cwd();
  // find 层 (宽/并行/找 bug 靠召回): model + effort 各 env 可调。默认 effort=high。
  // issue #6: 默认坐标落 deepseek 家族, 无凭证环境里 (内嵌 G2 自动 review) 会抛 provider 无凭证崩掉
  // 整个审查阶段 → roleModelWithFallback 顺延到已注册 provider。全不可达才原样返 (下游报错语义不变)。
  // find→review 角色, verify→verifier 角色(跨模型), 单一真源 resolveReviewModels(无硬编码坐标)。
  const { findModel, verifyModel } = resolveReviewModels(opts, env);
  const findEffort = (env.OMD_REVIEW_FIND_EFFORT as ReviewEffort) || 'high';
  // spec 轴模型: OMD_REVIEW_SPEC_MODEL 单独覆盖 (spec 对照吃长上下文, 可路由长窗模型), 回落 find 层。
  const specModel = roleModelWithFallback(env.OMD_REVIEW_SPEC_MODEL ?? findModel, 'review');
  const verifyEffort = (env.OMD_REVIEW_VERIFY_EFFORT as ReviewEffort) || undefined;
  const diffBlock = `===== 改动 diff (审查依据) =====\n\`\`\`diff\n${opts.diff}\n\`\`\``;

  // Spec 轴: 定位当前 SDD (无 → 轴跳过, 非失败)。
  const wantSpec = dims.includes('spec');
  const sdd = wantSpec ? findSdd(join(cwd, 'docs', 'plan')) : null;
  const specSkipped = wantSpec && !sdd;

  const findings = await Promise.all(
    dims.map(async (dimension): Promise<ReviewFinding> => {
      if (dimension === 'spec') {
        if (!sdd) {
          return { dimension, text: SPEC_SKIPPED_NOTE, likelySlop: false, hasRealSignal: false, skipped: true };
        }
        const prompt = buildSpecReviewPrompt({
          scope: opts.scope, gate: opts.gate, sddPath: sdd.path, sddText: sdd.text, extraFocus: opts.extraFocus,
        });
        const res = await sendFn({
          model: specModel,
          messages: [{ role: 'user', content: `${diffBlock}\n\n${prompt}` }],
          thinkingLevel: findEffort,
        });
        const screen = screenFinding(res.text);
        return { dimension, text: res.text, likelySlop: screen.likelySlop, hasRealSignal: screen.hasRealSignal };
      }
      const prompt = buildReviewPrompt({ dimension, scope: opts.scope, gate: opts.gate, extraFocus: opts.extraFocus });
      // diff 在前 (共享前缀 → prefix-cache) + 维度 prompt 在后。
      const res = await sendFn({
        model: findModel,
        messages: [{ role: 'user', content: `${diffBlock}\n\n${prompt}` }],
        thinkingLevel: findEffort,
      });
      const screen = screenFinding(res.text);
      return { dimension, text: res.text, likelySlop: screen.likelySlop, hasRealSignal: screen.hasRealSignal };
    }),
  );

  // 收敛层:find 层散文 → 结构化 finding → 仓库取证 → 证伪裁决(误报在 fleet 内部消化)。
  // **两轴共用** —— spec 偏离与 standards bug 一样过 extract→取证→证伪; 跳过的 spec 轴不进 (无产出可裁)。
  let verified: VerifiedFinding[] | undefined;
  if (opts.verify) {
    verified = await verifyFindings(
      findings.filter((f) => !f.skipped).map((f) => ({ dimension: f.dimension, text: f.text })),
      { model: verifyModel, cwd: opts.cwd, verdictEffort: verifyEffort, send: sendFn },
    );
  }

  // ---- 落盘报告: 收敛层裁决 (两轴共用) + Standards 轴 / Spec 轴 双段 ----
  const standards = findings.filter((f) => f.dimension !== 'spec');
  const specFindings = findings.filter((f) => f.dimension === 'spec');
  const doc: string[] = [`# 对抗审查 [${opts.gate}] ${opts.scope.split('\n')[0]}`, ''];
  if (verified) {
    const c = verified.filter((v) => v.verdict === 'CONFIRMED').length;
    const r = verified.filter((v) => v.verdict === 'REFUTED').length;
    const u = verified.filter((v) => v.verdict === 'UNVERIFIED').length;
    doc.push(
      '## ⚖️ 收敛层裁决 (两轴共用)',
      `> 提取 ${verified.length} 条 · CONFIRMED ${c} · REFUTED ${r} · UNVERIFIED ${u} —— **全部逐条裁决,无静默丢弃**。`,
      `> REFUTED 也留档在此(下方各 lens 段为完整来源);安全/authz 敏感 diff 建议连 REFUTED 一起过一眼(证伪也可能误判)。`,
      '',
    );
    for (const v of verified) {
      doc.push(`- **${v.verdict}** [${v.severity}] [${v.dimension}] ${v.file}${v.line ? `:${v.line}` : ''} — ${v.claim}`, `  依据: ${v.reason}`);
    }
    if (verified.length === 0) doc.push('- (extract 未产出成立的 P0/P1 finding)');
    doc.push('');
  }
  doc.push('## Standards 轴', '');
  for (const r of standards) {
    doc.push(`### [${r.dimension}]${r.likelySlop ? ' ⚠️疑似slop(无file:line/repro)' : ''}`, '', r.text, '');
  }
  if (wantSpec) {
    doc.push('## Spec 轴', '');
    doc.push(sdd ? `> 对照 SDD: \`${sdd.path}\`` : `> ${SPEC_SKIPPED_NOTE}`, '');
    for (const r of specFindings) {
      if (r.skipped) continue; // 跳过说明已在段首
      doc.push(`### [spec]${r.likelySlop ? ' ⚠️疑似slop(无file:line/repro)' : ''}`, '', r.text, '');
    }
  }
  const outPath = opts.outPath ?? `/tmp/omd-review-${opts.gate}-${Date.now()}.md`;
  await Bun.write(outPath, doc.join('\n'));

  return { findings, verified, outPath, model: findModel, sddPath: sdd?.path, specSkipped: specSkipped || undefined };
}
