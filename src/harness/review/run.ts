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
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReviewPrompt, buildSpecReviewPrompt, screenFinding, type ReviewDimension, type ReviewGate } from './index';
import { verifyFindings as realVerifyFindings, type VerifiedFinding, type ReviewSendFn } from './verify';
import { checkFindingAnchors, type AnchorCheckResult } from './anchor-check';
import { findLatestSdd } from '../execute-slice';
import { send } from '../../model/gateway';
import { roleModelWithFallback } from '../../model/role-fallback';
import { resolveRoleModel, tryResolveSeatModel } from '../../model/role-models';

/**
 * review 模型解析(单一真源, baseline + 单 agent 共用)。**无硬编码坐标 + review 自成体系**:
 *  - find → `review` 角色(env OMD_REVIEW_MODEL / config / fallback)。
 *  - verify → `OMD_REVIEW_VERIFY_MODEL` 覆盖,否则回落 find 模型(**不引用引擎 `verifier` 角色**,
 *    避免 OMD_VERIFIER_MODEL 意外渗入 review;跨模型靠显式配 OMD_REVIEW_VERIFY_MODEL)。
 * `verifier` 角色留给引擎自身(DAG postcondition / judge 跨模型对抗),与 review 领域不重叠。
 * 不假设用户 key:坐标无凭证 → roleModelWithFallback 顺延已注册 provider。
 */
export function resolveReviewModels(
  opts: Pick<RunReviewOpts, 'model' | 'verifyModel'>,
  env: Record<string, string | undefined> = process.env,
): { findModel: string; verifyModel: string } {
  const findModel = roleModelWithFallback(opts.model ?? resolveRoleModel('review', env), 'review', env);
  const verifyModel = roleModelWithFallback(opts.verifyModel ?? env.OMD_REVIEW_VERIFY_MODEL ?? findModel, 'review', env);
  return { findModel, verifyModel };
}

/**
 * 维度 → 模型的**跨模型分派** (2026-07-26 owner: review 该是多视角, 不是一个模型换五个 prompt)。
 *
 * 为什么: find 层是**召回漏斗** —— 同一个模型换五个维度 prompt, 五条召回共享同一套盲点
 * (同家族的训练数据/偏好/思维定式), 五维看着宽实则窄。不同家族的模型各扫一遍, 才是真的多视角。
 *
 * 配法: `OMD_REVIEW_DIM_MODELS="correctness=openai-codex:gpt-5.6-sol,security=kimi-coding:k3"`
 * (逗号分隔 `维度=坐标`)。未列出的维度**由调用方回落** findModel(不在本函数里, 本函数只解析显式配的那些);
 * spec 轴仍走 OMD_REVIEW_SPEC_MODEL。
 * 坐标不可达 → roleModelWithFallback 顺延 (无凭证环境不炸整轮审查)。
 */
export function resolveDimensionModels(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env.OMD_REVIEW_DIM_MODELS?.trim();
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [dim, coord] = pair.split('=').map((x) => x?.trim());
    if (!dim || !coord || !coord.includes(':')) continue;
    out[dim] = roleModelWithFallback(coord, 'review', env);
  }
  return out;
}

/** reasoning_effort 档 (send 的 thinkingLevel; high/xhigh → deepseek reasoning_effort high/max)。 */
type ReviewEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/** 每维度 gate 默认镜头 (G1 契约/边界 · G2 +正确性/安全 · G3 全 + **spec 强制**)。 */
export const DIMS_BY_GATE: Record<ReviewGate, ReviewDimension[]> = {
  G1: ['contract', 'boundary'],
  G2: ['correctness', 'security', 'boundary'],
  G3: ['correctness', 'security', 'boundary', 'contract', 'spec'],
};

/**
 * review 进度事件 (D-4 onProgress 汇, SDD C-5)。**不是**引擎 DagNodeEvent —— review 自编排不迁
 * executor-dag, 装配层 (fleet 的 dag_review) 负责把这份翻成标准 `DagNodeEvent` 灌 pushDagEvent。
 * 语义: 维度 = 节点 (planned 一次列全 → 每维 start/settle); 证伪阶段每条 finding 一条 verdict
 * (gate 恒为 'review', CONFIRMED→fail / 证伪撤销→pass, D-9)。
 */
export type ReviewProgressEvent =
  | { type: 'planned'; nodes: Array<{ id: string; kind: string }> }
  | { type: 'start'; id: string; kind: string }
  | { type: 'settle'; id: string; status: 'done' | 'failed'; kind: string; model?: string;
      durationMs?: number; failReason?: string }
  | { type: 'verdict'; id: string; gate: 'review'; verdict: 'pass' | 'fail'; round: number; reason?: string };

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
  /** D-3 锚点反幻觉闸裁定 (opts.verify 且有结构化 finding 时有)。red = 有 P0/P1 被降级记账。 */
  anchorCheck?: AnchorCheckResult;
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
  /**
   * `review-spec` 座位解析的注入面 (hermetic 测试用; 默认读真 .omd/config.json)。
   * 座位链会读进程级 config —— 不给这个口子, 任何注入 env 的测试都会被真实仓配置压过去。
   */
  seatOpts?: { modelsMap?: Record<string, string>; autoAssignMap?: Record<string, string>; configPath?: string };
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
  /**
   * D-4 观察面汇 (SDD C-5): 进度事件回调 (planned → 每维 start/settle → 证伪 verdict)。
   * 给了不改变任何审查行为, 只是多转一份; 省略 = 不转 (今天的现状)。单 agent 深审
   * (opts.single) 不走本汇 —— run-single 不在 D-4 写集, 其观察面保持现状 (零事件)。
   */
  onProgress?: (e: ReviewProgressEvent) => void;
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
  // deps.verifyFindings 接缝 (RunReviewDeps 文档即"注入依赖 (测试 fake generate 用)")——
  // 此前只被 run-single 用, run.ts 这条是死的 (接口有字段、实现不读, 注入即静默忽略)。
  const verifyFindings = opts.deps?.verifyFindings ?? realVerifyFindings;
  const findSdd = opts.deps?.findSdd ?? findLatestSdd;
  const cwd = opts.cwd ?? process.cwd();
  // find 层 (宽/并行/找 bug 靠召回): model + effort 各 env 可调。默认 effort=high。
  // issue #6: 默认坐标落 deepseek 家族, 无凭证环境里 (内嵌 G2 自动 review) 会抛 provider 无凭证崩掉
  // 整个审查阶段 → roleModelWithFallback 顺延到已注册 provider。全不可达才原样返 (下游报错语义不变)。
  // find→review 角色, verify→verifier 角色(跨模型), 单一真源 resolveReviewModels(无硬编码坐标)。
  const { findModel, verifyModel } = resolveReviewModels(opts, env);
  const dimModels = resolveDimensionModels(env);
  const findEffort = (env.OMD_REVIEW_FIND_EFFORT as ReviewEffort) || 'high';
  // spec 轴模型 = `review-spec` **座位** (spec 对照吃长上下文, 可路由长窗模型), 解不到回落 find 层。
  // 经单一 resolver (INV-MODEL-1): config.models['review-spec'] → OMD_REVIEW_SPEC_MODEL (座位正名 env)
  // → auto-assign → defaultModel。此前这里直读 env, 于是那个座位是纯装饰 —— auto-assign 派了模型、
  // 起跑自检查了凭证, 却没有任何人读它 (2026-07-28 空旋钮全仓扫)。
  const specModel = roleModelWithFallback(
    tryResolveSeatModel('review-spec', { env, ...(opts.deps?.seatOpts ?? {}) })?.model ?? findModel,
    'review',
  );
  const verifyEffort = (env.OMD_REVIEW_VERIFY_EFFORT as ReviewEffort) || undefined;
  const diffBlock = `===== 改动 diff (审查依据) =====\n\`\`\`diff\n${opts.diff}\n\`\`\``;

  // Spec 轴: 定位当前 SDD (无 → 轴跳过, 非失败)。
  const wantSpec = dims.includes('spec');
  const sdd = wantSpec ? findSdd(join(cwd, 'docs', 'plan')) : null;
  const specSkipped = wantSpec && !sdd;

  // D-4 事件汇: onProgress = 进程内回调 (测试/内嵌); OMD_REVIEW_EVENT_FILE = 子进程通道
  // (scripts/dag-review.ts 经 fleet 传 env, 本文件把进度 NDJSON 逐行追加, 父进程轮询翻成标准
  // DagNodeEvent 灌 pushDagEvent) —— 零脚本改动: 子进程只调 runReview, 不用知道自己被观察。
  // 两路都 fail-open (观察面不打断审查; C-1 同款"留痕但不炸"语义)。
  const eventFile = process.env.OMD_REVIEW_EVENT_FILE;
  const emit = (e: ReviewProgressEvent): void => {
    try {
      opts.onProgress?.(e);
    } catch {
      // 订阅者抛错不打断审查 (观察面是可丢的旁路)。
    }
    if (eventFile) {
      try {
        appendFileSync(eventFile, `${JSON.stringify(e)}\n`);
      } catch {
        // 事件文件不可写 → 观察面静默降级, 审查照跑。
      }
    }
  };
  emit({ type: 'planned', nodes: dims.map((d) => ({ id: d, kind: 'review' })) });

  const findings = await Promise.all(
    dims.map(async (dimension): Promise<ReviewFinding> => {
      // D-4 观察面: 每维 start → find 调用 → settle (失败也 settle failed 再照抛 —— 汇不改语义)。
      emit({ type: 'start', id: dimension, kind: 'review' });
      const t0 = Date.now();
      const settle = (status: 'done' | 'failed', extra: { model?: string; failReason?: string } = {}): void => {
        emit({ type: 'settle', id: dimension, status, kind: 'review', durationMs: Date.now() - t0, ...extra });
      };
      try {
        if (dimension === 'spec') {
          if (!sdd) {
            settle('done', { model: specModel });
            return { dimension, text: SPEC_SKIPPED_NOTE, likelySlop: false, hasRealSignal: false, skipped: true };
          }
          const prompt = buildSpecReviewPrompt({
            scope: opts.scope, gate: opts.gate, sddPath: sdd.path, sddText: sdd.text, extraFocus: opts.extraFocus,
          });
          const res = await sendFn({
            model: specModel,
            // #144 洞 1: review-spec 座此前在台账上完全不存在 (无 role → `(unattributed)`)。
            meta: { role: 'review:spec' },
            messages: [{ role: 'user', content: `${diffBlock}\n\n${prompt}` }],
            thinkingLevel: findEffort,
          });
          const screen = screenFinding(res.text);
          settle('done', { model: specModel });
          return { dimension, text: res.text, likelySlop: screen.likelySlop, hasRealSignal: screen.hasRealSignal };
        }
        const model = dimModels[dimension] ?? findModel;
        const prompt = buildReviewPrompt({ dimension, scope: opts.scope, gate: opts.gate, extraFocus: opts.extraFocus });
        // diff 在前 (共享前缀 → prefix-cache) + 维度 prompt 在后。
        // 维度模型: OMD_REVIEW_DIM_MODELS 里点名的走那个坐标, 否则回落 findModel (跨模型多视角, 见
        // resolveDimensionModels —— 同一模型跑五个维度 = 五条召回共享同一套盲点)。
        const res = await sendFn({
          model,
          // 标签带维度: 五个维度共用 review 座, 但「哪个维度贵」只有 byTrace 分得开 (#144 洞 1)。
          meta: { role: `review:${dimension}` },
          messages: [{ role: 'user', content: `${diffBlock}\n\n${prompt}` }],
          thinkingLevel: findEffort,
        });
        const screen = screenFinding(res.text);
        settle('done', { model });
        return { dimension, text: res.text, likelySlop: screen.likelySlop, hasRealSignal: screen.hasRealSignal };
      } catch (err) {
        settle('failed', { failReason: String(err instanceof Error ? err.message : err).split('\n')[0]!.slice(0, 160) });
        throw err;
      }
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
  // D-4 观察面: 证伪阶段每条 finding 一条 verdict (gate:'review')。D-9 —— pass/fail 指**被审对象**:
  // CONFIRMED (代码有伤) → fail; 证伪撤销 (REFUTED) → pass; UNVERIFIED 未被证伪撤销 → fail
  // (与 scripts/dag-review 的"存活 (≠REFUTED)"口径一致, 不静默丢真伤候选)。reason = finding 摘要 ≤160。
  if (verified) {
    for (const v of verified) {
      emit({
        type: 'verdict',
        id: v.dimension,
        gate: 'review',
        verdict: v.verdict === 'REFUTED' ? 'pass' : 'fail',
        round: 1, // 收敛层单轮 (ROUND_CAPS=1 doctrine)
        reason: `${v.claim} (${v.file}${v.line ? `:${v.line}` : ''})`.slice(0, 160),
      });
    }
  }
  // D-3 反幻觉锚点闸 (挂 review 产出出口): 每条结构化 finding 的 file:line 确定性校验 —
  // 文件真实存在 + line ≤ 行数; P0/P1 无合法锚点 → 降级记账 (G-5)。零 LLM, 一次 stat/条。
  let anchorCheck: AnchorCheckResult | undefined;
  if (verified) {
    anchorCheck = await checkFindingAnchors(verified, cwd);
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
    doc.push('');
  }
  if (anchorCheck) {
    doc.push('## 🎯 锚点反幻觉闸 (D-3)', '');
    if (anchorCheck.skipped) {
      doc.push('> 整份产出未开始填 (无真 finding 行) — 整体 skipped, 零误报 (模板豁免)。');
    } else if (anchorCheck.downgrades.length === 0) {
      doc.push('> 全部 finding 锚点合法 — 无降级。');
    } else {
      doc.push(`> ${anchorCheck.downgrades.length} 条 P0/P1 finding 锚点不合法 — **降级记账**:`);
      for (const d of anchorCheck.downgrades) {
        const f = d.finding;
        doc.push(`- **${f.severity}→${d.downgradedSeverity}** [${d.verdict}] ${f.file}${f.line ? `:${f.line}` : ''} — ${d.detail}`);
      }
    }
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

  return { findings, verified, anchorCheck, outPath, model: findModel, sddPath: sdd?.path, specSkipped: specSkipped || undefined };
}
