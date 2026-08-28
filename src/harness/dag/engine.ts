/**
 * src/harness/dag/engine —— **DAG 执行引擎**(2026-08-07 由 `executor-dag.ts` 改名并入 `dag/`)。
 *
 * omd agent 本体 runtime 的自包含编排循环:
 *   task ──conductor──▶ plan(leaves + deps) ──engine──▶ 现场 fan-out ──▶ results
 *
 * ## 为什么不再叫 `executor-dag`
 *
 * 旧名的 `executor-` 前缀是用来跟**「宏观 PG DAG」**区分的 —— Valinor 初版(`10f4b3b`,2026-06-04)
 * 计划中的一层 Postgres 支撑的跨轮持久化工作流(表 `valinor_workflow_nodes`),原文写着「= 后续外层」。
 * **那一层从来没有建过**:表名全仓零命中,唯一的 postgres 残留是 `project-scope.ts` 里一个零调用方的
 * `upsertProjectRegistry`。**一个前缀在区分一个从未存在的东西**,读的人只会以为自己漏了什么。
 *
 * 设计锁(Nick 2026-06-01):无硬默认(conductorModel/leafModel 必填)· model-agnostic(经 `src/model` callModel)·
 *   现场 in-process(leaves 经 `primitives.parallel`)。
 *
 * ## 家族四件(T2#5, 2026-06-23 由 682 行 god-file 按簇拆开)
 *
 * - `engine.ts`(本文件)—— ExecOnce / planAndExecute / runDag + barrel re-export 公共面
 * - `types.ts` —— 契约类型(消费方最多的一个:74 处)
 * - `defaults.ts` —— 默认值与 prompt 常量
 * - `planner.ts` —— 纯 helper(topoLevels / buildLeafPrompt / addUsage)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

/**
 * C-1 (2026-08-19, 引擎采集片独占):
 *   `_engineRound` = 引擎外层轮计数 (executePlan 每次进入 ++1, 初始=1 = 首轮, 升级/补丁重规划后=2/3/...)。
 *   落到节点的 `dagRound` 字段, 是「跨轮身份」的真源。A 片 (dag-record) 落库列未就位, 这里先在
 *   LeafResult 上留痕, 等 A 加列后自动接上 (read 侧同模式: `typeof (r as {...}).x === 'number'`)。
 *   单调跨进程 (不跨 run 重置) —— 跨 run 的区分靠 runId (dag-runs.db 自带), 不会撞车。
 *
 *   `_nodeLastSettled` = 上一轮该 id 的 settle 结果, 用于「上一轮已被本轮覆盖」标记。
 *   mutate 上轮的 LeafResult 是允许的: prev round 的 results 已经写回, 与 computeReuse 解耦
 *   (复用判 = `usage.in/out === 0 ∧ skipped:true`, 与 overriddenBy 无关); 下一轮读它只看 settled 落账面,
 *   对 `_overriddenBy` 字段无依赖。
 */
let _engineRound = 0;
const _nodeLastSettled = new Map<string, LeafResult>();
// C-1 (2026-08-22, falsify 兄弟节点并发): 同树互斥 (一执行树 = 一个 key, 一把尾队列 promise)。
// 临界区 = 唯一匹配校验 → 写 mutation → 跑命令 → finally 还原 (D-3); 同一 key 上排队的 falsify
// 节点**不并发** (INV-1/3), 不同 key (不同 worktree) 互不排队 (INV-5)。返回 release 函数 ——
// 调用方在 finally 内无条件调 (D-4, 任何出口都释放)。
const mutationLocks = new Map<string, Promise<void>>();
function acquireMutationLock(key: string): Promise<() => void> {
  // 证伪方式: 把下一行换成 `const prev = Promise.resolve();` (后到者不等前一个 = 关掉互斥)
  // ⇒ `falsify-mutex.test.ts` 的 GWT-1/GWT-2 当场红 (2026-08-22 实跑过, 红在"看见了别人的
  // mutation"与"第二个节点拿不到锁")。
  const prev = mutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  const chain: Promise<void> = prev.then(() => next);
  mutationLocks.set(key, chain);
  return prev.then(() => () => {
    release();
    if (mutationLocks.get(key) === chain) mutationLocks.delete(key);
  });
}
import { join } from 'node:path';
import type { ModelUsage } from '../../model/gateway';
import { escalationProviderReady, type VerifierVerdict } from '../verifier';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import {
  conductorSystemPrompt,
  conductorPatchSystemPrompt,
  parsePlan,
  mergeMcpAllow,
  PLAN_BOUNDARY,
  conductorPromptProfileFromEnv,
  type ConductorPlan,
  type ConductorProfileRosterEntry,
} from '../conductor-plan';
// SDD 2026-08-11-leaf-profile库 D-3: 节点 profile 字段经此解析成 LeafProfile, 复用既有注入口
// (agent-leaf.ts AgentLeafRunnerOpts.profile 同型), 不建平行管道。loadProfiles 只投影有界 conductor 名册。
import { loadProfiles, resolveProfile, type LeafProfile } from '../profiles/profile';
// D-3 注册 server 集真源 (parsePlan knownServers 必传): 该 run 的 cwd 经 loadMcpClientConfig。
import { knownMcpServerNames } from '../../mcp/client/config';
// S3.6 escalation patch 模式: 补丁解析 + 程序化 merge (未补丁节点字节不动 → D-21 复用按构造成立)。
import { parsePlanPatch, applyPlanPatch, buildPatchRequest } from '../plan/plan-patch';
import { hashArtifact, hashText, computeDagGeneration } from '../continuity/checkpoint-manager';
import type { NodeCheckpoint, NodeLoopJournal, RoundVerdict } from '../continuity/types';
// noun-gate 接缝(INV-X3):宿主注入(上游宿主传 memory-hub checkNouns);包不依赖 memory-hub。
type NounGateFn = (args: { text: string; material: string; repoRoot: string; annotate: boolean }) => { novelNouns: string[] };
let _nounGate: NounGateFn | null = null;
export function setNounGate(fn: NounGateFn | null): void { _nounGate = fn; }

/**
 * 预算过半接缝 (SDD F1 片 2, INV-8) —— 引擎轮边界读 `spent / cap`, 任一轴**首次**
 * `spent >= cap / 2` 调一次 `emit(event)`, 同轴再过轮边界不重发。**未配该轴 cap**
 * 由调用方在调用前自行短路 (此函数不读 config)。
 *
 * 纯函数 + 注入 emit —— 可独立测 (notify-wiring.test.ts 直接调, 零 IO)。
 * `fired` 是内环局部标志, 不跨进程去重: resume 新进程可再发一次 (D-6 接受的重复)。
 * 等值 `cap / 2` 判为已过半 (`>=`)。`cap=0` 时 `cap/2=0`, `spent=0` 也判为过半。
 *
 * ⚠ 这条只读「本次内环累计」的钱 (token) / 时间 (ms), 不读运行锚那半 —— 运行锚在
 * `dispatchBudgetHit` 那一段另行判 (D-6 词表外)。
 */
export function emitBudgetHalfIfHalf(
  spent: number,
  cap: number,
  fired: { tokens: boolean; ms: boolean },
  axis: 'tokens' | 'ms',
  emit: (e: DagNodeEvent) => void,
): DagNodeEvent | null {
  if (fired[axis]) return null;
  if (spent < cap / 2) return null;
  fired[axis] = true;
  const event: DagNodeEvent = { type: 'budget', axis, spent, cap };
  // emit 接入 emitRunEvent 时, 那一层自带 try/catch + fail-open (观察者不扰动被观察者)。
  // 这里**不再包一层**: 多套一层只会多一个静默 catch (§静默坑 2), 而 fail-open 的语义没变。
  emit(event);
  return event;
}
import { cavemanRule, leafCavemanLevel } from '../caveman';
import { leafCostReward } from '../model-router';
import {
  collectUseEvent,
  leafCreditFromResult,
  rejectIfProbe,
  type UseEvent,
} from './credit';
import { logger } from '../logger';
import { type AnchorVerdict, captureTreeAnchor, compareTreeAnchor, describeAnchorVerdict } from '../goal/criterion-anchor';
import { NOVELTY_COLLAPSE_LINE, pushNoveltyRound } from '../pathfinder/proximity';
// #245: 失败明细的 `(fail)` 解析 — 复用 goal/accept-delta 的 extractFailSet, 不写第二份 (INV-8)。
// 跨层 import 是必要的: engine.ts 拿到了 fc 闭包内的 cr.text, 而接 parse 的活归 accept-delta 单点。
import { extractFailSet } from '../goal/accept-delta';
// ── T2#5 按簇拆出的兄弟文件 (引擎消费) ──
import type { GenerateFn, ExecutorDagConfig, LeafResult, ExecutorDagResult, DagObservation, BlameRetryLedger, DagNodeEvent } from './types';
import { trySpinRepair } from './replan-spin';
import {
  buildSpinLadderReport,
  buildSpinRung2Decision,
  chooseSpinRung2Dimension,
  SPIN_LADDER_RUNG1_DIMENSION,
  type SpinLadderReading,
  type SpinRung2Decision,
} from './spin-rung2';
// C 无效否决闸 (2026-08-21): 判词可不可证伪 —— 纯函数, 判据与用例都在那边。
import { classifyVeto, isInfraVerdict } from './veto-guard';
import { makeDefaultGenerate, LEAF_SYSTEM_PREFIX, PONYTAIL_LEAF_DISPOSITION } from './defaults';
import { topoLevels, buildLeafPrompt, addUsage, filterOracleCommandNodes } from './planner';
// ready-set 调度器 (拓扑推进 + 三层并发闸 + quorum 判定; 纯同步零 IO, 见 dag-scheduler.ts)。
import { DagScheduler, type SchedKind, type QuorumVerdict } from './dag-scheduler';
import { nodeExecKind, type NodeExecKind } from './node-kind';
import { loadAgentTemplates, templateRoster, type AgentTemplate } from '../agent-templates';
import { expandMapNode, mapSpecHash } from '../plan/map-expand';
// SDD 0013 S1 约束选择: primitive 节点 → compile(复用 primitives.ts)→ run。
import { compilePrimitive, type PrimitiveCtx } from '../primitive-registry';
// fan-in 定向摘要 (扇出≥2 → 摘要替全文注入, 见 fanin-summary.ts)。
import {
  normalizeFaninConfig,
  runFaninSummary,
  composeFaninView,
  extractPathAnchors,
  faninAnchorLoss,
  DEFAULT_FANIN_SCHEMA,
} from '../fanin-summary';
// D-21 escalation 跨轮复用: 语义 Merkle 指纹 + 前驱闭包匹配 (semantic-key 单一真源)。
import { computeReuse, merkleFingerprints } from '../plan-passes/semantic-key';
import { researchNodesWithoutRunner, researchUnavailableRemediation } from '../plan/research-availability-gate';
import { mergeCommandChains } from '../plan-passes/merge-command-chain';
import { expandConductorNode, subgraphLintView, subgraphWarnings } from '../plan/conductor-expand';
import { renderRoundForJudge, splitNamedIds, type JudgeChildView } from '../plan/conductor-judge';
import { collectJudgeArtifacts, DEFAULT_ARTIFACT_BUDGET, type ArtifactBudget } from '../plan/judge-artifacts';
import { writeSetChangedSinceBaseline } from './writeset-evidence';
import type { ShellRun } from '../leaf-runners';
import type { CommandLeafResult } from '../leaf-runners';
import type { FalsifyMutate, FalsifyNodeExtras } from './types';
// S3 片 5 (D-1/D-2/D-3, INV-1/2/3/4/5/6): retry 域判定 + verdict 幂等账本 + 部分失败 join 的
// observation 在本片里**真正接上 engine** —— 上面只 import 是空, 把判定逻辑就地展开就
// 等于「读源码复制粘贴」, 仓规 S-39 那条记忆写过这是同一件事声明第二遍。 wiring 见
// budgetFor (runNode 内) · runVerifier 包装 (verify 段) · partial-quorum-failure 发射点
// (executePlan 的 pump 循环)。
import { classifyRetryDomain, retryBudgetFor } from './retry-domain';
import { append, emptyLedger, infraObserved, terminal, type VerdictEntry, type VerdictKind, type VerdictLedger } from './verdict-ledger';
import {
  appendClaimEvidence,
  checkableFromJudgeView,
  engineFacts,
  findUnsupportedClaims,
  renderClaimObservation,
  isVerificationRun,
  renderShellRunFact,
  type UnsupportedClaimFinding,
} from '../plan/claimed-actions';
import { gateFalseCompletion, renderFalseCompletionFindings } from '../plan/false-completion';

/**
 * 一个子节点最多往 judge 视图里放几条 bash 命令记录。
 *
 * 这段进的是**每一次** judge 调用 —— 没有上限就是给每轮判决挂一个无界成本 (同 S1 产物预算
 * 那条理由)。取 6 是结构性取值不是实测值: 够放下一次典型自验 (装依赖 + 跑测试 + 跑 tsc),
 * 超出的条数如实列出来, 不静默丢。
 */
const SHELL_FACT_CAP = 6;

/**
 * 交接块之后那句「这一轮该怎么重画」(#226 从内联字符串提出来, 逐字未改)。
 * 提出来只为让 `renderHandoff` 与它各管一件事:前者管**交接怎么渲染**, 这句管**要它做什么**。
 */
const RETRY_INSTRUCTION =
  '这一轮请**重新分解**: 该补的步骤补上 (包括上一轮压根没有的那种, 比如先去把某个事实查清楚), ' +
  '该改的改掉。原样再画一遍上一轮的图只会再失败一次。' +
  '但**没被点名的节点请逐字节保持原规格** (goal 文本/依赖/executor 一字不动) —— ' +
  '节点 id 按内容寻址, 规格没变的节点零成本复用上轮产出; 顺手改写无辜节点 = 它整棵子树白烧重跑。';
import { verifiedShellWriteTargets } from '../writeset/shell-writes';
import { blamePathCandidates, failureExcerpt } from '../failure-trace';
import { findRedOracles, renderOracleRedVerdict } from './oracle-red';
import { attributeBlame, renderAttribution } from './blame-attribution';
import { captureRollbackAnchor } from '../writeset/rollback-anchor';
import { serializeWriteRaces, staticLintPlan } from '../plan/static-lint';
import { autoRewriteLeafTier } from '../plan/leaf-tier-gate';
import { critique, type Diagnostic, type DiagnosticCode } from '../plan-critic';
import { scheduledArtifactFindings } from '../plan/invocation-facts';
// D-Q 图外只读观察者的两个确定性 producer (零模型调用): 制品边 lint + 环空转检测。
import {
  lintArtifactEdges,
  artifactLintObservations,
  detectLoopNoProgress,
  classifyArtifactMove,
  detectRuntimeWriteRace,
  detectDetectorWrites,
  detectVerbatimDrop,
  gateVerbatimRed,
  extractQuoteSegments,
  type QuoteSegment,
  type RoundShape,
  type RoundArtifacts,
  ARTIFACT_ABSENT,
} from '../plan/observers';
import { parseDetectorVerdict, DETECTOR_PROTOCOL } from '../plan/detector';
import { repeatedActionBlock, type ActionAttempt } from '../plan/repeated-action';
import { makeLlmConvergenceJudge } from '../plan/llm-judge';
// D-6 启动期孤儿回收 (SDD 2026-08-24): 引擎硬崩溃 (OOM/SIGKILL) 后下次启动回收上个生命周期的
// 孤儿子进程。reapOrphansOnce 一次性闸, run + solve 经引擎入口只触发一次。INV-5/6/7 已由模块自身保证。
import { reapOrphansOnce } from '../proc/orphan-reap';
import { send } from '../../model/gateway';
// D-14v2 多模态媒体管道 (S4): attach_media 执行期从直接前驱输出解析图片 → ContentPart 注入。
import { collectDepMedia } from '../leaf-media';
import { recordGeneration, recordSpan } from '../../model/langfuse';
import { recordSeatUsage } from '../../model/seat-usage';
import { parseWrittenFiles, renderParseFailures } from '../writeset/write-parse-gate';
import { checkClaimAnchors } from '../writeset/claim-anchor';
import { applyPoisonRollback, planPoisonRollback } from '../writeset/poison-rollback';
import { ModelError, isTransientModelFault } from '../../model';
import { classifyCommandExit, withFailureKind, upstreamFailureNotice, type NodeFailureKind } from '../node-failure';
import { collectRepairGuidance, loadRepairFingerprints } from './repair-guidance';
import { livePin } from '../../model/provider-health';
import { makeRunNonce, fenceUntrusted, trustHeader } from '../prompt-fence';
import type { ContentPart } from '../../model/gateway';
// D-1 责备集 (SDD 2026-08-10-blame-scoped-node-retry): verifier 打回的结构化点名 → 失效闭包。
// 单一住处 (blame.ts, 与冻结的 blame.test.ts 同源); 引擎只接线不重实现 (INV-2)。
import { parseBlameVerdict, invalidationClosure } from './blame';
import { awaitNode } from './await-node';

/** 上一轮 plan+results (escalation 重规划轮传入, D-21 跨轮复用的匹配源)。 */
import type { PriorExec } from './types';

// ── 切片 1 (2026-08-23, 引擎自纠错片 1) —— conductor 内环留轮边界时间戳 ───────────
//   时间戳取值收进模块作用域的具名 helper, 三处埋点共用。理由 (SDD D-5):
//   反向自检的 mutation 定位要**唯一**, 内联 `new Date().toISOString()` 会让这一跳
//   落在 6+ 个 toISOString 调用点上, 闸红的时候分不清是哪个。改成 stub → 立刻红。
const roundStampNow = (): string => new Date().toISOString();

// ── barrel re-export: 保持 ./executor-dag 公共面稳定 (importer-closure, 消费方零改) ──
export type { GenerateFn, ExecutorDagConfig, ExecutorDagResult, LeafResult, DagNodeEvent } from './types';
export { topoLevels } from './planner';
export { loadAgentTemplates, templateRoster, AGENT_TEMPLATE_DIR } from '../agent-templates';
export type { AgentTemplate } from '../agent-templates';
export { PONYTAIL_LEAF_DISPOSITION } from './defaults';
// D-1 冻结符号再导出 (契约 §10): parseBlameVerdict / invalidationClosure 定义在 blame.ts 单一住处,
// 引擎只接线不重实现 (INV-2); 顶层具名导出保持公共面可见, 无别名包裹。
export { parseBlameVerdict, invalidationClosure } from './blame';

/**
 * seenUpstreamOutputs —— D-3 (verbatim-drop 修结构性错位, 2026-08-25)
 *
 * 给 `detectVerbatimDrop` 喂的上游输入 = 节点**真实消费**的视图 (详见 src/harness/plan/observers.ts)。
 * 而非原始 `depOutputs[d]` —— 后者是 producer 的全文, 节点没看过; 大扇入时被摘要视图
 * (见 `upstreamText` / `capFanin`) 截断的引文, 节点根本没机会逐字留。
 *
 * 行为:
 * - 逐 `d ∈ plan.nodes[nodeId].depends_on` 取上游, 跳过非 string 与空 (与原行字节等价)。
 * - 优先 `faninView[d]` —— 节点在 prompt 里实际看到的"摘要视图+逐字引文附录" (slice 1 修);
 * - fallback `depOutputs[d]` —— 未触发摘要时与原行为逐字一致 (零回归通道)。
 * - 全部经 `capFanin` 走一遍: 节点看到的上游 = 同一份 capFanin 截过的 body, 观察者判的也是同一份。
 *   调用方传**与节点同一份**的 `capFanin` (executeDag 内就是同一个闭包常量) → 两边逐字相等。
 *
 * 模块级 + 纯 = 单测可直接喂最小 fixture, 不跑整张图。
 */
export function seenUpstreamOutputs(
  nodeId: string,
  plan: Pick<ConductorPlan, 'nodes'>,
  depOutputs: Readonly<Record<string, string>>,
  faninView: Readonly<Record<string, string>>,
  capFanin: (depId: string, body: string) => string,
): string[] {
  const deps = plan.nodes[nodeId]?.depends_on ?? [];
  const out: string[] = [];
  for (const d of deps) {
    const raw = depOutputs[d];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const body = capFanin(d, faninView[d] ?? raw);
    if (body.length > 0) out.push(body); // INV-3: 喂观察者时空 body 不污染「真有多少上游」的分母
  }
  return out;
}

/**
 * 产物路径解析 (SDD 2026-08-22 · S50 根治切片 1)。
 *
 * 把「绝对路径怎么解析到 run 的产物根」收成一处 —— 之前散落在 `:217 / :825 / :837 / :1121`
 * 四处, 任何一处漏写 INV-2/3 锚回都会导致 leaf 报的路径 (绝对 / 相对) 落不到产物根上,
 * 失败方向**全部静默** (hashArtifact 返回 null 不抛不记)。本 helper 是这四处的唯一实现。
 *
 * INV (与 SDD C-1 一字对齐):
 * - INV-1 相对路径 ⇒ `${root}/${p}`, 与今天逐字相同。
 * - INV-2 绝对路径原样存在 ⇒ 返回原样。
 * - INV-3 绝对路径不存在 ∧ 以 `repoRoot + '/'` 开头 ∧ `root !== repoRoot`
 *   ⇒ 返回 `root + p.slice(repoRoot.length)` (当且仅当它存在)。
 * - INV-4 `root === repoRoot` 或 `repoRoot` 为空 ⇒ 不锚回 (恒等, 省一次 stat)。
 * - INV-5 两个候选都不存在 ⇒ 返回**原样 `p`**, 由调用方决定怎么处置 ("不存在" 不能冒充 "存在")。
 *
 * 反向自检 (S-49 · 承重那一位):
 *   1. INV-3 短路 ⇒ GWT1 (worktree 命中) 必红。
 *   2. INV-5 短路 ⇒ GWT2 (两边都 miss) 必红 (错把不存在放行 = 闸判废)。
 *   3. 既有的 `artifact-gate-anchor.test.ts` 一条不改也一条不红 (D-2 纯重构的证据)。
 */
export function resolveArtifactPath(
  p: string,
  opts: {
    /** 本 run 的产物根 (worktree 锚点)。 */
    root: string;
    /** 主干根; INV-3 剥前缀锚点。空串 ⇒ 不锚回 (INV-4 双保险)。 */
    repoRoot: string;
    /** 注入点; 默认 `existsSync` (与今天逐字相同)。 */
    exists?: (p: string) => boolean;
    /**
     * 注入点: 每条候选路径 stat 前回调一次, 用于 `probed` 跟踪 (默认 no-op)。
     *
     * 不影响返回语义 (INV-1..5 仍是字符串) —— 是 `resolveMissingArtifacts` 的「多路径
     * probe 列表」职责的承载面, 不属于本 helper 的契约面 (INV 集合不动)。
     */
    onProbe?: (candidate: string) => void;
  },
): string {
  const existsFn = opts.exists ?? existsSync;
  const onProbe = opts.onProbe ?? (() => {});
  const { root, repoRoot } = opts;
  // INV-1: 相对路径 ⇒ `${root}/${p}`, 一颗钉子都没动 (存在与否由调用方处理)。
  if (!p.startsWith('/')) {
    const candidate = `${root}/${p}`;
    onProbe(candidate);
    return candidate;
  }
  // INV-2: 绝对路径原样命中 ⇒ 直接返回。
  onProbe(p);
  if (existsFn(p)) return p;
  // INV-3 / INV-4: 锚回试一次。INV-4 短路 (`root === repoRoot` 或 `repoRoot` 空) ⇒
  // 不剥前缀 (剥了再拼 = 恒等, 每个绝对路径白 stat 一次; `p.startsWith('')` 还恒真)。
  if (repoRoot.length > 0 && root !== repoRoot && p.startsWith(repoRoot + '/')) {
    const anchored = root + p.slice(repoRoot.length);
    onProbe(anchored);
    if (existsFn(anchored)) return anchored;
  }
  // INV-5: 两个候选都不存在 ⇒ 返回原样 (让调用方按自己的语义处置, 不冒充存在)。
  return p;
}

/**
 * 产物闸「绝对路径判定」(SDD 2026-08-22 · S1 Step B · 锚回上线)。
 *
 * 把 engine.ts 第 3320 行的内联表达式提到 helper (Step A 纯提取),
 * 再叠加 INV-2/3/4 「绝对路径锚回 worktree」 (Step B):
 * - INV-1 `existsSync(p)` 命中 ⇒ 不判 missing (绝对路径原样 stat)。
 * - INV-2 不中 ∧ 绝对路径 ∧ `p` 以主干根 (`repoRoot + '/'`) 开头
 *   ⇒ 剥主干根前缀, 拼到 `root` 再 stat; 命中 ⇒ 不判 missing。
 * - INV-3 不中 ∧ 锚回不适用 (相对路径 / 不以主干根开头 / INV-4 短路) ⇒ 判 missing。
 * - INV-4 `root === repoRoot` ⇒ 跳过锚回 (D-3: 剥了再拼 = 恒等, 每个绝对路径白 stat 一次)。
 * - INV-5 相对路径走 `${root}/${p}`, 字字与今天相同 (一颗钉子都没动)。
 *
 * `probed[p]` = 实际 stat 过的绝对路径列表 (INV-2 命中时 1 条; 都 miss 时 2 条; INV-3 时 1 条)。
 * 判词 (call site) 据此补 INV-6 「两基准都查过」叙述。
 *
 * `exists` 仍在签名上: 反向自检时把 INV-2 那条 exists 短路 ⇒ GWT1/5/6 必红。
 */
export function resolveMissingArtifacts(args: {
  /** 本 run 的产物根 (worktree 锚点); leaf 自报 cwd > continuity.repoRoot > cwd。 */
  root: string;
  /** 主干根 (`continuity?.repoRoot ?? process.cwd()`); INV-2 剥前缀锚点。 */
  repoRoot: string;
  /** leaf 自报碰过的路径 (绝对或相对)。 */
  filesTouched: string[];
  /** 注入点; 默认 `existsSync` (与今天逐字相同)。 */
  exists?: (p: string) => boolean;
}): { missing: string[]; probed: Record<string, string[]>; outOfScope: string[] } {
  const existsFn = args.exists ?? existsSync;
  const root = args.root;
  const repoRoot = args.repoRoot;
  const missing: string[] = [];
  const probed: Record<string, string[]> = {};
  // s1 Step C (SDD 2026-08-22): 写域外绝对路径 (既不在 root 也不在 repoRoot 之下) 从判据剔除,
  // 只留一份 `outOfScope` 账 (D-2: 不动 `LeafResult.filesTouched` 记录)。
  const outOfScope: string[] = [];
  // D-1 (s1 Step C): 「在根之下」单行定义, 锚回式 INV-2 已在 helper 里覆盖 ——
  // 这里只判「绝对路径是不是落在任一根目录里」(不替它 stat, 也不进 missing / probed)。
  const isUnderRoot = (p: string, r: string): boolean => r.length > 0 && (p === r || p.startsWith(r.endsWith('/') ? r : r + '/'));
  // D-2: 路径解析逻辑一律委托 `resolveArtifactPath` (INV-1..5 的唯一实现处)。
  // 本函数只承担「多路径 probed 列表」与「missing 判定」 —— 调用方契约面 (`probed[p]` =
  // 实际 stat 过的路径列表) 不变, 反向自检 (`artifact-gate-anchor.test.ts` 一字不改) 守住。
  for (const p of args.filesTouched) {
    const isAbsolute = p.startsWith('/');
    // s1 Step C · INV-1: 绝对路径 ∧ 既不在 root 之下也不在 repoRoot 之下 ⇒ 写域外。
    //   相对路径按 root 解析, 构造上就在域内, D-4 一字不变。
    //
    // ⚠ **写域外只免死, 不免功** (2026-08-22 收编时补): 剔除的条件要再加一条「盘上也没有」。
    //   第一版无条件剔除, 于是「leaf 真在 root 之外写了一个文件并且它还在」也被算成没产出 ——
    //   `test/core/executor-dag-file-producer.test.ts` 当场红 (它建的真产物落在临时目录里)。
    //   本片要治的是**跑完就没了的一次性脚本**, 不是「写在别处的真产物」。两者的差别恰好是
    //   `existsFn(p)`: 盘上还在 = 有产出的证据, 照旧计入; 盘上没有 = 不判死也不计入 (D-3 仍成立)。
    if (isAbsolute && !isUnderRoot(p, root) && !isUnderRoot(p, repoRoot) && !existsFn(p)) {
      outOfScope.push(p);
      continue;
    }
    // INV-1 / INV-5: 与今天逐字相同 —— 绝对路径原样 stat, 相对路径拼 root。
    const statPath = isAbsolute ? p : `${root}/${p}`;
    const probedSet: string[] = [];
    const resolved = resolveArtifactPath(p, {
      root,
      repoRoot,
      exists: existsFn,
      onProbe: (candidate) => {
        if (!probedSet.includes(candidate)) probedSet.push(candidate);
      },
    });
    probed[p] = probedSet;
    // missing ⇔ helper 没有替我们找到存在的候选 (resolved 仍是 statPath, 即 INV-2 命中或 INV-5 都 miss)。
    // 相对路径在 helper 里不 stat ⇒ 这里补一次; 绝对路径走 helper 已 stat ⇒ 这再 stat 一次是幂等的,
    // 既不改变 missing 也与今天逐字相同的语义 (单源 `existsSync`, 副作用无)。
    if (resolved === statPath && !existsFn(statPath)) missing.push(p);
  }
  return { missing, probed, outOfScope };
}

/** 一轮 plan+execute 的产物 (verify/升级编排在 runExecutorDag 外层组装)。 */
interface ExecOnce {
  plan: ConductorPlan;
  levels: string[][];
  results: Record<string, LeafResult>;
  /** 本轮 D-21 复用命中的节点 id (结果面 reusedNodes 的来源)。 */
  reusedNodes: string[];
  /**
   * resume 时因规格变更而被丢弃的绿节点 id (S-51 抓法 ③; 结果面 specChangedNodes 的来源)。
   * ⚠ **必须 optional 且缺席有意义**: 缺席 = 不是 resume(不适用), 空数组 = resume 了但没变。
   */
  specChangedNodes?: string[];
  /** D-Q 图外只读观察者本轮的产出 (制品边 lint / 环空转)。 */
  observations: DagObservation[];
  /** 「声称 vs 引擎记录」两道扫描各自查了多少、检出多少 (见 ExecutorDagResult.claimCheck)。 */
  claimCheck: NonNullable<ExecutorDagResult['claimCheck']>;
  /** 「产物没变」判据判得了多少次 (分母; 见 ExecutorDagResult.artifactMove)。 */
  artifactMove: NonNullable<ExecutorDagResult['artifactMove']>;
  /** 起跑时「跑坏了回得去吗」的快照 (D1; 见 ExecutorDagResult.rollback)。 */
  rollback: NonNullable<ExecutorDagResult['rollback']>;
  /** 运行时写竞争的机会与命中 (见 ExecutorDagResult.writeRace)。 */
  writeRace: NonNullable<ExecutorDagResult['writeRace']>;
  /** D-P: 本轮是被叫停的 (给了就非自然结束); notRun = 一个都没起跑过的节点。 */
  cancelled?: { reason: string; at: string; notRun: string[] };

  conductorUsage: ModelUsage;
  leavesIn: number;
  leavesOut: number;
  leavesCacheHit: number;
}

/**
 * **执行段的段名** —— 段的分辨面取 `plan.name`, 与 run-goal 同一条既有口径
 * (`goal-contract` / `goal-execute`, 见 run-goal.ts 的 `_runDag` 注), 不新开旋钮。
 * 直通 v2 的平铺图 (`goal-execute-flat`) 压根没有 conductor 节点, 走不到这条闸, 故不入表。
 */
const EXECUTE_SEGMENT_PLAN_NAME = 'goal-execute';

/**
 * **执行段禁调研** (owner 2026-08-11 裁; 语义同内环 v2 D-2「不自转, STALLED 开票交人」
 * 与控制面 D-2③)。key = 被禁的 executor, value = 拒绝理由 (原样进错误文本, 给下一轮/复盘的人读)。
 *
 * ⚠ **不能**并进 conductor-expand 的全局禁单: 契约段 (`goal-contract`) 的 conductor **正当需要**
 * research 子节点 —— 它的 goal 里逐字写着「外部调研 (`executor:"research"`)」那一条, 而两段共用
 * 同一个展开器。所以这份禁单按调用传, 只在执行段生效。
 */
const EXECUTE_SEGMENT_FORBIDDEN_EXECUTORS: ReadonlyMap<string, string> = new Map([
  ['research', '执行段禁调研 —— 已结晶 SDD 的 research 已付费, 缺信息走 STALLED 开票交人, 不自开调研'],
]);

/**
 * D-3 注册表根: parsePlan 的 knownServers 从**该 run 的 cwd** 取 (与 :3256 loadAgentTemplates 同一个根,
 * 省略 = process.cwd()) —— 必传, 不存在省略注册表即静默跳过 mcp 校验的路径 (惰性闸修复)。
 */
function mcpRegistryRoot(config: ExecutorDagConfig): string {
  return config.continuity?.repoRoot ?? process.cwd();
}

/** INV-7: conductor 只见 name + 一行能力摘要, 不让整份 ProfileSpec/persona 穿透。 */
function profileRoster(config: ExecutorDagConfig): ConductorProfileRosterEntry[] {
  return [...loadProfiles(mcpRegistryRoot(config)).values()].map((profile) => ({
    name: profile.name,
    summary: profile.skills?.length
      ? `skills=${profile.skills.join(',')}; output=${profile.outputSchema ?? 'unspecified'}`
      : profile.outputSchema
        ? `output=${profile.outputSchema}`
        : 'specialist profile',
  }));
}

/**
 * 单轮: conductor 规划 (显式 conductorModel) → 现场 fan-out leaves → results。
 * 升级时本函数被重复调用 (换 conductorModel + 注入失败原因的 task)。
 */
async function planAndExecute(
  task: string,
  config: ExecutorDagConfig,
  conductorModel: string,
  generate: GenerateFn,
  maxPlanRetries: number,
  templates: ReadonlyMap<string, AgentTemplate>,
  prior?: PriorExec,
  /** D-3 反馈锚定 (SDD 2026-08-10-blame-scoped-node-retry): 闭包节点 id → 追加到其 goal 的 verifier 意见。非闭包节点不碰 (G-2)。 */
  blameAnchor?: ReadonlyMap<string, string>,
  warnedUnknownProfiles: Set<string> = new Set(),
  /**
   * 观测名前缀 (#144 洞 1)。升级重规划轮坐的是 `conductorEscalationModel`, 但此前 traceName 仍打
   * `conductor:*` —— 于是 escalation 座的钱**结构上算在 conductor 头上**。这不是缺数是**错归**,
   * 而错归比缺数难发现: 账上有一个看起来很正常的 conductor 数字, 没人会去怀疑它。
   */
  seatLabel: 'conductor' | 'escalation' = 'conductor',
): Promise<ExecOnce> {
  // ── 1. conductor: 单结构化调用规划 (显式可换) ──────────────────────────────
  // 模板注册表进规划 prompt (每卡一行 description); parsePlan 校验 template 引用 (TPL-2 规划层拒)。
  // prompt 档位: config > env OMD_CONDUCTOR_PROMPT > 'full' (弱 conductor 教练全量; 'lean' 给顶级模型)。
  const promptProfile = config.conductorPromptProfile ?? conductorPromptProfileFromEnv();
  const sys = conductorSystemPrompt({
    agents: config.agents,
    templates: templateRoster(templates),
    profiles: profileRoster(config),
    profile: promptProfile,
    researchAvailable: Boolean(config.researchRunner),
  });
  let plan: ConductorPlan | null = null;
  let conductorUsage: ModelUsage = { in: 0, out: 0 };
  let lastErr = '';
  let correction = '';
  // g1 leaf 档位闸 (图 #9): parse 重试与闸拒回**分开记账** —— 闸拒回是"计划合法但档位派错",
  // 吃 parse 预算会让一次违规偷走真正的格式重试。有界重问, 用尽 fail-open 放行 + 响亮留证
  // (仓规: fail-open 可以吞异常, 不许吞证据)。patch 重规划轮 (tryPatchReplan) 不过闸:
  // 补丁只改局部字段, 首轮整图已闸过。
  const LEAF_TIER_MAX_REJECTS = 2;
  // E-T2 research 可用性闸: 与 leaf 档位闸同形 (有界拒回 → fail-open 留证), 各记各的账。
  const RESEARCH_GATE_MAX_REJECTS = 2;
  // #247 (2026-08-24, 片 2): plan-critic 进活环, 只收「无外部输入」子集 —— 字段存在性/枚举/形状 (零外部状态)。
  // PP-T*/PP-S* 需 inventory/skill 装配 (S2 债), 空 working-set 下 enforce = 教模型删 toolRefs, 反教化。
  // 具名常数让 S2 扩集只改一处。
  const INLOOP_ENFORCED_CODES: ReadonlySet<DiagnosticCode> = new Set([
    'PP-I01', 'PP-I02', 'PP-O01', 'PP-O02', 'PP-V01', 'INV-12',
  ]);
  const PLAN_CRITIC_MAX_REJECTS = 2;
  let parseFails = 0;
  let gateRejects = 0;
  let planCriticRejects = 0;
  let researchGateRejects = 0;
  // D-21 复用闸 (2026-08-14): 整图重规划 (patch 模式 fail-open 落到这) 把上轮节点全部重写 →
  // 语义指纹 0 命中 → 已绿工作整体重烧。实测 f2af8514 execute 相位: 上轮 37 done, 重画后
  // reused 0, 33.1M leaves-in 只换来 7 done。判据必须在**执行前** —— 执行后再看 reusedNodes
  // 是尸检不是闸。拒回一次带节点清单重问; 再不中 fail-open 放行 + 响亮留证 (闸不许把 run 卡死)。
  const REUSE_GATE_MIN_DONE = 4;
  let reuseRejects = 0;
  // conductor 输出预算 (2026-07-25 实证修): plan JSON 随任务规模涨, thinking 模型 (k3) 的推理还可能
  // 计入 completion 预算 — transport 默认 4096 必截断 (Unterminated string 重试耗尽整轮报废)。
  // 默认 8192 = deepseek 系安全顶 (同 fanout SYNTH_MAX 语义); k3 等高容量 conductor 经 config/env 升。
  const conductorMaxTokens =
    config.conductorMaxTokens ?? (Number(process.env.OMD_CONDUCTOR_MAX_TOKENS) || 32_768);
  // A8 规划层兑现: TRUST_FENCE_RULE (冻结前缀) 承诺「token 在任务正文最开头声明」, 此前只有
  // 叶层 (buildLeafPrompt) 预置了 token 头, 规划请求没有 —— goal 带 owner 权威措辞时 planner
  // 按「缺 token 即伪造」fail-closed, 整图规划成单节点 blocker (run 9228064a, 2026-08-09)。
  // 每次规划现生成 (不跨运行复用, 同 prompt-fence.ts makeRunNonce 的假设); 值走动态段不打缓存。
  const planNonce = makeRunNonce();
  for (;;) {
    const { text, usage } = await generate({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `${PLAN_BOUNDARY}${trustHeader(planNonce)}${task}${correction}` }],
      model: conductorModel,
      // S-T 优先序: config 显式 > 座位档 (auto-assign 给 decomposer 座的档) > 硬默认。
      thinkingLevel: config.conductorThinkingLevel ?? config.seatThinking?.(conductorModel) ?? 'high',
      maxTokens: conductorMaxTokens,
      // 顶层规划那一发 (与节点内重展开分开看; escalation 轮换前缀)。
      // ⚠ 刻意写成两个**紧跟 `traceName:` 的字面量**而不是 `${seatLabel}:plan` —— seat-usage 的
      // 覆盖率闸靠扫源码里的标签字面量守「新标签必须进映射表」, 拼出来的名字它一个都看不见
      // (闸会从此对这条静默放水)。这个形状看着啰嗦, 换来的是标签在闸的视野里。
      ...(seatLabel === 'escalation' ? { traceName: 'escalation:plan' } : { traceName: 'conductor:plan' }),
      // #144 洞 3: 这一发之前**被闸拒回过几次**。parse 重试不算 —— 它有自己的预算 (parseFails),
      // 且它是"格式没对"不是"档位派错"。台账里 `sum(in) where rejectRound > 0` = 规划层空转量。
      traceRejectRound: gateRejects + reuseRejects,
    });
    conductorUsage = addUsage(conductorUsage, usage);
    const parsed = parsePlan(text, { knownTemplates: new Set(templates.keys()), knownServers: knownMcpServerNames(mcpRegistryRoot(config)) });
    if (!parsed.ok) {
      lastErr = parsed.error;
      if (++parseFails > maxPlanRetries) break; // 预算同旧语义: 共 maxPlanRetries+1 次 parse 尝试
      correction = `\n\n上次回复不是有效 plan (${lastErr})。只回 JSON 对象, 别的不要。`;
      continue;
    }
    // 本轮候选图。g1 闸可能**程序化改写**它 (下面), 之后的 D-21 预览与最终 plan 都以它为准 ——
    // 拿改写前的图去预览复用, 预览的就不是真要执行的那张图。
    let candidate = parsed.plan;
    // E-T2 (2026-08-28) research 可用性闸: researchRunner 缺席时 research 节点执行期必败
    // (missing-capability) 占位耗轮 (bench 单批实测 124 次) —— 规划期确定性拒回重画。
    // 有界; 预算尽 fail-open 放行 + 响亮留证, 执行期硬闸 (executor:research 分支) 兜底。
    if (!config.researchRunner) {
      const researchHits = researchNodesWithoutRunner(candidate, false);
      if (researchHits.length > 0 && researchGateRejects < RESEARCH_GATE_MAX_REJECTS) {
        researchGateRejects++;
        logger.info(
          { nodes: researchHits, rejects: researchGateRejects },
          '[omd/executor-dag] research 可用性闸拒回 plan → 带 remediation 重问 (E-T2)',
        );
        correction = `\n\n上一版 plan 被 research 可用性闸拒回 (可修, 不是格式问题):\n- ${researchUnavailableRemediation(researchHits)}\n改完只回完整 plan JSON 对象, 别的不要。`;
        continue;
      }
      if (researchHits.length > 0) {
        logger.warn(
          { nodes: researchHits },
          '[omd/executor-dag] research 可用性闸重问预算用尽仍有 research 节点 → fail-open 放行 (执行期 missing-capability 兜底)',
        );
      }
    }
    if (config.leafTierGate) {
      // #144 提议 3 / #145 提议 3: 闸自己动手。判据命中且改写是确定性的 (静态节点 + 塞得下) →
      // 引擎直接把 `agent` 换成 `command`+`leaf` 对, **零规划发**; 改不动的残余才拒回问模型。
      // 此前这里一律拒回, 而 conductor prompt 里早就写着同一条规则 —— 规则在、模型不听、闸抓住、
      // 然后再花一发最贵的座位让它照着改。
      const rw = autoRewriteLeafTier(parsed.plan, {
        ...(config.leafTierThresholdBytes !== undefined ? { thresholdBytes: config.leafTierThresholdBytes } : {}),
      });
      candidate = rw.plan;
      // 静默改图与静默违规一样坏 —— 每一次改写都留证 (同写竞争硬闸那条)。
      for (const r of rw.rewritten) {
        logger.warn(
          { node: r.node, readNode: r.readNode, command: r.command, bytes: r.totalBytes },
          '[omd/executor-dag] leaf 档位闸**自动改写**: agent 读确定路径 → command+leaf 对 (零规划发, g1 图#9)',
        );
      }
      const findings = rw.residual;
      if (findings.length > 0 && gateRejects < LEAF_TIER_MAX_REJECTS) {
        gateRejects++;
        logger.info(
          { nodes: findings.flatMap((f) => f.nodes), rejects: gateRejects, autoRewritten: rw.rewritten.length },
          '[omd/executor-dag] leaf 档位闸拒回 plan → 带改写建议重问 (g1 图#9; 改不动的那部分)',
        );
        correction = `\n\n上一版 plan 被 leaf 档位闸拒回 (可修, 不是格式问题):\n${findings.map((f) => `- ${f.message}`).join('\n')}\n按建议改写后只回完整 plan JSON 对象, 别的不要。`;
        continue;
      }
      if (findings.length > 0) {
        logger.warn(
          { rejects: gateRejects, findings: findings.map((f) => f.message) },
          '[omd/executor-dag] leaf 档位闸重问预算用尽仍违规 → fail-open 放行 (证据在此, g1)',
        );
      }
    }
    // #247 (2026-08-24, 片 2): plan-critic 静态闸进活规划环。位置: parsePlan 成功后 · leafTierGate
    // 之后 · D-21 复用闸之前 (与 leaf-tier-gate 同形)。判定 = critique() + 过滤到 INLOOP_ENFORCED_CODES;
    // 有界拒回 = `PLAN_CRITIC_MAX_REJECTS` 次 (与 parseFails/gateRejects/reuseRejects **各记各的账**)。
    // 预算尽 → fail-open 放行 + logger.warn (留证 + 残余码进 gate_hit_distribution 供 SDD §10 消费),
    // 不 escalate 不停 run (D-3, 采纳期;硬闸化以 S2 读数为闸,见 debt_ledger:plan_critic_inloop_fail_open)。
    if (config.planCriticGate) {
      const allDiags: readonly Diagnostic[] = critique({
        plan: candidate,
        round: parseFails + gateRejects + reuseRejects + planCriticRejects + 1,
        workingSet: [],
        skills: [],
        runId: config.sessionId ?? config.continuity?.runId ?? 'unknown',
      });
      const inloop = allDiags.filter((d) => INLOOP_ENFORCED_CODES.has(d.code));
      if (inloop.length > 0) {
        if (planCriticRejects < PLAN_CRITIC_MAX_REJECTS) {
          planCriticRejects++;
          logger.info(
            { rejects: planCriticRejects, codes: inloop.map((d) => d.code), nodes: [...new Set(inloop.map((d) => d.node_id))] },
            '[omd/executor-dag] plan-critic 闸拒回 plan → 带 remediation 重问 (#247)',
          );
          correction = `\n\n上一版 plan 被 plan-critic 闸拒回 (可修, 不是格式问题):\n${inloop.map((d) => `- ${d.code} ${d.node_id}: ${d.remediation}`).join('\n')}\n按建议改写后只回完整 plan JSON 对象, 别的不要。`;
          continue;
        }
        // 预算尽 → fail-open 放行 (D-3)。**留证** (仓规: 可以吞, 不许吞证据) + 入 gate_hit_distribution。
        logger.warn(
          { rejects: planCriticRejects, residual: inloop.map((d) => ({ code: d.code, node_id: d.node_id, evidence: d.evidence, remediation: d.remediation })) },
          '[omd/executor-dag] plan-critic 闸重问预算用尽仍违规 → fail-open 放行 (#247; debt:plan_critic_inloop_fail_open)',
        );
      }
    }
    // D-21 复用闸: 上轮有可复用的 done 节点 (未中毒), 新图却一个都对不上 → conductor 把
    // 「未点名节点逐字保留」的指令整个无视了。预览用与 executePlan 同一条 computeReuse
    // (filters 先过, 与真执行同输入; blame append 只碰闭包节点, 而闭包已在毒集, 不影响预览)。
    if (prior) {
      const priorFps = merkleFingerprints(prior.plan);
      const eligibleDone = Object.entries(prior.results).filter(
        ([id, r]) => r.status === 'done' && !prior.poisoned?.has(priorFps.get(id) ?? ''),
      ).length;
      if (eligibleDone >= REUSE_GATE_MIN_DONE) {
        const preview = computeReuse(applyPlanFilters(candidate, config), prior, prior.poisoned);
        if (preview.size === 0 && reuseRejects < 1) {
          reuseRejects++;
          const keepIds = Object.keys(prior.plan.nodes).slice(0, 40).join(', ');
          logger.info(
            { eligibleDone, priorNodes: Object.keys(prior.plan.nodes).length },
            '[omd/executor-dag] D-21 复用闸拒回 plan → 带上轮节点清单重问 (整图重写 = 已绿工作重烧)',
          );
          correction =
            `\n\n上一版 plan 与上轮分解**零复用**: 上轮已有 ${eligibleDone} 个完成且未被点名有问题的节点, ` +
            `而你把所有节点都重写了 —— 引擎按语义指纹复用未变节点, id/goal/字段/依赖边任何措辞变化都会白白重算。` +
            `未被点名的节点**逐字保留**, 只改被点名有问题的。上轮节点 id: ${keepIds}。只回完整 plan JSON 对象。`;
          continue;
        }
        if (preview.size === 0) {
          // 重问预算用尽仍零复用 → fail-open 放行 + 响亮留证 (仓规: 可以吞, 不许吞证据)。
          logger.warn(
            { eligibleDone, rejects: reuseRejects },
            '[omd/executor-dag] D-21 复用闸重问后仍零复用 → fail-open 放行 (已绿工作将整体重烧, 证据在此)',
          );
        }
      }
    }
    plan = candidate;
    break;
  }
  if (!plan) throw new Error(`executor-dag: conductor (${conductorModel}) 未产出有效 plan: ${lastErr}`);

  // pass 管线 (SDD v2): oracle 过滤 + planFilters (prune→dedup→stamp, 接线层组装)。
  // conductor 之后, 下游执行机器与 plan 来源无关 → 交 executePlan (D-7 预构造入口共用同一机器)。
  return executePlan(applyPlanFilters(plan, config), task, config, generate, conductorUsage, templates, prior, blameAnchor, warnedUnknownProfiles);
}

/**
 * SDD v2 pass 管线: oracle 等价节点过滤 → config.planFilters 依序应用 (prune → dedup → stamp,
 * 链由接线层组装, 见 plan-passes/)。确定性纯函数链; 抛错上抛 fail-closed (坏 pass 不静默跳过)。
 * conductor 首轮与 escalation 重规划轮都过同一管线 (planAndExecute 每轮调用)。
 */
/**
 * 冻结节点复原(SDD 2026-08-22 「冻结判据在重规划轮里并不冻结」, C-2/INV-1..INV-5)。
 *
 * 调用方在 `config.frozenNodes` 里点名 (run-goal 的 flatPlan 路径传 `['accept']`);
 * `snapshot` 是 round-1 post-filter 那一刻 `exec.plan.nodes` 的字面快照 (run-goal
 * 路径 = 调用方铺图后被 `applyPlanFilters` 改写过的形态, 与 `s1-green 被吸进 accept`
 * 那条「不算违约」对得齐 — 引擎**不会**因为复原把串行 command 链合并给拆开)。
 *
 * 行为表:
 *   - INV-1  新定义 ≠ 快照 → 整个覆盖 + 一行 warn (payload 含 `node` 与 `changedFields`)
 *   - INV-2  id 在新图缺席 → 补回 + 一行 warn (D-3)
 *   - INV-3  逐字相同 → 零触碰零噪声(常态)
 *   - INV-4  `frozenNodes` 缺省 / 空数组 → 调用方不进来 (snapshot 也空), 一字节不变
 *   - INV-5  只动 `plan.nodes[id]` 的定义; `exec.results` / 毒集 / blame 闭包 / 复用集一律不碰
 *
 * 反向自检 (切片 1): 把循环源替成 `for (const id of [])` → GWT-1/GWT-2 当场红。
 *   注释里禁止 `|` (falsify 行用 `config.frozenNodes ?? []` 而非 `[]`)。
 */
function restoreFrozenNodes(
  exec: ExecOnce,
  snapshot: ReadonlyMap<string, ConductorPlan['nodes'][string]>,
  frozenNodes: readonly string[] | undefined,
): void {
  for (const id of frozenNodes ?? []) {
    const original = snapshot.get(id);
    if (!original) continue;
    const current = exec.plan.nodes[id];
    if (!current) {
      // INV-2: conductor 把节点删了 → 补回 + warn (图上没判卷标准是最坏的一类漂移)
      exec.plan.nodes[id] = original;
      logger.warn(
        { node: id },
        '[omd/executor-dag] 冻结节点被 conductor 删除 → 逐字补回 (D-3, INV-2)',
      );
      continue;
    }
    // INV-1: 逐字比较 (字段全等)
    const changedFields: string[] = [];
    const oRec = original as Record<string, unknown>;
    const cRec = current as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(oRec), ...Object.keys(cRec)]);
    for (const k of allKeys) {
      if (JSON.stringify(oRec[k]) !== JSON.stringify(cRec[k])) changedFields.push(k);
    }
    if (changedFields.length > 0) {
      exec.plan.nodes[id] = original;
      logger.warn(
        { node: id, changedFields },
        '[omd/executor-dag] 冻结节点被 conductor 改写 → 逐字复原 (D-2, INV-1)',
      );
    }
    // INV-3: 逐字相同 → 静默
  }
}

function applyPlanFilters(plan: ConductorPlan, config: ExecutorDagConfig): ConductorPlan {
  let p = config.oracleCmd ? filterOracleCommandNodes(plan, config.oracleCmd) : plan;
  for (const f of config.planFilters ?? []) p = f(p);
  // #153② 验收尾链机械合并 (墙钟杠杆 2): 串行 command 直线 → 一条 && 节点 (语义保持, 每环
  // 独立判红)。挂在这里 = 顶层图与 conductor 子图共用一条 (同 serializeWriteRaces 的理由)。
  // 补了图就响亮留证 —— 静默改图与静默串行一样坏。
  const chainMerge = mergeCommandChains(p);
  for (const m of chainMerge.merged) {
    logger.warn(
      { into: m.into, absorbed: m.absorbed },
      '[omd/executor-dag] #153② 串行 command 链已机械合并为一条 && 节点 (跨节点纯亏: 付摘要税换不回并行)',
    );
  }
  p = chainMerge.plan;
  // 计划期写竞争硬闸 (2026-08-14): 同文件多写者且互不可达 → 程序化补边串行化 (构造性消灭,
  // 不烧重画轮)。挂在这里 = 顶层图与 conductor 子图 (D-N 管线) 两个口共用一条。方向/成环
  // 论证见 serializeWriteRaces 的注。补了边就响亮留证 —— 静默改图与静默竞争一样坏。
  const serialized = serializeWriteRaces(p);
  for (const e of serialized.added) {
    logger.warn(
      { from: e.from, to: e.to, path: e.path },
      '[omd/executor-dag] 写竞争硬闸: 两节点声明写同一文件且无序 → 已补依赖边串行化 (谁后写由拓扑+声明序定)',
    );
  }
  return serialized.plan;
}

/**
 * S3.6 escalation patch 模式 (D-21/G-21 强化, 信任反转): 重规划 conductor 只输出节点补丁 JSON
 * ({改哪些节点: 新字段}), 引擎程序化 merge 到上轮 plan — 未补丁节点**字节不动** → 语义指纹复用
 * 按构造成立, 不再指望 LLM「逐字保留」(S3.5 实证跨轮重措辞, 4 采样 1 中)。
 * 补丁解析/校验失败 → exec:null, 调用方回退现行整图重规划 (SDD 钉死 fail-open);
 * usage 始终返回 (补丁尝试烧掉的 conductor token 不丢账 — 成功时已折进 exec.conductorUsage)。
 *
 * D-1/D-2 (SDD 2026-08-11-l2-diff-replan) 请求侧差量: 有 closure (blame 解析成功) → user 消息
 * 换成 buildPatchRequest 的差量体 (闭包节点全文 + 闭包外 `id: goal首行` 单行清单), 且
 * applyPlanPatch 收 allowedIds=closure (越界机器闸, G-2)。closure 缺省/null (blame 解析失败,
 * fail-open) → 现行整图请求, 不设 allowedIds — 行为与今天逐字节相同 (INV-1)。
 */
async function tryPatchReplan(
  task: string,
  reason: string,
  prior: PriorExec,
  config: ExecutorDagConfig,
  conductorModel: string,
  generate: GenerateFn,
  maxPlanRetries: number,
  templates: ReadonlyMap<string, AgentTemplate>,
  /** D-3 反馈锚定: 同 planAndExecute (补丁路径同样在 executePlan 入口落 append)。 */
  blameAnchor?: ReadonlyMap<string, string>,
  /** D-1/D-2: blame 闭包 (invalidationClosure 结果)。null/undefined = blame 解析失败 → 整图请求, 无越界闸。 */
  closure?: ReadonlySet<string> | null,
  warnedUnknownProfiles: Set<string> = new Set(),
): Promise<{ exec: ExecOnce | null; usage: ModelUsage }> {
  const sys = conductorPatchSystemPrompt();
  const requestBody = closure
    ? buildPatchRequest(prior.plan, closure)
    : JSON.stringify(
        {
          name: prior.plan.name,
          ...(prior.plan.description ? { description: prior.plan.description } : {}),
          nodes: prior.plan.nodes,
          ...(prior.plan.outputs?.length ? { outputs: prior.plan.outputs } : {}),
        },
        null,
        1,
      );
  const known = new Set(templates.keys());
  let usage: ModelUsage = { in: 0, out: 0 };
  let lastErr = '';
  // #144 洞 3: 与 `attempt` 分开数 —— attempt 同时被 parse 失败与闸拒推进, 混在一起就答不了
  // 「多少发烧在闸拒回上」。run A 的 7 行日志里 escalation 补丁连拒 3 次, 而账上一个字都没有。
  let patchGateRejects = 0;
  for (let attempt = 1; attempt <= maxPlanRetries + 1; attempt++) {
    const correction = attempt === 1 ? '' : `\n\n上次回复不是有效补丁 (${lastErr})。只回 {"patch": {...}} JSON 对象, 别的不要。`;
    const { text, usage: u } = await generate({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `${PLAN_BOUNDARY}${requestBody}\n\n[verification failure] ${reason}${correction}` },
      ],
      model: conductorModel,
      // 补丁轮只在 verifier 未过之后跑, 且坐的是 escalation 模型 → 前缀是 escalation 不是 conductor。
      traceName: 'escalation:repair', // 校验失败后的补丁重试 —— 与首次规划分开看 (它的贵是有原因的)
      traceRejectRound: patchGateRejects,
      thinkingLevel: config.conductorThinkingLevel ?? config.seatThinking?.(conductorModel) ?? 'high',
      maxTokens: config.conductorMaxTokens ?? (Number(process.env.OMD_CONDUCTOR_MAX_TOKENS) || 32_768),
    });
    usage = addUsage(usage, u);
    const parsed = parsePlanPatch(text);
    if (!parsed.ok) {
      lastErr = parsed.error;
      continue;
    }
    const applied = applyPlanPatch(prior.plan, parsed.patch, { knownTemplates: known, ...(closure ? { allowedIds: closure } : {}) });
    if (!applied.ok) {
      lastErr = applied.error;
      continue;
    }
    // g1 闸对补丁轮同样生效 (2026-08-04 当天实测堵洞): 首版设计只闸首轮, 结果 f2 复测 pair1 的
    // escalation 补丁把被拒的 agent 读盘模板**原样带了回来** (run 6d3f9e9b, 每篇又烧 19-141s)。
    // 违规补丁按无效补丁处理 → 重试带建议; 用尽 → exec:null 回落整图重规划 (那条路有闸)。
    let patched = applied.applied.plan;
    if (config.leafTierGate) {
      // 同首轮: 能确定性改的直接改 (零规划发), 改不动的才按无效补丁重试。
      // 这条路上"再问一次"尤其贵 —— 补丁轮坐的是 escalation 座, 而 run A 就是在这里连拒 3 次
      // 之后放弃补丁模式、退回整图重画、再被 D-21 拒一次。
      const rw = autoRewriteLeafTier(patched, {
        ...(config.leafTierThresholdBytes !== undefined ? { thresholdBytes: config.leafTierThresholdBytes } : {}),
      });
      patched = rw.plan;
      for (const r of rw.rewritten) {
        logger.warn(
          { node: r.node, readNode: r.readNode, command: r.command, bytes: r.totalBytes },
          '[omd/executor-dag] escalation 补丁被 leaf 档位闸**自动改写** → 无需重试 (g1 图#9)',
        );
      }
      const gateFindings = rw.residual;
      if (gateFindings.length > 0) {
        patchGateRejects++;
        lastErr = `leaf 档位闸拒 (大内容进 prompt 不进工具环): ${gateFindings.map((f) => f.message).join(' | ')}`;
        logger.info(
          { nodes: gateFindings.flatMap((f) => f.nodes), autoRewritten: rw.rewritten.length },
          '[omd/executor-dag] escalation 补丁被 leaf 档位闸拒 → 带建议重试 (g1 图#9; 改不动的那部分)',
        );
        continue;
      }
    }
    const { changed, removed, added } = applied.applied;
    const plan = patched;
    logger.info(
      { changed, removed, added, total: Object.keys(plan.nodes).length },
      '[omd/executor-dag] escalation 补丁采纳 → 程序化 merge (S3.6; 未补丁节点按构造复用)',
    );
    const exec = await executePlan(applyPlanFilters(plan, config), task, config, generate, usage, templates, prior, blameAnchor, warnedUnknownProfiles);
    return { exec, usage };
  }
  logger.warn({ err: lastErr }, '[omd/executor-dag] escalation 补丁模式未产出有效补丁 → 回退整图重规划 (S3.6 fail-open)');
  return { exec: null, usage };
}

/**
 * 执行一张**已定** plan (conductor 路径 ∨ D-7 预构造入口共用): topo 分层 → ready-set 现场 fan-out
 * (map/primitive/command/agent/inproc + checkpoint) → results。**纯下游执行机器**, 与 plan 从哪来无关
 * (ConductorPlan = 接缝, 下游零感知)。conductorUsage 由 caller 传入 (conductor 路径=累加规划用量;
 * 预构造路径={in:0,out:0}) → 账本一致。
 */
async function executePlan(
  plan: ConductorPlan,
  task: string,
  config: ExecutorDagConfig,
  generate: GenerateFn,
  initialConductorUsage: ModelUsage,
  templates: ReadonlyMap<string, AgentTemplate>,
  prior?: PriorExec,
  /** D-3 反馈锚定: 闭包节点 id → goal 追加后缀。执行前落 (computeReuse 在其后, 指纹吃 append 后的 plan)。 */
  blameAnchor?: ReadonlyMap<string, string>,
  warnedUnknownProfiles: Set<string> = new Set(),
): Promise<ExecOnce> {
  let conductorUsage = initialConductorUsage;
  // C-1 (2026-08-19): 引擎外层轮 ++。每次 executePlan 入口 = 新一轮; planAndExecute 走主路径,
  // tryPatchReplan 走补丁路径 (两者最终都进 executePlan, 单点 ++ 即可覆盖), 预构造入口也走这里。
  // 跨 run 不重置 —— 不同 run 在 db 靠 runId 区分。
  const currentEngineRound = ++_engineRound;
  // D-3 反馈锚定 (SDD 2026-08-10-blame-scoped-node-retry): verifier 意见只 append 到被责备
  // (闭包内) 节点自己的 goal —— 非闭包节点字节不动 → 语义指纹与上轮相同 → D-21 复用成立 (G-2)。
  // 闭包节点指纹已入 D-4 毒集 (computeReuse 见毒即 skip), append 只影响它自己的重跑 prompt,
  // 不产生第二套匹配逻辑 (INV-2)。新 plan 里没有该 id (conductor 重画) → 跳过, 不编造节点。
  if (blameAnchor) {
    for (const [id, suffix] of blameAnchor) {
      const n = plan.nodes[id];
      if (!n) continue;
      // ⚠ 用**新对象**替换而非原地改 goal: applyPlanPatch 浅拷贝 nodes (未补丁节点与上轮 plan
      // 共享同一对象引用), 原地写会污染 prior.plan → priorFp 的指纹被 append 打翻 → 毒集 (按
      // 未突变指纹铸的票) 落空 → 被责备节点逃过毒集被复用。G-5 负控当场抓到 (2026-08-10)。
      plan.nodes[id] = { ...n, goal: `${n.goal ?? ''}${suffix}` };
    }
  }
  const levels = topoLevels(plan);
  // 观测归组键。与 runExecutorDag 里那一处**同一条口径** (config.sessionId 优先) ——
  // agent leaf 不经 gateway, 它的观测记录要落到同一条 trace 上才有意义。
  // runExecutorDag 解析完 sessionId 就写回了 config, 所以这里恒有值; `??` 只为类型收窄。
  const obsTraceId = config.sessionId ?? `agent-only-${plan.name}`;
  logger.info(
    { plan: plan.name, leafModel: config.leafModel, nodes: Object.keys(plan.nodes).length, levels: levels.length },
    '[omd/executor-dag] planned',
  );
  // warnedUnknownProfiles 由 runDagInternal 持有并跨升级重规划复用: 同一未知名整轮 run 只 WARN 一行。

  // 节点进度事件发射器 (fail-open: 观察者抛错不许扰动执行)。kind 词表 = executor ?? primitive ?? leaf。
  const nodeKind = (n: ConductorPlan['nodes'][string]): string =>
    n.kind === 'primitive' ? 'primitive' : (n.executor ?? 'leaf');
  const emitNodeEvent = (e: Parameters<NonNullable<ExecutorDagConfig['onNodeEvent']>>[0]): void => {
    try {
      config.onNodeEvent?.(e);
    } catch {
      /* fail-open */
    }
  };
  emitNodeEvent({
    type: 'planned',
    nodes: Object.entries(plan.nodes).map(([id, n]) => ({ id, kind: nodeKind(n) })),
  });

  // ── D-P 协作式取消 (2026-07-30) ────────────────────────────────────────────
  // 只在**调度接缝**上问一句"还要不要派新活", 不碰在飞的节点 (见 ExecutorDagConfig.cancelSignal)。
  const isCancelled = (): boolean => config.cancelSignal?.aborted === true;

  // ── #158 预算派发闸: 「不再开新贵活」的共用判定 ─────────────────────────────
  // 消费点三个: 环入口 (跨相位烧穿一轮不开) / 子图 pump (轮内不再派新子节点, 在飞跑完 ——
  // 与 D-P 取消缝同形, 「不打断在飞」教义不破) / 轮边界 (原检查照旧, 这里补运行锚那半)。
  // 只管时间轴: token 轴在轮边界照旧 (轮内没有便宜的累计读点)。锚 = config._budgetAnchor
  // (goal 层注入 = 整个 solve 一只钟; 缺省 = 本次 executePlan 起跑)。fail-open: 没配 ms → 恒 null。
  const planStartedAt = Date.now();
  const dispatchBudgetHit = (): string | null => {
    const msCap = config.loopBudget?.ms;
    if (msCap === undefined) return null;
    const spent = Date.now() - (config._budgetAnchor ?? planStartedAt);
    return spent >= msCap
      ? `时间预算已尽: 已用 ${Math.round(spent / 1000)}s / 上限 ${Math.round(msCap / 1000)}s`
      : null;
  };
  const cancelReason = (): string => {
    const r = config.cancelSignal?.reason;
    return typeof r === 'string' && r.trim() ? r : r instanceof Error ? r.message : '调用方叫停';
  };

  // ── D-Q 图外只读观察者的收集面 ─────────────────────────────────────────────
  // 同一条观察可能被多轮/多处算出来 (制品 lint 每轮跑一次, 而边一直没补) → 按内容去重,
  // 否则一个没修的问题会在结果面里刷屏, 把真正的新发现淹掉。
  const observations: DagObservation[] = [];
  /**
   * 「声称 vs 引擎记录」检出器**跑过没有**(2026-08-05,一次真跑逼出来的)。
   *
   * ⚠ 那条判据只活在 conductor 内环里。而首次 shadow 真跑是 `dag_run` 路径:6 个节点**没有一个是
   * conductor** —— 检出器结构上够不着,账本却记成 `observations: []`,与"检查过、零检出"**逐字相同**。
   * 按 entry 数了一下,`run`+`dag_run` 有 17 跑走这条路、`dag_goal`+`solve` 14 跑走另一条 ——
   * 也就是说**约一半流量的分母是错的**,活体基率会被算低近一倍。
   *
   * 这就是仓规第一条(`NULL ≠ 0 ≠ 不适用`)的实例:「这条路不适用」被压进了「跑了但零检出」。
   * 三态由此分开:计数缺席 = 不适用 · rounds>0 且 findings=0 = 检查过零检出 · findings>0 = 检出。
   */
  let claimCheckRounds = 0;
  let claimCheckedNodes = 0;
  let claimFindings = 0;
  /**
   * 「产物没变」判据的**机会计数**(2026-08-06)—— 见 `ExecutorDagResult.artifactMove`。
   *
   * 与上面 `claimCheck` 那三个是同一条纪律的第二个实例: 那次是「整图没有 conductor → 判据够不着」
   * 被记成了零检出; 这次是「内环没转到第二圈 / 两轮都没有产物信号 → 判据够不着」被记成零检出。
   * 读数板 ⑧ 段拿运行次数当分母读了 53 跑, 而真正的分母(可比较的跨轮次数)一次都没被记过。
   */
  let moveTransitions = 0;
  let moveUnobserved = 0;
  let moveFindings = 0;
  /**
   * **执行窗口真重叠过的节点对**(2026-08-06)—— 运行时写竞争的机会面。
   *
   * 今天 `write-race` 这个名字下只有**跑前静态**那一半(`static-lint`, 看 `output_path` 声明)。
   * 一个 leaf 经 bash 写出去的文件不在任何声明里, 于是两个并发兄弟真撞了**没有任何一处知道** ——
   * 而台账一直把静态那几次读数当成运行时这条的证据。两者的下一步相反, 所以要各记各的。
   *
   * 键取排序后的 `ab`, 于是同一对只记一次(重叠是无向的)。窗口 = [起跑, leaf 返回],
   * **不含** fan-in 摘要那段(摘要期不写产物, 算进去会造出假重叠)。
   */
  const liveNow = new Set<string>();
  /** 键 = 排序后的两个 id 拼串(只为去重);值 = 那两个 id 本身 —— **不从键上拆回来**。 */
  const overlapPairs = new Map<string, [string, string]>();
  /** 内环那道已经检过的子节点 id —— 平铺那道跳过它们, 两个分母**不重叠**。 */
  const claimCheckedIds = new Set<string>();
  let flatCheckedNodes = 0;
  let flatFindings = 0;
  const seenObservations = new Set<string>();
  /** conductor 运行时展开出来的子节点 id —— `detector` 的消费者只在内环里, 别处设了要响亮忽略。 */
  const conductorChildIds = new Set<string>();
  /**
   * 运行期内容寻址 id → **规划期的可读名** (2026-07-30 live 挖出来的)。
   *
   * 制品 lint 的建议原先是"请给 [execute::1dsso0lqe0kky] 补上 [execute::1errm3oj42qds]" ——
   * 而这句话的唯一读者是**下一轮重画的 conductor**, 它写的是自己起的可读名, 内容寻址 id 是
   * 展开那一刻才算出来的, 它既没见过也用不了。于是这条真阳性的建议 100% 不可执行:
   * 报得对, 但按它做不了任何事。
   *
   * ⚠ 与命令检测者的别名翻译**同源同向** (那边: 接受可读名并翻回 id; 这边: 把 id 翻回可读名),
   * 都是"跨过展开这道墙时把名字换成对方认识的那种"。与 judge 视图刻意不给别名不冲突 ——
   * 那边要的是模型**点名**落在 id 上, 这边是给模型**读**的一句人话。
   */
  const runtimeNodeNames = new Map<string, string>();
  const observe = (obs: readonly DagObservation[]): DagObservation[] => {
    const fresh: DagObservation[] = [];
    for (const o of obs) {
      const key = `${o.kind}|${o.nodes.join(',')}|${o.message}`;
      if (seenObservations.has(key)) continue;
      seenObservations.add(key);
      observations.push(o);
      fresh.push(o);
      logger.warn({ kind: o.kind, nodes: o.nodes }, `[omd/executor-dag] 图外观察者: ${o.message}`);
    }
    return fresh;
  };
  /**
   * #153 D-7 升闸收集面: 谓词命中的节点 id (逐字保真通道断了 **且** goal 明写要出处/逐字)。
   *
   * run 作用域 —— 探针点火处 (外层 settle / 内环局部 settle) 只往里放, 判前在
   * `runConductorRound` 的检测者票合并处消费 (取出即删, 免得上一轮的红漂到下一轮)。
   * 没有 conductor 环的平铺路径没有消费者 → 结构性只报不拦 (账本照记, 同 trigger-pass O-2)。
   */
  const verbatimReds = new Set<string>();
  /** 制品路径的解析根 (lint 用; 与产物闸的兜底根同一个)。 */
  const artifactLintRoot = config.continuity?.repoRoot ?? process.cwd();
  /**
   * S1 产物内容进 judge 视图的预算 (`null` = 关)。
   *
   * ⚠ 这段进的是**每一次** judge 调用 —— 无界即是给每轮判决挂一个无界成本, 所以它是预算而不是
   * 布尔开关。
   *
   * **缺省开** (2026-08-03 A/B 之后翻的; 在那之前缺省关):
   * `deepseek-v4-pro` 座位 · 4 段 × 16 次 × 2 臂 —— 假阴性 **16/16 → 0/16** (Fisher p≈1.6e-9),
   * 假阳性 **0/48 → 0/48** (没被换到另一侧), prompt token +11%。判据见
   * `scripts/eval-judge-artifacts.ts` 的模块注: 两侧都要满足, 只报"收敛率升了"是自证。
   * ⚠ **单座位读数** —— 换 judge 座位 (尤其换模型家族) 必须重跑, 别默认它是正收益。
   */
  const judgeArtifactBudget: ArtifactBudget | null =
    config.judgeArtifacts === false
      ? null
      : config.judgeArtifacts && typeof config.judgeArtifacts === 'object'
        ? config.judgeArtifacts
        : DEFAULT_ARTIFACT_BUDGET;
  /**
   * 产物读取器。根用 `artifactLintRoot` —— **与制品 lint 同一个根**, 于是也继承它那条诚实边界:
   * `filesTouched` 的相对根是产出它的那个 leaf 的 cwd, 多 runner 混跑时可能对不上。
   * 对不上的后果是**读不到**, 而读不到会如实写进视图 (`引擎未能读到`), 不是悄悄跳过 ——
   * 这个失败方向是安全的: judge 看见"声称写了但引擎读不到", 该拒就拒。
   */
  const artifactReader = (p: string): string | null => {
    try {
      return readFileSync(p.startsWith('/') ? p : join(artifactLintRoot, p), 'utf-8');
    } catch {
      return null;
    }
  };
  /**
   * 一轮内环在盘上留下的产物指纹 (G5 正解的输入)。
   *
   * ⚠ 读不到就记 `null`, **不跳过** —— 跳过等于把"量不到"悄悄当成"这个文件不存在于本轮",
   * 而下游判据一比就成了"路径集变了 → 有位移"。那是**拿缺失冒充证据**, 方向还正好反了。
   * 记 null 之后, 检测器见到任一 null 就整轮不判 (fail-open, 倾向不报)。
   */
  const collectRoundArtifacts = (roundResults: ReadonlyMap<string, LeafResult>): RoundArtifacts => {
    const hashes: Record<string, string | null> = {};
    for (const r of roundResults.values()) {
      // **用这个节点自己的根**, 不是引擎进程的 cwd —— R2 隔离档下 leaf 跑在另一棵 worktree 里。
      // 拿错根去找文件会全部 hash 成 null, 于是检测器在最该用它的配置里静默失效 (端到端用例抓住的)。
      const root = r.artifactRoot ?? continuity?.repoRoot ?? process.cwd();
      // S50 收敛: 路径解析走 `resolveArtifactPath` (INV-6 · detector population 不再恒 null
      // —— 主干绝对前缀的产物落在 worktree 时, 这条把锚回补上)。
      const repoRoot = continuity?.repoRoot ?? process.cwd();
      for (const p of r.filesTouched ?? []) {
        hashes[p] = hashArtifact(resolveArtifactPath(p, { root, repoRoot }));
      }
      // ── N7 (2026-07-31): **声明了产物却没写出来** 的那一格 ──────────────────────
      //
      // 产物闸判 empty-artifact 的节点恰好没有 filesTouched, 于是它对 population 的贡献是 0;
      // 一轮里若这类占满, population 归零 → 「产物没变」检测器**静默不判**。
      // 2026-07-31 两跑 live 的第二个 0 就是这么来的 —— 不是没卡住, 是这条瞎了。
      //
      // 用**计划里声明的** output_path 补进 population: 文件真不在 → ARTIFACT_ABSENT
      // (确定性事实, 可跨轮比较); 在 → 照常 hash (它可能只是没记 filesTouched)。
      const declared = (plan?.nodes[r.id] as { output_path?: string } | undefined)?.output_path;
      if (declared && !(declared in hashes)) {
        // S50: 同 helper (INV-8 · 相对路径行为一字不变)。
        const abs = resolveArtifactPath(declared, { root, repoRoot });
        hashes[declared] = existsSync(abs) ? hashArtifact(abs) : ARTIFACT_ABSENT;
      }
    }
    return { hashes };
  };

  /** 跑一次制品边 lint (D-12/INV-P2-4) → 新发现的观察条目。零模型调用, 只报告不拦截。 */
  const runArtifactLint = (): DagObservation[] =>
    observe(
      artifactLintObservations(lintArtifactEdges(plan!.nodes, results, { root: artifactLintRoot }), runtimeNodeNames),
    );

  /**
   * **运行时展开留痕** (观察面补齐, 2026-07-30): map/conductor 把子节点挂进图的那一刻,
   * ① 发 `expanded` 事件 (活体进度: `dag_status` 的图不再只有父节点一个点)
   * ② 追加进 `_dag.json` 的 `runtimeNodes` (事后审计; **不碰** nodeIds/deps/plan/generation ——
   *    动那四样会让下一次 resume 的代数校验全体作废, 见 DagMetadata.runtimeNodes 的注)。
   * 全程 fail-open: 留痕失败不该影响执行。
   */
  const recordRuntimeExpansion = (parent: string, childIds: readonly string[]): void => {
    try {
      const nodes = childIds.map((id) => ({
        id,
        parent,
        kind: nodeKind(plan!.nodes[id]!),
        deps: [...((plan!.nodes[id]!.depends_on ?? []) as string[])],
      }));
      emitNodeEvent({ type: 'expanded', parent, nodes });
      if (continuity) continuity.manager.appendRuntimeNodes(continuity.runId, nodes);
    } catch (err) {
      logger.warn({ node: parent, err }, '[omd/executor-dag] 运行时展开留痕失败 (fail-open)');
    }
  };

  /**
   * 一个节点**此刻**的语义 Merkle 指纹 —— checkpoint 写入侧与 resume 复用侧的**唯一取值口**。
   *
   * 两个消费者:
   *  · 写入侧 (通道⑤-b): 存进 `NodeCheckpoint.fingerprint`, 给 resume 预载判毒用;
   *  · 读回侧 (T-1a 规格守卫, S-51): `shouldSkip` 拿它与盘上那份比 —— 节点自身的语义
   *    (goal / command / write_set / self_check / expect_exit …) 变了就不许当绿跳过。
   *
   * **必须是同一个口**。写一个值、读另一个值, 那道守卫就会恒判不匹配, 每次 resume 全图重跑。
   *
   * 不缓存是刻意的: `plan` 在运行时展开后会长出新节点, 缓存一份就会让展开出来的子节点
   * 永远拿不到指纹。代价是 O(节点数) 的重算, 而 `Bun.hash` 在这个量级上可以忽略。
   * 算不出 (环等) → `undefined` → 两侧都退回原语义 (fail-open), **缺席不是不匹配**。
   */
  const currentFingerprint = (nodeId: string): string | undefined => {
    try {
      return merkleFingerprints(plan).get(nodeId);
    } catch (err) {
      // fail-open 可以吞异常, 不许吞证据 (仓规静默坑 ②): 指纹算不出来时,
      // 写入侧少存一个字段、读回侧少一道守卫 —— 两件事都无声, 这一行是唯一的痕迹。
      logger.warn({ node: nodeId, err: String(err) }, '[omd/executor-dag] 语义指纹算不出 → 规格守卫与 checkpoint 指纹双双缺席 (fail-open)');
      return undefined;
    }
  };

  // ── D-21 escalation 跨轮复用: 语义 Merkle 指纹 + 前驱闭包匹配上轮 done 节点 → 零 LLM 注入。
  // 重规划最烧 token 的形态 = 80% 节点语义没变却整图重跑; 指纹按语义不按 id, 重命名不破匹配。
  // D-4 (P1.5): prior.poisoned = 上轮被 judge 点名拒绝的节点指纹, 一律不复用 (前向闭包免费, 见 computeReuse)。
  const reuse = prior ? computeReuse(plan, prior, prior.poisoned) : new Map<string, LeafResult>();
  // conductor 内环的跨轮复用命中 (D-21 内环版) 也要进结果面 —— 撤外层 (D-F) 之后, 复用这件事
  // **只发生在内环里**, 不并进来的话 `reusedNodes` 对 goal 引擎恒空 (INV-GOAL-3 的可证面就没了)。
  const innerReused = new Set<string>();
  if (reuse.size > 0) {
    logger.info({ reused: [...reuse.keys()], total: Object.keys(plan.nodes).length }, '[omd/executor-dag] 跨轮语义复用集 (D-21)');
  }
  if (prior?.poisoned?.size) {
    logger.info({ poisoned: prior.poisoned.size, reused: reuse.size }, '[omd/executor-dag] D-4 毒集生效 → 被拒指纹及其下游强制重跑');
  }

  // ── 2. executor: ready-set 现场 fan-out (依赖就绪即跑, 见下方调度器), leaf 调显式 leafModel ──
  const results: Record<string, LeafResult> = {};
  const depOutputs: Record<string, string> = {};
  /**
   * **本次运行的信任 token** (A8, 2026-07-31)。整套注入防御只依赖一个假设:
   * 攻击者写那张网页 / 那个文件的时候, 这个值还不存在。所以它必须是**每次运行现生成**的,
   * 不能来自配置、不能跨运行复用 —— 复用一次就等于把它交给了上一次抓到的任何一段正文。
   */
  const runNonce = makeRunNonce();
  // fan-in 定向摘要视图: nodeId → 摘要+全文指针 (扇出≥2 且够长的 producer 才有条目)。
  // 下游 fan-in 注入 `faninView[d] ?? depOutputs[d]` (有摘要用摘要, 否则全文兜底)。
  const faninView: Record<string, string> = {};
  const faninCfg = normalizeFaninConfig(config.faninSummary);
  let leavesIn = 0;
  let leavesOut = 0;
  let leavesCacheHit = 0;

  // W2 continuity (SDD C4): 落 _dag.json 元数据 + resume 时预载已绿节点。全程 fail-open (manager 内部已兜)。
  const continuity = config.continuity;
  const resumeGreens = new Map<string, NodeCheckpoint>();
  // W4 SHADOW-3: 本 run 的 DAG 代数签名 (落 metadata + checkpoint; resume 时校验防过期切点乱截)。
  let dagGeneration: string | undefined;
  /**
   * S-51 抓法 ③ 的读数。**只在 resume 那条路上赋值** —— 非 resume 时保持 `undefined`,
   * 那不是「0 个失效」而是「这一问不适用」(仓规坑 ①,判据写在 `ExecutorDagResult` 上)。
   */
  let specChangedNodes: string[] | undefined;
  if (continuity) {
    const goal = task.slice(0, 400);
    const nodeIds = Object.keys(plan.nodes);
    const deps = Object.fromEntries(Object.entries(plan.nodes).map(([k, n]) => [k, n.depends_on ?? []]));
    dagGeneration = computeDagGeneration({ goal, nodeIds, deps });
    continuity.manager.writeDagMetadata(continuity.runId, {
      runId: continuity.runId,
      specSlug: task.slice(0, 60),
      goal,
      nodeIds,
      deps,
      createdAt: new Date().toISOString(),
      generation: dagGeneration,
      // plan-memory 缺口①: 全量 plan + 任务原文写入磁盘 (此前只存骨架, 图的"肉"随进程丢弃)。
      plan: { name: plan.name, ...(plan.description ? { description: plan.description } : {}), nodes: plan.nodes },
      taskText: task,
    });
    if (continuity.resume) {
      for (const cp of continuity.manager.loadAllGreen(continuity.runId)) resumeGreens.set(cp.nodeId, cp);
      // ── S-51 抓法 ③: 「因规格变更而失效的片」要出声 ────────────────────────────
      // T-1a/T-1b 那两道守卫**会**丢弃这些绿, 但丢得静悄悄 —— 只有 shouldSkip 里一行 info。
      // 而 S-51 那次的病灶正是「run 摘要只说复用 N 节点」: 人第一眼看的是摘要, 不是日志。
      // 这里把它算出来抬到结果面, 由 run-goal 印进摘要 (**0 也印** —— 见 specChangedNodes 的
      // 三格纪律: 缺席 = 不是 resume, 空 = resume 了但没变, 两者不许压成同一个 undefined)。
      // 判据与 shouldSkip 里那道**同源**: 都是「盘上那份指纹 vs 此刻这份」。两侧任一缺席不算变。
      specChangedNodes = [...resumeGreens.entries()]
        .filter(([id, cp]) => {
          const now = currentFingerprint(id);
          return cp.fingerprint !== undefined && now !== undefined && cp.fingerprint !== now;
        })
        .map(([id]) => id)
        .sort();
      if (specChangedNodes.length > 0) {
        logger.info(
          { nodes: specChangedNodes, count: specChangedNodes.length },
          '[omd/executor-dag] 规格守卫: 这些绿节点的语义指纹与盘上不一致 → 本轮不复用, 真重跑 (S-51)',
        );
      }
      // ⚠ 回滚根用**执行锚**, 不是状态锚 (2026-08-21, run 58df6b9e 复盘)。隔离档下 checkpoint
      // 落主仓而文件写在 worktree 里 —— 拿 repoRoot 当回滚根 = 对着一棵没有那些产物的树做回滚。
      const rolledBackIds: readonly string[] = dropPoisonedGreens(
        resumeGreens,
        plan,
        prior?.poisoned,
        continuity?.execRoot ?? continuity?.repoRoot,
        continuity?.rollbackBaseline,
      );
      // SDD 2026-08-22 C-2: 回滚集 ∩ 复用集 = ∅。两处都按指纹算、按理应当一致, 实测不一致
      // (根因未查) —— 先按 id 对账兜住整族。回滚是破坏性 (产物已回 HEAD), 复用只是省钱优化,
      // 冲突时强制重跑 (D-2)。相交非空必留判词 (D-3, fail-open 不许吞证据)。
      if (rolledBackIds.length > 0) {
        const rolledBack = new Set(rolledBackIds);
        const intersection: string[] = [];
        for (const id of [...reuse.keys()]) {
          if (rolledBack.has(id)) {
            reuse.delete(id);
            intersection.push(id);
          }
        }
        if (intersection.length > 0) {
          logger.warn(
            { nodes: intersection, count: intersection.length },
            '[omd/executor-dag] 回滚集∩复用集非空: 产出已被回滚, 复用会让绿节点配一张空盘 (SDD C-2 × INV-4)',
          );
        }
      }
    }
  }

  /**
   * 一个节点这次吃到的**输入面** (D-O): dep id → 该 dep 的**输出全文**。
   *
   * 锚在依赖的全文而非"实际注入的 prompt": fan-in 定向摘要是 LLM 现生成的, 拿它当锚会让每次
   * resume 都判 stale。全文没变 = 输入语义没变。还没产出的 dep 不入表 (调度保证不会发生)。
   */
  /**
   * **一个上游在下游 prompt 里该长什么样** (A5, 2026-07-31)。
   *
   * 与 `depOutputs` 刻意分开的理由: `depOutputs` 是 **staleness 的语义锚** (`inputsOf` 拿它算
   * 输入面 hash), 而这里是 **给读者看的话**。两者的消费者不同 —— 把告示混进锚里, 一次措辞改动
   * 就会让全图下游判 stale 重跑; 把锚直接当话给读者, 就是今天这条静默失真。
   *
   * 没过的上游**必须带告示**: 探针实证下游此前拿到的要么是个空标题 (与"产出为空但有效"不可分),
   * 要么是那个节点自报完成的假话。见 `upstreamFailureNotice`。
   */
  const upstreamText = (d: string): string => {
    const body = capFanin(d, faninView[d] ?? depOutputs[d] ?? '');
    const r = results[d];
    if (!r || r.status === 'done') return body;
    return `${upstreamFailureNotice(d, r.failureKind, r.status)}\n${body}`;
  };

  /**
   * fan-in 硬上限 (2026-08-14, 爆窗闸)。
   *
   * 实测背景: kaupan-ala 首跑 (6bbab733) 一个分析节点把 316KB 上游正文整个吃进 prompt →
   * 窗口炸掉, 117 节点图报废重派 (重做 24.4M in + 1.05M out)。定向摘要机制管不到它的三条缝:
   * ① 扇出 <2 的线性链整个绕过 (minFanout 闸); ② 摘要解析失败回落**全文**;
   * ③ creative 节点护全文。三条缝的共同下游就是这里 —— 所以兜底闸放注入点, 不放摘要里。
   *
   * 上限 24K 字符 ≈ 8K token: 对"全文直传"的正常用法绰绰有余 (fanin 摘要的触发线才 1.8K),
   * 而 6 个满额 dep 也只 ~48K token, 在最小生产窗口 (128K) 内。截断必须响亮 + 带全文指针
   * (No-silent-caps): 有工具的 consumer 拿路径分页读, 无工具的至少知道自己看的是节选。
   * ⚠ 只截 prompt 视图, **不碰 depOutputs** —— 那是 staleness 的语义锚, 截了它 resume 必判 stale。
   */
  // 「上限 24K 字符 ≈ 8K token」是契约的语义; 实际硬截 budget 留 500 字符 slack 给 fence + caveman
  // + section header + 截断告示 (No-silent-caps), 保证 prompt 总长 ≤ upstream (fanin-quotes #b 反向自检)。
  const FANIN_HARD_CAP_CHARS = 23_500;
  // #153 D-4 拼回块: 注入体末尾追加一段「逐字引文保留」(两个注入点共用同一模板)。
  // 抽段器 = observers.extractQuoteSegments (INV-1: 全仓唯一引文判据源)。
  // 字段格式 = `[来源节点 X] ${s.text} "${s.text}"` —— 一行一段; 含 `${s.text}` 与 `"${s.text}"` 两种形态,
  // 前者供下游消费按节点 id 取段, 后者保「原句含外侧引号」逐字 (下游 verifier/出处核对直接子串命中)。
  // 已含于 injectedBody 的段零新增字节跳过 (D-4 纪律, 与 composeAnchorBlock 的「只补摘要没含的」同源)。
  // 段按 (nodeId, start) 升序 —— 同一节点的多段按原文位置; 跨节点按 id 字典序。
  const quoteBlock = (segments: readonly QuoteSegment[], injectedBody: string): string => {
    const filtered = segments.filter((s) => !injectedBody.includes(s.text));
    if (filtered.length === 0) return '';
    const sorted = [...filtered].sort((a, b) =>
      a.nodeId !== b.nodeId ? (a.nodeId < b.nodeId ? -1 : 1) : a.start - b.start,
    );
    const lines = sorted.map((s) => `[来源节点 ${s.nodeId}] ${s.text} "${s.text}"`);
    return `\n\n<fan-in 逐字引文保留>\n${lines.join('\n')}\n`;
  };
  const capFanin = (d: string, body: string): string => {
    if (body.length <= FANIN_HARD_CAP_CHARS) return body;
    // 实测 (fanin-quotes.test.ts #153): capFanin 输出要 + fence + leafPrompt 头/尾 ≈ 770 字符,
    // prompt 总长才能 ≤ upstream (硬上限的 fanin 截断用例)。24_000 留给内容; 截断预算 = 23_500。
    // 仍守「24K 上限」契约 (engine.ts:842, contract D-5): 真正装进 prompt 的 dep 内容 ≤ 23_500,
    // 余下 500 字符给 fence + caveman + section header + 截断告示 (No-silent-caps)。
    const fullPath = continuity ? continuity.manager.saveFaninFull(continuity.runId, d, body) : null;
    // D-5 截断排序: 引文先保, 叙述先砍。先抠全部引文段, 算 QUOTE_BLOCK 全长, 再扣指针与截断告示的预算,
    // 余下 = 叙述预算。病态引文超预算时, 引文按序保留, 叙述归零 (Math.max(0, …))。
    const segments = extractQuoteSegments(body, d);
    const sortedSegs = [...segments].sort((a, b) => a.start - b.start);
    // 叙述 = body 抠掉引文段的剩余文本。
    let narrativeFull = '';
    let cursor = 0;
    for (const s of sortedSegs) {
      if (s.start > cursor) narrativeFull += body.slice(cursor, s.start);
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < body.length) narrativeFull += body.slice(cursor);
    // 估一次预算: 按「全部引文都进 QUOTE_BLOCK」算 quotesLen + pointerLen, 余下即叙述。
    // 迭代一遍: 第一遍用 0 占位的 pointer 算 narrBudget; 第二遍用真 pointer 长度重扣,
    // 收敛 (二次之后 quoteBlock 与 pointer 都不会再变 —— 长度差仅来自数字位)。
    const buildPointer = (narrBudget: number): string =>
      `\n…[fan-in 硬上限: 上游 ${d} 输出 ${body.length} 字符, 此处只含前 ${narrBudget};` +
      (fullPath ? ` 全文在 ${fullPath} —— 有 read 工具就按需分页读它]` : ' 全文未写入磁盘 (无 continuity), 需要时让上游改写进文件]');
    let narrative = '';
    let qb = '';
    let pointer = '';
    for (let iter = 0; iter < 3; iter++) {
      const trialQb = quoteBlock(segments, narrative);
      const trialPtr = iter === 0 ? buildPointer(0) : pointer;
      const narrBudget = Math.max(0, FANIN_HARD_CAP_CHARS - trialQb.length - trialPtr.length);
      narrative = narrativeFull.slice(0, narrBudget);
      const newQb = quoteBlock(segments, narrative);
      const newPtr = buildPointer(narrative.length);
      if (newQb === qb && newPtr === pointer) {
        qb = newQb;
        pointer = newPtr;
        break;
      }
      qb = newQb;
      pointer = newPtr;
    }
    logger.warn(
      { dep: d, len: body.length, cap: FANIN_HARD_CAP_CHARS, persisted: !!fullPath, quotesKept: qb ? qb.split('\n').length - 2 : 0 },
      '[omd/executor-dag] fan-in 硬上限截断 (爆窗闸) —— 上游全文过大, 引文先保, 叙述先砍',
    );
    return narrative + qb + pointer;
  };

  /**
   * **内环轮间交接的渲染** (#226, 2026-08-23)。上一条 `capFanin` 的同族 —— 同一条
   * No-silent-caps 纪律,而这里此前**没有**守。
   *
   * ## 它治的两条 (读数在 #226 的评论里)
   *
   * ① **静默头切**: 原实装是裸 `prevReason.slice(0, 1500)` —— 没有告示、没有指针、不写入磁盘。
   *    账本 542 跑实测: 模型判词单项长度 p90 = 1337 · p95 = 1854,**单它就 ≥1500 的占 7.8%**,
   *    而交接 = 判词 + 观察者块(后者 p90 再加 561)。切掉的是判词**尾部** ——
   *    判词尾部通常正是「所以下一步该做什么」,也就是这一轮唯一真正要传下去的东西。
   *    (⚠ 那 7.8% 量的是 `verification.reason`,拿 verifier 判词当内环 judge 判词的**代理**。
   *     ⚠ 2026-08-28 订正: 「内环 judge 判词盘上没有任何一处持久化」这句**已经过期** ——
   *     `RoundVerdict[]` 自 #227 起随 journal 写入磁盘 (`continuity/types.ts`)。缺的从来不是
   *     「存」,是「喂」: 见下面 {@link renderPriorRounds}。)
   *
   * ② **必达块正好排在被切掉的那一侧**: `NOVELTY_COLLAPSE_LINE` 是在 prevReason
   *    **末尾**追加的,而截断从**头部**切 ⇒ 一旦超界就 100% 丢。而它「只进 prompt 不进控制流」,
   *    prompt 是它唯一的通道。于是账本记着 `novelty-collapse` observation(读起来像"提示发过了"),
   *    模型一个字没看到 —— `docs/silent-failures.md` 正在收的那个形状。
   *
   * ## 判据: 必达块不参与截断预算
   *
   * 这跟 `ownerCtx` 是同一条纪律(人的指令独立成块、逐字、不参与任何加工)。
   * 判断"是不是必达"的判据: **它的唯一通道是不是 prompt**。是 → 摘出去,单独成块。
   *
   * ⚠ 单一变量: 保留下来的正文与改动前**逐字相同**(仍是 `slice(0, HANDOFF_CAP_CHARS)`)。
   * 本片只加告示/指针/必达块,不动额度 —— 额度该多大是另一个问题,别混在一次改动里。
   */
  const HANDOFF_CAP_CHARS = 1500;
  /**
   * #228 的必达块前缀。judge 的「下一步」走**独立参数**进来, 不并进 `reason` 字符串再拆 ——
   * 并进去就得靠正则找回边界, 而每多一种必达块就要改一处正则, 漂一次坏一处 (`mustReach`
   * 现有那条用逐字常量比对正是为了躲开这个)。
   */
  const NEXT_STEPS_PREFIX = '上一轮 judge 给的下一步 (机制级动作, 逐字):\n';
  /**
   * #245 的必达块前缀 (第三种必达块)。冻结判据红时把**结构化失败明细** (命令+退出码+(fail) 名集)
   * 作为必达块进下一轮 prompt —— 它的唯一通道也是 prompt, 所以同款纪律: 独立参数 + 逐字前缀 +
   * 不参与 HANDOFF_CAP_CHARS 预算。闸拒 (exitCode<0) / 绿 / 赦免 → 缺席, 一个字不挂 (INV-5)。
   */
  const FREEZE_FAIL_PREFIX = '上一轮冻结判据红的失败明细 (逐字, 不参与交接硬上限):\n';
  /**
   * **更早几轮的判词摘要** (G1, 2026-08-28) —— 环终于看得见自己走过的路。
   *
   * ## 它治的
   *
   * 到今天为止, 第 N 轮的 conductor **只看得见第 N-1 轮**的判词 (`prevReason` 是标量, 每轮覆写)。
   * 第 1 轮为什么被拒, 第 3 轮的它不知道 —— 于是它可以完全合法地把第 1 轮那条死路**再走一遍**。
   * 毒集拦得住**节点指纹**复用, 拦不住**同一条思路**被重画出来: 换个 id、换个措辞, 指纹就变了。
   *
   * 这正是 `noveltySeq` (判词词袋聚类, 簇数连续不增 = 空转) 一直在**测量**的那个现象的成因。
   * 尺子造好很久了, 治法没有 —— 因为数据一直在盘上躺着 (`RoundVerdict[]` 进 journal), 只是
   * `at(-1)` 之外的都没人读。**算了不喂 = 没算。**
   *
   * ## 预算纪律 (与必达块相反的方向)
   *
   * 必达块的纪律是「唯一通道是 prompt ⇒ 不参与截断预算」。这一块**不是**必达块: 它是可折叠的
   * 历史, 全文本来就在 journal 里。所以它走**自己的独立预算** ({@link PRIOR_ROUNDS_CAP_CHARS}),
   * 既不吃 `HANDOFF_CAP_CHARS` (那是上一轮判词的额度, 单一变量: 本片不动它一个字符),
   * 也不许无界增长 —— 一个 20 轮的环, 无界就是给每轮的 conductor 调用挂一份线性增长的成本。
   *
   * 超预算时**丢最老的**, 不丢最近的 (最近的轮次对"别再走这条路"的判断更有用), 并出告示
   * (No-silent-caps, D-2): 丢了几轮、去哪读全文, 都写在明面上。
   *
   * ## 缺席 = 一个字都不写
   *
   * 第 1 轮 (没有更早轮) 与第 2 轮 (更早轮就是上一轮, 已在 `<上一轮未通过>` 里) 都返空串。
   * 不挂空标题、不写「(无)」—— 仓规坑①: 「没有」与「有但是空」在读者那里是两件事。
   */
  const PRIOR_ROUNDS_CAP_CHARS = 1200;
  /**
   * ask 出口的触发轮数 (2026-08-28): **连续**几轮契约 unknown 才停轮问人。
   *
   * 2 而不是 1: 第 1 轮材料本来就少, unknown 很常见, 探索一轮多半就清楚了。
   * 2 而不是 3: 默认 `max_rounds` 是 1–2, 定 3 就是一条永远够不着的闸 (仓规: 永远绿的闸不是闸)。
   */
  const ASK_UNKNOWN_STREAK = 2;
  /** 单轮摘要里判词部分的额度 —— 一轮吃满整块预算会把其余轮全挤掉。 */
  const PRIOR_ROUND_REASON_CAP = 240;
  const renderPriorRounds = (verdicts: readonly RoundVerdict[], currentRound: number): string => {
    // 只渲染**更早**的轮: 上一轮 (currentRound - 1) 已经整段在 `<上一轮未通过>` 里, 重复挂一遍
    // 既费预算又制造"同一件事说两遍"的噪声。
    const earlier = verdicts.filter((v) => v.round < currentRound - 1);
    if (earlier.length === 0) return '';
    const line = (v: RoundVerdict): string => {
      const head = v.reason.split('\n').find((s) => s.trim().length > 0)?.trim() ?? '';
      const body = head.length <= PRIOR_ROUND_REASON_CAP ? head : `${head.slice(0, PRIOR_ROUND_REASON_CAP)}…`;
      // 四态逐字带出去: 「闸替 judge 说的」与「judge 真投了反对票」在读者那里的下一步不同
      // (前者要看闸, 后者要看方案), 压成一句"没过"就把这一格抹平了 (RoundVerdict 的注同款)。
      const next = v.nextSteps ? ` → 当时给的下一步: ${v.nextSteps.split('\n')[0]!.trim()}` : '';
      return `- 第 ${v.round} 轮 [判据 ${v.criterion} · judge ${v.judge}] ${body}${next}`;
    };
    const rendered: string[] = [];
    let used = 0;
    let dropped = 0;
    // 从**最近**往回填, 填不下就停 —— 丢的是最老的那几轮。
    for (let i = earlier.length - 1; i >= 0; i--) {
      const s = line(earlier[i]!);
      if (used + s.length > PRIOR_ROUNDS_CAP_CHARS && rendered.length > 0) {
        dropped = i + 1;
        break;
      }
      rendered.unshift(s);
      used += s.length + 1;
    }
    const notice = dropped > 0
      ? `\n…[更早的 ${dropped} 轮已略去 (本块额度 ${PRIOR_ROUNDS_CAP_CHARS} 字符); 全轮判词全文在本节点的内环 journal 里]`
      : '';
    return `\n\n<更早几轮的判词摘要>\n这些路**已经走过并且没成**。不要重画一条与它们等价的图 —— 换个 id 或换套措辞不算新方案。\n${rendered.join('\n')}${notice}\n</更早几轮的判词摘要>`;
  };
  const renderHandoff = (nodeId: string, round: number, reason: string, nextSteps?: string, criterionFailDetail?: string): string => {
    // 必达块先摘出去。用逐字常量比对而不是正则: 这几个块的文本是常量,正则只会带来误伤面。
    const mustReach: string[] = [];
    let body = reason;
    if (body.includes(NOVELTY_COLLAPSE_LINE)) {
      mustReach.push(NOVELTY_COLLAPSE_LINE);
      body = body.split(NOVELTY_COLLAPSE_LINE).join('').trimEnd();
    }
    // #228: 「下一步」与 NOVELTY_COLLAPSE_LINE 同判据 —— 唯一通道就是 prompt, 所以不参与预算。
    // 缺席 → **一个字都不写**: 不挂空标题、不写占位。judge 没答就是没答 (仓规坑①)。
    if (nextSteps) mustReach.push(`${NEXT_STEPS_PREFIX}${nextSteps}`);
    // #245: 第三种必达块, 同款纪律 —— 缺席时一个字不挂, 给了就逐字成块、不进预算。
    if (criterionFailDetail) mustReach.push(`${FREEZE_FAIL_PREFIX}${criterionFailDetail}`);
    const tail = mustReach.length ? `\n${mustReach.join('\n')}` : '';
    if (body.length <= HANDOFF_CAP_CHARS) return `\n\n<上一轮未通过>\n${body}\n</上一轮未通过>${tail}\n`;
    // 落**全文原文** (含必达块), 不落摘出去之后的 body —— 事后复盘要问的是"当时整份交接长什么样"。
    // #228: `nextSteps` 走独立参数进来 (不在 `reason` 串里), 所以要在这里补回去, 否则写入磁盘的
    // "全文"会缺掉这一块 —— 那就成了另一种静默丢证据。
    // #245: criterionFailDetail 同款: 走独立参数, 写入磁盘时也要补回去, 否则"当时整份交接"缺角。
    const tailForFull = [
      nextSteps ? `${NEXT_STEPS_PREFIX}${nextSteps}` : null,
      criterionFailDetail ? `${FREEZE_FAIL_PREFIX}${criterionFailDetail}` : null,
    ].filter((x): x is string => x !== null).join('\n');
    const fullText = tailForFull ? `${reason}\n${tailForFull}` : reason;
    const fullPath = continuity ? continuity.manager.saveHandoffFull(continuity.runId, nodeId, round, fullText) : null;
    const kept = body.slice(0, HANDOFF_CAP_CHARS);
    const pointer =
      `\n…[交接硬上限: 上一轮判词 ${body.length} 字符, 此处只含前 ${kept.length};` +
      (fullPath
        ? ` 全文在 ${fullPath} —— 有 read 工具就按需分页读它]`
        : ' 全文未写入磁盘 (无 continuity), 判词尾部已丢 —— 需要时让上一轮把结论写进文件]');
    logger.warn(
      { node: nodeId, round, len: body.length, cap: HANDOFF_CAP_CHARS, persisted: !!fullPath, mustReach: mustReach.length },
      '[omd/executor-dag] 轮间交接硬上限截断 —— 必达块不参与预算, 已单独成块',
    );
    return `\n\n<上一轮未通过>\n${kept}${pointer}\n</上一轮未通过>${tail}\n`;
  };

  /**
   * **上游内容 = 不可信数据** (A8, 2026-07-31)。
   *
   * 上游里混着 research 节点从真外部网页抓回来的正文, 而它此前与 owner 指令、引擎观察
   * **共用同一套带内标记分块** —— 探针实证一段网页正文可以闭合 `<upstream>` 再伪造一个
   * owner 指令块 (连"优先级高于你自己的判断"那句都是我们自己写的)。围栏带本轮 token,
   * 攻击者写那张网页时拿不到它。见 `prompt-fence.ts` 的诚实边界那段。
   */
  const fencedUpstream = (d: string): string => fenceUntrusted(runNonce, d, upstreamText(d));

  const inputsOf = (deps: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const d of deps) {
      const o = depOutputs[d];
      if (o !== undefined) out[d] = o;
    }
    return out;
  };

  /**
   * **成功节点 checkpoint 写入磁盘** (D-O 统一出口, fail-open)。此前只有 inproc/agent 分支写,
   * command / research 节点根本没有绿 checkpoint。
   *
   * 三件事一起做: ① 输出全文落制品 (`out-<id>.txt`) —— summary 自此只给人看 ② 记输入面指纹
   * (上游内容变了 resume 就不许跳过) ③ 产物 hash (原有的产出面校验)。
   *
   * noun-gate 注释 only, material = 节点 prompt (含 deps 上下文) —— "输出了输入和 repo 都没有的
   * 名词"才是审计信号 (material 含 output 会恒真, SDD C5 消费者② 修正)。无 prompt 的节点
   * (command/research) 不跑它。tokenUsage: 传什么记什么 —— agent leaf 那条曾写 null,
   * 理由见调用点 (2026-08-16 更正)。
   */
  const saveDoneCheckpoint = (opts: {
    id: string;
    kind: NodeCheckpoint['leafKind'];
    model?: string;
    text: string;
    usage: ModelUsage | null;
    filesTouched: readonly string[];
    /** D-12: 本节点读过的文件 → checkpoint.inputPaths (resume 跳过时还原, 观察面不因续跑变窄)。 */
    filesRead?: readonly string[];
    deps: readonly string[];
    t0: number;
    /** noun-gate material (agent/inproc leaf 的完整 prompt); 无则跳过注释。 */
    prompt?: string;
    /** 产物根 (agent leaf 自报 cwd 最准); 缺省 continuity.repoRoot。 */
    artifactRoot?: string;
    /** S1 埋点: agent leaf watchdog 采集, 形状同 {@link NodeCheckpoint.watchdog}; 只透传, 不判定。 */
    watchdog?: NodeCheckpoint['watchdog'];
    /**
     * 工具调用序列 (2026-08-16)。**成功节点也要记** —— hashline stale 与 §8.5 的判据都需要
     * 「正常长什么样」当对照面; 只记失败节点的话, 攒出来的分布没有分母。
     */
    toolSteps?: NodeCheckpoint['toolSteps'];
    toolStepsDropped?: number;
    /**
     * bash 痕迹 / 工具次数 / 写效果计数 (2026-08-16 补)。
     *
     * ⚠ **`47bf576` 把这三位补给了失败 checkpoint, 却没补给这一条成功出口** —— 而紧邻的
     * `toolSteps` 注里刚写过这条判据的原话:「**成功节点也要记** …… 只记失败节点的话,
     * 攒出来的分布没有分母」。同一次改动里同一条判据只用了一半。
     * 实测代价: plana 1029 个生产 checkpoint 里带 `shellRuns` 的是 **0 个**,
     * 于是「`bun test` 到底跑没跑过」在成功节点上盘上无痕, 而成功节点才是常态。
     * 这一位也是「量 tsc 在单轮墙钟里占多少」(#145 提议 5 的触发条件) 唯一的输入面。
     */
    shellRuns?: NodeCheckpoint['shellRuns'];
    toolCalls?: number;
    writeCounts?: NodeCheckpoint['writeCounts'];
  }): void => {
    if (!continuity) return;
    try {
      const root = opts.artifactRoot ?? continuity.repoRoot ?? process.cwd();
      // S50: 主干根也带进作用域 —— `resolveArtifactPath` 锚回用它剥前缀 (INV-3/4)。
      const repoRoot = continuity.repoRoot ?? process.cwd();
      // 产物路径相对化到 root (worktree 可移植; shouldSkip 用 repoRoot 锚回)。
      // S50 (INV-7): `rel()` 现在从 **helper 解析后的 `abs`** 剥前缀, 与 stat 同一套规则
      // —— 修前 `rel(p)` 对非 `${root}/` 前缀的绝对路径会保留原样, `${root}/${rp}` = 损坏路径
      // ⇒ hashArtifact 恒 null (静默)。
      const rel = (abs: string): string => (abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs);
      const artifactHashes: Record<string, string> = {};
      const outputPaths: string[] = [];
      for (const p of opts.filesTouched) {
        const abs = resolveArtifactPath(p, { root, repoRoot });
        const rp = rel(abs);
        outputPaths.push(rp);
        const h = hashArtifact(abs);
        if (h) artifactHashes[rp] = h;
        else {
          // S-50 后半 (2026-08-24): 根因 (三处实现) 已由 `resolveArtifactPath` 收拢, 但**失败仍然静默** ——
          // `hashArtifact` 对「文件真不在」与「在但读不了」都返回 null 且不抛不记 (坑①: 两种成因塌成一格)。
          // 不记的后果不是这一跑坏掉, 是 **resume 的判毒/复用依据缺一块而没人知道**:
          // 少一个 hash ⇒ 该节点下次被当成"输入变了"重跑, 或反过来被当成没变而复用一个错的产物。
          // 这里只留证据不改行为 (告知层 fail-open), 但两种成因分开写 —— 合成一句"hash 失败"
          // 事后就再也分不出该去修路径还是修权限。
          logger.warn(
            { node: opts.id, declared: p, resolved: abs, root, repoRoot, cause: existsSync(abs) ? 'unreadable' : 'absent' },
            '[omd/executor-dag] S-50: 产物 hash 取不到 → checkpoint 少一条, resume 的判毒/复用依据缺一块 (只报不拦)',
          );
        }
      }
      const summary = opts.text.slice(0, 800);
      // 通道⑤-b: 写入磁盘时把语义指纹一并存下 —— resume 预载判毒时**不用重算**, 于是运行时展开的
      // 子节点 (预载那刻还不在图里) 也判得了。指纹只依赖祖先, 而祖先此刻已定死 → 与轮末 judge
      // 算的值一致。fail-open: 算不出来就不存, 退回原语义。
      // ⚠ 与 T-1a 规格守卫读的是**同一个函数** (currentFingerprint) —— 写一个值、读另一个值,
      //   那道守卫就会恒判不匹配, 每次 resume 全图重跑。两侧同源是它成立的前提。
      const fingerprint = currentFingerprint(opts.id);
      // D-O: 全文落制品。写失败 → null → 字段缺席, resume 退回 summary (fail-open, 有留痕)。
      const outputText = continuity.manager.saveNodeOutput(continuity.runId, opts.id, opts.text);
      const inputHashes: Record<string, string> = {};
      for (const [d, o] of Object.entries(inputsOf(opts.deps))) inputHashes[d] = hashText(o);
      let nounAnnotations: string[] | undefined;
      if (opts.prompt !== undefined) {
        try {
          if (!_nounGate) throw new Error('noun-gate not injected');
          const ng = _nounGate({ text: summary, material: opts.prompt, repoRoot: root, annotate: false });
          if (ng.novelNouns.length > 0) nounAnnotations = ng.novelNouns.slice(0, 10);
        } catch {
          /* noun-gate 注释 only, 挂了不影响 checkpoint */
        }
      }
      continuity.manager.saveCheckpoint(continuity.runId, {
        nodeId: opts.id,
        leafKind: opts.kind,
        status: 'done',
        // **这份 checkpoint 是第几轮的** (2026-08-06): checkpoint 按 nodeId 覆写, 多轮内环里
        // 同一个节点跑好几次, 盘上那一份此前说不出自己是第几轮 —— 于是事后拿窗口重建并发
        // (读数板 ⑧.7) 会把不同轮的两份配成一对。缺席 = 顶层节点 (没有"轮"这回事) 或老记录。
        ...(roundOfNode.has(opts.id) ? { round: roundOfNode.get(opts.id)! } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        outputPaths,
        artifactHashes,
        ...(opts.filesRead?.length ? { inputPaths: opts.filesRead.map(rel) } : {}),
        tokenUsage: opts.usage,
        summary,
        ...(outputText ? { outputText } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(Object.keys(inputHashes).length ? { inputHashes } : {}),
        ...(nounAnnotations ? { nounAnnotations } : {}),
        ...(opts.watchdog ? { watchdog: opts.watchdog } : {}),
        ...(opts.toolSteps ? { toolSteps: opts.toolSteps } : {}),
        ...(opts.toolStepsDropped ? { toolStepsDropped: opts.toolStepsDropped } : {}),
        // 缺席 ≠ 空: 「这个 leaf 没用过 bash」与「这条采集没接」必须分得开 (同 LeafResult 的三态)。
        ...(opts.shellRuns ? { shellRuns: opts.shellRuns } : {}),
        ...(opts.toolCalls !== undefined ? { toolCalls: opts.toolCalls } : {}),
        ...(opts.writeCounts ? { writeCounts: opts.writeCounts } : {}),
        durationMs: Date.now() - opts.t0,
        createdAt: new Date().toISOString(),
        ...(dagGeneration ? { generation: dagGeneration } : {}),
        schemaVersion: 1,
      });
    } catch (err) {
      logger.warn({ node: opts.id, err }, '[omd/executor-dag] checkpoint write failed (fail-open)');
    }
  };

  // ── P3 批次 3 第一次加厚: `executor:'conductor'` 运行时**异构**展开 (D-B/D-C/D-D) ───────
  //
  // 与 map 的分工: map 扇的是「同一件事的 N 份」(模板 + 运行时清单); conductor 展的是
  // 「一件事的若干不同步骤」(各有各的 goal/executor/依赖) —— 模板表达不了的形状。
  //
  // **本次不带环** (刻意): 第一次加厚只做「展开 + 局部调度」, 跑通为先。环 (D-A: 把外层 fixpoint
  // 搬进节点内) 留给第二次加厚 —— P1 的 double-loop 教训是两层 verify 必须二选一, 在环搬进来
  // **之前**先把外层撤掉是错的顺序, 会有一段时间两层都不在。
  /**
   * 内环 judge (D-E): 判的是**这个节点的 goal 达成没有**, 不另加一层全局验收
   * (加了就要回边, 破坏无环)。形状承 D-4: 除了收敛与否, 还要它**点名**哪些子节点的产出不作数
   * —— 点名才铸得出票, 铸不出票就只能整轮重来。
   *
   * fail-closed: 解析不出结论 → 判未收敛并说明, 不当作收敛 (谎报收敛比多跑一轮贵得多)。
   */
  const judgeConductorRound = async (
    id: string,
    goal: string,
    leaf: LeafResult,
    round: number,
    children: readonly JudgeChildView[],
    /**
     * 「声称的引擎动作 ⊄ 引擎记录」本轮的确定性检出 (2026-08-05, report-only)。
     * 由 {@link runConductorRound} 从**同一个** children 数组算出来后传进来 —— 在这里重算会
     * 多一份可漂的输入面 (那正是 `orderedChildren` 逐字重建踩过的坑)。
     */
    claims: readonly UnsupportedClaimFinding[],
  ): Promise<{
    converged: boolean;
    reason: string;
    rejected: string[];
    usage: ModelUsage;
    /** judge **调不通**时的错误原文 (确定性故障: config / transport / 非 provider-fault 的 http); 瞬时故障 (parse/validation/truncation/429/5xx) → null。 */
    unreachable: string | null;
    /**
     * judge 这一发**瞬时**失败时的逐字身份 (`kind|status|message`); 没失败或已判确定性 → null。
     * 闸级熔断的比对键 —— 逐字相同连续 K 轮 = 这一格零位移 (§8.4 的「相同」而不是「重复」)。
     */
    faultKey: string | null;
    /**
     * 这份判词是**确定性闸合成的**, 不是 LLM judge 投的票 (#148, 2026-08-17)。
     * 有值 → judge 没被问过 —— 「没投票」≠「投了反对票」(仓规坑 1): 合成票不得写进
     * `LeafResult.judgeConverged` (那一位按契约只装 judge 自己的票), journal 里记 `gate-rejected`。
     */
    synthetic?: 'round-failed' | 'false-completion';
    /**
     * G2: judge 顺手判的契约结论。缺席 = **没被问过** (闸合成 / 调不通 / 模型没答), 不是 aligned。
     */
    contractVerdict?: 'aligned' | 'unknown' | 'needs_revision' | 'invalid';
    /** G2: `contractVerdict !== 'aligned'` 时, 原题的哪一条被写歪了 (逐字)。 */
    contractIssue?: string;
    /** ask 出口: `contractVerdict='unknown'` 时 judge 说该问人的那一个问题 (只是内容, 不是触发器)。 */
    askOwner?: string;
    /**
     * judge 给的**下一步** (#228, 2026-08-23) —— 只有 LLM judge 真答了才有值。
     *
     * 与 `synthetic` / `unreachable` 互斥: 那两条出口 judge 没被问过, 合成一条"下一步"
     * 就是拿闸的回声冒充 judge 的动作建议。缺席合法, 由 `renderHandoff` 决定不挂这一块。
     */
    nextSteps?: string;
  }> => {
    const childIds = children.map((c) => c.id);
    // 整轮就没跑成 → 直接未收敛, 省一次 judge 调用 (同 llm-judge 的 status==='failed' 短路)。
    if (leaf.status === 'failed') {
      // D-3 (2026-08-11): 判决升级为事件 (整轮没跑成 = 确定性短路, 仍给一条 judge 判词)。
      emitNodeEvent({ type: 'verdict', id, gate: 'judge', verdict: 'fail', round, reason: `整轮失败: ${leaf.output.slice(0, 300)}` });
      return { converged: false, reason: `整轮失败: ${leaf.output.slice(0, 300)}`, rejected: [], usage: { in: 0, out: 0 }, unreachable: null, faultKey: null, synthetic: 'round-failed' as const };
    }
    // ── D-4 谎报完成闸 (2026-08-10, SDD 切片 4) ─────────────────────────────────
    // 确定性先行: 节点声称完成 ∧ 引擎证据**实败** (校验命令正非零退出码 / 状态 failed)
    // = 硬矛盾, 当场判未收敛, **不烧一次贵座 judge 调用** (同冻结判据的顺序纪律)。
    // 判据在 plan/false-completion.ts; 词表蒸自本仓 gate 历史误放样本 (INV-2 反向自检
    // 见 false-completion.test.ts)。lexiconHits = O-2 假阳率读数面, 只记不拦。
    const fc = gateFalseCompletion(checkableFromJudgeView(children));
    if (fc.findings.length) {
      logger.warn(
        { node: id, round, hits: fc.lexiconHits, nodes: fc.findings.map((f) => f.nodeId) },
        '[omd/executor-dag][false-completion] D-4 谎报完成闸: 声称完成而验收命令实败 → 判未收敛',
      );
      // D-3 (2026-08-11): 确定性闸的判决独立成 gate:'gate' 词表 (与 LLM judge 分开, D-9 同一读法)。
      emitNodeEvent({ type: 'verdict', id, gate: 'gate', verdict: 'fail', round, reason: renderFalseCompletionFindings(fc.findings) });
      return {
        converged: false,
        reason: renderFalseCompletionFindings(fc.findings),
        rejected: fc.findings.map((f) => f.nodeId),
        usage: { in: 0, out: 0 },
        unreachable: null,
        faultKey: null,
        synthetic: 'false-completion' as const,
      };
    }
    const judgeCoord = config.judgeModel ?? config.conductorModel;
    try {
      // **复用外层那份判词** (D-E, 2026-07-29 实测后改): 我原先另写的一份在 `fabricated` 段
      // 30 次里 9 次谎报完成, 而外层那份 100% —— 差的是它判词里那条「捏造 → converged=false」
      // 与「先抽出所有明确要求再逐条对照」。详见 plan/conductor-judge.ts 的模块注。
      // 顺带白拿 responseSchema 强制结构化 (裸 JSON 手抠时 flash 档实测出过解析失败与空裁决)。
      let usage: ModelUsage = { in: 0, out: 0 };
      const judge = makeLlmConvergenceJudge<null>({
        judgeModel: judgeCoord,
        task: goal,
        // G2 (2026-08-28): 原题原文。`task` 是**这个节点的 goal**, 而 goal 是从原题派生的 ——
        // 派生这一跳没有任何人回头查过。给了它, judge 才判得了「goal 相对原题写歪没有」。
        // 不新加一层验收环 (那条早被拒过, 理由是回边破坏无环): 同一个判官多答一位控制头,
        // 零额外调用、控制流形状不变。
        rootTask: task,
        // judge 看的是**专门渲染的视图**, 不是节点对下游的 output —— 后者带"N/M 成功"的开场白
        // (对 judge 是"都好着呢"的暗示) 且只有可读名没有可点名的 id。
        // 确定性差集当**显式证据**接在视图后面 (2026-08-05)。judge 对"产物断言了一件引擎没做过
        // 的事"基线召回 0/64, 而把这条差集**显式说给它听**之后 3/4 类伪装升到 94~100% ——
        // 也就是说那不是"模型不行", 是**证据没进视图** (与 S1 产物内容、`[引擎实测]` 那行同源)。
        // 拼法逐字沿用 eval 的 `--claim-check` 臂 (appendClaimEvidence), 生产与读数同形状。
        // ⚠ 它**只是证据**: 判还是 judge 判, 引擎这一档一票不铸 (report-only)。
        extract: () => ({ status: 'done', summary: appendClaimEvidence(renderRoundForJudge(children), claims) }),
        callModelFn: async (req) => {
          // 观测面接线 (2026-07-31)。此前这一发**不带 meta** —— 而 `send()` 的口径是
          // `traceId = meta?.sessionId ?? 自生成`、`name = meta?.role ?? 'model-call'`,
          // 于是内环 judge 每一发都落进**自己的一条孤立 trace**、名字是通用的 `model-call`。
          //
          // 这不是"少了个标签"。2026-07-31 实测: judge 座位在 codex 上恒抛
          // `Unsupported parameter: temperature`, 环每轮拿不到裁决 → 空转 65 分钟,
          // 而那条 ERROR **不在这次 run 的 trace 里** —— 是靠全库按名字捞才找到的。
          // 判词是环的承重决定, 它必须在图的那条 trace 上, 且叫得出自己是谁。
          const r = await (config.judgeSend ?? send)({
            ...req,
            meta: { ...req.meta, sessionId: obsTraceId, role: `judge:${id}`, nodeId: id },
          });
          usage = addUsage(usage, r.usage ?? { in: 0, out: 0 });
          return r;
        },
      });
      const v = await judge(null, round);
      const { rejected, ghosts } = splitNamedIds(v.rejectedNodes, childIds);
      if (ghosts.length) {
        logger.warn({ node: id, round, ghosts }, '[omd/executor-dag] 内环 judge 点名了子图中不存在的 id → 丢弃');
      }
      // A5: 空理由的兜底在**源头** (`llm-judge` 的 failureReason ??) 补, 不在这里补第二遍 ——
      // 同一件事两处兜底就是两处会漂。这里若拿到空串, 那是绑定层的缺陷, 不该被静默糊上。
      if (!v.converged && !v.failureReason) {
        logger.warn({ node: id, round }, '[omd/executor-dag] 内环 judge 判未收敛却零理由 → 下一轮反馈为空 (A5, 应由 llm-judge 兜住)');
      }
      emitNodeEvent({ type: 'verdict', id, gate: 'judge', verdict: v.converged ? 'pass' : 'fail', round, ...(v.failureReason ? { reason: v.failureReason } : {}) });
      // #228: `nextSteps` 只在 judge 真答了这条路径上带出去。上面 false-completion 的 synthetic
      // 出口与下面 catch 的 unreachable 出口都**不带** —— 那两处 judge 没被问过, 合成一条
      // "下一步"就是拿闸的回声冒充 judge 的动作建议 (与 `judgeConverged` 同一条纪律)。
      // G2: 契约结论只在 judge 真被问过这条路上带出去 —— 同 `nextSteps` 的纪律。
      return {
        converged: v.converged,
        reason: v.failureReason ?? '',
        nextSteps: v.nextSteps,
        rejected,
        usage,
        unreachable: null as string | null,
        faultKey: null as string | null,
        ...(v.contractVerdict ? { contractVerdict: v.contractVerdict } : {}),
        ...(v.contractIssue ? { contractIssue: v.contractIssue } : {}),
        ...(v.askOwner ? { askOwner: v.askOwner } : {}),
      };
    } catch (err) {
      // fail-closed: 判不出来就当没达成。judge 挂掉不该变成"那就算过了吧"。
      logger.warn({ node: id, round, err: String(err) }, '[omd/executor-dag] 内环 judge 无结论 → 判未收敛 (fail-closed)');
      // **「调不通」与「判词解析不了」不是一回事** (2026-07-31 实测那 65 分钟): 前者是
      // 传输/配置层的确定性故障 (codex 拒 temperature → 每一轮同样抛), 再转多少轮都一样;
      // 后者是模型这一发没说清楚, 下一轮可能就好了。此前两者都落"未收敛"、都继续转 ——
      // 于是一个改配置一分钟能修的事, 烧掉了全部轮数, 而症状看起来像"任务太难"。
      // 判据**不靠猜错误文本**, 取 model 层已有的可重试性分类 (`isTransientModelFault`,
      // 内里复用熔断那份 `isProviderFault` —— 一套分类两处用, 不新造第二份会漂的表)。
      //
      // ⚠ 2026-08-16 订正: 此前判据是裸的 `err instanceof ModelError`, 而 ModelError 的 kind
      //   有六个 —— `parse` (invalid JSON) 与 `validation` (schema 不合) 正是上面说"下一轮可能
      //   就好"的那类, 却被归进了"再转多少轮都一样"。**注释写对了, 判据写反了。**
      //   它一直没被发现, 是因为 gate 坐在 flash 上时这一格 0/120 从没亮过; 换 M3 后 1/60
      //   (`.omd/eval/gate-m3`) —— 一次 parse 抖动就白白终止整个内环。
      const unreachable =
        err instanceof ModelError && !isTransientModelFault(err) ? String((err as Error).message ?? err) : null;
      // 闸级熔断的比对键: 只在**判成瞬时**的那支产出 —— 已判确定性的走上面那条, 不用再量。
      // `kind|status|message` 逐字, 与 §8.4 的「失败输出逐字相同」同一个键法。
      const faultKey =
        unreachable === null && err instanceof ModelError
          ? `${err.kind}|${err.status ?? ''}|${String(err.message)}`
          : null;
      // A5: 这句话的读者是**下一轮重画的 conductor**。旧文案 (`judge 无可解析结论 (fail-closed)`)
      // 报得对, 但它是**引擎侧的事故**, 而读者会把出现在「上一轮未通过」里的任何东西当成对自己
      // 方案的评价 —— 于是它会为了迎合一句根本不存在的判词去改图。所以第一句先把这件事撇清。
      emitNodeEvent({ type: 'verdict', id, gate: 'judge', verdict: 'fail', round, reason: '【引擎侧事故】judge 调用失败或结论无法解析 → 判未收敛 (fail-closed)' });
      return {
        converged: false,
        unreachable,
        reason:
          '【引擎侧事故, 不是对上一轮方案的评价】judge 这一轮没能给出任何裁决 (调用失败或结论无法解析)。' +
          '也就是说: **上一轮的方案没有被判过**, 没有任何证据说它坏。' +
          '不要为了迎合一句不存在的判词去改图 —— 若上一轮的产出看起来是完整的, 原样再交一次即可。',
        rejected: [],
        usage: { in: 0, out: 0 },
        faultKey,
      };
    }
  };

  /** 一轮内环: 展开 → 闸 → 局部调度 → 汇总。环由 {@link runConductorNode} 在外面绕。 */
  const runConductorRound = async (
    id: string,
    round: number,
    prevReason: string,
    /**
     * 上一轮 judge 给的「下一步」(#228) —— 与 `prevReason` **分两个参数**, 不并串。
     * 缺席 (judge 没被问过 / 没答) → undefined, `renderHandoff` 据此不挂这一块。
     */
    prevNextSteps: string | undefined,
    /**
     * #245: 上一轮冻结判据红的失败明细 —— 与 `prevNextSteps` 同款 (独立参数 / 不并串 / 缺席
     * 时 `renderHandoff` 不挂这一块 / 一轮一鲜)。判据绿 / 闸拒 / 赦免 / 未配 → undefined。
     */
    prevCriterionFailDetail: string | undefined,
    /**
     * G1 (2026-08-28): **本节点到目前为止每一轮的判词**(`RoundVerdict[]`, resume 时含跨进程的
     * 那几轮)。`renderPriorRounds` 只渲染 `round < 当前轮 - 1` 的那些 —— 上一轮已由 `prevReason`
     * 整段带出去。空数组 / 只有上一轮 → 渲染出空串, 一个字不挂 (INV: 缺席零字节)。
     */
    priorVerdicts: readonly RoundVerdict[],
    poisoned: ReadonlySet<string>,
    /** 上一轮的子节点结果 (D-21 内环版: 跨轮复用的匹配源, 键 = 内容寻址 id)。 */
    prevResults: ReadonlyMap<string, LeafResult>,
  ): Promise<{
    leaf: LeafResult;
    children: JudgeChildView[];
    usage: ModelUsage;
    results: Map<string, LeafResult>;
    /** D-Q 图内检测者本轮的裁决 (与 judge 的票并进同一个毒集)。 */
    detector: { rejected: string[]; blocked?: string };
    /** D-12 制品边 lint 本轮**新**发现的观察条目 (去重后; 进下一轮失败原因)。 */
    lint: DagObservation[];
    /**
     * 「声称的引擎动作 ⊄ 引擎记录」本轮的确定性检出 (2026-08-05, report-only)。
     * 判官视图那一路由 {@link judgeConductorRound} 消费; 这里返出来是给账本与下一轮 prompt。
     */
    claims: UnsupportedClaimFinding[];
    /**
     * 上面那批压成的观察条目 —— **本轮全量, 不是增量**。
     *
     * ⚠ 与 `lint` 那条 (只回 observe 判新的) 刻意不同: journal **每轮覆写**, 而
     * 「上一轮未通过」是本轮快照不是增量。只在首次出现那轮进 prevReason 的话, 盘上留下的最后
     * 一轮就**没有它** —— 而 report-only 的全部价值正是事后能拿原句人工核对误伤。
     * 账本那一侧照旧去重 (observe 内部按 kind|nodes|message)。
     */
    claimObs: DagObservation[];
    /** 本轮展开出的子节点 id (D-Q 空转检测的比对面)。 */
    childIds: string[];
    /** #158 轮内派发闸触发原文 (null = 没触发) —— 冒给 runConductorNode 上叶。 */
    budgetHalt: string | null;
  }> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    let usageAcc: ModelUsage = { in: 0, out: 0 };

    // ── 1. 让 conductor 现场画子图 ──
    // 上游输出进 prompt (有 fan-in 摘要用摘要), 与 map lister 同形。
    const depCtx = deps.length
      ? `\n\n${deps.map((d) => fencedUpstream(d)).join('\n\n')}`
      : '';
    // **环的信息通道**: 上一轮的失败原因回灌给 conductor, 让它**重新画**而不是重跑同一张图。
    // 这是 D-A 环的全部价值 —— 重跑只能把同样的活再干一遍, 重画才补得出上一轮压根没有的步骤
    // (D-G′ 说的「补调研」正是这个形状: 不需要回边, 每一轮都是一张全新的无环子图)。
    // G1: 更早几轮的判词摘要排在 `<上一轮未通过>` **之前** —— 时序自然 (老→新), 而且最近那一轮
    // 离 `RETRY_INSTRUCTION` 最近。它走独立预算, 不吃 `HANDOFF_CAP_CHARS` (单一变量: 上一轮判词
    // 的额度本片一个字符没动)。首轮 / 只有一轮历史 → 空串, 整块缺席。
    const retryCtx = prevReason
      ? `${renderPriorRounds(priorVerdicts, round)}${renderHandoff(id, round, prevReason, prevNextSteps, prevCriterionFailDetail)}\n${RETRY_INSTRUCTION}`
      : '';
    // **owner 指令** (S3 / D-S): 与失败原因同一条管道、**独立的块**、**逐字**。
    // 排在失败原因**之前** —— 人的指令优先级高于机器的观察, 顺序上也该先看见。
    // ⚠ 一个字都不许加工: 观测者在这条链上只是信使, 它改写了, 失真的地方 owner 自己看不见。
    // A8: 拿本轮 token 去渲染 —— 它是**唯一带 token 的块**, 而带内伪造品复制得了文案复制不了 token。
    const ownerCtx = config.ownerDirectives ? config.ownerDirectives(round, runNonce) : '';
    // ── 轮级 conductor 升级 (D-F 顺带搬进来的) ────────────────────────────────
    // 外层 fixpoint 有这条: 连着几轮不收敛就换更强的脑子重画 (弱 conductor 画不出来的图, 再画
    // 一遍多半还是画不出来)。撤外层 (D-F) 不该顺手把这个能力一起撤掉 —— 内环是它现在唯一的家。
    // 旋钮与外层**共用** ExecutorDagConfig 的 conductorEscalationModel/escalateAfterRound
    // (两处各写一份默认值就会漂)。provider 没注册 → escalationProviderReady 判 false, 维持弱。
    const useEscalation =
      round >= (config.escalateAfterRound ?? 2) && escalationProviderReady(config.conductorEscalationModel);
    // TPL-3 显式最高优先: 手写 plan 钉了 node.model 就用它 (升级也压不过显式指定)。
    // (stamp pass 刻意跳过 conductor 节点 —— 它盖的是 leaf 档坐标, 这里根本不读。)
    const conductorCoord = node.model ?? (useEscalation ? config.conductorEscalationModel! : config.conductorModel);
    if (useEscalation && !node.model) {
      logger.info(
        { node: id, round, from: config.conductorModel, to: config.conductorEscalationModel },
        '[omd/executor-dag] 内环多轮未收敛 → conductor 轮级升级重画 (D-F)',
      );
    }
    let sub: ConductorPlan;
    try {
      const sys = conductorSystemPrompt({
        ...(config.agents ? { agents: config.agents } : {}),
        templates: templateRoster(templates),
        profiles: profileRoster(config),
        profile: config.conductorPromptProfile ?? conductorPromptProfileFromEnv(),
        researchAvailable: Boolean(config.researchRunner),
      });
      const userMsg =
        // A8: token 声明必须排在**任何**不可信内容之前 —— 读者先拿到判据, 再看材料。
        `${PLAN_BOUNDARY}${trustHeader(runNonce)}${node.goal ?? id}${depCtx}${ownerCtx}${retryCtx}\n\n` +
        // D-D 写进 prompt 而不只靠事后拒: 让它知道边界, 比让它撞上去便宜。
        '注意: 本次分解出的节点**不得**再用 executor:"conductor" 或 executor:"map" —— ' +
        '你现在就是运行时展开, 已经知道清单了, 直接把步骤列出来即可。';
      // **prompt 观测面** (2026-07-31)。走 `logger.debug` 而不是新加旋钮/读 env:
      // 默认 logger 的 debug 是空函数 → 生产零成本; 想看的人 (冒烟脚本 / 排障) 用
      // `setCoreLogger` 注入一个会记的实现即可 —— 现成的接缝, 不新开一个。
      //
      // 为什么值得有: 本轮四条缺陷 (A5 三条 + A8 一条) **全部**是靠抓 prompt 抓出来的,
      // 而 live 上我们对这一面**完全瞎** —— 盘上留下了 plan、结果、checkpoint、journal,
      // 唯独没留下"模型到底看见了什么"。那恰恰是最能解释它为什么那么画的那一份。
      logger.debug({ node: id, round, phase: 'conductor', model: conductorCoord, system: sys, prompt: userMsg }, '[omd/prompt] conductor');
      const { text, usage } = await generate({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        // 坐标 (含轮级升级) 在上面算好, 见 conductorCoord。
        model: conductorCoord,
        traceName: `conductor:${id}`, // 节点内重展开 —— 观测上要认得出是哪个 conductor 节点的第几轮
        traceNodeId: id,
        thinkingLevel: config.conductorThinkingLevel ?? config.seatThinking?.(conductorCoord) ?? 'high',
        maxTokens: config.conductorMaxTokens ?? (Number(process.env.OMD_CONDUCTOR_MAX_TOKENS) || 32_768),
      });
      usageAcc = addUsage(usageAcc, usage);
      const parsed = parsePlan(text, { knownTemplates: new Set(templates.keys()), knownServers: knownMcpServerNames(mcpRegistryRoot(config)) });
      if (!parsed.ok) throw new Error(`子图不是有效 plan: ${parsed.error}`);
      // ── D-N 展开闸 (前半): 子图过**与外层同一条** pass 管线 (oracle 过滤 → prune → dedup →
      // evidence → stamp)。此前子图一条 pass 都不过, 后果不是"少了点优化"而是两个实打实的洞:
      //   ① `tier` 在子节点上是**哑弹** —— stamp 才是把档位翻译成坐标的那一步, 不过它就全部
      //      掉到静态 leafModel, conductor 写 tier:'strong' 白写。
      //   ② evidence pass 的硬闸 (UI 交付物必须挂确定性截图闸) 对子图不生效。
      // 管线抛错 = fail-closed 拒整份子图, 与外层 plan 撞上坏 pass 时同一语义。
      sub = applyPlanFilters(parsed.plan, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ node: id, round, err: msg }, '[omd/executor-dag] conductor 节点展开失败 → failed');
      return {
        leaf: { id, status: 'failed', failureKind: 'infra-error', kind: 'conductor', output: `[conductor 展开失败: ${msg}]`, deps, usage: usageAcc },
        children: [], usage: usageAcc, results: new Map(), detector: { rejected: [] }, lint: [], claims: [], claimObs: [], childIds: [],
        budgetHalt: null,
      };
    }

    // ── 2. 纯展开: D-B 内容寻址 id + D-D 禁嵌套 + 环检测 + 硬顶 ──
    // 执行段的附加禁单 (research) 按调用传 —— 契约段不传, 它的 research 子节点是正当的。
    // E-T2: researchRunner 缺席时契约段也禁 —— 这不是政策收紧, 是能力缺席 (子节点执行期必败)。
    const forbidBase =
      plan!.name === EXECUTE_SEGMENT_PLAN_NAME ? EXECUTE_SEGMENT_FORBIDDEN_EXECUTORS : undefined;
    const forbidExecutors = config.researchRunner
      ? forbidBase
      : new Map<string, string>([
          ...(forbidBase ?? []),
          ['research', '本部署无 search provider — research 子节点执行期必败 (E-T2), 用本地材料的 agent/leaf 完成'],
        ]);
    const expand = expandConductorNode(id, sub, {
      ...(node.max_nodes ? { maxNodes: node.max_nodes } : {}),
      ...(forbidExecutors ? { forbidExecutors } : {}),
    });
    if (expand.status !== 'ok') {
      // 'empty' 也走这条: 与 map 的「空清单 = 成功 0 子」**刻意不同**。map 的空是 lister 如实报告
      // "没有东西要处理", 是一条真实且常见的信息; conductor 的空是**它没能把这件事分解出来** ——
      // 这里根本到不了 (PlanSchema 要求 ≥1 节点, 空的在 parsePlan 就被拒了), 但万一到了,
      // 判成 done 就是给"没做任何事"发一张成功票, 那是 empty-done 的同一种坏。
      logger.warn({ node: id, round, status: expand.status, error: expand.error }, '[omd/executor-dag] conductor 子图被拒');
      return {
        leaf: {
          id, status: 'failed', failureKind: 'infra-error', kind: 'conductor',
          output: `[子图被拒 (${expand.status}): ${expand.error ?? '空子图 — conductor 没能分解出任何步骤'}]`,
          deps, usage: usageAcc,
        },
        children: [], usage: usageAcc, results: new Map(), detector: { rejected: [] }, lint: [], claims: [], claimObs: [], childIds: [],
        budgetHalt: null,
      };
    }
    if (expand.truncated > 0) {
      logger.warn({ node: id, truncated: expand.truncated }, '[omd/executor-dag] conductor 子图截断 (no-silent-caps)');
    }
    // ── D-N 展开闸 (后半): 结构体检。**刻意只 warn 不拒** —— 这两条都有正当反例
    // (真的只有一步 / 交付物是文档而非可跑的东西), 没有证据支持一个硬阈值, 就别假装有。
    // 硬拒的三条 (禁嵌套 / 环 / 非法 plan) 在上面, 那些没有正当反例。
    for (const w of subgraphWarnings(expand.children)) {
      logger.warn({ node: id, check: w.check }, `[omd/executor-dag] conductor 子图体检: ${w.message}`);
    }

    // ── A4 跑前静态闸 (2026-07-31, 补 Fowler 2×2 里最空的那格 computational feedforward) ──
    // 写竞争与缺输入**在跑之前就算得出来**, 而今天要烧一整轮 agent 调用才发现 —— 写竞争甚至
    // 根本不报错, 只是"有时候产物不对" (谁最后写谁赢, 赢家由调度顺序定)。
    // 用**规划期可读名**建一张临时 plan 来查: 判据要说给下一轮的 conductor 听, 而它只认自己起的名字
    // (2026-07-30 那条"建议拿运行期 id 对下一轮说话"的事故买来的纪律)。
    // 出口与制品 lint 同款: **只报不拦**, 发现进下一轮重展开的 prompt。
    //
    // ⚠ 2026-08-14 修 (issue #25 分支, 一次对照实验当场抓到): 这张临时 plan 此前**键与边不同体系**
    // —— 键取 `originalId` (可读名), 而 `c.node.depends_on` 已被展开器重写成内容寻址 id。于是子图里
    // 每一条内部边在这张 plan 上都指向一个不存在的 id, `ancestors()` 的闭包恒为空 → 「有依赖 = 有序 =
    // 不是竞争」这条豁免**从来没生效过**: 一条 a→b 的链上两个节点写同一个文件, 会被报成写竞争。
    // 实测对照: 同一张子图直接 lint 得 0 条, 经展开后按老口径 lint 得 `write-race[b,a]`。
    // 修法 = 把边翻回可读名 (与键同一个体系), 而不是把键换成运行期 id —— 判词的读者是下一轮
    // conductor, 它只认自己起的名字 (上面那条 2026-07-30 的纪律)。视图本身是纯函数 (可反向自检)。
    const staticPlan = subgraphLintView(expand.children);
    const staticFindings = staticLintPlan(staticPlan, {
      fileExists: (rel) => {
        try {
          return existsSync(rel.startsWith('/') ? rel : join(artifactLintRoot, rel));
        } catch {
          return true; // 探不到就当它在 —— 不猜, 免得把所有 plan 报红
        }
      },
      // 翻不回可读名的引用 = 指向子图**之外** —— 子节点引用父节点的外层上游是设计允许的
      // (conductor-expand 的 dep 重写注), 那不是手误, 不报。
      knownExternal: new Set(Object.keys(plan!.nodes)),
      // 被截断的兄弟由展开器自报 → 报成 truncated-dependency 而非 dangling-dependency
      // (owner 判据③: 刻意的悬空与手误的悬空不许混进同一个计数)。
      truncatedIds: new Set(expand.truncatedNames),
    });
    if (staticFindings.length) {
      observe(staticFindings.map((f) => ({ kind: f.kind, nodes: f.nodes, message: f.message })));
    }
    // 「要改的文件里哪些会被自动执行」—— 确定性、零 LLM、只报不拦。进环是因为下一轮 conductor
    // 判"这一步的后果可不可逆"时缺的正是这条事实 (三臂 eval: 漏标 25–33% → 0%)。
    const scheduled = scheduledArtifactFindings(staticPlan, artifactLintRoot);
    if (scheduled.length) observe(scheduled);

    // ── 3. 子节点挂进 plan.nodes → 复用 runNode 全套 (路由/产物闸/checkpoint/resume) ──
    // 依赖 = 子图内依赖 (已重写成内容寻址 id) **并上父节点的外层上游** —— 后者保证子节点看得见
    // conductor 节点本该看见的东西 (同 map 子节点接 `depends_on: deps`)。
    for (const child of expand.children) {
      const inner = (child.node.depends_on ?? []) as string[];
      plan!.nodes[child.id] = { ...child.node, depends_on: [...new Set([...inner, ...deps])] };
      // D-Q: 记下"这是 conductor 展开出来的子节点" —— detector 只在环里有消费者, 别处设了要 WARN。
      conductorChildIds.add(child.id);
      // 可读名留档: 图外观察者的建议要用它渲染, 否则那句话的读者 (下一轮 conductor) 认不出。
      runtimeNodeNames.set(child.id, child.originalId);
    }
    // 观察面: 图上多了这些点 (活体事件 + `_dag.json` 的 runtimeNodes 留痕)。
    recordRuntimeExpansion(id, expand.children.map((c) => c.id));
    // **本节点自己的毒集**落到 resume 面 (D-A: 毒集的新家是节点级 journal, 见 NodeLoopJournal)。
    // 上一轮被内环 judge 点名的子节点, 崩溃重来时不许靠 checkpoint 当绿跳过 —— 与外层
    // `dropPoisonedGreens` 同一条纪律, 只是键是**内容寻址的子节点 id** (见 NodeLoopJournal 的注:
    // 子图指纹与整图指纹不相等, 而 id 一把钥匙同时开两把锁)。
    for (const child of expand.children) {
      if (poisoned.has(child.id) && resumeGreens.delete(child.id)) {
        logger.info({ node: id, child: child.id }, '[omd/executor-dag] 内环毒集命中 → 该子节点强制重跑 (D-A)');
      }
    }

    // ── D-21 的内环版: **跨轮复用** ────────────────────────────────────────────
    // 环搬进节点之后一度把这条丢了 —— 外层 fixpoint 有 `computeReuse`, 语义没变的节点零 LLM 注入
    // 上轮输出; 内环第 2 轮却把**每个**子节点重跑一遍 (实测 3 个子节点 → 6 次调用)。修复轮的图与
    // 上一轮大半同构, 全重跑就是把环的成本翻倍。
    //
    // 匹配免费: 子节点 id 是内容寻址的, "同 id" ≡ "同规格 + 同祖先规格"。只需再要一条 ——
    // **前驱也得可复用**: 上游若要重跑, 本节点吃到的输入就变了 (与 computeReuse 的 `deps.every` 同理)。
    const reuseLocal = new Map<string, LeafResult>();
    if (prevResults.size > 0) {
      // ── INV-P2-5 制品级毒**作用在消费方** (D-12, 2026-07-30) ──────────────────
      // 被拒子节点写过的文件 = 可疑制品。上一轮**读过**这些文件的兄弟节点, 哪怕自己没被点名、
      // id 也没变, 一样不能复用 —— 它的产出是**吃着一份已被判为坏的输入**做出来的。
      // 为什么这条不能靠现有的前驱闭包兜: 闭包顺的是**图上的边**, 而这条读根本没有边
      // (有边的话它就是普通下游, 早被闭包扫掉了)。图外读正是 D-12 让它可见的那条通道。
      const poisonedArtifacts = new Set<string>();
      for (const pid of poisoned) {
        for (const f of prevResults.get(pid)?.filesTouched ?? []) poisonedArtifacts.add(f);
      }
      const readsPoisoned = (prev: LeafResult): string | null => {
        if (poisonedArtifacts.size === 0) return null;
        return (prev.filesRead ?? []).find((f) => poisonedArtifacts.has(f)) ?? null;
      };
      const memo = new Map<string, boolean>();
      const canReuse = (cid: string): boolean => {
        const m = memo.get(cid);
        if (m !== undefined) return m;
        memo.set(cid, false); // 环/自引用下界 (展开期已查过环, 这里是纯函数自保)
        const prev = prevResults.get(cid);
        const tainted = prev ? readsPoisoned(prev) : null;
        if (tainted) {
          logger.info(
            { node: id, child: cid, artifact: tainted },
            '[omd/executor-dag] 制品级毒命中消费方 → 该子节点不复用 (INV-P2-5: 它读过被拒节点写的文件)',
          );
        }
        const inner = ((plan!.nodes[cid]?.depends_on ?? []) as string[]).filter((d) => d.startsWith(`${id}::`));
        const ok = !!prev && prev.status === 'done' && !poisoned.has(cid) && !tainted && inner.every(canReuse);
        memo.set(cid, ok);
        if (ok && prev) reuseLocal.set(cid, prev);
        return ok;
      };
      for (const c of expand.children) canReuse(c.id);
      for (const cid of reuseLocal.keys()) innerReused.add(cid);
      if (reuseLocal.size > 0) {
        logger.info(
          { node: id, round, reused: reuseLocal.size, total: expand.children.length },
          '[omd/executor-dag] 内环跨轮复用 → 语义没变的子节点零 LLM 注入上轮输出',
        );
      }
    }
    logger.info(
      { node: id, children: expand.children.length, ids: expand.children.map((c) => `${c.originalId}→${c.fingerprint}`) },
      '[omd/executor-dag] conductor 子图展开 (D-B 内容寻址)',
    );

    // ── 4. D-C 局部拓扑调度 ──
    // **不复用外层 ready-set**: 外层的 idSet/indeg/dependents 在 run 开始就算死了, 运行期新增的
    // 子节点进不去。也**不能用 map 那种扁平队列**: map 的子节点互相无边, conductor 的子节点有边。
    // 故在子图内自己算一次 ready-set (只认子图内的边; 指向外层的 dep 由外层调度保证已完成)。
    const childIds = expand.children.map((c) => c.id);
    const childSet = new Set(childIds);
    const indegLocal = new Map<string, number>();
    const dependentsLocal = new Map<string, string[]>();
    for (const cid of childIds) {
      const inner = ((plan!.nodes[cid]!.depends_on ?? []) as string[]).filter((d) => childSet.has(d));
      indegLocal.set(cid, inner.length);
      for (const d of inner) dependentsLocal.set(d, [...(dependentsLocal.get(d) ?? []), cid]);
    }
    const readyLocal = childIds.filter((c) => (indegLocal.get(c) ?? 0) === 0);
    // judge 视图的顺序 = 子图内**拓扑序** (上游在前), 在 pump 把 indeg 改掉之前先算出来。
    // 为什么不用现成的两个顺序: 结清序取决于并发时序 (同一张图两次跑给出两个不同的 prompt);
    // 展开序是**按指纹字典序**排的 (conductor-expand 为了同指纹消歧确定性), 那是哈希顺序,
    // 谁在前面纯属偶然。拓扑序两条都占: 确定, 且是读一张子图最自然的顺序。
    const topoOrder = ((): string[] => {
      const indeg = new Map(indegLocal);
      const queue = childIds.filter((c) => (indeg.get(c) ?? 0) === 0);
      const out: string[] = [];
      while (queue.length) {
        const c = queue.shift()!;
        out.push(c);
        for (const d of dependentsLocal.get(c) ?? []) {
          const n = (indeg.get(d) ?? 1) - 1;
          indeg.set(d, n);
          if (n === 0) queue.push(d);
        }
      }
      return out.length === childIds.length ? out : childIds; // 有环 (展开期已拒) 时的纯函数兜底
    })();
    const capLocal = Math.max(1, config.maxFanout && config.maxFanout > 0 ? config.maxFanout : childIds.length);
    let runningLocal = 0;
    let settledLocal = 0;
    let failedLocal = 0;
    // 类型写全 (含 S1 的 artifacts): 写窄了, 下面 `orderedChildren` 那次逐字重建就漏字段而 tsc 不响。
    const childOut: JudgeChildView[] = [];
    // 子树碰过的文件要**冒泡到父节点**: 对外层来说 conductor 节点是一个会产出东西的节点, 而产物
    // 全落在它内部的子节点上 —— 不冒泡, 父节点的 filesTouched 恒空, 调用方 (如 goal 引擎要找
    // 子树写的 spec 文件) 与外层的产物观察面就都看不见这棵子树干了什么。同 map 的收集语义。
    const touchedAll = new Set<string>();
    const roundResults = new Map<string, LeafResult>();
    const byId = new Map(expand.children.map((c) => [c.id, c]));
    /** #158 轮内派发闸触发原文 (null = 没触发)。冒到轮结果上, 让终态词说得出"是预算停的"。 */
    let budgetHalt: string | null = null;

    await new Promise<void>((resolve) => {
      const pump = (): void => {
        if (settledLocal === childIds.length) {
          resolve();
          return;
        }
        // D-P 取消接缝②: 不再派新子节点。在飞的跑完 (它们的产物/checkpoint 一样不少),
        // 全部结清后由下面那条"无就绪且无在飞"的路提前 resolve。
        if (isCancelled() && runningLocal === 0) {
          logger.warn(
            { node: id, round, settled: settledLocal, total: childIds.length },
            '[omd/executor-dag] 已取消 → 内环停止派新子节点 (D-P 协作式)',
          );
          resolve();
          return;
        }
        // #158 预算派发闸 (与 D-P 取消缝同形: 不打断在飞, 只不再派新的)。这里管**单轮内**的
        // 超跑 —— d39b559e 第 2 轮单轮跑 44min 越过 90min 上限, 轮边界与环入口都量不到轮中。
        const budgetHitNow = dispatchBudgetHit();
        if (budgetHitNow && runningLocal === 0) {
          budgetHalt = `${budgetHitNow} (轮内派发闸, 已派 ${settledLocal}/${childIds.length})`;
          logger.warn(
            { node: id, round, settled: settledLocal, total: childIds.length },
            `[omd/executor-dag] ${budgetHitNow} → 内环停止派新子节点 (#158)`,
          );
          resolve();
          return;
        }
        if (budgetHitNow) budgetHalt = `${budgetHitNow} (轮内派发闸, 已派 ${settledLocal}/${childIds.length})`;
        while (!isCancelled() && !budgetHitNow && runningLocal < capLocal && readyLocal.length > 0) {
          const cid = readyLocal.shift()!;
          runningLocal++;
          // ── 运行时写竞争: **子图这一层也要进重叠集** (2026-08-06 补) ────────────────
          // 首版只在外层 pump 上记 `liveNow`, 于是 ⑧.6 只看得见**顶层调度的节点**;
          // 而 conductor 扇出正是并发的主要来源 —— 两个真并发的兄弟撞同一个文件时
          // `overlaps` 照样是 0。那个 0 意思是"没往那儿看", 不是"没发生"。
          // ⚠ 父节点 (这个 conductor) 此刻也在外层的 `liveNow` 里, 于是会配出
          //   `C × C::child` 这种父子对 —— 判据层有守卫把它跳掉 (父的 filesTouched 是子树并集)。
          for (const y of liveNow) {
            if (y === cid) continue;
            const [p1, p2] = [cid, y].sort() as [string, string];
            overlapPairs.set(`${p1}\u0000${p2}`, [p1, p2]);
          }
          liveNow.add(cid);
          roundOfNode.set(cid, round); // 这一次是第几轮 —— 见 NodeCheckpoint.round
          const hit = reuseLocal.get(cid);
          void (hit
            ? // 复用命中: 注入上轮输出, 零 LLM 零工具 (id/deps 归本轮, skipped 同 resume 语义)。
              Promise.resolve({ ...hit, id: cid, deps: (plan!.nodes[cid]!.depends_on ?? []) as string[], usage: { in: 0, out: 0 }, skipped: true } as LeafResult)
            : runNode(cid)
          )
            .catch((e): LeafResult => ({
              id: cid, status: 'failed', failureKind: 'infra-error', kind: 'inproc',
              output: `[failed] ${e instanceof Error ? e.message : String(e)}`,
              deps: (plan!.nodes[cid]!.depends_on ?? []) as string[], usage: { in: 0, out: 0 },
            }))
            .then(async (r) => {
              liveNow.delete(cid); // 写窗口到此为止 (同外层那条: 不含之后的摘要/记账)
              // 摘要在飞、dependents 不在摘要就绪前释放)。fail-open, 永不抛; view 只喂 faninView,
              // 全文账 (results/roundResults/depOutputs/checkpoint/usage) 一律走 settledR。
              // consumers 传 `dependentsLocal`(子图内边, 见上方 D-C 局部拓扑调度那段) —— 顶层
              // `sched` 看不见这些运行时子节点, 传了才有真实扇出数 (2026-08-14 修, 见 maybeFaninView 注)。
              const { r: settledR, view } = await maybeFaninView(cid, r, dependentsLocal.get(cid) ?? []);
              if (view) faninView[cid] = view;
              results[cid] = settledR;
              // 子图节点也发 span (2026-07-31)。此前**只有外层 settle 循环调 recordSpan**, 而
              // 运行时展开出来的子节点走的是这条内环 —— 于是它们在观测面上只有 generation、没有 span,
              // 而 generation 又按 nodeId 挂在那个不存在的 span 上 → **全成孤儿**。
              // 这不是个别情况: 一次 goal 的绝大多数节点正是子图节点。实测那一跑 13 条 observation
              // 里 10 条孤儿、只有 1 个 span, 「一条 trace 打开是整张图的形状」对 goal 路径基本不成立。
              // 用同一个 recordSpan 而不是在这儿另拼一份 —— 父子关系仍由 `父::子` 的 id 解出。
              recordSpan({
                traceId: obsTraceId,
                nodeId: cid,
                kind: settledR.kind,
                status: settledR.status,
                startTime: new Date(nodeStartedAt.get(cid) ?? Date.now()),
                endTime: new Date(),
                ...(settledR.failureKind ? { failureKind: settledR.failureKind } : {}),
              });
              roundResults.set(cid, settledR);
              depOutputs[cid] = settledR.output;
              // #153 D-7: 子节点绕过外层 settle → 逐字保真探针在这里同样点一次 (同一个
              // detectVerbatimDrop 调用, 不是第二判据)。观察条目两条路都照常进账本 (INV-6),
              // 差别只在升闸谓词命中时把 id 收进 verbatimReds → 判前并进本轮毒集。
              //
              // D-3 (2026-08-25): 上游输入 = 节点在 prompt 里真实看到的视图 (`seenUpstreamOutputs`),
              // 不是原始 `depOutputs[d]` —— 摘要脱引文后, 节点从未见过的原文不再被冤枉。
              // 切片 1 (D-2) 让 faninView 自带逐字引文附录, 本切片让观察者判真实所见。
              if (settledR.status === 'done') {
                const upsCid = seenUpstreamOutputs(cid, plan!, depOutputs, faninView, capFanin);
                const vdCid = detectVerbatimDrop(cid, upsCid, settledR.output ?? '');
                if (vdCid) {
                  observe([vdCid]);
                  if (gateVerbatimRed(vdCid, plan!.nodes[cid]?.goal ?? '')) verbatimReds.add(cid);
                }
              }
              usageAcc = addUsage(usageAcc, settledR.usage);
              if (settledR.status === 'failed') failedLocal++;
              // 失败子节点**带上败因** (截断防爆), 不是一个光秃秃的 `[failed]`。
              // 2026-07-30 live 冒烟实证: 一个写文件的子节点被产物闸拒 (`filesTouched 空 — leaf
              // 自报完成但未做任何文件写操作`), 而环里看到的只有 `[failed]` —— judge 于是自己编了
              // 一套猜测 (「可能是 mkdir 没权限」), 下一轮的 conductor 也就照着那个猜测重画。
              // 环的全部信息通道就是"上一轮为什么没过", 把最确切的那句话挡在通道外, 等于让它盲跑。
              // **引擎实测到的事实**与 leaf 的自述分开带给 judge (2026-07-30 第三次 live 冒烟):
              // 此前视图里只有 leaf 自己写的那句话, 于是反捏造判词打在了真做完的活上
              // (子图 2/2 成功、文件真在盘上, judge 判"捏造执行确认" —— 它没冤枉谁, 证据确实没进视图)。
              // 只放引擎观测到的: filesTouched 经产物闸核过存在性; command 节点 done ≡ 退出码符合 expect_exit。
              // 引擎记录的那几行 —— **构造器与整图那道扫描共用一份** (见 engineFacts 的注:
              // 两处各写一份的话, 同一个节点在两条路上会得到不同的"引擎记录", 而差异是静默的)。
              const facts = engineFacts(settledR, {
                expectExit: plan!.nodes[cid]?.expect_exit ?? 0,
                shellCap: SHELL_FACT_CAP,
              });
              // S1: 上面那三条只回答"文件在不在 / 命令过没过", 而验收在**内容**上的目标问的是
              // "文件里写了什么" —— judge 看不见它就只能 fail-closed, 于是交付物全对也判未收敛
              // (2026-07-30 两次带种 live 都是这个形状)。产物内容由**引擎读盘**补进来:
              // 让 leaf 自己把内容复述进 output 就又回到自证, 而自证正是反捏造判词要杀的东西。
              const artifacts = judgeArtifactBudget
                ? collectJudgeArtifacts(settledR.filesTouched ?? [], artifactReader, judgeArtifactBudget)
                : [];
              childOut.push({
                id: cid,
                originalId: byId.get(cid)?.originalId ?? cid,
                status: settledR.status,
                output: settledR.status === 'failed' ? `[failed] ${(settledR.output || '(无输出)').slice(0, 600)}` : settledR.output,
                ...(facts.length ? { facts } : {}),
                ...(artifacts.length ? { artifacts } : {}),
              });
              for (const f of settledR.filesTouched ?? []) touchedAll.add(f);
              // 子节点绕过外层 settle() → 补发事件 (同 map 子节点)。
              emitNodeEvent(settleEvent(cid, settledR));
              // 释放子图内下游。失败也释放 —— 是否执行由下游自己的 requires quorum 判 (D-7v2),
              // 不在这里替它决定 (与外层 settle 同语义)。
              for (const dep of dependentsLocal.get(cid) ?? []) {
                const n = (indegLocal.get(dep) ?? 1) - 1;
                indegLocal.set(dep, n);
                if (n === 0) readyLocal.push(dep);
              }
              runningLocal--;
              settledLocal++;
              pump();
            });
        }
        // 无就绪且无在飞而仍未结清 = 子图内有环 (展开期已查过, 这里是防御性兜底, 不许静默挂起)。
        if (runningLocal === 0 && readyLocal.length === 0 && settledLocal < childIds.length) {
          logger.warn({ node: id, settled: settledLocal, total: childIds.length }, '[omd/executor-dag] conductor 局部调度死锁 → 提前结清 (防挂起)');
          resolve();
        }
      };
      pump();
    });

    // ── 4.5 检测者 (D-Q 图内 fan-in) + 制品边 lint (D-12 图外观察者) ────────────
    //
    // 两件事都在**判之前**做完: 检测者的票要和 judge 的票并到同一个毒集里 (它俩说的是同一件事
    // ——"这一段产出不作数"), 而 lint 的发现要能进这一轮的失败原因, 否则下一轮 conductor 看不到
    // "你少画了一条边"这句话, 就会一直少画。
    const detectorVerdict: { rejected: string[]; blocked?: string } = { rejected: [] };
    for (const cid of childIds) {
      if (plan!.nodes[cid]?.detector !== true) continue;
      const r = roundResults.get(cid);
      // ⚠ **失败的检测者仍然要读** (2026-07-30 eval 挖出的静默失效): 前一版这里是
      // `r.status === 'failed' → continue`, 而 conductor 自发画检查节点时最常见的写法恰恰是
      // 「发现冲突就 exit 1 / 让节点失败」—— 它把"失败"当成了反馈通道。于是那种节点**印出了**
      // `REJECT: <兄弟>` 却被这一行整个吞掉: 票没进毒集, 环下一轮不知道该拒谁。
      //
      // 读失败节点的输出是安全的, 因为解析本身已经是 fail-closed 的反面 —— **没有协议行 = 没有
      // 裁决** (parseDetectorVerdict 的语义)。一个真崩了的检测者 (命令语法错/API 报错) 吐的是
      // 堆栈或空串, 行首不会出现 `REJECT:`/`BLOCKED:`, 解析出来仍是空 verdict。
      // 只有 `!r` (根本没跑, 级联 skip 前就没有结果) 才是真的"它没说过话"。
      if (!r) continue;
      // 别名映射 (可读 id → 内容寻址 id): 命令检测者按构造只知道规划期那个可读名 —— 不给它
      // 这条翻译, `REJECT:` 这一半协议对 command 节点等于不存在。
      const aliasToId = new Map(expand.children.map((c) => [c.originalId, c.id]));
      const v = parseDetectorVerdict(r.output, childIds, aliasToId);
      if (v.ghosts.length) {
        logger.warn({ node: id, detector: cid, ghosts: v.ghosts }, '[omd/executor-dag] 检测者点名了子图中不存在的 id → 丢弃 (D-Q)');
      }
      for (const rid of v.rejected) if (!detectorVerdict.rejected.includes(rid)) detectorVerdict.rejected.push(rid);
      if (v.blocked !== undefined && detectorVerdict.blocked === undefined) detectorVerdict.blocked = `[检测者 ${cid}] ${v.blocked}`;
      if (v.rejected.length || v.blocked) {
        // 分开记"检测者自己失败了但仍有裁决": 这正是上面那条修复救回来的那一类, 不留痕的话
        // 它与普通路径在日志上长得一模一样 —— 而"从不发生"和"没这个功能"读数相同 (交接文的坑)。
        logger.info(
          { node: id, detector: cid, rejected: v.rejected, blocked: v.blocked, detectorFailed: r.status === 'failed' },
          r.status === 'failed'
            ? '[omd/executor-dag] 检测者自身 failed 但印出了裁决 → 仍落进环 (D-Q)'
            : '[omd/executor-dag] 检测者裁决落进环 (D-Q)',
        );
      }
    }
    // #153 D-7 升闸消费点: 逐字保真升闸的红并进**检测者同一个毒集** —— 它说的是同一件事
    // ("这一段产出不作数"), 另开一条平行通道就会出现两套毒集语义各自漂移。取出即删: 这一轮
    // 的红只毒这一轮, 下一轮要红得由下一轮的探针重新点火。
    for (const cid of childIds) {
      if (!verbatimReds.delete(cid)) continue;
      if (!detectorVerdict.rejected.includes(cid)) detectorVerdict.rejected.push(cid);
      logger.info({ node: id, child: cid }, '[omd/executor-dag] 逐字保真升闸 → 子节点进本轮毒集 (#153 D-7)');
    }
    const lintFindings = runArtifactLint();

    // ── 5. 汇总 (INV-U7 同款: 子节点部分失败 = 部分成功; 全失败才算 conductor 节点失败) ──
    //
    // ⚠ `[...childOut]` 那个拷贝不是洁癖: `sort` **原地改数组**, 而下面 judge 视图用的是同一个
    // childOut。原先两处共用一份被就地排过序的数组 —— 于是 judge 看到的顺序悄悄变成了"按内容
    // 寻址 id 的字典序", 也就是**按哈希值排**, 谁在前面纯属偶然 (2026-07-30 给指纹加一个字段就
    // 让顺序翻了个个儿, 一条按下标点名的测试因此变红)。两个视图的顺序从此各自独立且确定:
    // 人看的摘要按 id 排 (稳定), judge 看的按**子图拓扑序** (见 topoOrder 那段注)。
    const ok = childOut.filter((c) => c.status !== 'failed').length;
    const summary = [...childOut]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((c) => `[${c.originalId}] ${c.status}\n${c.output}`)
      .join('\n\n');
    const settled = new Map(childOut.map((c) => [c.id, c]));
    // ⚠ 这里**逐字重建**而不是原样传, 于是每加一个视图字段都要在这一行补一次 —— 漏了就是
    //   "生产者有、消费者拿不到", 而症状是沉默的 (视图里少一段, 读上去像这个改动没用)。
    //   S1 的 `artifacts` 第一次跑就栽在这儿, 靠 judge-artifacts-wiring 那条网抓出来。
    const orderedChildren = topoOrder.flatMap((cid) => {
      const c = settled.get(cid);
      return c
        ? [{
            id: c.id,
            originalId: c.originalId,
            status: c.status,
            output: c.output,
            ...(c.facts?.length ? { facts: c.facts } : {}),
            ...(c.artifacts?.length ? { artifacts: c.artifacts } : {}),
          }]
        : [];
    });
    // ── 4.6 「声称的引擎动作 vs 引擎记录」确定性核对 (2026-08-05, **只报不拦**) ──────
    //
    // 算在 `orderedChildren` 上而不是 childOut: 判官看的就是这个数组, 两者取不同的输入面
    // 就会出现"报的和判的不是同一批产出" (逐字重建那道坑的下一种形态)。
    //
    // 它求的是差集「产物声称的引擎校验动作 ⊆ 引擎记录的动作」, 不是判断题 —— 引擎精确知道
    // 自己记了什么。判据很窄且**已知会误伤良性语域** (指令句「确保测试通过」、整改回执
    // 「已按 verifier 意见修改」), 所以这一档三条出口一票不铸: 视图 / 账本 / 下一轮 prompt。
    const claims = findUnsupportedClaims(checkableFromJudgeView(orderedChildren));
    const claimObs: DagObservation[] = claims.map((f) => ({
      kind: 'unsupported-claim' as const,
      nodes: [f.nodeId],
      message: renderClaimObservation(f),
    }));
    // 账本这一侧走 observe (按内容去重 + 出声): 活体基率数的是**不同的发现**, 同一条重复几轮
    // 不该被数成几次。进 prompt 的那一侧用全量, 见返回类型上 claimObs 的注。
    observe(claimObs);
    // 「检出器到底跑没跑过」的三态计数 —— 见 claimCheckRounds 的声明处。
    claimCheckRounds++;
    claimCheckedNodes += orderedChildren.length;
    claimFindings += claims.length;
    for (const c of orderedChildren) claimCheckedIds.add(c.id);
    return {
      leaf: {
        id,
        status: ok > 0 ? 'done' : 'failed',
        // 子图全灭 ≠ 这个节点自己坏了 —— 成因在子节点上, 而它们各自已经归好类。
        // (这一格是 2026-07-31 live 的读数板点名出来的: 它当时落进 unclassified。)
        ...(ok > 0 ? {} : { failureKind: 'subgraph-failed' as const }),
        kind: 'conductor',
        output: `[conductor 子图: ${ok}/${childIds.length} 成功${expand.truncated ? `, 截断 ${expand.truncated}` : ''}${failedLocal ? `, 失败 ${failedLocal}` : ''}]\n\n${summary}`,
        deps,
        usage: usageAcc,
        ...(touchedAll.size ? { filesTouched: [...touchedAll] } : {}),
      },
      children: orderedChildren,
      usage: usageAcc,
      results: roundResults,
      detector: detectorVerdict,
      lint: lintFindings,
      claims,
      claimObs,
      childIds,
      budgetHalt,
    };
  };

  /**
   * **D-A: 环封在 conductor 节点内** (P3 批次 3 第二次加厚, 2026-07-29)。
   *
   * `max_rounds` 缺省 1 = 展开一次就结束, **零回归** —— 于是在外层 fixpoint 还没撤 (D-F) 之前,
   * 不存在"两层 verify 同时在"的过渡态: 双环只在有人显式写 `max_rounds > 1` 时才出现。
   * (P1 的 double-loop 教训是两层必须二选一; 撤外层要等环在这里跑通, 反过来会有一段时间两层都不在。)
   */

  // ── S3 跨 run 等待: engine park 该节点, 等 run-board published 后 unpark ─────

  const runAwaitNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    const spec = node.await!;
    const root = continuity?.repoRoot ?? process.cwd();
    const t0 = Date.now();

    emitNodeEvent({ type: 'start', id, kind: 'await' });

    const res = await awaitNode(
      root,
      {
        artifact: spec.artifact,
        timeoutMs: spec.timeoutMs ?? 3 * 60 * 60 * 1000, // D-8 默认 3h
        writeSet: node.write_set ?? [],
        fromRun: spec.fromRun,
      },
      {
        pollMs: 30_000, // 低频 poll 兜底 (fs.watch 为主触发)
        runId: continuity?.runId ?? id,
      },
    );

    const usage: ModelUsage = { in: 0, out: 0 };

    if (res.verdict === 'unparked') {
      emitNodeEvent({ type: 'settle', id, status: 'done', kind: 'await' });
      saveDoneCheckpoint({
        id,
        kind: 'await' as NodeCheckpoint['leafKind'],
        text: res.commit ?? '',
        usage,
        filesTouched: [],
        deps,
        t0,
        artifactRoot: root,
      });
      return {
        id,
        status: 'done',
        kind: 'await' as LeafResult['kind'],
        output: res.commit ?? '',
        deps,
        usage,
        ...(res.commit ? { commit: res.commit } as any : {}),
      };
    }

    // stalled → failed with stall failure kind
    emitNodeEvent({ type: 'settle', id, status: 'failed', kind: 'await' });
    return {
      id,
      status: 'failed',
      failureKind: 'stall',
      kind: 'await' as LeafResult['kind'],
      output: res.tickets[0]?.title ?? 'await stalled',
      deps,
      usage,
    };
  };
  // ── conductor 内环展开 ────────────────────────────────────────────────────
  const runConductorNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    const maxRounds = node.max_rounds ?? 1;
    const judgeFinal = node.judge_final === true;
    const cm = continuity?.manager;

    // F1 (片 2, INV-8): 内环节点级事件发射器 —— emitRunEvent 在 runDagInternal 闭包里,
    // runConductorNode 拿不到 (跨函数闭包); 这里直接调 config.onNodeEvent, 它的消费方
    // (dag-tools.ts:430) 已自带 try/catch + fail-open (观察者不许扰动被观察者)。
    const emitRunEventLocal = (e: DagNodeEvent): void => { config.onNodeEvent?.(e); };

    // resume: 接回上次的轮次/毒集/上轮原因 (INV-P2-6 同款, 只是键降到了节点级)。
    const journal = cm && continuity?.resume ? cm.loadNodeLoopJournal(continuity.runId, id) : null;
    if (journal?.converged) {
      logger.info({ node: id, rounds: journal.completedRounds }, '[omd/executor-dag] 内环已收敛 (journal) → 直接返上次结论');
      // #148 尾巴 (2026-08-17): judge 自己那一票从 verdicts 尾巴**还原**, 不另存一位 ——
      // 同一件事两处声明就是漂移源 (S-39), 停轮的 verdict 就是最后一条。还原规则与 live 路径
      // 逐位相同: 只有「判据绿停 ∧ judge 真投过票」才有这一位 (判据 'green' ∧ judge
      // 'converged'/'rejected'); 'gate-rejected'/'unreachable' = 没投票 → 缺席; 判据不绿时的
      // 停轮 (judge 收敛停 / 轮尽) live 侧本就不写它 → 缺席。丢了这一位不翻终态 (裁决位是
      // converged), 丢的是判据轴: resume 后一次真实的 judge 异议会被读成「judge 也说绿」。
      const lastVerdict = journal.verdicts?.at(-1);
      const restoredJudge =
        lastVerdict?.criterion === 'green' && (lastVerdict.judge === 'converged' || lastVerdict.judge === 'rejected')
          ? lastVerdict.judge === 'converged'
          : undefined;
      return {
        id, status: 'done', kind: 'conductor', output: journal.lastOutput ?? '[内环已收敛]', deps,
        usage: { in: 0, out: 0 }, skipped: true, rounds: journal.completedRounds, converged: true,
        ...(restoredJudge === undefined ? {} : { judgeConverged: restoredJudge }),
      };
    }
    const poisoned = new Set(journal?.poisoned ?? []);
    let prevReason = journal?.prevReason ?? '';
    // #228: 「下一步」不另开 journal 字段 —— 它已经随 `RoundVerdict` 写入磁盘 (见 types.ts),
    // resume 时从**最后一条 verdict** 还原即可。同一件事两处声明就是漂移源 (S-39, 与上面
    // `restoredJudge` 同一条纪律)。缺席 = 那一轮 judge 没被问过 / 没答 → 下一轮不挂这一块。
    let prevNextSteps: string | undefined = journal?.verdicts?.at(-1)?.nextSteps;
    // #245 (INV-9): 冻结判据失败明细 = **瞬态**单轮线程, 不入 journal —— 一轮一鲜, 不粘滞。
    // 跨 resume 复用 = 上轮 freeze 红的明细混进新一轮 prompt = 错误的现场。第 N+1 轮 freeze 绿
    // → 第 N+2 轮自然缺席 (闭包里重新计算, 不持久)。
    let prevCriterionFailDetail: string | undefined;
    // r1 片3/4 (INV-R1-4 + C2): 各轮发现文本→累计簇数; resume 接回旧序列 (journal 持久)。
    const noveltyTexts: string[] = journal?.noveltyTexts ? [...journal.noveltyTexts] : [];
    const noveltySeq: number[] = journal?.noveltySeq ? [...journal.noveltySeq] : [];
    const startRound = (journal?.completedRounds ?? 0) + 1;
    if (journal) {
      // **内环重入探针** (2026-08-06): 盘上实测同一个 run 的同一个节点被重入 16 次, 其中 9 次
      // 0ms 死在下面那条 `startRound > maxRounds` 上 —— 而**每次 0ms 死亡都紧挨着一次成功执行**
      // (`__r9` 0ms → 22 秒后 `__r10` done)。那个机制这批数据**答不了**: 判它需要的
      // `{startRound, maxRounds, resume, journal 何时写的}` 四位当时一位都没记。
      // 这一行就是补那四位。**纯留痕, 不改任何行为** —— 先让那个数有人写, 再判要不要改。
      logger.info(
        {
          node: id, startRound, maxRounds, poisoned: poisoned.size,
          resume: continuity?.resume === true,
          journalUpdatedAt: journal.updatedAt,
          journalStop: journal.stop?.kind,
          exhausted: startRound > maxRounds,
        },
        '[omd/executor-dag] 内环恢复: 接回轮次/毒集 (D-A)',
      );
    }

    let usageAcc: ModelUsage = { in: 0, out: 0 };
    let last: LeafResult | null = null;
    // 上一轮的子节点结果 —— 跨轮复用的匹配源 (进程内; 崩溃后由各子节点自己的 checkpoint 兜)。
    let prevResults = new Map<string, LeafResult>();

    /**
     * 节点定局的**唯一出口**: 盖轮数/裁决 + 落审计 checkpoint。
     *
     * 审计 checkpoint (交接文 2026-07-30 的 filesTouched 下一档): `outputPaths` = 子树并集,
     * `artifactHashes` 照算。此前这份并集只活在内存里, 崩了就没 —— 而"这棵子树到底动过哪些文件"
     * 是事后审计唯一的锚。**永不用于 resume-skip**: runNode 在 conductor 分支就 return 了,
     * 结构上走不到那条 resume 判定 (纪律由结构保证而不靠自觉; 有测试钉住)。
     */
    const settle = (leaf: LeafResult, rounds: number, converged?: boolean): LeafResult => {
      const out: LeafResult = { ...leaf, rounds, ...(converged === undefined ? {} : { converged }) };
      // 切片 1 (C-1 INV-3): 内环收尾 —— 环定局这一刻, 留总墙钟。埋这里是因为环的三条 return
      // (收敛 / 轮数用尽 / 空转 BLOCKED) 都过 settle, 写在外面会被 return 跳过。
      logger.info(
        { node: id, rounds, at: roundStampNow(), loopMs: Date.now() - loopStartedAt },
        '[omd/executor-dag] 内环收尾',
      );
      if (out.status === 'done') {
        saveDoneCheckpoint({
          id,
          kind: 'conductor',
          text: out.output,
          usage: out.usage,
          filesTouched: out.filesTouched ?? [],
          deps,
          t0: nodeStartedAt.get(id) ?? Date.now(),
        });
      }
      // **预算轴留痕 (报不拦, 2026-08-12 S1 埋点)**: 上面的预算轴 (round > startRound 处) 只在
      // **轮边界**查, 于是"这一轮自己就跑穿预算、当轮就收敛/定局退出"这一路 (settle 从任何非
      // 预算出口被叫到) 此前一条记录都不留 —— 实测 d39b559e 内环跑 131.3min / 预算 90min,
      // budget-exhausted 计数 0。判定逻辑一字不改: 不提前 break, 不改 cap/阈值, settle 本身就是
      // "环已经定局"这一刻, 只在这一刻对一次账。`!budgetStopped` 避免与「开轮前拦下」重复记
      // (那条已经在轮边界写过 journal 了) —— 这里补的是它**没**触发、但定局时账已经超了的那格。
      if (!budgetStopped) {
        const postSpentTokens = usageAcc.in + usageAcc.out;
        const postSpentMs = Date.now() - loopStartedAt;
        const postTokenCap = config.loopBudget?.tokens;
        const postMsCap = config.loopBudget?.ms;
        let postLoopBudgetExceeded: string | undefined;
        if (postTokenCap !== undefined && postSpentTokens >= postTokenCap) {
          postLoopBudgetExceeded = `token 预算跑穿 (轮跑完才发现): 已花 ${postSpentTokens} / 上限 ${postTokenCap}`;
        } else if (postMsCap !== undefined && postSpentMs >= postMsCap) {
          postLoopBudgetExceeded = `时间预算跑穿 (轮跑完才发现): 已用 ${Math.round(postSpentMs / 1000)}s / 上限 ${Math.round(postMsCap / 1000)}s`;
        }
        if (postLoopBudgetExceeded) {
          logger.warn(
            { node: id, rounds, postSpentTokens, postSpentMs },
            `[omd/executor-dag] ${postLoopBudgetExceeded} → 内环已定局, 只报不拦`,
          );
          writeLoopJournal(rounds, poisoned, prevReason, false, out.output, {
            kind: 'budget-exhausted',
            evidence: postLoopBudgetExceeded,
            atRound: rounds,
          });
        }
      }
      return out;
    };

    /**
     * 节点级环 journal 写入磁盘 —— **每轮判完就写**, 不是节点结束时写 (崩在这之后 resume 接得回来)。
     * 三个调用点共用: 正常轮末 / 检测者 BLOCKED / 空转 BLOCKED。三处各写一份就会漂。
     */
    /**
     * 逐轮两道闸的裁决(2026-08-06)。resume 时接回旧的 —— 断在第 2 轮再续跑,
     * 第 1 轮那条不能凭空消失(整段的价值就在于"这个环历史上有没有出现过某个组合")。
     */
    const roundVerdicts: RoundVerdict[] = journal?.verdicts ? [...journal.verdicts] : [];
    const writeLoopJournal = (
      round: number,
      poisonedNow: ReadonlySet<string>,
      reason: string,
      converged: boolean,
      lastOutput: string,
      /** N6: 这一轮是不是**停在这儿**, 以及凭什么 (原文证据)。不停就省略。 */
      stop?: NodeLoopJournal['stop'],
    ): void => {
      if (!cm || !continuity) return;
      cm.writeNodeLoopJournal(continuity.runId, {
        runId: continuity.runId,
        nodeId: id,
        completedRounds: round,
        poisoned: [...poisonedNow],
        ...(reason ? { prevReason: reason } : {}),
        ...(noveltyTexts.length ? { noveltyTexts: [...noveltyTexts], noveltySeq: [...noveltySeq] } : {}),
        // 逐轮两道闸的裁决 —— 解锁 D-I 那条"判据红 ∧ judge 说收敛才补守卫"的预设判据 (只记不判)。
        ...(roundVerdicts.length ? { verdicts: [...roundVerdicts] } : {}),
        ...(converged ? { converged: true, lastOutput } : {}),
        ...(stop ? { stop } : {}),
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      });
    };

    // D-Q 空转检测的比对面 (上一轮的子节点 id 集 + 被拒集)。
    let prevShape: RoundShape | null = null;
    /** 上一轮盘上的产物指纹 (G5 正解的比对源)。 */
    let prevArtifacts: RoundArtifacts | null = null;
    /**
     * 「盘上没位移」**连续**命中几轮。今天只用来出读数 —— 它就是将来把这条从**报**升成
     * **BLOCKED** 时, K 该取几的那份依据。0 读数时先定 K 等于凭感觉定闸。
     */
    let noArtifactChangeRounds = 0;
    /** 闸级熔断的累积面: 上一轮 judge 瞬时失败的逐字身份 + 它已经连续几轮逐字相同。 */
    let lastJudgeFaultKey: string | null = null;
    let judgeFaultStreak = 0;
    /** 设 0 或 1 = 关闭本闸 (阈值 1 等于一失败就熔断, 那不是熔断 —— 同 repeatedActionThreshold 的口径)。 */
    const judgeFaultThreshold = config.judgeFailureThreshold ?? 2;
    /** 真正跑完的轮次 (取消收尾时要如实报, 不能拿 maxRounds 顶)。 */
    let doneRounds = startRound - 1;

    /** 内环起跑时刻 (预算轴的时间那半)。 */
    const loopStartedAt = Date.now();
    /** 环因预算停下的原因 (未超 = undefined)。 */
    let budgetStopped: string | undefined;
    /** #F1 片 2 / INV-8: 预算过半通知的 per-axis 幂等标志 —— 本内环实例局部, 不跨进程去重。 */
    const budgetHalfFired: { tokens: boolean; ms: boolean } = { tokens: false, ms: false };
    /**
     * §8.4 动作级熔断的累积面: 本内环里**失败过的 command 节点** (跨轮累积)。
     * 轮级空转判据看的是"整轮原地踏步"; 这一条看的是"整轮在变, 但**某一条命令**始终以逐字
     * 相同的方式失败" —— 粒度差一个量级, 前者看不见后者。
     */
    const failedActions: ActionAttempt[] = [];

    // #158 环入口预算检查: 前面的相位/节点把钱烧光 → 本环一轮不开。此前唯一判点在轮边界
    // 且带 `round > startRound` 首轮豁免 —— 跨相位烧穿后本环照样满额起跑。
    const preloopHit = dispatchBudgetHit();
    if (preloopHit) {
      const msg = `${preloopHit} → 内环一轮不开 (#158)`;
      logger.warn({ node: id, startRound }, `[omd/executor-dag] ${msg}`);
      writeLoopJournal(doneRounds, poisoned, prevReason, false, '', {
        kind: 'budget-exhausted',
        evidence: msg,
        atRound: startRound,
      });
      return (
        // resume 场景 last 缺席 → 合成失败叶; 语义词全在 budgetStopped 上 (outcome 阶梯读它)。
        { id, status: 'failed', kind: 'conductor', output: `[${msg}]`, deps, usage: usageAcc, budgetStopped: msg }
      );
    }

    for (let round = startRound; round <= maxRounds; round++) {
      // D-P 取消接缝③: 不开新一轮。已判完的轮次全在 journal 里, resume 从下一轮接着跑。
      if (isCancelled()) {
        logger.warn({ node: id, round }, '[omd/executor-dag] 已取消 → 内环不开新一轮 (D-P 协作式)');
        break;
      }
      // **预算轴** (2026-07-31, Loop Engineering 四条停止轴里我们唯一缺的那条): 与取消同一个接缝 ——
      // 只在轮边界查, 不打断在飞的一轮 (半轮的钱已经花了, 打断只是把产出也扔掉)。
      // 软停不是硬杀: 已跑完的全保留, resume 时给个更大的预算就接着跑。
      if (round > startRound) {
        const spentTokens = usageAcc.in + usageAcc.out;
        const spentMs = Date.now() - loopStartedAt;
        const tokenCap = config.loopBudget?.tokens;
        const msCap = config.loopBudget?.ms;
        // #F1 (片 2, INV-8): 预算过半通知 —— additive 事件, 不挡在飞的轮, 装在已有边界读数里。
        // 只在配了该轴 cap 时判; per-axis 幂等标志为本内环局部 (D-6 不跨进程去重)。
        if (tokenCap !== undefined) {
          emitBudgetHalfIfHalf(spentTokens, tokenCap, budgetHalfFired, 'tokens', emitRunEventLocal);
        }
        if (msCap !== undefined) {
          emitBudgetHalfIfHalf(spentMs, msCap, budgetHalfFired, 'ms', emitRunEventLocal);
        }
        if (tokenCap !== undefined && spentTokens >= tokenCap) {
          budgetStopped = `token 预算用尽: 已花 ${spentTokens} / 上限 ${tokenCap} (第 ${round - 1} 轮后)`;
        } else if (msCap !== undefined && spentMs >= msCap) {
          budgetStopped = `时间预算用尽: 已用 ${Math.round(spentMs / 1000)}s / 上限 ${Math.round(msCap / 1000)}s (第 ${round - 1} 轮后)`;
        } else {
          // #158 运行锚那半: 环锚 (loopStartedAt) 量不到前相位烧掉的钱, goal 层注入的
          // _budgetAnchor 才是整个 solve 的一只钟。
          const runHit = dispatchBudgetHit();
          if (runHit) budgetStopped = `${runHit} (第 ${round - 1} 轮后, 运行锚)`;
        }
        if (budgetStopped) {
          logger.warn({ node: id, round, spentTokens, spentMs }, `[omd/executor-dag] ${budgetStopped} → 内环不开新一轮`);
          // 停在**开跑之前** → atRound 记的是没能开成的那一轮 (与 completedRounds 差 1, 见字段注释)。
          writeLoopJournal(round - 1, poisoned, prevReason, false, last?.output ?? '', {
            kind: 'budget-exhausted',
            evidence: budgetStopped,
            atRound: round,
          });
          break;
        }
      }
      // 切片 1 (C-1 INV-1): 轮开始 —— 取消/预算闸之后, runConductorRound 之前。
      // ms 取值从这里起算, judge 时间落在轮结束与下一条轮开始之间, 由内环收尾的 loopMs 兜住。
      const roundStartedAt = Date.now();
      logger.info({ node: id, round, at: roundStampNow() }, '[omd/executor-dag] 轮开始');
      // G1: `roundVerdicts` 此刻含第 1..round-1 轮 (本轮的那条在轮末才 push) —— 正是
      // `renderPriorRounds` 要的输入。resume 时它已从 journal 接回, 所以跨进程的历史一样看得见。
      const r = await runConductorRound(id, round, prevReason, prevNextSteps, prevCriterionFailDetail, roundVerdicts, poisoned, prevResults);
      // 切片 1 (C-1 INV-2): 轮结束 —— runConductorRound 返回后立刻 (D-3: ms 只覆盖展开+执行,
      // 不含轮末 judge, 三段时间加起来无主)。r.results 是 Map, 子图节点数 = .size。
      logger.info(
        { node: id, round, at: roundStampNow(), ms: Date.now() - roundStartedAt, nodes: r.results.size },
        '[omd/executor-dag] 轮结束',
      );
      doneRounds = round;
      // #158: 轮内派发闸触发 → 终态词上叶 (不然 goal 层把预算停读成普通未收敛, 指引就错了)。
      // journal 在这儿写一条; 后面 settle 的"跑完才发现"账 `if (!budgetStopped)` 自然不重记。
      if (r.budgetHalt && !budgetStopped) {
        budgetStopped = r.budgetHalt;
        writeLoopJournal(round, poisoned, prevReason, false, r.leaf.output, {
          kind: 'budget-exhausted',
          evidence: r.budgetHalt,
          atRound: round,
        });
      }
      prevResults = r.results;
      usageAcc = addUsage(usageAcc, r.usage);
      last = { ...r.leaf, usage: usageAcc };
      const isFinal = round === maxRounds;

      // ── §8.4 动作级熔断 ────────────────────────────────────────────────────
      // 顺序上**先于**检测者与 judge: 它判的是"这一格上零位移", 是确定性的字节比对, 比任何
      // 一次 LLM 判定都硬; 而且早一步退环就少烧一次 judge 调用。
      for (const [cid, res] of r.results) {
        if (res.kind !== 'command' || res.status !== 'failed') continue;
        const cmd = (plan!.nodes[cid] as { command?: string } | undefined)?.command;
        if (cmd) failedActions.push({ command: cmd, output: res.output });
      }
      const actionBlock = repeatedActionBlock(failedActions, config.repeatedActionThreshold);
      if (actionBlock) {
        logger.warn({ node: id, round, reason: actionBlock.split('\n')[0] }, '[omd/executor-dag][fuse-action] 动作级熔断 → 环提前退出 (§8.4)');
        // 与检测者 BLOCKED 同一个出口、同一条 fail-closed 纪律 (恒 converged=false):
        // 阻塞更不该被读成成功。
        writeLoopJournal(round, poisoned, prevReason, false, last.output, {
          kind: 'blocked',
          evidence: actionBlock, // 原话进 journal, 不复述 —— 复盘要的是"当时看见了什么"
          atRound: round,
        });
        return { ...settle(last, round, false), blocked: actionBlock };
      }

      // ── D-Q 图内检测者的票 (与 judge 的票同一个毒集) ────────────────────────
      // 顺序上**先于** judge: 检测者常是确定性 oracle (command 节点), 它说"这段不作数"比
      // 一次 LLM 判定更硬; 而两者点到同一个 id 时 Set 天然合并, 不需要谁压过谁。
      for (const cid of r.detector.rejected) poisoned.add(cid);
      if (r.detector.blocked !== undefined) {
        // BLOCKED 异步出口: 图没坏、节点没挂, 是"没有外部输入推不动" —— 剩下的轮数是纯烧钱。
        // 恒 converged=false (fail-closed: 阻塞更不该被读成成功)。
        logger.warn({ node: id, round, reason: r.detector.blocked }, '[omd/executor-dag] 检测者判 BLOCKED → 环提前退出 (D-Q)');
        writeLoopJournal(round, poisoned, prevReason, false, last.output, {
          kind: 'blocked',
          evidence: r.detector.blocked,
          atRound: round,
        });
        return { ...settle(last, round, false), blocked: r.detector.blocked };
      }

      // 单轮档 (max_rounds=1, 缺省): 不请 judge —— 没有下一轮可去, 判了也没有用它的地方,
      // 白花一次贵座调用。这也是零回归的那一半。
      //
      // `judge_final` 是那唯一的例外 (D-F): 调用方要拿这个裁决当"整体目标成了吗"的答案
      // (撤外层之后没有别的层再问这句), 那就值得为单轮档也多付一次。
      // 多轮档照旧**每轮都判** —— 末轮那次不只是为了下一轮, 它还要写进 journal (resume 据它
      // 判"这个节点上次到底成没成"), 省掉它等于让 resume 拿一个空白的结论重跑。
      // 配了冻结判据就一定要问 judge —— 判据轴要的是**两个布尔**, 缺了 judge 那一半,
      // 「judge 太紧」(判据过了而 judge 说没成) 这一格就永远观测不到。
      if (maxRounds === 1 && !judgeFinal && !config.freezeCriterion) return { ...settle(last, round), ...(budgetStopped ? { budgetStopped } : {}) };

      // ── 冻结判据进环 (2026-08-01) ────────────────────────────────────────────
      // **在这儿直接跑, 不作为子节点** —— 这是护栏①: `renderRoundForJudge` 渲染的是 children,
      // 而 command 子节点通过时 facts 会写「命令退出码符合预期」。judge 一旦看得见判据结论
      // 就会抄答案, 两条判据永远一致 —— 而判据轴量的恰恰是它们的不一致。
      // 顺序上先于 judge (同 §8.4 与 D-Q 那两条: 确定性的先问, 早一步就少烧一次贵座调用)。
      // 赦免证据原文 (S-37 下沉): freezeGreen 走 waived 路径时, evidence 字段带它进 journal
      // —— 否则 verifier/judge 看到的是 "silent green", 那正是本契约要杀的形状 (INV-3)。
      let freezeWaivedNote: string | undefined;
      // #245 (INV-5): 红时构造失败明细 (构造块在闭包**内**, cr.text / cr.exitCode 只在这里拿得到)。
      // 闸拒 / 赦免 / 绿 → 缺席, 一个字不挂 —— 闸拒 ≠ 跑出红, 不混这两态。`extractFailSet`
      // 复用 accept-delta 的那一份 (INV-8)。failSet 空 → 只带命令与退出码, **不带原文** (原文
      // 有制品/journal 通道, 必达块按构造有界 —— 不让一块无限长塞进 prompt)。
      let freezeFailDetail: string | undefined;
      const freezeGreen = await (async (): Promise<boolean | null> => {
        const fc = config.freezeCriterion;
        if (!fc || !config.commandRunner) return null; // 没配 = 旧行为, 判据只在环外跑
        try {
          const cr = await config.commandRunner({ command: fc.command });
          // `null` (死于信号) 不是闸拒: 闸拒 = 命令没执行, 死于信号 = 执行了没跑完 —— 两者下一步相反。
          const blocked = cr.exitCode !== null && cr.exitCode < 0; // 闸拒 ≠ 跑出红, 不赦免 (D-4 同款纪律)
          let ok = !blocked && cr.exitCode === (fc.expectExit ?? 0);
          // 与节点级 expect_output 同语义: 退出码判「怎么结束的」, 这一格判「跑到了什么」。
          if (ok && fc.expectOutput !== undefined && !(cr.text ?? '').includes(fc.expectOutput)) ok = false;
          let waivedHere = false;
          if (!ok && !blocked && fc.waiveRed) {
            const waived = fc.waiveRed(cr.text);
            if (waived !== null) {
              ok = true;
              freezeWaivedNote = waived;
              waivedHere = true;
            }
          }
          // #245 INV-5: 红 ∧ 未闸拒 ∧ 未赦免 → 构造失败明细。绿 / 闸拒 / 赦免 / 未配 → 不构造。
          if (!ok && !blocked && !waivedHere) {
            const failSet = extractFailSet(cr.text);
            const head = `冻结判据红 (${fc.command} → exit ${cr.exitCode})`;
            freezeFailDetail = failSet.length
              ? `${head}\n· 失败 ${failSet.length} 条: ${failSet.join(', ')}`
              : head;
          }
          logger.info({ node: id, round, command: fc.command, exitCode: cr.exitCode, ok, waived: !!freezeWaivedNote }, '[omd/executor-dag] 冻结判据 (环内)');
          return ok;
        } catch (e) {
          // 判据本身跑不起来 ≠ 判据没过 —— 但对停止决定而言两者一样 (不能据此判绿)。
          logger.warn({ node: id, round, err: String(e) }, '[omd/executor-dag] 冻结判据跑不起来 → 按未过处理');
          return false;
        }
      })();

      const verdict = await judgeConductorRound(id, node.goal ?? id, r.leaf, round, r.children, r.claims);
      usageAcc = addUsage(usageAcc, verdict.usage);
      // 四态各自的判词原文 (D-3, 2026-08-23):
      //   · `unreachable` → 错误原文 (judge 调用本身挂了, 它没投过票);
      //   · 其它三态     → verdict.reason (converged/rejected 是 judge 的 failureReason;
      //                                gate-rejected 是闸合成的, judge 没被问过 —— 这一格
      //                                **不许**被冒充成 judge 的票, 否则又把"没投票"灌进
      //                                "投了反对票"那一格了)。
      // No-silent-caps (D-2): 超 2000 字符 → 全文落 `<runDir>/reason-<nodeId>-r<round>.txt`,
      // journal 存告示 + 指针, 与交接 / fanin / debug-plan redEvidence 同形。
      const REASON_CAP_CHARS = 2000;
      const rawReason = verdict.unreachable ? (verdict.unreachable ?? '') : (verdict.reason ?? '');
      let reasonField: string;
      if (rawReason.length <= REASON_CAP_CHARS) {
        reasonField = rawReason;
      } else {
        const fullPath = continuity ? continuity.manager.saveReasonFull(continuity.runId, id, round, rawReason) : null;
        const kept = rawReason.slice(0, REASON_CAP_CHARS);
        reasonField = kept + (fullPath
          ? `\n[判词已截断 (cap=${REASON_CAP_CHARS}, 原文 ${rawReason.length} 字符); 全文在 ${fullPath} —— 有 read 工具就按需分页读它]`
          : `\n[判词已截断 (cap=${REASON_CAP_CHARS}, 原文 ${rawReason.length} 字符); 全文未写入磁盘 (无 continuity), 判词尾部已丢]`);
        logger.warn(
          { node: id, round, len: rawReason.length, cap: REASON_CAP_CHARS, persisted: !!fullPath },
          '[omd/executor-dag] 内环判词超 cap → 全文写入磁盘 + journal 存指针',
        );
      }
      // 两道闸各说了什么, 逐轮记一条。**只记不判** —— 下面的收敛判定一个字没改。
      // 三态/两态不压平的理由见 `RoundVerdict`: 「没配判据」≠「判据红」,「judge 调不通」≠「judge 说没成」。
      roundVerdicts.push({
        round,
        criterion: freezeGreen === null ? 'none' : freezeGreen ? 'green' : 'red',
        judge: verdict.unreachable ? 'unreachable' : verdict.converged ? 'converged' : verdict.synthetic ? 'gate-rejected' : 'rejected',
        reason: reasonField,
        // #228: judge 真答了才有这一列。缺席 = 不写键 (不是空串) —— 事后要能分出
        // 「judge 没被问过」与「judge 答了一句空话」(仓规坑①)。
        ...(verdict.nextSteps ? { nextSteps: verdict.nextSteps } : {}),
        // G2: 契约结论同款纪律 —— judge 真答了才有这一列, 缺席 ≠ aligned。
        ...(verdict.contractVerdict ? { contract: verdict.contractVerdict } : {}),
      });
      // ── G2 契约闸 (2026-08-28) ──────────────────────────────────────────────
      // judge 说这个节点的 goal 相对**原题**写歪了 (漏了硬约束 / 换成了另一个目标)。
      //
      // **这里不重跑, 也不自己改 goal。** 仓规: impl 暴露 contract 错 → **回流改 contract**,
      // 不是 silent override。再转一轮只会照着同一份歪契约再干一遍 —— 加轮数是这一格最没用的动作,
      // 所以 stop kind 取 `blocked` (N5 词表: "要人给外部输入, 加轮数没用"), 不取 not-converged。
      //
      // ⚠ 只拦 `needs_revision` / `invalid` 两态。`unknown` = 判不了, 那与 judge 拿不准同性质,
      //   照常继续转 (拿 unknown 停轮 = 把"我不知道"读成"它错了", 会把一次犹豫变成一次误停)。
      // ⚠ 与 `converged` **正交**: 收敛了也拦 —— `converged=true ∧ contract='invalid'` 正是最坏那格
      //   (活干完了, 干的是另一件事), 放过去就是拿一份写歪的契约给出一个"成功"。
      if (verdict.contractVerdict === 'needs_revision' || verdict.contractVerdict === 'invalid') {
        const issue = verdict.contractIssue?.trim() || '(judge 判契约不 aligned 但没写清哪一条 —— 按原题逐条自查)';
        const evidence = `G2 契约闸: judge 判本节点 goal 相对原题 ${verdict.contractVerdict} —— ${issue}`;
        logger.warn(
          { node: id, round, contract: verdict.contractVerdict, converged: verdict.converged },
          '[omd/executor-dag][contract-gate] G2: goal 相对原题写歪 → 停轮交人改契约 (加轮数没用)',
        );
        observe([{ kind: 'contract-misaligned', nodes: [id], message: evidence }]);
        writeLoopJournal(round, poisoned, prevReason, false, last.output, {
          kind: 'blocked',
          evidence,
          atRound: round,
        });
        // ⚠ 不写 `failureKind`: 那张表 (`node-failure.ts`) 每一条都带逐条处置指引, 扩它是另一片的活。
        // 这一格的处置已经在 journal 的 `stop.kind='blocked'` + observation 里说清了 (无第二套)。
        return settle(last, round, false);
      }
      // ── ask 出口 (2026-08-28) ───────────────────────────────────────────────
      // 连续两轮判官都说「材料不足以判断这活对不对」= 这个歧义**不会靠再转一轮自己消掉**,
      // 它要的是人回答一句话。LH-Harness 把这条做成 manager 的一等路由 (`Next: ask`):
      // 暂停 → 抛问题 → 答案作权威用户输入进下一轮。omd 这边的等价物是「停轮 + 把问题记下来」,
      // 答案经 resume 时的 `ownerDirectives` 逐字进下一轮 prompt (那条通道早就在, 不新造)。
      //
      // ## 为什么触发权在引擎不在模型
      //
      // judge 只提供**问题内容** (`askOwner`), **停不停由这里的确定性判据说了算**。
      // 反过来做 (模型想停就停) 等于给它一个按钮 —— 一个爱提问的座位能把每一跑都停在第 1 轮,
      // 而这一格没有任何机械证据能反驳它。可靠性来自模型之外: 触发是数出来的, 不是求来的。
      //
      // ## 判据为什么是「连续两轮」而不是「一轮」
      //
      // 一轮 unknown 很常见 (第 1 轮材料本来就少, 探索一轮就清楚了)。**连续两轮**才是
      // 「转了一圈回来还是不知道」。streak 直接从 `roundVerdicts` 数 —— 不另开计数器,
      // 那份数组本来就随 journal 写入磁盘, resume 之后接得回来 (同一件事两处声明就是漂移源, S-39)。
      //
      // ⚠ 与上面 G2 那道闸互斥 (contract 四态各归各的出口), 排在它后面只是让契约轴的两个出口挨着。
      const unknownStreak = (() => {
        let n = 0;
        for (let i = roundVerdicts.length - 1; i >= 0; i--) {
          if (roundVerdicts[i]!.contract === 'unknown') n++;
          else break;
        }
        return n;
      })();
      if (unknownStreak >= ASK_UNKNOWN_STREAK) {
        // 缺席不编: judge 说不出要问什么, 就照实写它说不出 —— 编一个问题比没有问题更坏
        // (人会去回答一个引擎虚构的问题, 而真正卡住的地方一个字没被记下来)。
        const question = verdict.askOwner?.trim();
        const evidence = question
          ? `ask 出口: 连续 ${unknownStreak} 轮判官都说不准这活对不对 → 停轮问 owner: ${question}`
          : `ask 出口: 连续 ${unknownStreak} 轮判官都说不准这活对不对, 但它**没写出要问什么** → 停轮交人 (请自己对着原题看这个节点的 goal 该怎么定)`;
        logger.warn(
          { node: id, round, streak: unknownStreak, hasQuestion: !!question },
          '[omd/executor-dag][ask-owner] 连续两轮契约 unknown → 停轮问 owner (再转一轮消不掉这个歧义)',
        );
        observe([{ kind: 'owner-question', nodes: [id], message: evidence }]);
        writeLoopJournal(round, poisoned, prevReason, false, last.output, {
          kind: 'blocked',
          evidence,
          atRound: round,
        });
        return settle(last, round, false);
      }
      // judge **调不通** → 立刻退环, 不把剩下的轮数烧在一个确定性故障上 (2026-07-31)。
      // 与 §8.4 熔断同一个出口形状, 但 kind 是 `infra-error` 不是 `blocked`: N5 词表里这两格的
      // 下一步相反 —— blocked 是"要人给外部输入", infra-error 是"引擎自己出事, 该修的是引擎"。
      // 把它念成 not-converged (此前的行为) 会让人去加轮数, 而加轮数正是最没用的那个动作。
      // 判据绿 → **这一轮就是最后一轮** (D-I「以判据为准」; 而判据本身已由 G4 的空世界自检 +
      // 反面样本探针两道筛过, 不是随便一条命令就有停止权)。judge 的票**只记录不决定** ——
      // 护栏②: 不问的话「judge 太紧」那一格永远观测不到, 等于从另一头把判据轴杀掉。
      if (freezeGreen === true) {
        // 护栏④: judge 同时调不通 → 仍然按判据停, 但**出声说这一跑只有一道闸** ——
        // 不说的话就是"以为两道闸、其实一道", 而那正是这个仓一直在杀的形状。
        const oneGate = verdict.unreachable ? ` · ⚠ judge 调不通 (${verdict.unreachable}) —— 这一跑只有一道闸` : '';
        if (verdict.unreachable) logger.warn({ node: id, round }, '[omd/executor-dag] 冻结判据绿但 judge 调不通 → 按判据收敛, 但这一跑只有一道闸');
        logger.info({ node: id, round, judgeSaid: verdict.converged }, '[omd/executor-dag] 冻结判据绿 → 环提前收敛 (judge 的票只记录)');
        const waiverTag = freezeWaivedNote ? ` · 赦免: ${freezeWaivedNote}` : '';
        writeLoopJournal(round, poisoned, prevReason, true, last.output, {
          kind: 'success',
          evidence: `冻结判据绿 (${config.freezeCriterion!.command})${oneGate}${waiverTag}`,
          atRound: round,
        });
        // S-44 时效锚: 在**判据刚绿的这一刻**取一次工作树快照。外层拿它比对收尾时的树,
        // 不一致 = 这条绿说的是另一棵树。取不到锚返回 undefined → 下游判 unknown, 不判 changed。
        const freezeAnchor = captureTreeAnchor(continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd()) ?? undefined;
        return {
          ...settle(last, round, true),
          // C (2026-08-21): 这一位往外带, 外层 verifier 才知道"这一轮拿到过机器绿"。
          // 不带的话, 外层只能看见一堆 done 节点, 而"done"与"判据绿"是两个问题。
          freezeGreen: true,
          ...(freezeAnchor ? { freezeAnchor } : {}),
          // judge 自己那一票**单独带出去**: `converged` 现在是判据说的, 不再等于 judge 说的。
          // 混在一起会让判据轴把"判据绿"误记成"judge 也说绿" —— 那正是它要量的那一格。
          // synthetic (确定性闸合成的判词) 同 unreachable 一样**不写这一位** (#148):
          // judge 没被问过, 「没投票」≠「投了反对票」—— 写了就是拿闸的回声冒充 judge 的票。
          ...(verdict.unreachable || verdict.synthetic ? {} : { judgeConverged: verdict.converged }),
        };
      }

      if (verdict.unreachable) {
        logger.warn({ node: id, round, err: verdict.unreachable }, '[omd/executor-dag] judge 调不通 → 环提前退出 (infra-error, 不烧剩余轮数)');
        writeLoopJournal(round, poisoned, prevReason, false, last.output, {
          kind: 'infra-error',
          evidence: `judge 调不通: ${verdict.unreachable}`, // 原话进 journal, 复盘要的是当时看见了什么
          atRound: round,
        });
        return { ...settle(last, round, false), infraStopped: `judge 调不通: ${verdict.unreachable}` };
      }

      // ── 闸级熔断 (2026-08-16): §8.4 那条原则的第三个粒度 ────────────────────────
      //
      // 上面按 kind 分的判据有个够不着的角: **确定性**故障若碰巧落进"瞬时"那一类, 就会每轮
      // 重来直到轮数烧光。实例: `minimax-native` 把业务码塞进 `status`, 业务码全 ≥ 1000 →
      // 鉴权失败 (1004) / 无效 key (2049) 一律落进 `isProviderFault` 的 `s >= 500` 那支。
      // 按 kind **猜**不出来 —— 但**转一轮量一量**就知道。
      //
      // 判据沿用仓里既有的那条 (轮级 D-Q、动作级 §8.4 都是它): **「相同」而不是「重复」**。
      //   逐字相同 → 这一格零位移 → 确定性, 退环
      //   文本在变 → 事情在动 (模型换了说法) → 继续转
      // 这个键在这里不用调: 坏 key 每轮逐字相同 (第 2 轮退); 瞬时 1000 文本虽同, 但连续两轮
      // 的概率 ≈ 0.017² ≈ 0.03% (`.omd/eval/gate-m3` 实测 M3 关思考 1/60); parse 抖动的错误里
      // 带随输出变的 token, 文本不同 → 继续。
      if (verdict.faultKey && verdict.faultKey === lastJudgeFaultKey) {
        judgeFaultStreak++;
      } else {
        judgeFaultStreak = verdict.faultKey ? 1 : 0;
      }
      lastJudgeFaultKey = verdict.faultKey;
      if (judgeFaultThreshold >= 2 && judgeFaultStreak >= judgeFaultThreshold) {
        const evidence = `judge 连续 ${judgeFaultStreak} 轮以逐字相同的方式失败 (零位移 → 确定性): ${verdict.faultKey}`;
        logger.warn({ node: id, round, streak: judgeFaultStreak }, '[omd/executor-dag][fuse-judge] 闸级熔断 → 环提前退出 (infra-error, 不烧剩余轮数)');
        // 与 judge 调不通同一个出口、同一个词: 该修的是引擎/凭证, 不是"等人给外部输入" (N5)。
        writeLoopJournal(round, poisoned, prevReason, false, last.output, { kind: 'infra-error', evidence, atRound: round });
        return { ...settle(last, round, false), infraStopped: evidence };
      }
      last = { ...r.leaf, usage: usageAcc };

      // D-4 同款铸票: judge 点名的子节点 → **id** 入毒集 (键取 id 的理由见 NodeLoopJournal 的注)。
      for (const cid of verdict.rejected) poisoned.add(cid);
      // 检测者与 judge 点的名并在一起当"这一轮谁坏了"; 空转判据看的就是这个合集。
      const rejectedNow = [...new Set([...verdict.rejected, ...r.detector.rejected])];
      // 制品 lint 的发现**接在失败原因后面**进下一轮的重展开 prompt —— 环的信息通道只有这一条,
      // 「你少画了一条边」这句话进不去, conductor 下一轮还会照样少画 (D-12 lint 为主的落点)。
      // ── 「产物没变」检测 (2026-07-31, G5 正解) ────────────────────────────────
      // 判在这里而不是和空转判据一起, 是因为**它不拦** —— 它的出口就是下面这条 prompt 通道。
      // 位置在 journal 之前: 这句话必须跟着 prevReason 一起被写进 journal, 否则 resume 接回来
      // 的那一轮会丢掉它 (环唯一的信息通道断一次, 就等于这条检测器白跑)。
      const curArtifacts = collectRoundArtifacts(r.results);
      const move = classifyArtifactMove(prevArtifacts, curArtifacts);
      prevArtifacts = curArtifacts;
      // ── 机会计数 (2026-08-06): 判据**够不够得着**要与「够得着且没命中」分开记 ─────────
      // 少了这三行, 一次 `loop-no-artifact-change: 0` 在账本里与"这个环压根没走到能判的地方"
      // 长得一模一样 —— 而两者的下一步相反 (前者该收掉这条检测器, 后者该问环为什么只转一圈)。
      if (move.kind !== 'unobserved' || move.why !== 'first-round') moveTransitions++;
      if (move.kind === 'unobserved' && move.why !== 'first-round') moveUnobserved++;
      const noMove = move.kind === 'no-move' ? move.observation : null;
      if (noMove) {
        moveFindings++;
        noArtifactChangeRounds++;
        logger.warn(
          { node: id, round, files: Object.keys(curArtifacts.hashes).length, consecutive: noArtifactChangeRounds },
          '[omd/executor-dag] 盘上没有位移: 产物与上一轮逐字节相同 (只报不拦, 攒 K 用)',
        );
        observe([noMove]);
      } else {
        noArtifactChangeRounds = 0;
      }
      // ⚠ `r.claimObs` 用**全量**而不是 observe 判新的那批 (lint 走的是后者): journal 每轮覆写,
      // 「上一轮未通过」是本轮快照。只在首次出现那轮进 prevReason 的话, 盘上留下的最后一轮就
      // 没有它 —— 而 report-only 唯一的价值就是事后拿原句人工核对误伤 (见 claimObs 的类型注)。
      // ⚠ 顺带记一笔耦合: prevReason 也是**新颖性坍塌**判据的输入 (pushNoveltyRound 取前 400 字)。
      // 一条逐轮重复的发现会让各轮文本更像, 于是簇数更容易不增 —— 那条同样只报不拦 (只追加一行
      // 建议进 prompt), 所以不改控制流; 但它的读数从此不是纯净的, 解读时要知道有这一路输入。
      const roundObs = [...r.lint, ...r.claimObs, ...(noMove ? [noMove] : [])];
      // #228: 「下一步」**不并进 prevReason** —— 并进去它就跟判词一起进 `body`, 一起被头切,
      // 而它偏偏住在尾部 (那正是这一票要治的)。走独立变量 → 独立参数 → 必达块。
      // 缺席 (judge 没被问过 / 没答) 时置回 undefined, 不留上一轮的残值: 挂一条**上上轮**的
      // 下一步比不挂更坏 —— 读者无从知道它已经过期了。
      prevNextSteps = verdict.nextSteps;
      // #245: 冻结判据失败明细同款线程 —— 单轮一鲜, 不留残值。本轮 freeze 绿 / 闸拒 / 赦免 / 未配
      // → freezeFailDetail === undefined → 下一轮 prompt 不挂这一块 (缺席零字节, INV-6)。
      prevCriterionFailDetail = freezeFailDetail;
      prevReason = roundObs.length
        ? `${verdict.reason}\n\n[图外观察者]\n${roundObs.map((o) => `- ${o.message}`).join('\n')}`
        : verdict.reason;
      // r1 C2 (INV-R1-3): 簇数连续 K 轮不增 → 警告行**追加进 prevReason** (环唯一的信息通道,
      // 只进 prompt 不进控制流; 终止权仍归轮数/预算/判据)。同时落 observation 进账本 (INV-R1-4)。
      if (pushNoveltyRound(noveltyTexts, noveltySeq, prevReason)) {
        logger.info({ node: id, round, seq: noveltySeq }, '[omd/executor-dag] 新颖性坍塌 (簇数连续不增) → 建议行进下一轮 prompt');
        observe([{ kind: 'novelty-collapse', nodes: [id], message: `簇数序列 [${noveltySeq.join(',')}] 连续 2 轮不增` }]);
        prevReason = `${prevReason}\n\n${NOVELTY_COLLAPSE_LINE}`;
      }

      // **每轮判完就写** journal —— 不是节点结束时写。崩在这之后, 下次 resume 接得回来。
      writeLoopJournal(
        round,
        poisoned,
        prevReason,
        verdict.converged,
        last.output,
        // 收敛才是"停"; 没收敛只是这一轮判完了, 环还要继续 —— 那时不写 stop
        // (写了会让 resume 读到一个"已经停过"的环)。
        verdict.converged ? { kind: 'success', evidence: `judge 判收敛 (第 ${round} 轮)`, atRound: round } : undefined,
      );
      if (verdict.converged) {
        logger.info({ node: id, round }, '[omd/executor-dag] 内环收敛 (D-A)');
        return settle(last, round, true);
      }
      // 轮数用尽仍未收敛 (judge_final 档才走到这): 返最后一轮结果并**如实带上 converged=false**。
      if (isFinal) {
        logger.warn({ node: id, maxRounds }, '[omd/executor-dag] 内环轮数用尽仍未收敛 (INV-GOAL-4 有界)');
        // N6: 四条停止轴里**最常走**的这一条此前一个字都不留 —— journal 上只看得到
        // "最后一轮判完没收敛", 与"阻塞"、"预算停"在盘上长得一模一样, 于是 resume 的人分不出
        // 该加轮数、该加预算、还是该去看一眼。⚠ 这条 return 在轮末 journal **之后**,
        // 所以要再写一次 (同轮号, 补上 stop) —— 第一版把它写在函数尾部, 而这条 return
        // 根本走不到那里, 探针一跑就看见 stop 缺席。
        writeLoopJournal(round, poisoned, prevReason, false, last.output, {
          kind: 'not-converged',
          evidence: `轮数用尽仍未收敛 (跑满 ${round} / 上限 ${maxRounds} 轮, judge 最后一轮仍判未达标)`,
          atRound: round,
        });
        return settle(last, round, false);
      }
      // ── D-Q 空转 → BLOCKED (判在"还有轮可跑"之后): 这一轮重展开得到与上一轮**完全相同**的
      // 子图 (内容寻址 id 逐个相同) 且拒的还是同一批 → 再转按构造不会有新东西, 剩下的轮是纯烧钱。
      const shape: RoundShape = { childIds: r.childIds, rejected: rejectedNow };
      const stuck = detectLoopNoProgress(prevShape, shape);
      prevShape = shape;
      if (stuck) {
        observe([stuck]);
        // ⚠ N6 顺手修的一个**真漏**: 这条 BLOCKED 出口此前**压根不写 journal** ——
        // 而 writeLoopJournal 的文档注释白纸黑字写着"三个调用点共用: 正常轮末 / 检测者 BLOCKED /
        // **空转 BLOCKED**"。三缺一, 于是空转停下来的环 resume 时读不回自己为什么停,
        // 只会看到"上一轮没收敛"。又一次声明面与执行面对不上。
        writeLoopJournal(round, poisoned, prevReason, false, last.output, {
          kind: 'blocked',
          evidence: stuck.message,
          atRound: round,
        });
        return { ...settle(last, round, false), blocked: stuck.message };
      }
      logger.info({ node: id, round, rejected: verdict.rejected.length }, '[omd/executor-dag] 内环未收敛 → 重新展开');
    }
    // D-P: 取消是从这条路出来的 (循环 break)。**不谎报收敛, 也不谎报失败** —— 已跑完的轮次
    // 是真跑完的, 结果照原样返, converged 缺席 = 没人判过 (调用方按 `?? false` 读)。
    if (isCancelled() && last) {
      logger.warn({ node: id, doneRounds }, '[omd/executor-dag] 内环因取消收尾 (已判轮次全在 journal 里, resume 可续)');
      return settle(last, doneRounds);
    }
    // 预算轴出口 (2026-07-31): 与取消同一个形状 —— 已跑完的轮次照原样返, **converged=false 显式给**
    // (fail-closed: 没跑完就不是成)。`budgetStopped` 与 `blocked` **刻意是两个字段**: 前者加预算
    // resume 很可能就成, 后者再多钱都一样, 两个不同的下一步不该读同一句话。
    if (budgetStopped && last) {
      return { ...settle(last, doneRounds, false), budgetStopped };
    }

    // 到这里 = startRound > maxRounds (resume 接回一个已跑满轮数却没收敛的节点): 一轮都没跑,
    // 没有裁决可报。**不谎报收敛**。
    //
    // ⚠ **2026-08-06 改判**: 此前这条归 `infra-error`, 而 infra-error 的判词是「重试 / 换池」——
    // 对这一格**重试一万次都是同样的 0ms 死**。盘上实测: 10 条 infra-error 里 9 条是这一格,
    // 同一个 run 的同一个节点在 8 小时里被重入 9 次, 每次 0–1ms。且 infra-error 在
    // run 级 severity 里排第一 → 整跑结论被一个"没轮次了"盖成"引擎坏了"。
    // 现在归 `rounds-exhausted` (→ run 级 `blocked`, 同 gate-rejected: 再试也没用, 要改条件本身),
    // 并且**判词里指名道姓给出两条出口**, 其中删 journal 那条要带真实路径 —— 猜不到的出口等于没出口。
    const journalPath = cm ? cm.loopPath(continuity!.runId, id) : '(无 continuity, 无 journal 文件)';
    logger.warn(
      { node: id, maxRounds, startRound, journalPath, completedRounds: journal?.completedRounds },
      '[omd/executor-dag] 内环无轮可跑 (resume 已用尽轮数) → rounds-exhausted, 别重试',
    );
    return (
      last ?? {
        id,
        status: 'failed',
        failureKind: 'rounds-exhausted',
        kind: 'conductor',
        output:
          `[内环轮数已用尽: journal 记 ${journal?.completedRounds ?? 0} 轮 / 上限 ${maxRounds} 轮, 本次重入一轮都没跑]\n` +
          '**原样重试没有用** —— 每次都会在同一个位置零执行返回。两条出口二选一:\n' +
          `  ① 调高该节点的 max_rounds (schema 上界 4) —— 意思是"再给它几轮";\n` +
          `  ② 删掉 ${journalPath} 让轮次归零 —— 意思是"忘掉之前几轮的毒集与上轮原因, 重头来"。`,
        deps,
        usage: usageAcc,
      }
    );
  };

  // ── U1 P1: map 节点运行时展开 (SDD 0009 §2.3 StateMachine) ──────────────────
  // lister → expandMapNode(纯) → 子节点入 plan.nodes 复用 runNode 全套(路由/产物闸/checkpoint)
  // → 稳定 key 序 collect。INV-U7: 子节点部分失败 = map partial 成功;只 lister 失败才 fail map。
  const runMapNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    const spec = node.map!;
    const specHash = mapSpecHash(spec as unknown as Parameters<typeof mapSpecHash>[0]);

    // ── U1 P2 (INV-U3): spec 变 → 作废整棵子树的 resume 预载 (子节点重跑)。
    // map 节点自身**永不**整体 skip (lister 便宜, 重展开保正确); 子节点各自按 checkpoint 续。
    const prevMapCp = resumeGreens.get(id);
    if (prevMapCp && prevMapCp.expansionHash !== specHash) {
      for (const key of [...resumeGreens.keys()]) {
        if (key.startsWith(`${id}::`)) resumeGreens.delete(key);
      }
      logger.info({ node: id, prev: prevMapCp.expansionHash, now: specHash }, '[omd/executor-dag] map spec 变 → 子树 resume 作废 (INV-U3)');
    }

    // ── 1. lister (INV-U7: 失败 → map failed, 子节点不 spawn) ──
    let listerOutput: Record<string, unknown>;
    let usageAcc: ModelUsage = { in: 0, out: 0 };
    try {
      const listerGoal = spec.lister.goal ?? `枚举 ${spec.over}`;
      const schemaNote = spec.lister.output_schema
        ? `\n输出 JSON 必须符合 schema: ${JSON.stringify(spec.lister.output_schema)}`
        : '';
      const depCtx = deps.length
        ? `\n\n${deps.map((d) => fencedUpstream(d)).join('\n\n')}`
        : '';
      let text: string;
      if (spec.lister.executor === 'command' && spec.lister.command && config.commandRunner) {
        const r = await config.commandRunner({ command: spec.lister.command });
        if (r.exitCode !== 0) throw new Error(`lister command exit ${r.exitCode}: ${r.text.slice(0, 300)}`);
        text = r.text;
        usageAcc = addUsage(usageAcc, r.usage);
      } else if (spec.lister.executor === 'agent' && config.agentRunner) {
        const listerPrompt = `${listerGoal}${schemaNote}${depCtx}\n\n只回一个 JSON 对象, 必含数组键 "${spec.over}"。`;
        const listerModel = config.agentLeafModel ?? config.leafModel;
        const listerStart = new Date();
        // SDD S3 碰撞台账会话: runId + 节点维度稳定后缀 (lister 是 map 节点的子 agent)。
        // 引擎不建 runner (由接线层注入、跨 run 复用) → session 只能走调用期 input (AgentLeafInput.touchSession)。
        const touchRunId = continuity?.runId ?? config.sessionId;
        const r = await config.agentRunner({ prompt: listerPrompt, model: listerModel, ...(touchRunId ? { touchSession: `${touchRunId}:${id}:lister` } : {}) });
        recordGeneration({
          traceId: obsTraceId,
          name: `map-lister-agent:${id}`,
          model: listerModel,
          input: listerPrompt,
          output: r.text ?? '',
          ...(r.usage ? { usage: r.usage } : {}),
          startTime: listerStart,
          endTime: new Date(),
        });
        text = r.text;
        usageAcc = addUsage(usageAcc, r.usage);
      } else {
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: `${listerGoal}${schemaNote}${depCtx}\n\n只回一个 JSON 对象, 必含数组键 "${spec.over}"。别的不要。` },
          ],
          model: config.leafModel,
          traceName: `map-lister:${id}`,
          traceNodeId: id,
          thinkingLevel: config.inprocThinkingLevel ?? config.seatThinking?.(config.leafModel) ?? 'high',
        });
        text = r.text;
        usageAcc = addUsage(usageAcc, r.usage);
      }
      // JSON 提取: 剥 code fence → 首 '{' 到末 '}'。
      const stripped = text.replace(/```(?:json)?/g, '').trim();
      const s = stripped.indexOf('{');
      const e = stripped.lastIndexOf('}');
      if (s < 0 || e <= s) throw new Error(`lister 输出无 JSON 对象: ${stripped.slice(0, 200)}`);
      listerOutput = JSON.parse(stripped.slice(s, e + 1)) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ node: id, err: msg }, '[omd/executor-dag] map lister 失败 → map failed (INV-U7)');
      return { id, status: 'failed', failureKind: 'infra-error', kind: 'map', output: `[map lister 失败: ${msg}]`, deps, usage: usageAcc };
    }

    // ── 2. 纯展开 (INV-U2/U4/U5/U8 在 expandMapNode 内) ──
    const expand = expandMapNode(id, spec as unknown as Parameters<typeof expandMapNode>[1], listerOutput);
    if (expand.status === 'not_array' || expand.status === 'nested_map') {
      logger.warn({ node: id, error: expand.error }, '[omd/executor-dag] map 展开失败');
      return { id, status: 'failed', failureKind: 'infra-error', kind: 'map', output: `[map 展开失败: ${expand.error}]`, deps, usage: usageAcc };
    }
    if (expand.truncated > 0) {
      logger.warn({ node: id, truncated: expand.truncated }, '[omd/executor-dag] map 扇出截断 (INV-U4, no-silent-caps)');
    }

    // ── 3. 子节点跑 (G9: 空清单 = 成功 0 子) ──
    const childResults: { key: string; item: unknown; status: string; output: string }[] = [];
    let failedCount = 0;
    if (expand.children.length > 0) {
      // 子节点挂进 plan.nodes → runNode 全套复用 (per-node 路由/产物闸/checkpoint/resume)。
      for (const child of expand.children) {
        plan!.nodes[child.id] = { ...(child.node as (typeof plan.nodes)[string]), depends_on: deps };
      }
      // 观察面: 图上多了这些点 (同 conductor 展开)。
      recordRuntimeExpansion(id, expand.children.map((c) => c.id));
      // 局部 pump: 并发 = map.concurrency ?? config.maxFanout ?? 全宽。INV-U6: 子集独立, 不进外层 ready-set。
      const childCap = spec.concurrency ?? config.maxFanout ?? expand.children.length;
      const queue = [...expand.children];
      const runners: Promise<void>[] = [];
      // worker 数在起 worker **之前**一次算死: 每个 worker 的同步序里就有 `queue.shift()`, 上界若引用
      // 活的 queue.length 就会边生成边缩 —— r1 实测 (2026-08-04) cap≥N/2 时恰好只起 ⌈N/2⌉ 个
      // (f2 三跑 + 合成复现: 10 片恒 5 槽), 且 cap 放得越大越触发。回归闸: map-concurrency.test.ts。
      const workerCount = Math.max(1, Math.min(childCap, queue.length));
      for (let w = 0; w < workerCount; w++) {
        runners.push(
          (async () => {
            for (;;) {
              const child = queue.shift();
              if (!child) return;
              // INV-6/INV-U7: 子失败隔离, 不连坐。
              const r = await runNode(child.id).catch((e): LeafResult => ({
                id: child.id, status: 'failed', failureKind: 'infra-error', kind: 'inproc',
                output: `[failed] ${e instanceof Error ? e.message : String(e)}`,
                deps, usage: { in: 0, out: 0 },
              }));
              results[child.id] = r;
              depOutputs[child.id] = r.output;
              // map 子节点绕过外层 settle() → 此处补发 settle 事件 (INV-U6 子集独立调度)。
              emitNodeEvent(settleEvent(child.id, r));
              usageAcc = addUsage(usageAcc, r.usage);
              if (r.status === 'failed') failedCount++;
              // 失败子项带败因截断 (2026-08-04): 此前压成光秃 '[failed]', 下游 fan-in 与 repair 轮
              // 都看不见 10 个子项**为什么**全灭 (ed4dbe39: 防注入闸拒的原话被吞, reconcile 只能说
              // "无任何论文原文") —— 环的信息通道就是败因, 同 conductor 子图 childOut 的纪律。
              childResults.push({ key: child.key, item: child.item, status: r.status, output: r.status === 'failed' ? `[failed] ${(r.output || '(无输出)').slice(0, 300)}` : r.output });
            }
          })(),
        );
      }
      await Promise.all(runners);
      childResults.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // 稳定 key 序 (INV-U2)
    } else {
      logger.info({ node: id }, '[omd/executor-dag] map 空清单 → 成功 0 子 (G9)');
    }
    if (failedCount > 0) {
      logger.warn({ node: id, failedCount, total: expand.children.length }, '[omd/executor-dag] map 部分失败 (INV-U7 partial)');
    }

    const output = JSON.stringify(childResults);
    // ── 4. map 自身 checkpoint (expansionHash = spec hash; 产物归子节点各自的 checkpoint) ──
    if (continuity) {
      try {
        continuity.manager.saveCheckpoint(continuity.runId, {
          nodeId: id, leafKind: 'map', status: 'done', outputPaths: [], artifactHashes: {},
          tokenUsage: usageAcc, summary: output.slice(0, 800), expansionHash: specHash,
          durationMs: 0, createdAt: new Date().toISOString(),
          ...(dagGeneration ? { generation: dagGeneration } : {}), schemaVersion: 1,
        });
      } catch (err) {
        logger.warn({ node: id, err }, '[omd/executor-dag] map checkpoint write failed (fail-open)');
      }
    }
    return { id, status: 'done', kind: 'map', output, deps, usage: usageAcc };
  };

  // ── SDD 0013 S1: primitive 节点 (约束选择) 执行 ─────────────────────────────
  // {kind:'primitive', primitive, params} → registry.compilePrimitive (SEL-1 校验 + SEL-2 静态定界) →
  // invocation.run。控制流封装在原语 compile + primitives.ts (SEL-3), 此处只搭 leaf 工厂 ctx。
  const runPrimitiveNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    const deps = node.depends_on ?? [];
    let usageAcc: ModelUsage = { in: 0, out: 0 };
    const depCtx = deps.length
      ? `\n\n${deps.map((d) => fencedUpstream(d)).join('\n\n')}`
      : '';
    const ctx: PrimitiveCtx = {
      maxFanout: config.maxFanout,
      usage: () => usageAcc,
      // D-8v2: judge/parallel/tournament 的 attempts 按候选池轮转 (原语层 pickCandidate)。
      candidates: config.primitiveCandidates,
      leaf: async ({ goal, persona, model }) => {
        const cav = cavemanRule(leafCavemanLevel(false, config.cavemanLevel ?? 'full'));
        const personaLine = persona ? `<persona>${persona}</persona>\n` : '';
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: `${personaLine}${goal}${depCtx}${cav ? `\n\n${cav}` : ''}` },
          ],
          model: model ?? config.leafModel,
          traceName: `primitive-leaf:${id}`,
          traceNodeId: id,
          thinkingLevel:
            config.inprocThinkingLevel ?? config.seatThinking?.(model ?? config.leafModel) ?? 'high',
        });
        usageAcc = addUsage(usageAcc, r.usage);
        return r.text;
      },
    };
    const compiled = compilePrimitive(node.primitive as string, node.params ?? {}, ctx);
    if (!compiled.ok) {
      // SEL-1 fail-closed: 坏 primitive/params/超 cap → 失败有明确错, 不静默降范围。
      logger.warn({ node: id, err: compiled.error }, '[omd/executor-dag] primitive 编译失败 → failed (SEL-1 fail-closed)');
      return { id, status: 'failed', failureKind: 'infra-error', kind: 'primitive', output: `[primitive 编译失败: ${compiled.error}]`, deps, usage: usageAcc };
    }
    logger.info(
      { node: id, primitive: node.primitive, maxUnits: compiled.invocation.maxUnits },
      '[omd/executor-dag] primitive compiled (SEL-2 静态定界)',
    );
    try {
      const { output, usage } = await compiled.invocation.run();
      return { id, status: 'done', kind: 'primitive', output, deps, usage };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ node: id, err: msg }, '[omd/executor-dag] primitive run 抛错 → failed');
      return { id, status: 'failed', failureKind: 'infra-error', kind: 'primitive', output: `[primitive 失败: ${msg}]`, deps, usage: usageAcc };
    }
  };

  // 节点起跑时刻 (issue #4: 失败 checkpoint 的 durationMs 用; settle 在 runNode 各早退分支之外, 需独立捕获)。
  const nodeStartedAt = new Map<string, number>();
  // S2 后半 (C-2 / INV-5): use_event 发射去重 —— settle 重入路径可能多次经过同一个
  // (tool_id, leaf_id), 键 = `${tool_id}\\0${leaf_id}`。不靠 credit.dedupeUseEvents 在
  // 末端兜底, 而是在发射点就拦下重复 —— 事件面消费者不需要再过一道 filter。
  const useEventsEmitted = new Set<string>();
  // S2 (2026-08-25, 片 3): rung 2 派发闭包状态。runNode 在档 1 spin-fused 时写入,
  // runLeafNode 的 agentRunner 调用处读取后清空 ——
  // **单节点临时**, 跨节点不共享。键 = 节点 id。
  // undefined = 节点当前 attempt 不是 rung 2 重派 (普通 retry / 首次 / ladder 已终止)。
  const rung2DispatchByNode = new Map<string, SpinRung2Decision | undefined>();
  // ── SDD 2026-08-11 (D-1/D-5/D-10): settle 观测字段 + progress 节流 ───────────────
  // settle 三新字段全 optional (additive, 老发射点不补也合法); durationMs 真源 = 引擎侧墙钟
  // (nodeStartedAt), 不是 TUI 的事件到达间隔 (D-5); failReason = 失败原文首行 ≤160 (全文在 run 记录)。
  const settleEvent = (id: string, r: LeafResult): DagNodeEvent => {
    const startedAt = nodeStartedAt.get(id);
    const failReason = r.status === 'failed' ? (r.output || '(无输出)').split('\n')[0]!.slice(0, 160) : undefined;
    return {
      type: 'settle',
      id,
      status: r.status,
      kind: r.kind,
      ...(r.model ? { model: r.model } : {}),
      ...(startedAt !== undefined ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
      ...(failReason ? { failReason } : {}),
      // 2026-08-21: 闸的分类随事件出去 —— 观测面此前只拿得到 failReason 那 160 字符首行,
      // 「是哪个闸拦的」画不出来。`r.failureKind` 在 settle 出口已过 `withFailureKind` 归一化。
      ...(r.failureKind ? { failureKind: r.failureKind } : {}),
      ...(r.usage ? { usage: { in: r.usage.in, out: r.usage.out } } : {}),
    };
  };
  // progress 节流 (D-2/D-10): 生产端按节点 ≥500ms 一条; **首条不节流** —— C-2 反向自检依赖它
  // (≥3 次工具调用必须至少出 1 条, 而 3 次调用完全可以落在 500ms 内)。
  const PROGRESS_THROTTLE_MS = 500;
  const lastProgressAt = new Map<string, number>();
  const progressCalls = new Map<string, number>();
  /**
   * conductor 子图节点 → **它这一次是第几轮跑的**(2026-08-06)。
   *
   * 只在内环 pump 里写。同一个 cid 在多轮里会被覆写成最新那一轮 —— 与 checkpoint 本身
   * 「按 nodeId 覆写」的语义一致(盘上那一份就是最后一次的,轮次也该是最后一次的)。
   * ⚠ 不做成一个全局 `currentRound`:顶层可以同时跑**多个** conductor,各有各的轮计数。
   */
  const roundOfNode = new Map<string, number>();
  // ── 起跑时照一张「跑坏了回得去吗」的快照 (D1, 2026-08-06) ──────────────────────
  //
  // D-AB 说「范围内写」那一级可以放手, 理由是**git 就是 rollback**。而 R2 给的隔离档
  // (独立 worktree + 分支) 当时**默认关着且只挂在 dag_goal 一个入口上** —— 2026-08-06 实测:
  // `git branch --list 'omd/run/*'` **0 条**, 一次都没被用过 (S-3 那一族, 这次有读数)。
  // 于是那时几乎所有跑都落在 `head` 档直接写当前工作树, 而在那一档上「git 就是 rollback」
  // **不是恒假的, 是有条件的** —— 条件就是起跑时那棵树干不干净。这一位此前没人记。
  //
  // ⚠ **上一段是 2026-08-06 的读数, #253 (2026-08-25) 之后不成立**: MCP 两个写型入口默认
  //   落隔离 worktree, head 变显式 opt-in。**但这一发照查不误** —— head 档没消失(只是变
  //   opt-in), 人也一直在主树上写; 而且这一发落进 `omd_dag_runs.rollback` 的那一列, 正是
  //   「多少跑从脏树起跑」这个数的唯一来源 (实测 546/604 带锚, 其中九成是脏的)。
  //
  // ⚠ **只报不拦, 且只照一次**: 它不阻断任何一次跑, 也不在跑中重复查 (那会把 agent 自己的写
  //   算进"起跑时就脏"里, 判词当场失真)。
  const rollback = captureRollbackAnchor({ cwd: continuity?.repoRoot ?? process.cwd() });

  // ── B1 (2026-08-17, dsh/cordis 吸收线 B): 节点执行分发查表化 ────────────────────
  // 判定与执行分离: nodeExecKind (dag/node-kind.ts, 纯函数) 判"这是哪类节点",
  // nodeExecutors 表定"这类节点谁来跑"。三个内联分支体 (command/research/leaf) 从原
  // if-链**逐字搬移**成同 scope 闭包 (行为保持重构, 单一变量 = 分发机制); 表类型
  // Record<NodeExecKind, …> — 删一行是编译错, 新增 kind = 闭包 + 表一行 + 词表一员。
  type NodeExecCtx = { id: string; node: NonNullable<ConductorPlan['nodes'][string]>; deps: string[] };

      // command leaf (方案 A): 确定性 CLI, 零 LLM, 无 caveman/prompt。exitCode 0 = done。
  const runCommandNode = async ({ id, node, deps }: NodeExecCtx): Promise<LeafResult> => {
        if (!config.commandRunner || !node.command) {
          logger.warn({ node: id, hasRunner: !!config.commandRunner, hasCmd: !!node.command }, '[omd/executor-dag] executor:command 缺 commandRunner/command → failed');
          return { id, status: 'failed', failureKind: 'missing-capability', kind: 'command', output: '', deps, usage: { in: 0, out: 0 } };
        }
        // C-3 falsify mutation (sN-falsify, 2026-08-22): passthrough `mutate` + `expects_nonzero`
        // 字段 (sdd-compile.ts 编译时挂上, Zod passthrough 透传, 字段契约见 types.ts FalsifyMutate)。
        // 切片 1 承诺了节点构造 (sN / sN-green / sN-falsify-i 字段表逐字不变), 切片 2 承诺执行面语义。
        const extras = node as FalsifyNodeExtras;
        const falsifyMut: FalsifyMutate | undefined = extras.mutate;
        const expectsNonzero: boolean = extras.expects_nonzero === true;

        // INV-1 (C-1, 2026-08-22, falsify 兄弟互斥): 同树互斥。**仅 falsify 节点取锁**, 普通 command
        // 一个字节不受影响 (D-5 / INV-2)。key = `execRoot ?? repoRoot ?? process.cwd()` —— 一棵
        // 执行树 = 一个 key (D-2); 不同 worktree 各跑各的 (INV-5)。
        let r: CommandLeafResult | undefined;  // 在临界区**外**声明: let 是 block-scoped, 临界区结束后 want/ok/... 仍要读 r。
        const releaseLock: (() => void) | null = falsifyMut
          ? await acquireMutationLock(continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd())
          : null;

        try {
          // mutation 前置 (INV-8/9): 读原文 → 唯一匹配校验 → 替换 → 写盘。原文留在内存给 finally 用,
          // 不依赖 git baseline (INV-3 的承重姿态: head / branch 两条路都能用)。
          let mutatePath: string | undefined;
          let mutateOriginal: string | undefined;
          let mutateApplied = false;

          if (falsifyMut) {
            mutatePath = falsifyMut.file.startsWith('/')
              ? falsifyMut.file
              : join(continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd(), falsifyMut.file);

            let matches = -1; // -1 = 读盘失败 (把"文件不在"与"oldText 零匹配"分开, 落到不同出口)
            let readErr: unknown;
            try {
              mutateOriginal = readFileSync(mutatePath, 'utf-8');
              // split 计数: 'a'.split('a').length - 1 = 1; 'abab'.split('ab').length - 1 = 2。
              // 副作用: 空 oldText 会算成全文长度, 自然走 ≥2 那路拒掉 (与「唯一匹配」语义对齐)。
              matches = mutateOriginal.split(falsifyMut.oldText).length - 1;
            } catch (err) {
              readErr = err;
            }

            if (matches !== 1) {
              // INV-9: 0 匹配 / ≥2 匹配 / 读盘失败都拒。**不跑 command, 不改文件** (mutateOriginal
              // 从未被写过盘, 旧内容原封)。点名匹配数 / 失败原因, 让 owner 知道是该改 SDD 还是该
              // 删多余字面量。
              logger.warn(
                { node: id, file: falsifyMut.file, matches, readErr: readErr ? String(readErr) : undefined },
                '[omd/executor-dag] falsify mutate.oldText 唯一匹配校验失败 → failed (INV-9, 命令未跑, 文件未动)',
              );
              return {
                id, status: 'failed',
                failureKind: 'assert-failed',
                kind: 'command',
                output: `[falsify-mutate: file=${falsifyMut.file} oldText matches=${matches} (必须 = 1)${readErr ? `, readErr=${String(readErr).slice(0, 200)}` : ''}; command 未执行, 文件未改动]`,
                deps, usage: { in: 0, out: 0 }, exitCode: null,
              };
            }

            // 唯一匹配 (matches === 1) → 应用替换并写盘
            const mutated = mutateOriginal!.split(falsifyMut.oldText).join(falsifyMut.newText);
            try {
              writeFileSync(mutatePath, mutated, 'utf-8');
              mutateApplied = true;
            } catch (err) {
              // 写盘失败也是 INV-9 范畴 (mutation 步骤失败, 不许"半 mutation 半跑命令")。
              // mutateOriginal 仍在内存但没写过盘 → 不需要 finally 还原 (文件没被动过)。
              logger.warn(
                { node: id, file: falsifyMut.file, err: String(err) },
                '[omd/executor-dag] falsify mutate 写盘失败 → failed (INV-9)',
              );
              return {
                id, status: 'failed',
                failureKind: 'assert-failed',
                kind: 'command',
                output: `[falsify-mutate: write failed: ${String(err).slice(0, 200)}]`,
                deps, usage: { in: 0, out: 0 }, exitCode: null,
              };
            }
          }

          // 运行命令 + finally 还原 (INV-10): 任何出口 (成功 / 抛错 / 超时 / 进程被杀) 都把原文写回。
          // finally 内再抛会盖掉原异常, 故 catch 写盘错误只 WARN 不重抛, 防止把"命令结果"也吞掉。
          try {
            r = await config.commandRunner({ command: node.command });
          } finally {
            if (mutateApplied && mutatePath && mutateOriginal !== undefined) {
              try {
                writeFileSync(mutatePath, mutateOriginal, 'utf-8');
              } catch (err) {
                logger.error(
                  { node: id, file: falsifyMut!.file, err: String(err) },
                  '[omd/executor-dag] falsify mutate finally 还原失败 — 文件已污染 (INV-10 硬告警, owner 必须看)',
                );
              }
            }
          }
          // commandRunner 类型上返 CommandLeafResult, 走 finally 后必有值; 此处兜底防 TS narrowing。
          if (!r) {
            throw new Error(`[omd/executor-dag] commandRunner 无返回值 (command=${node.command}, 命令过程中抛错, 文件已还原)`);
          }

          // 临界区结束: 还原已完成 (mutation 路径) 或无须还原 (普通路径)。后续只读 r/不写盘,
          // 锁在此放掉, 兄弟 falsify 节点可以进来 (INV-3 的"看到的是原文")。
          // —— 走正常出口 (return 后续处理结果)。返回本身在 finally 之后发生, finally 仍在。
        } finally {
          // D-4: 任何出口都释放 — 成功 / 早退 return / 抛错 / 超时。无条件, finally 内不抛。
          if (releaseLock) releaseLock();
        }

        // D-K: expect_exit = 判 done 的期望退出码 (缺省 0)。verify-red 靠它表达 —— "证明新测试现在是红的"
        // 的成功判据就是非 0 退出, 而 shell 取反整族被注入闸拒 (command-leaf.ts:145)。
        //
        // ⚠ 负退出码**恒 failed**, 不受 expect_exit 影响: -1 是 command-leaf 的**闸拒**返回值
        // (危险命令 / 不在白名单 / 含元字符 / git 写子命令), 不是被执行命令的退出码。让 expect_exit
        // 把一次安全拒绝翻译成 done, 等于给闸开了一条从 plan 里绕过去的路。schema 已 min(0) 挡住
        // conductor 写 -1; 这条是给**预构造 plan** (不经 zod) 的运行期硬闸, 两层都要有。
        //
        // Falsify 节点走 INV-11 的 "expects_nonzero" 分支: 退出码 ≠ 0 判 done, = 0 判 failed
        // —— 是 sN-falsify 切片 2 的判别力通道 (mutation 后 verify 必须红; 仍然绿 = 这条自检没判别力)。
        const want = node.expect_exit ?? 0;
        const blocked = r.exitCode !== null && r.exitCode < 0; // 同上: null = 死于信号, 不是闸拒
        let ok: boolean;
        if (expectsNonzero) {
          // INV-11: blocked (闸拒) 仍恒 failed —— 闸拒 ≠ 跑出红, 不能被 translates 成 done。
          ok = !blocked && r.exitCode !== 0;
        } else {
          ok = !blocked && r.exitCode === want;
        }
        // expect_output: 与退出码取**交**。退出码判「命令怎么结束的」, 这一格判「它到底跑到了什么」——
        // 空匹配 (`bun test <路径写错>`) 两件事上恰好是: 正常结束 + 什么都没跑。缺省不检查。
        const wantOutput = node.expect_output;
        if (ok && wantOutput !== undefined && !(r.text ?? '').includes(wantOutput)) {
          ok = false;
        }
        // S-37 下沉 (2026-08-17): D-K 红 → 先过 freezeCriterion.waiveRed 闭包。
        //   节点命令 = 判据命令 (同串判据构造, INV-4) ∧ 非闸拒 (D-4) ∧ 闭包返非 null
        //   → 按 done 落 + 节点输出前缀赦免注记。
        let waiveNote: string | undefined;
        if (!ok && !blocked) {
          const fc = config.freezeCriterion;
          if (fc && node.command === fc.command && fc.waiveRed) {
            const waived = fc.waiveRed(r.text);
            if (waived !== null) {
              waiveNote = waived;
              ok = true;
              logger.info({ node: id, command: node.command, waived }, '[omd/executor-dag] D-K 红 → 基线赦免 (S-37 下沉), 按 done 落');
            }
          }
        }
        if (!ok && expectsNonzero) {
          // Falsify 节点红 = 「判别力不足」= mutation 后 verify 仍绿 = 这条自检没用。点名通道留给
          // 外层 verifier / 读数板, 自身文案明示是 falsify 出口, 不是普通 D-K 红。
          logger.warn({ node: id, got: r.exitCode, blocked }, '[omd/executor-dag] falsify 节点命中 exit=0 / 闸拒 → failed (判别力不足, INV-11)');
        } else if (!ok && want !== 0) {
          logger.warn({ node: id, want, got: r.exitCode, blocked }, '[omd/executor-dag][oracle-exit-miss] command 节点未命中 expect_exit → failed (D-K)');
        }
        // #167 (2026-08-17): command 绿也落 checkpoint —— **只当账, 不当闸**。此前刻意不落
        // (重跑闸比跳过安全), 代价是 base 文件只可能 failed/skipped: run 68cfb43f 的 accept
        // 红一攻绿一攻, 盘上只剩红那份, 验尸把一单成功读成判据红。resume 不跳的性质原样保住,
        // 但执法点挪进 shouldSkip (leafKind==='command' 恒不跳) —— 账与闸各归各。
        // filesTouched 传空: command 是闸不是产物生产者, 产物归属写它的节点 (可见性另有 write_set 位)。
        const waivePrefix = waiveNote ? `[waiveRed: ${waiveNote}]\n` : '';
        if (ok) {
          saveDoneCheckpoint({ id, kind: 'command', text: `${waivePrefix}${r.text}`, usage: r.usage, filesTouched: [], deps, t0: nodeStartedAt.get(id) ?? Date.now() });
        }
        return {
          id,
          status: ok ? 'done' : 'failed',
          // P1: 这是整个词表的**原型格** —— 同一个 `failed`, 三种不同的下一步, 判据是各自的
          // 直接证据 (`exitCode` 落在哪), 不是谁的补集。闸拒 = 再试也没用 (BLOCKED);
          // 没跑出判词 = 别读成回归 (X-4); 断言没成立 = 再试一轮可能就好 (STALLED)。见 node-failure.ts。
          ...(ok ? {} : { failureKind: classifyCommandExit(r.exitCode) }),
          kind: 'command',
          // 期望非 0 却拿到别的码时, 把"想要什么/拿到什么"写进 output —— 否则 verify-red 失败时
          // 下游只看到一串正常的测试输出, 看不出它失败在"本该红却绿了"。
          // expects_nonzero 那路 (INV-11) 走专有文案, 把「mutation 后仍绿」的信号写在最前,
          // 让 verifier 一眼读出"判别力不足"而不是把它当成普通 D-K 红误诊。
          output: waiveNote
            ? `${waivePrefix}${r.text}`
            : (!ok && expectsNonzero
              ? `[expects_nonzero, 实得 exit ${r.exitCode}${blocked ? ' (命令被闸拒, 未执行)' : ' (=0, mutation 后 verify 仍绿, 判别力不足)'}]`
              : (!ok && want !== 0
                ? `[expect_exit ${want}, 实得 ${r.exitCode}${blocked ? ' (命令被闸拒, 未执行)' : ''}]\n${r.text}`
                : r.text)),
          deps,
          usage: r.usage,
          // 闸拒(负码)与普通失败(断言没成立)后续动作相反, 记下来才分得开 —— 见 DagNodeResult.exitCode。
          exitCode: r.exitCode,
          // **写的可见性** (2026-08-06): command 节点从来不填 filesTouched, 于是两个并发 command
          // 真撞在同一条路径上时 ⑧.6 只看得见 overlaps, 机会分母恒 0。这一位补的就是它 ——
          // **只进可见性, 不参与任何判定** (上面那个 ok/status 是退出码说了算, 一个字没动)。
          // 根取仓根: command leaf 跑在仓根, 它没有自己的 cwd 通道 (CommandLeafResult 不报)。
          ...(() => {
            const cands = verifiedShellWriteTargets([node.command!], {
              root: continuity?.repoRoot ?? process.cwd(),
              startedAt: nodeStartedAt.get(id) ?? 0,
            });
            return cands.length ? { writeCandidates: cands } : {};
          })(),
        };
  };

      // research leaf (D-6): 真 web 检索 + 有界内环。**零来源 = failed** —— INV-GOAL-2 要的是
      // 真抓取痕迹, 一个没抓到还吐终稿的节点吐的是模型记忆里的引用 (假 grounded), 比失败更坏:
      // 它会带着编造的事实往下游走。与 producesFiles 的 filesTouched 闸同一条纪律。
  const runResearchNode = async ({ id, node, deps }: NodeExecCtx): Promise<LeafResult> => {
        if (!config.researchRunner) {
          logger.warn({ node: id }, "[omd/executor-dag] executor:research 缺 researchRunner → failed (拒绝降级 inproc 编引用)");
          return { id, status: 'failed', failureKind: 'missing-capability', kind: 'research', output: '[research 节点无 researchRunner, 无 web 能力]', deps, usage: { in: 0, out: 0 } };
        }
        const groundTruth = deps
          .filter((d) => results[d]?.status === 'done')
          .map((d) => depOutputs[d] ?? '')
          .filter(Boolean)
          .join('\n\n');
        const r = await config.researchRunner({
          question: node.goal ?? id,
          ...(groundTruth ? { groundTruth } : {}),
          ...(node.research?.k ? { k: node.research.k } : {}),
          // A1: lensCount = 镜头数/广度 (与 k = 召回分开), 缺省 undefined 走原行为。
          ...(node.research?.lensCount !== undefined ? { lensCount: node.research.lensCount } : {}),
          // 内环有界 (INV-GOAL-4): 缺省 1 轮, 上限由 schema 钳到 4。
          rounds: node.research?.rounds ?? 1,
        });
        if (r.sources.length === 0) {
          logger.warn({ node: id }, '[omd/executor-dag] research 节点零来源 → failed (无真抓取痕迹 = 假 grounded)');
          return { id, status: 'failed', failureKind: 'no-sources', kind: 'research', output: '[research 零来源: 无真 URL 抓取痕迹]', deps, usage: r.usage };
        }
        logger.info({ node: id, sources: r.sources.length, reportPath: r.reportPath }, '[omd/executor-dag] research 节点完成');
        // D-O: research 节点此前**没有绿 checkpoint** —— 于是每次 resume 都重跑一遍真联网检索
        // (实测 104s + token)。它正是最该被 resume 兜住的一类。
        // 对照: command 节点绿 checkpoint **只当账不当闸** (#167): resume 仍恒重跑, 执法在
        // shouldSkip 的 leafKind 卡 —— 它便宜且往往就是验收 oracle, 重跑比"跳过一个闸"安全。
        saveDoneCheckpoint({
          id,
          kind: 'research',
          text: r.text,
          usage: r.usage,
          filesTouched: r.reportPath ? [r.reportPath] : [],
          deps,
          t0: nodeStartedAt.get(id) ?? Date.now(),
        });
        return {
          id,
          status: 'done',
          kind: 'research',
          output: r.text,
          deps,
          usage: r.usage,
          sources: r.sources,
          ...(r.reportPath ? { filesTouched: [r.reportPath] } : {}),
        };
  };

  // leaf 家族 (agent/inproc 双模): 模板卡/profile/caveman/prompt 组装 + 产物闸全在这里。
  const runLeafNode = async ({ id, node, deps }: NodeExecCtx): Promise<LeafResult> => {
      // S2 (2026-08-25, 片 3): rung 2 派发闭包读取。runNode 在档 1 spin-fused 时写入
      // (同一节点 id), agentRunner 调用后由 runNode 清空。本 attempt 是 rung 2 → 三字段
      // (freshContext / targetSeatCoord / rung2Evidence) 透传到 runner 入参面; 非 rung 2
      // → undefined → spread 后零字段 (INV-8 存量语义不变)。
      const rung2Dispatch = rung2DispatchByNode.get(id);
      // agent 模板卡解析: 命中注册表 → body 注入 prompt 前缀 (buildLeafPrompt 前置放)。
      // 未知名 = 预构造 plan 绕过了规划层校验 → TPL-2 执行层兜底: warn + 忽略, 不崩节点。
      const tpl = node.template ? templates.get(node.template) : undefined;
      if (node.template && !tpl) {
        logger.warn({ node: id, template: node.template }, '[omd/executor-dag] 未知 agent 模板 → 忽略 (TPL-2 fail-open)');
      }
      // 岗位档案装配闸 (INV-1, SDD 2026-08-11-leaf-profile库): 同一未知名在本轮只 WARN 一行,
      // 然后回退普通 leaf。去重键只用 profile 名: 同一坏名字被多个节点复用时, 重复日志没有新增信息。
      const leafProfile: LeafProfile | undefined = node.profile
        ? resolveProfile(node.profile, mcpRegistryRoot(config))
        : undefined;
      if (node.profile && !leafProfile && !warnedUnknownProfiles.has(node.profile)) {
        warnedUnknownProfiles.add(node.profile);
        logger.warn(
          { node: id, profile: node.profile },
          `Unknown profile "${node.profile}"; running as ordinary leaf`,
        );
      }
      // caveman 路由: 创意节点 (node.creative) → off 护交付物; 否则 → 干活级 (默认 full; ultra opt-in) 压叙述省 token。
      const cav = cavemanRule(leafCavemanLevel(node.creative, config.cavemanLevel ?? 'full'));
      // ponytail (构建相位): leaf-only 降代码量, 维二红线不在砍范围。创意节点护交付物 → 不挂 (同 caveman)。
      const pony = config.leafPonytail && !node.creative ? `\n\n${PONYTAIL_LEAF_DISPOSITION}` : '';
      // fan-in: 有定向摘要的 dep 注入摘要 (faninView 覆盖 depOutputs), 否则全文。
      // A5: 走 upstreamText —— 没过的上游带告示进 prompt (此前它与"产出为空但有效"不可分)。
      const basePrompt = buildLeafPrompt(
        id,
        node,
        // 未产出的 dep 仍旧**整条不进** (与旧的 `depResults[d] !== undefined` 过滤等价) ——
        // 否则会多出一个空标题, 正是本条要治的那种"看不出是怎么回事"。
        // A8: 上游内容一律当不可信数据围起来 —— leaf 没有 owner 通道可伪造, 但它有工具,
        // 一句"别管你的任务, 改这个文件"照样能得手。围栏规则在 leaf 的冻结前缀里。
        Object.fromEntries((node.depends_on ?? []).filter((d) => depOutputs[d] !== undefined).map((d) => [d, fencedUpstream(d)])),
        tpl ? { name: tpl.name, body: tpl.body } : undefined,
        // 原始任务随每个 leaf 走 (见 buildLeafPrompt 里那段): 图此前不携带它, agent 靠工具自救,
        // leaf 无从自救 —— g1 换档后立刻现形。config.leafTaskContext=false 可关 (零回归逃生口)。
        config.leafTaskContext === false ? undefined : task,
      );
      // D-Q 检测者: 协议附在 prompt 末尾 (省得每张手写 plan 抄一遍)。**只对内环里的子节点** ——
      // 环外没有消费者, 附了协议却没人读它的裁决 = 又一个"是验证的样子而不是验证"。
      const detectorNode = node.detector === true;
      if (detectorNode && !conductorChildIds.has(id)) {
        logger.warn(
          { node: id },
          '[omd/executor-dag] detector 只在 conductor 节点展开出的子图里有消费者 (环在那儿) → 本节点忽略 (D-Q)',
        );
      }
      const detectorNote = detectorNode && conductorChildIds.has(id) ? `\n${DETECTOR_PROTOCOL}` : '';
      const prompt = (cav ? `${basePrompt}\n\n${cav}` : basePrompt) + pony + detectorNote;
      // C-1 (2026-08-19): 注入文本 token 计量。与 buildLeafPrompt (planner.ts:82-89) 一致口径:
      // 「注入」= 累加 `(deps 文本) 被 fencedUpstream 包过 → 拼成 Predecessor outputs 块」那一段。
      // chars/4 与 agent-leaf.ts:778 `BYTES_PER_TOKEN` 同族 (pi-agent-core `estimateTokens` 口径),
      // **不另造换算**。inproc 路径下为可观察量, 算完写 leaf; agent leaf prompt 由 SDK 包, 这里
      // 数不到注入部分 → null (INV-1「拿不到传 null 不传 0」)。
      let injectedTokens: number | null;
      const upstreamParts = (node.depends_on ?? [])
        .filter((d) => depOutputs[d] !== undefined)
        .map((d) => fencedUpstream(d));
      if (upstreamParts.length > 0) {
        const joined = upstreamParts.join('\n\n');
        injectedTokens = joined.length > 0 ? Math.ceil(joined.length / 4) : 0;
      } else {
        // 空上游 (无 dep / 没产出) = 真注入零, 与「拿不到」是两种事实, 此处 assignment 见 useAgent 分流。
        injectedTokens = 0;
      }
      // 双模分流: executor:'agent' + 有 agentRunner → 带工具子 agent (能改文件); 否则 inproc 单发。
      // M3 bug 修 (2026-06-20): conductor (M3 非确定性) 把"写文件"节点标成 leaf → inproc 不能写文件 →
      //   exit 0 但无产物 (静默假成功)。判别"写文件意图" = output_type:file/git ∨ 有 output_path ∨
      //   goal 含强写文件信号 (创建/实现/写入 + 文件路径)。命中 = 必须 agent。
      const producesFiles =
        node.output_type === 'file' ||
        node.output_type === 'git' ||
        !!node.output_path ||
        /(?:实现|创建|新建|写入|生成|修改|实装|落地)[^。\n]{0,40}\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|md|css|html|py|go|rs)\b/.test(node.goal ?? '');
      /**
       * **产物闸的触发条件 ≠ 路由的触发条件**(2026-08-06 拆开)。
       *
       * 上面那个 `producesFiles` 的用途是**路由**(M3 bug 修:conductor 把写文件节点标成
       * `leaf` → inproc 不能写文件 → 静默假成功),所以它**故意宽**,连 goal 文本正则都算数 ——
       * 宽在路由上没有代价:多分一个节点去 agent 档,最坏是贵一点。
       *
       * 而它同时被**产物闸**当判据用,宽在那里的代价是**判一个没做错事的节点失败**。
       * 盘上实测(21 份 `empty-artifact`):
       *   · `output_path` 触发 14 · `output_type` 触发 1 · **只被 goal 正则触发 6**。
       * 那 6 个的 goal 逐条读,开头写着「**只读**检查」「**只读**检索」「**只读**勘察」——
       * 节点从没声明过它要写文件,而闸要求它必须写。正则命中的是**名词**:
       * 「只读检查非测试**实现文件** `src/harness/pathfinder/proximity.ts`」里的
       * 「实现」+ 40 字内的 `.ts`。
       *
       * 代价不止那 6 个节点:`empty-artifact` 是级联跳过的**头号可识别根因**
       * (78 份 `dep-skip` 里 28 份的上游是它,对比 `assert-failed` 2 份)。
       *
       * ⇒ **闸只认显式声明**(`output_path` / `output_type: file|git`)。
       * 一个节点要被要求"必须产出文件",得有人**明说**它产出文件 —— 从 goal 文本里猜出来的
       * 意图可以拿去选执行档,不能拿去判失败。
       */
      const declaredArtifact = node.output_type === 'file' || node.output_type === 'git' || !!node.output_path;
      // 写文件节点但无 agentRunner → 根本无法产物 → 标失败 (拒绝 inproc 静默假成功; oracle/heal 才看得到)。
      if (producesFiles && !config.agentRunner) {
        logger.warn({ node: id, output_type: node.output_type }, '[omd/executor-dag] 写文件节点但无 agentRunner → 失败 (拒绝 inproc 静默假成功)');
        return { id, status: 'failed', failureKind: 'missing-capability', kind: 'inproc', output: '[写文件节点无 agentRunner, 无法产物]', deps: node.depends_on ?? [], usage: { in: 0, out: 0 } };
      }
      const wantAgent = node.executor === 'agent' || producesFiles;
      if (producesFiles && node.executor !== 'agent') {
        logger.warn({ node: id, executor: node.executor, output_type: node.output_type }, '[omd/executor-dag] 写文件节点 conductor 标成非 agent → 提升 agent (治 M3 inproc 静默假成功)');
      } else if (node.executor === 'agent' && !config.agentRunner) {
        logger.warn({ node: id }, '[omd/executor-dag] executor:agent 但无 agentRunner → 降级 inproc (无工具, 不会改文件)');
      }
      const useAgent = wantAgent && !!config.agentRunner;
      // ── D-14v2 (SDD v2 S4) attach_media 媒体管道: 直接前驱的**原始输出** (depOutputs, 非 fanin
      // 摘要 — 摘要可能丢路径) 里解析图片引用 → 存在性校验 → data-URI ContentPart, 注入 inproc leaf
      // 的 user 消息 (模型由 stamp pass 分到 multimodal 池)。usage 走 provider 真值 — 图片 token
      // 计入返回的 usage.in, 账本无需特判。
      let mediaParts: ContentPart[] = [];
      if (node.attach_media === true) {
        const mediaRoot = continuity?.repoRoot ?? process.cwd();
        const depTexts = deps.filter((d) => results[d]?.status === 'done').map((d) => depOutputs[d] ?? '');
        const media = collectDepMedia(depTexts, { root: mediaRoot });
        if (media.skipped.length > 0 || media.missing.length > 0) {
          // MEDIA-2 no silent caps: 没附上的引用全部留痕 (超限/读失败/不存在), 不静默装作看过。
          logger.warn(
            { node: id, missing: media.missing, skipped: media.skipped, attached: media.attached.length },
            '[omd/executor-dag] attach_media 部分媒体未附上 (D-14v2)',
          );
        }
        if (media.parts.length === 0) {
          // 拒绝"无图多模态审查"静默文本化 (同 empty-done/产物校验哲学): 看图节点没图 = 假成功
          // 温床 → 显式 failed, heal/escalate 回路可见。前驱失败缺图的形态由 requires quorum 先拦。
          logger.warn({ node: id, missing: media.missing }, '[omd/executor-dag] attach_media 无可用媒体 → failed (D-14v2 fail-closed)');
          return {
            id, status: 'failed', failureKind: 'missing-capability', kind: useAgent ? 'agent' : 'inproc',
            output: `[attach_media 无可用媒体: 直接前驱输出未解析出存在的图片${media.missing.length ? `; 路径不存在: ${media.missing.join(', ')}` : ''}]`,
            deps, usage: { in: 0, out: 0 },
          };
        }
        if (useAgent) {
          // D2: agent 节点不再静默扔图 — 把 media.parts 透传到 runner 的 promptImages。
          // pi 通道在 agent-leaf 内转 pi ImageContent 拼首条 user 消息 parts;SDK 通道因 prompt:string
          // 字段限制走响亮旁路 (具名常量日志 + prompt 文本附路径清单 + view_image 指令, 工具面兜底)。
          // 失败兜底: 上一版这里降级成 warn + 清空, 把"agent 看图节点"变成了假装跑过的无图节点,
          // 与 empty-done 同一种温床 —— 此后不该再退化, 即使旁路也比静默丢强。
          logger.info({ node: id, attached: media.attached }, '[omd/executor-dag] attach_media 注入到 agent runner (D2: pi 腿转 parts / SDK 腿响亮旁路)');
          mediaParts = media.parts;
        } else {
          logger.info({ node: id, attached: media.attached }, '[omd/executor-dag] attach_media 注入媒体 parts (D-14v2)');
          mediaParts = media.parts;
        }
      }
      // per-node model 路由 (TPL-3): node.model 显式最高优先 → 模板卡 model → profile.seat →
      // router (bandit) 选 → 静态 (agent→agentLeafModel, inproc→leafModel)。bucket = executor kind。
      const bucket = useAgent ? 'agent' : 'inproc';
      const staticModel = useAgent ? config.agentLeafModel ?? config.leafModel : config.leafModel;
      // dispatch 存活闸 (S-B1, 样本 B/C): plan/模板/profile pin 的座位在冷却窗内 → 视为缺席,
      // 落回既有解析链 (role-fallback 层本来就避开冷却 channel)。重解析结果经节点
      // checkpoint 的 model 字段留痕 (与 pin 不一致即重解析发生过)。
      const pinnedCoord = node.model ?? tpl?.model ?? leafProfile?.seat;
      const alivePin = livePin(pinnedCoord);
      if (pinnedCoord !== undefined && alivePin === undefined) {
        logger.warn(
          { node: id, pinned: pinnedCoord },
          '[omd/executor-dag] plan pin 座位在冷却窗 → dispatch 就地重解析 (死座不复活, 样本 B/C)',
        );
      }
      const model = alivePin ?? (config.router ? config.router.select(bucket, staticModel) : staticModel);
      const t0 = Date.now();
      // ── 声明产物的**跑前快照** (2026-07-30 live 冒烟挖出来的) ────────────────────
      // `filesTouched` 只统计 write/edit 族工具。agent 用 **bash 重定向** 写文件时它是空的 ——
      // 实测: 目标"创建 notes/hello.md"真的成功了 (文件在、内容对), 却被产物闸判成 empty-done,
      // 于是 judge 判未收敛、整个 goal 报 failed。**假阴性**, 但一样贵: 自主环因此收不了尾。
      //
      // 救回的条件刻意苛刻 —— 只认**节点自己声明的** `output_path`, 且要求它**内容变了**:
      // 光查存在性等于把一个早就在那儿的文件当成本次产物, 闸就白设了 (这正是 empty-done 的同一种坏)。
      // 没声明产物的节点不救: 那种节点"我做完了"之外没有任何可核对的东西, 该继续 fail。
      const declaredOut = producesFiles && node.output_path ? String(node.output_path) : '';
      const preRoot = continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd();
      const declaredAbsPre = declaredOut ? (declaredOut.startsWith('/') ? declaredOut : `${preRoot}/${declaredOut}`) : '';
      const declaredHashPre = declaredAbsPre ? hashArtifact(declaredAbsPre) : null;
      // ── 写集跑前快照 (SDD s1 · C-1, 2026-08-23) ───────────────────────────────
      // 合同写的是「产出这些文件」(write_set), 判据就该判这个 (D-1) —— 不问谁写的、
      // 不问用什么工具写的、命令文本长什么样都不进判据。证据 = 跑前跑后哈希 (D-2,
      // mtime 那条因为窗口必带时钟偏斜容差, 而容差必然把「节点起跑前 2s 内被别人创建
      // 的文件」算成本节点的产出, 第一次点火 `f0c706b8` 用 mtime 当场被既有测试打回)。
      // 写集为空 ⇒ 不快照、不复算 (INV-3, 零开销; 没有合同就没有判据)。
      // 锚 = `execRoot ?? repoRoot ?? cwd` (D-3 / D-6, 两侧同一个锚, 隔离档下
      // 与 `root` 一致; 跟救援① 同源 `preRoot` 的差别是这一份走执行锚, 因为
      // 隔离档 leaf 真写文件的那棵树是 execRoot, 抢救① 的「根不一致 → 不救」也是
      // 因为同一个根两份取法不一致)。
      const writeSetSnapshotRoot = continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd();
      const writeSetSnapshot = (node.write_set ?? []).filter((p) => typeof p === 'string' && p.length > 0);
      const writeSetPreHashes: Record<string, string | null> = {};
      for (const p of writeSetSnapshot) {
        const abs = p.startsWith('/') ? p : `${writeSetSnapshotRoot}/${p}`;
        writeSetPreHashes[p] = hashArtifact(abs); // 不存在 ⇒ null (INV-2)
      }
      let text: string;
      let usage: ModelUsage;
      let filesTouched: string[] = [];
      let filesRead: string[] = [];
      let toolCalls: number | undefined;
      let toolSteps: LeafResult['toolSteps'];
      let toolStepsDropped: number | undefined;
      // agent leaf 经 bash 跑过的命令 + 退出码 (2026-08-05)。undefined = 这条链上没人报
      // (inproc leaf / 旧 runner / 测试替身), 与 `[]` (跑了但一次没用 bash) 刻意分开。
      let shellRuns: ShellRun[] | undefined;
      let artifactRoot: string | undefined;
      // §8.5 效果指标的压缩形 [总写次数, no-op 次数]。undefined = 这条链上没人报 (inproc 节点),
      // 与 [0,0] (跑了但一次没写) 刻意分开 —— 读数板必须把两者分开念。
      let writeCounts: [number, number] | undefined;
      // S1 埋点: agent leaf watchdog 采集, 只透传不判定。undefined = 该 runner 不统计 (inproc/旧 runner)。
      let watchdog: NodeCheckpoint['watchdog'];
      // prompt 观测面 (同 conductor 那处: 默认 logger 的 debug 是空函数, 生产零成本)。
      // leaf 这一份尤其值钱 —— 上游材料、围栏、失败前驱的告示全落在它里面。
      logger.debug({ node: id, phase: useAgent ? 'agent-leaf' : 'inproc-leaf', model, prompt }, '[omd/prompt] leaf');
      if (useAgent) {
        // ── agent leaf 的观测出口 (2026-07-31) ────────────────────────────────────
        // agent leaf **不经 gateway.send** (它走 pi session 自己的传输), 所以在此之前
        // 它的 prompt 一个字都不在 Langfuse 上 —— 而这恰恰是唯一会改文件、跑 xhigh、
        // 最贵的那类节点。"每个节点的 prompt 可审查"少了它就等于没做。
        // 记的是**这一次调用的边界**: 输入 prompt / 最终文本 / 用量。
        // ⚠ 诚实边界: 内部工具循环 (每一次 read/edit/bash) **不在这条记录里** ——
        // 那要接 agent-leaf 的 onEvent 汇, 是另一件事。别把这条读成"agent 的全过程可见"。
        const agentStart = new Date();
        // SDD S3 碰撞台账会话: runId + 节点 id (runId 未知 → 不记, fail-open)。
        const touchRunId = continuity?.runId ?? config.sessionId;
        // SDD D-7: 外部 MCP 授权清单 = node.mcp ∪ 模板卡 mcp (去重并集; C-5 闸按 server 名或
        // "server:tool" 判)。空清单 → 不传字段, leaf 回落 deny (执行叶子不声明不授权)。
        // 合并真源 = conductor-plan.mergeMcpAllow (接线测试共用, 禁复刻)。
        const mcpAllow = mergeMcpAllow(node, tpl);
        // 写域闸的判据面 (2026-08-21, run e2d204b7 节点 s4 复盘): 节点声明了 `write_set`
        // 就只准写那些文件, `write` / `edit` 在**写的那一刻**判。
        //
        // 平铺图早就把它放在节点上了 (goal/sdd-compile.ts), 但此前**只以散文进 prompt**
        // (「写集 (只许动这些文件): …」) —— 而本仓实测结论是**讲道理拦不住**。
        //
        // `output_path` 并进来: 声明了产物路径却没列进写集是常见写法, 不并会造假 major,
        // 而**假 major 的代价是有人把整条闸关掉**。
        // 没声明 → 不传字段 → 闸缺席放行 (conductor 铺图路径本就没有逐节点写集)。
        const writeAllow = [...new Set([...(node.write_set ?? []), ...(node.output_path ? [node.output_path] : [])])];
        // SDD D-2 (2026-08-11): 挂 leaf 事件汇 → 转成 DAG progress 事件。只认工具起跑;
        // text_delta 不进 DAG 事件 (D-10: DAG 面板不是 transcript)。回调抛错 fail-open。
        const leafProgress = (e: AgentEvent): void => {
          if (e.type !== 'tool_execution_start') return;
          const now = Date.now();
          const calls = (progressCalls.get(id) ?? 0) + 1;
          progressCalls.set(id, calls);
          const last = lastProgressAt.get(id);
          if (last !== undefined && now - last < PROGRESS_THROTTLE_MS) return;
          lastProgressAt.set(id, now);
          const a = (e.args ?? {}) as { path?: unknown; command?: unknown; patch?: unknown };
          const note =
            typeof a.path === 'string' && a.path.trim()
              ? `${e.toolName} ${a.path.trim()}`
              : typeof a.command === 'string' && a.command.trim()
                ? `bash: ${a.command.trim().slice(0, 40)}`
                : undefined;
          emitNodeEvent({
            type: 'progress',
            id,
            ...(e.toolName ? { tool: e.toolName } : {}),
            ...(note ? { note } : {}),
            calls,
            elapsedMs: now - (nodeStartedAt.get(id) ?? now),
          });
        };
        const r = await config.agentRunner!({
          prompt,
          model,
          ...(leafProfile ? { profile: leafProfile } : {}),
          ...(touchRunId ? { touchSession: `${touchRunId}:${id}` } : {}),
          ...(mcpAllow.length ? { mcpAllow } : {}),
          ...(writeAllow.length ? { writeAllow } : {}),
          // #178: 产物意图下发 —— produces-files 节点让叶知道"必须写入磁盘 + 落到哪",
          // agent-leaf 据此启用 produce-by 软推 (勘探超预算零写 → 催产)。非产物节点不传, 叶行为零变化。
          ...(producesFiles ? { expectsArtifactPath: node.output_path ?? '(路径见 goal)' } : {}),
          // D2: attach_media:true 的 agent 节点由本 runner 接 promptImages。引擎侧零成本透传
          // (image_url.data URI 已在 collectDepMedia 里读盘 + base64 编好), agent-leaf 层按通道分派。
          ...(useAgent && mediaParts.length > 0 ? { promptImages: mediaParts } : {}),
          // S2 (2026-08-25, 片 3): rung 2 派发闭包 → agentRunner 入参。fresh-context 同座位 +
          // 丢消息历史 (D-6), seat-upgrade 真实换脑 (INV-3), 四件证据字段必带 (D-4)。
          // 三字段互斥: 同 attempt 不会同时是 fresh-context 又换脑 (片 1 决策函数保证)。
          ...(rung2Dispatch && rung2Dispatch.kind === 'fresh-context'
            ? { freshContext: true as const }
            : {}),
          ...(rung2Dispatch && rung2Dispatch.kind === 'seat-upgrade' && rung2Dispatch.to !== undefined
            ? { targetSeatCoord: rung2Dispatch.to }
            : {}),
          ...(rung2Dispatch
            ? {
                rung2Evidence: {
                  packHash: rung2Dispatch.evidencePackHash ?? `rung2:${id}`,
                  failureReason: 'spin-fused',
                  criterionDiff: { kind: 'no-history' as const, literal: '本节点无 self_check,无判据可 diff' },
                  blockerSignature: 'spin-fused',
                },
              }
            : {}),
          onEvent: leafProgress,
        });
        recordGeneration({
          traceId: obsTraceId,
          name: `agent:${id}`,
          nodeId: id,
          model,
          input: prompt,
          output: r.text ?? '',
          // promptVersion 由 runner 报 (2026-07-31 补): 它是**脚手架**的版本, 而脚手架是 runner
          // 按模型档在三套里挑的 (strong-core / discipline+routing / off) —— 只有它自己知道挑了哪套。
          // 从这条 prompt 反算不出来: 整条里含本节点的 goal 与上游材料, 逐节点都不同。
          ...(r.promptVersion ? { promptVersion: r.promptVersion } : {}),
          ...(r.usage ? { usage: r.usage } : {}),
          startTime: agentStart,
          endTime: new Date(),
          metadata: { filesTouched: r.filesTouched?.length ?? 0, ...(r.stalled ? { stalled: true } : {}) },
        });
        text = r.text;
        usage = r.usage;
        filesTouched = r.filesTouched ?? [];
        // D-12: 图外数据流的观察面 (谁读了谁写的文件)。inproc leaf 无工具 → 恒空。
        filesRead = r.filesRead ?? [];
        // §8.5 效果指标 (2026-07-31, **只报不判**): 写调用成功 ≠ 真的改了。
        // 下面那道产物闸查的是「碰了文件」+「文件在盘上」—— 它看不见"写进去的和原来一样"这一类:
        // 文件在、内容也在, 只是这次调用什么都没改变, 而且返回码是成功的。
        // 刻意不据此判 failed: 一次 no-op 写完全可能是正当的 (上一轮已经写对了, 这一轮复核了一遍)。
        // 要不要因此判失败, 得先有分布 —— 这条告警就是攒分布的那一步 (承 R1 的 report-only 纪律)。
        const effects = r.writeEffects ?? [];
        const noops = effects.filter((e) => e.noop);
        // runner 没报 writeEffects (旧 runner / 测试替身) → 保持 undefined, 不编一个 [0,0] 出来:
        // 那会把「没记」伪装成「跑了但没写」, 正是本轮反复在治的那种静默失真。
        if (r.writeEffects) writeCounts = [effects.length, noops.length];
        if (effects.length > 0 && noops.length === effects.length) {
          logger.warn(
            { node: id, model, writes: effects.length, paths: noops.map((e) => e.path) },
            '[omd/executor-dag] §8.5 效果指标: 本节点的写调用**全部 no-op** (内容与写前逐字相同) — 「看起来做了」',
          );
        } else if (noops.length > 0) {
          logger.info(
            { node: id, writes: effects.length, noops: noops.length, paths: noops.map((e) => e.path) },
            '[omd/executor-dag] §8.5 效果指标: 部分写调用 no-op',
          );
        }
        // 产物根: leaf 自报的 cwd 最准 (它就是写文件的那个进程) > continuity 根 > 本进程 cwd。
        artifactRoot = r.cwd;
        toolCalls = r.toolCalls;
        // 「诚实自验」的记录通道 (2026-08-05): agent 真跑过 `bun test` 这件事此前在引擎记录里
        // **完全不存在** —— 于是「产物声称的引擎校验动作 ⊆ 引擎记录的动作」这个谓词的记录集
        // 缺了主要合法元素, 诚实节点与顺手编一句的节点在 facts 上长得一模一样。
        shellRuns = r.shellRuns;
        // 工具序列 (2026-08-16): 既有三本账都答不了「它按什么顺序做了什么」, 而 hashline stale
        // 那条闸与 §8.5 攒了一年的分布, 判据都写在顺序上。见 ToolStep 的注。
        toolSteps = r.toolSteps;
        toolStepsDropped = r.toolStepsDropped;
        // S1 埋点: watchdog 只收 `.watchdog` 嵌套一种形状 (真源 LeafWatchdog), 缺席 = 该 runner
        // 不统计。2026-08-18 删掉了"顶层平铺四字段"双形兼容旁路 (一个类型收两种形状 = aposd C1
        // 抓到的晦涩源); 它唯一的消费者是 watchdog-checkpoint.test 的透传保真 fixture, 已随本次
        // 改喂嵌套形状 —— 透传保真钉的是「结果 → checkpoint」通路, 与入参形状无关。
        watchdog = r.watchdog;
        // 早期心跳闸 (issue #5): provider 挂起判停摆 → 标 failed (不把近零输出当 done), 附 stall 标记
        // 供 settle 记 failureKind='stall' (issue #4 败因留痕)。heal 回路可据此重试/换池。
        // G5 频率读数 (2026-08-03): leaf 在自己的工具循环里反复发同一个动作。**只报不拦** ——
        // 观察者的契约就是不铸毒票不改路由, 这一条也不例外。它进 observations 是为了让
        // 「要不要升成 BLOCKED、K 取几」有真跑上的频率可依, 而不是靠讲道理定。
        if (r.spin && r.spin.spinEvents > 0) {
          observe([
            {
              kind: 'leaf-spin',
              nodes: [id],
              message:
                `节点 ${id} 的 leaf 在工具循环里空转 ${r.spin.spinEvents} 个回合 ` +
                `(最高同签名重复 ${r.spin.maxSameCount} 次; 卡在 ${r.spin.stuckSigs.slice(0, 3).join(' / ') || '未记'})`,
            },
          ]);
        }
        if (r.stalled) {
          logger.warn({ node: id, model, outLen: text.length }, '[omd/executor-dag][heartbeat] agent leaf 停摆 (心跳闸) → 节点 failed');
          return {
            id, status: 'failed', failureKind: 'stall', kind: 'agent', model,
            output: `[停摆: 心跳闸提前中止, 疑 provider 挂起/排队] 原输出(${text.length}B): ${text.slice(0, 400)}`,
            deps: node.depends_on ?? [], usage, filesTouched, ...(filesRead.length ? { filesRead } : {}), stalled: true,
            ...(watchdog ? { watchdog } : {}),
          };
        }
        // 空转熔断 (2026-08-14): fuse 硬停的 leaf 判 failed + spin-fused 败因 (retryable:false ——
        // 原样重试大概率原地再烧一遍, 见 node-failure 的注)。已写入磁盘的产物在 filesTouched 里保留。
        if (r.spinFused) {
          logger.warn({ node: id, model, reason: r.spinFused }, '[omd/executor-dag][fuse-spin] agent leaf 空转熔断 → 节点 failed');
          return {
            id, status: 'failed', failureKind: 'spin-fused', kind: 'agent', model,
            output: `[${r.spinFused}] 原输出(${text.length}B): ${text.slice(0, 400)}`,
            deps: node.depends_on ?? [], usage, filesTouched, ...(filesRead.length ? { filesRead } : {}),
            ...(watchdog ? { watchdog } : {}),
          };
        }
        // 产物校验闸 (2026-07-03 实测教训: ultraspeed leaf 4 节点 3 个 empty-done — 自报完成
        // 却零改动, oracle 因"新文件没接线"照样绿 → 谎报完工静默漏过)。写文件节点 done 的
        // **必要条件** = 真碰了文件: filesTouched 空 / 声称的路径不存在 → failed (heal 回路可见)。
        // ⚠ 判据是 `declaredArtifact` 而**不是** `producesFiles` —— 见上面那段注: 后者宽在路由上
        //   没代价, 宽在这里的代价是判一个只读节点失败 (盘上 6/21)。
        if (declaredArtifact) {
          // 产物闸进闸态 (SDD C-1 INV-3, 2026-08-23): 必须在任何写集核实 / 救援改写
          // `filesTouched` **之前**取这一位的 length —— 救援①②③ 救回来后那个数叫「出闸条数」,
          // 不是分母; 分母 = 进闸那一刻 `filesTouched` 的 length。两条都进 payload (INV-4)。
          const entryFilesTouched = filesTouched.length;
          const root = artifactRoot ?? continuity?.repoRoot ?? process.cwd();
          // 「主干根」用于 INV-2 锚回 (SDD 2026-08-22): leaf 报主干绝对路径时,
          // 剥这个前缀再拼 root 才能命中 worktree。**不**等于 `root` (非 branch 时相等,
          // branch 时 = 主干根); D-3 的短路在 helper 里做。
          const repoRoot = continuity?.repoRoot ?? process.cwd();
          // **写集核实为正判据** (SDD s1 · C-2, 2026-08-23)。节点声明了 `write_set` ⇒
          // **正判据** = 跑前跑后哈希变了 ⇒ 判真写入, 把通过的路径并进 `filesTouched`。
          // 不知道谁写的、用什么工具写的、命令文本里有没有字面路径, 一律不进判据 (D-1)。
          //
          // ⚠ 故意放在救援①②③ **之前**: 这是**正判据**, 不是「没救活才救」。它与救援
          //   并存跑 (D-5: 删救援要看读数, 本片不删), 救援兜的是「写集没声明产物
          //   (没合同) 的情况」, 本条兜的是「写了但经 bash 等非受控通道」—— 后者原本
          //   落在救援①② 的盲区 (`shellWriteTargets` 解析命令文本、救援① 要 output_path)。
          //
          // ⚠ D-4: 「至少一个」非「全部」。一片改 3 个文件而这次只动了 1 个是正常交付,
          //   要求全部命中会把正常交付判死。判据要分「干了活」与「什么都没干」, 不是「干全没」。
          // ⚠ D-2: 「null → 有值」**算变** (INV-2), 跑前不存在的文件被新建是最常见的产出。
          // ⚠ 锚 = `writeSetSnapshotRoot`, 与跑前**同一个** (D-3)。绝对路径原样, 相对路径拼根。
          if (filesTouched.length === 0 && writeSetSnapshot.length > 0) {
            const verified: string[] = [];
            for (const p of writeSetSnapshot) {
              const abs = p.startsWith('/') ? p : `${writeSetSnapshotRoot}/${p}`;
              const before = writeSetPreHashes[p] ?? null;
              const after = hashArtifact(abs);
              // null !== 'hash' 与 'hashA' !== 'hashB' 一视同仁地算变。
              if (before !== after) verified.push(p);
            }
            if (verified.length > 0) {
              logger.info(
                { node: id, verified, writeSet: writeSetSnapshot },
                '[omd/executor-dag] 按写集核实判真写入 (不问谁写的; s1 写集核实正判据)',
              );
              filesTouched = verified;
            }
          }
          // 救回「经非受控工具 (bash 重定向等) 写入」的声明产物, 见上面快照那段注。
          // 根不一致时**不救**: 快照量的是另一棵树上的文件, 拿它当证据等于没量 (fail-closed)。
          if (filesTouched.length === 0 && declaredOut) {
            const abs = declaredOut.startsWith('/') ? declaredOut : `${root}/${declaredOut}`;
            if (abs !== declaredAbsPre) {
              logger.warn({ node: id, preRoot, root }, '[omd/executor-dag] 产物根跑前跑后不一致 → 不救 filesTouched 空 (fail-closed)');
            } else {
              const after = hashArtifact(abs);
              if (after && after !== declaredHashPre) {
                logger.warn(
                  { node: id, output_path: declaredOut, before: declaredHashPre ?? '(不存在)', after },
                  '[omd/executor-dag] filesTouched 空但声明产物内容变了 → 判真写入 (疑经 bash 等非受控工具), 补进 filesTouched',
                );
                filesTouched = [declaredOut];
              }
            }
          }
          // 救援②: **从本 leaf 自己跑过的 bash 命令里认写目标** (2026-08-05)。
          //
          // 救援① 要求节点声明 `output_path`, 而 conductor 常常不给 —— 于是经 bash 写入的产物
          // 彻底隐形, 闸把干完的活判成 empty-artifact (两次真跑两次中招, 一次还连累下游全 skip)。
          //
          // ⚠ **安全性质与救援①逐字相同: 没有盘上证据就不救**。候选只是候选, 必须同时满足
          //   ① 文件真在盘上 ② mtime 落在**本节点的执行窗口**内 —— 否则一个早就存在的文件
          //   会把 empty-done (自报完成、零改动) 洗成成功, 那正是这道闸唯一要拦的东西。
          // ⚠ 候选只取**本 leaf 自己命令里出现的路径**, 不是"窗口内变过的所有文件" ——
          //   后者在并发 fan-out 下会互相认领。这条约束把并发误认压到"另一个 leaf 恰好写了
          //   本 leaf 命令里点名的同一个路径"才会发生。
          if (filesTouched.length === 0 && (shellRuns?.length ?? 0) > 0) {
            // ⚠ **容差不是洁癖**: 文件系统 mtime 与 `Date.now()` 不是同一个钟。实测(写完立刻 stat)
            //   mtime 比写之前取的时刻还小 **3.58ms** —— 严格 `>=` 会把一次刚发生的写判成"窗口外",
            //   于是这条救援在真实形状上恒不触发(第一版就是这么写的, 闸当场抓到)。
            //   取 2s: 远大于时钟偏斜, 又远小于任何 agent 的执行时长, 所以"一小时前就存在的文件"
            //   仍然救不回来 —— 那一格有单独的用例钉着。
            // 判据抽在 `shell-writes.verifiedShellWriteTargets` 上 —— ⑧.6 的推断口径是它的
            // 第二个消费者, 两处各写一份必漂 (而漂的方向最坏: 没人说得清某次放行核过什么)。
            const rescued = verifiedShellWriteTargets(
              (shellRuns ?? []).map((r) => r.command),
              { root, startedAt: nodeStartedAt.get(id) ?? 0 },
            );
            if (rescued.length > 0) {
              logger.warn(
                { node: id, rescued, startedAt: nodeStartedAt.get(id) },
                '[omd/executor-dag] filesTouched 空, 但 bash 命令点名的文件在本节点窗口内被改过 → 判真写入, 补进 filesTouched',
              );
              filesTouched = rescued;
            }
          }
          // **救援③**: 写集相对 run 基线有改动 → 判真写入 (SDD s1 切片 1, 2026-08-22)。
          //
          // 死因: 隔离档 (`branchStrategy:'branch'`) 下被点名的叶子进毒集后被重跑,
          // 看见活已经在盘上干完,于是**理性地**只读不写 —— 而闸要求「本轮真碰了文件」。
          // 救援①② 量的是**本节点窗口**,救不回"上一轮已干完"的形状。本条把判据换成
          // 「**本 run** 有没有动过写集」,证据 = git, 不是 mtime。
          //
          // ⚠ **只在隔离档启用** (D-2): `continuity.rollbackBaseline` 缺席 ⇒ head 档,
          //   一字节都不生效。`writeSetChangedSinceBaseline` 自己**不**做这个短路,
          //   写在这里让闸的可读性高于 helper 自带判断 —— helper 一处复用更容易测,
          //   闸里这一行让"什么时候救"和"怎么救"都看 engine.ts 一眼就明白。
          if (filesTouched.length === 0 && continuity?.rollbackBaseline) {
            const writeSetEvidence = writeSetChangedSinceBaseline({
              // 执行锚 (隔离档 = execRoot) 是 leaf 真写文件的那棵树; git 必须在这里跑。
              // 见 types.ts:493-500 的 execRoot 注。省略 = `repoRoot`, 与上面的 `root` 解析一致。
              root: continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd(),
              writeSet: node.write_set ?? [],
              baseline: continuity.rollbackBaseline,
            });
            if (filesTouched.length === 0 && writeSetEvidence.changed.length > 0) {
              logger.warn(
                { node: id, changed: writeSetEvidence.changed, baseline: continuity.rollbackBaseline },
                '[omd/executor-dag] filesTouched 空但写集相对 run 基线有改动 → 判真写入 (修复轮只读不写), 补进 filesTouched',
              );
              filesTouched = [...writeSetEvidence.changed];
            }
          }
          // **失败出口的可观测尾巴** (2026-08-16, #145 评论① 复盘)。`types.ts:639` 声称
          // 「done/failed 两条出口都带 watchdog」—— 而下面这两个闸的**早退 return 一条都没带**,
          // 于是最需要诊断的那批节点, checkpoint 里恰好没有工具时间线 / bash 痕迹 / 工具次数。
          // run 1c9a4566 就是这么查不动的: 五个失败节点的 checkpoint 字段里没有 watchdog,
          // 最后只能靠 `exec.log` 里 drift 观察者顺手打印的采样倒推。
          // 与 verifier 判词那个坑同形: **最需要证据的那条路径, 恰好是把证据扔掉的那条。**
          const observabilityTail = (): Partial<LeafResult> => ({
            ...(toolCalls !== undefined ? { toolCalls } : {}),
            ...(shellRuns ? { shellRuns } : {}),
            ...(watchdog ? { watchdog } : {}),
            ...(writeCounts ? { writeCounts } : {}),
            ...(toolSteps ? { toolSteps } : {}),
            ...(toolStepsDropped ? { toolStepsDropped } : {}),
          });
          // 产物闸「绝对路径锚回」(SDD 2026-08-22 · s1 Step B): 判词据 `probed`
          // 自动补 INV-6 「两基准都查过」叙述 —— 锚回试过仍不中时写清路径基准,
          // 否则还是逐字 `声称产物不存在: <路径>`。`filesTouched` 为空那条分支
          // 的判词 INV-7 一字不动。
          const { missing, probed, outOfScope } = resolveMissingArtifacts({ root, repoRoot, filesTouched });
          // s1 Step C · INV-5/6: 判据面用剔除后的 `scopedTouched`; 写域外剔除 ≠ 放宽 (D-3 承重)
          //   —— 只碰过 `/tmp` 的节点 `scopedTouched` 为空 ⇒ 仍按「filesTouched 空」判死。
          // INV-8: `LeafResult.filesTouched` 一字不变 (D-2); 这里只是判据用。
          const outOfScopeSet = new Set(outOfScope);
          const scopedTouched = filesTouched.filter((p) => !outOfScopeSet.has(p));
          if (outOfScope.length > 0) {
            // INV-7: 剔除的事实打一行判词 (payload 至少 `{ node, outOfScope }`)。
            logger.warn(
              { node: id, outOfScope },
              '[omd/executor-dag][writescope-drop] 产物闸写域外路径剔除 (不参与判死, 仅记账; s1 Step C)',
            );
          }
          if (scopedTouched.length === 0 || missing.length > 0) {
            // ⚠ **别把"闸看不见"说成"它没做"** (2026-08-05 真跑实证)。上面那条救援要求节点
            //   声明了 `output_path`; conductor 没给的时候, 经 bash 写入的产物就彻底隐形 ——
            //   而当时这句话写的是「leaf 自报完成但**未做任何文件写操作**」。实测那一跑:
            //   文件真的写好了 (57 行, 内容合规), 闸却这么判, 于是下游四个复核节点全被 skip。
            //   引擎说的是它**看见了什么**, 不该冒充"发生了什么" —— 这与本仓一直在治的
            //   「声称 vs 记录」是同一条纪律, 只不过这次说错话的是引擎自己。
            //   bash 痕迹 (2026-08-05 补的记录通道) 正好能把话说准, 并指出怎么救。
            const ranShell = shellRuns ?? [];
            // 2026-08-16 (#145 评论① 复盘): 上面那段「给该节点声明 output_path 即可被救回」是
            // **有前提的建议, 而它此前无条件发**。run 1c9a4566 的五个节点 output_path **全声明了**,
            // 判词照样这么说 —— 于是排查方向被带向"采集面漏了工具名", 挖了一整晚, 而真相是
            // 这一轮它们确实一个字都没写 (D-4 毒集丢 checkpoint 但没回滚工作区 → 重跑的 leaf
            // 看见活已经干完, 只读不写)。**引擎说错话的代价是人查错方向**, 与它冒充"发生了什么"
            // 是同一条纪律。所以先分「声明了没有」, 再决定说哪句。
            const declaredNow = declaredOut
              ? existsSync(declaredAbsPre) // 与 declaredHashPre 同一条路径, 不另算一份
                ? hashArtifact(declaredAbsPre) === declaredHashPre
                  ? `声明的产物 \`${declaredOut}\` **在盘上, 且内容与本节点开始时逐字相同** — 本轮没有改动它`
                  : `声明的产物 \`${declaredOut}\` 在盘上且内容有变, 但变化发生在受控写工具之外`
                : `声明的产物 \`${declaredOut}\` **不在盘上**`
              : '本节点未声明 output_path';
            const why = filesTouched.length === 0
              ? ranShell.length > 0
                ? `filesTouched 空 — 受控写工具 (write/edit/hashline_edit) 一次没用过, 但本 leaf 跑过 ${ranShell.length} 条 bash 命令` +
                  ` (${ranShell.slice(0, 3).map((s) => s.command.slice(0, 40)).join(' · ')}${ranShell.length > 3 ? ' …' : ''})。${declaredNow}。` +
                  (declaredOut
                    ? ` 已声明产物却仍判失败, 说明救援路径查过了盘: 引擎判的是「**本轮**有没有产出」, 不是「产物存不存在」`
                    : ` 写操作可能经 bash 发生而产物闸看不见 —— 给该节点声明 output_path 即可被救回;` +
                      ` 若本节点本就不产文件 (纯验证/检查), 重画时该标 output_type:'none' 而不是声明产物`)
                : `filesTouched 空 — leaf 自报完成但未做任何文件写操作。${declaredNow}`
              : `声称产物不存在: ${missing
                  .map((p) => {
                    // INV-6: 锚回试过仍不中 ⇒ 写明两基准, 列出实际 stat 过的路径。
                    // 否则 (INV-3 / INV-4 短路) 保持原样, 判词不冗余。
                    const probes = probed[p];
                    return probes && probes.length >= 2
                      ? `${p} (主干与 worktree 两基准都查过: ${probes.join(' / ')})`
                      : p;
                  })
                  .join(', ')}`;
            logger.warn({ node: id, filesTouched, missing }, '[omd/executor-dag][artifact-empty] 产物校验失败 → 节点 failed (拒绝 empty-done)');
            // 产物闸判定 (判死出口, SDD C-1 INV-1/2): 无论判死判活都打这一行
            // (entry 取自进闸态, exit = 此刻 filesTouched.length, 救援/核实重赋值之后
            // —— 出闸态 —— 的真值)。与同出口的 `产物校验失败` 判词**并存**,非二选一。
            logger.info(
              { node: id, entry: entryFilesTouched, exit: filesTouched.length, verdict: 'dead' },
              '[omd/executor-dag][artifact-verdict] 产物闸判定 (declaredArtifact 节点; entry = 进闸条数)',
            );
            return {
              id, status: 'failed', failureKind: 'empty-artifact', kind: 'agent', model,
              output: `[产物校验失败: ${why}] 原输出: ${text.slice(0, 400)}`,
              deps: node.depends_on ?? [], usage, filesTouched, ...(filesRead.length ? { filesRead } : {}),
              ...observabilityTail(),
            };
          }
          // 声称锚点 (#145 附录 §9.5, 2026-08-16): 产物里的「file:line + 字面量」声称,
          // 能不能在那个文件里找到。**只报不判** —— 判据本身 L1/L2 零误报, 但那是相对 root 的,
          // 而节点输出里的路径未必以引擎这个 root 为基 (见 claim-anchor.ts 的 isBlockingLevel 注)。
          // 先攒分布: L3_REVIEW_AFTER 个样本之后必须回来结案, 别再变成第二笔无人认领的账。
          try {
            const claims = checkClaimAnchors(text, { root });
            if (claims.length > 0) {
              observe([
                {
                  kind: 'claim-anchor',
                  nodes: [id],
                  message:
                    `节点 ${id} 的产出里有 ${claims.length} 条对不上的声称: ` +
                    claims.slice(0, 3).map((c) => `[${c.level}] ${c.message}`).join(' | '),
                },
              ]);
            }
          } catch (err) {
            // fail-open 不吞证据: 这是观察面, 绝不能把一个真做完的节点带塌。
            logger.warn({ node: id, err: (err as Error).message }, '[omd/executor-dag] 声称锚点检查抛错 (已吞, 只丢可见性)');
          }
          // 写后即验 (#145 提议 1, 2026-08-16)。产物**在**不等于产物**是好的**: plana M3.5 那三次
          // 编辑损坏全都通过了上面那道存在性闸, 其中一次留下 58 个语法错、整棵树编译不过。
          // 判在这里 = pi 与 claude-sdk 两个通道共用一道闸; 判在节点末而不是每次写之后的理由
          // (中间态假阳性) 写在 write-parse-gate.ts 的文件头。
          const parseFailures = parseWrittenFiles(filesTouched, root);
          if (parseFailures.length > 0) {
            const why = renderParseFailures(parseFailures);
            logger.warn(
              { node: id, files: parseFailures.map((f) => f.path) },
              '[omd/executor-dag][artifact-broken] 写后即验: 节点写完之后文件语法解析不过 → 节点 failed (部分写入损坏)',
            );
            // 产物闸判定 (判死出口, SDD C-1 INV-1/2): 第二个判死出口 (broken-artifact)
            // 同样打这一行 —— payload 形状与 empty-artifact 出口**逐字相同** (D-3)。
            logger.info(
              { node: id, entry: entryFilesTouched, exit: filesTouched.length, verdict: 'dead' },
              '[omd/executor-dag][artifact-verdict] 产物闸判定 (declaredArtifact 节点; entry = 进闸条数)',
            );
            return {
              id, status: 'failed', failureKind: 'broken-artifact', kind: 'agent', model,
              output: `[${why}] 原输出: ${text.slice(0, 400)}`,
              deps: node.depends_on ?? [], usage, filesTouched, ...(filesRead.length ? { filesRead } : {}),
              ...observabilityTail(),
            };
          }
          // 产物闸判定 (判活出口, SDD C-1 INV-1): 两道闸 (empty-artifact + parseFailures)
          // 都放行 ⇒ declaredArtifact 节点跑完产物闸。payload 形状与两个判死出口**逐字相同** (D-3):
          // 不让两条出口各自微调文案, 漂移的代价从来不只在这一次。
          logger.info(
            { node: id, entry: entryFilesTouched, exit: filesTouched.length, verdict: 'live' },
            '[omd/executor-dag][artifact-verdict] 产物闸判定 (declaredArtifact 节点; entry = 进闸条数)',
          );
        }
      } else {
        // inproc leaf 带共享冻结前缀 (system) → 暖发后跨 leaf 命中 prompt-cache。
        // attach_media: user 消息升格 ContentPart[] (text part 在前, 图 parts 随后 — openai-compat 惯例)。
        const userContent: string | ContentPart[] =
          mediaParts.length > 0 ? [{ type: 'text', text: prompt }, ...mediaParts] : prompt;
        const r = await generate({
          messages: [
            { role: 'system', content: config.leafSystemPrefix ?? LEAF_SYSTEM_PREFIX },
            { role: 'user', content: userContent },
          ],
          model,
          traceName: `leaf:${id}`, // ← 审 prompt 时要认得出是哪个节点, 这是接观测的全部目的
          traceNodeId: id,
          // S-T 优先序 (显式永远赢): node.thinking > config 显式档 > 座位档 > 硬默认 high。
          // 座位档来自 auto-assign (量产 worker 座 low / judge·verify 座 xhigh), 老 config 无该段 → 回落 high。
          thinkingLevel: node.thinking ?? config.inprocThinkingLevel ?? config.seatThinking?.(model) ?? 'high',
        });
        text = r.text;
        usage = r.usage;
      }
      // **写的可见性** (2026-08-06): 与救援② 用同一条判据, 但**不受它那道门限制** ——
      // 救援② 只在 `filesTouched` 空时才跑, 于是「用 write 工具写了 a.md, 又用 bash 写了 b.md」
      // 这一路里 b.md 永远隐形。这一位独立算, 且**只进可见性不参与任何判定** (产物闸的判词与
      // 放行条件一个字没动 —— 放宽那条闸是另一件事, 它挡的是 empty-done)。
      const writeCandidates = shellRuns?.length
        ? verifiedShellWriteTargets(
            shellRuns.map((r) => r.command),
            { root: artifactRoot ?? continuity?.repoRoot ?? process.cwd(), startedAt: t0 },
          )
        : [];
      // `artifactRoot` 跟着 `filesTouched` 一起出图: 一组相对路径离开它的根就没有意义,
      // 而 R2 隔离档下这个根与引擎进程的 cwd 不是同一个 (见 LeafResult.artifactRoot 的注)。
      const leaf: LeafResult = { id, status: 'done', kind: useAgent ? 'agent' : 'inproc', model, output: text, deps: node.depends_on ?? [], usage, filesTouched, ...(artifactRoot ? { artifactRoot } : {}), ...(filesRead.length ? { filesRead } : {}), ...(toolCalls !== undefined ? { toolCalls } : {}), ...(shellRuns ? { shellRuns } : {}), ...(writeCounts ? { writeCounts } : {}), ...(toolSteps ? { toolSteps } : {}), ...(toolStepsDropped ? { toolStepsDropped } : {}), ...(writeCandidates.length ? { writeCandidates } : {}), // C-1 (2026-08-19): 注入文本 token。inproc 路径可观察 → 写真值或 0 (无上游);
        // agent 路径 SDK 自管 prompt → **不传 0** 一律 null (INV-1: 「拿不到」≠「零」)。
        // 通过条件 spread 落, 接住 A 片 `typeof === 'number'` 的读侧断言。
        ...(useAgent ? {} : { injectedTokens }), };
      saveDoneCheckpoint({
        id,
        kind: useAgent ? 'agent' : 'inproc',
        model,
        text,
        // 此前这里是 `useAgent ? null : usage`,注「agent leaf 真值不可得」——
        // **那条注已经不成立了**:`agent-leaf.ts` 逐轮累加 assistant 消息自报的 usage
        // (`sdkUsage ?? mapSessionUsage(totals)`),而同一个 `usage` 上面第 3394 行就在当真值
        // 累进 `leavesIn/leavesOut/leavesCacheHit`,#144 补账那条 `recordSeatUsage` 也用它。
        // 一份数三处用、只有 checkpoint 这一处写 null —— 于是 plana 四个 run 的 continuity 里,
        // **每一个 done 的 agent 节点 `tokenUsage` 都是 null**,恰好是烧得最多的那些
        // (实测有值的那几个 failed 节点 in 在 87K–12.8M),而"规划层 vs 执行层各烧多少"
        // 正是 #144 要问的那句话。
        usage,
        filesTouched,
        filesRead,
        deps: node.depends_on ?? [],
        t0,
        prompt,
        // agent leaf 自报的 cwd 最准 (它就是写文件的那个进程); inproc 无产物, 参数无所谓。
        ...(artifactRoot ? { artifactRoot } : {}),
        ...(watchdog ? { watchdog } : {}),
        ...(toolSteps ? { toolSteps } : {}),
        ...(toolStepsDropped ? { toolStepsDropped } : {}),
        // 与失败出口 (47bf576) 对齐 —— 分布要有分母, 见 saveDoneCheckpoint 的 shellRuns 注。
        ...(shellRuns ? { shellRuns } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(writeCounts ? { writeCounts } : {}),
      });
      return leaf;
  };

  const nodeExecutors: Record<NodeExecKind, (c: NodeExecCtx) => Promise<LeafResult>> = {
    primitive: (c) => runPrimitiveNode(c.id),
    map: (c) => runMapNode(c.id),
    conductor: (c) => runConductorNode(c.id),
    await: (c) => runAwaitNode(c.id),
    command: (c) => runCommandNode(c),
    research: (c) => runResearchNode(c),
    leaf: (c) => runLeafNode(c),
  };

  // runNodeOnce: **单次尝试** (resume-skip / primitive / map / command / agent / inproc + checkpoint)。
  // 重试策略在下方 runNode 包一层 —— 这里只管跑一次, 不认识 max_retry。
  // attempt.causeNote: L0 重试把上一次的失败原因追加进 goal (经 buildLeafPrompt 进 prompt), 不原样重放。
  const runNodeOnce = async (id: string, attempt?: { causeNote?: string }): Promise<LeafResult> => {
      const rawNode = plan!.nodes[id]!;
      const node = attempt?.causeNote ? { ...rawNode, goal: `${rawNode.goal ?? ''}${attempt.causeNote}` } : rawNode;
      const deps = node.depends_on ?? [];
      // D-21: 跨轮复用命中 → 上轮输出直接注入 (零 LLM 零工具; id/deps 归本轮, skipped 同 resume 语义)。
      const prev = reuse.get(id);
      if (prev) {
        logger.info({ node: id }, '[omd/executor-dag] 跨轮语义复用命中 → 注入上轮输出 (D-21)');
        return { ...prev, id, deps, usage: { in: 0, out: 0 }, skipped: true };
      }
      const kind = nodeExecKind(node);
      if (kind === null) {
        // fail-closed (B1 唯一刻意行为变化): 词表外 executor 此前静默落 inproc leaf ——
        // 与 command 负退出码闸同理, 这是给预构造 plan (不经 zod) 的运行期硬闸。
        logger.warn({ node: id, executor: node.executor }, '[omd/executor-dag] 词表外 executor → failed (fail-closed, 不再静默当 inproc)');
        return { id, status: 'failed', failureKind: 'missing-capability', kind: 'inproc', output: `[词表外 executor: ${String(node.executor)}]`, deps, usage: { in: 0, out: 0 } };
      }
      // resume 预步只对 command/research/leaf 生效 —— primitive/map/conductor/await 在原链中
      // 于 resume 检查之前 return (map/conductor 永不整体 resume-skip 的语义原样保留);
      // command 到得了这里但 shouldSkip 内部恒不跳 (#167 账与闸各归各), 同原链。
      if (kind === 'command' || kind === 'research' || kind === 'leaf') {
      // W2 resume: checkpoint done ∧ 代数匹配 ∧ **输入面未变 (D-O)** ∧ 产物存在且 hash 匹配 → 跳过执行。
      if (
        continuity?.resume &&
        resumeGreens.has(id) &&
        // S-43 第二张脸: expect_exit 非 0 = 基线测量型, resume 只量一次 (判据在 shouldSkip 里)。
        // T-1a 规格守卫 (S-51): 把**这一次**的语义指纹一并递进去 —— checkpoint 早就存了写入
        // 那一刻的值, 缺的只是拿当前值比一次。算不出 (环等) → 不传 → 闸缺席 (fail-open),
        // 与 checkpoint 写入侧那半 (通道⑤-b) 同一条纪律。
        continuity.manager.shouldSkip(continuity.runId, id, dagGeneration, inputsOf(deps), {
          baselineGate: (node.expect_exit ?? 0) !== 0,
          ...(currentFingerprint(id) !== undefined ? { fingerprint: currentFingerprint(id)! } : {}),
        })
      ) {
        const cp = resumeGreens.get(id)!;
        // D-O: 还原**全文**产物, 不是 800 字 summary —— 下游吃的就是这份输出, 拿摘要顶替等于
        // 每 resume 一次上游信息就被静默截断一次, 且它的 hash 与下游 inputHashes 对不上,
        // 会让整条下游误判 stale 全体重跑 (省下的钱又赔回去)。
        const full = cp.outputText ? continuity.manager.loadNodeOutput(cp.outputText) : null;
        if (cp.outputText && full === null) {
          logger.warn({ node: id, path: cp.outputText }, '[omd/executor-dag] resume: 输出制品读不到 → 退回 800 字 summary (下游可能因此重跑)');
        }
        logger.info({ node: id, restored: full !== null ? 'full' : 'summary' }, '[omd/executor-dag] continuity resume: 节点已绿, 跳过');
        // D-12: 读过的文件一并还原 —— 不还原的话, 续跑一次制品 lint 与读毒的观察面就静默窄一截。
        return {
          id, status: 'done', kind: cp.leafKind, output: full ?? cp.summary, deps,
          usage: { in: 0, out: 0 }, skipped: true, filesTouched: cp.outputPaths,
          ...(cp.inputPaths?.length ? { filesRead: cp.inputPaths } : {}),
        };
      }
      }
      // 明示即承诺的反面守卫 (D-K): expect_exit 只有 command 分支消费。原链中该警告在
      // command return 之后、research/leaf 之前 —— 等价于只对这两类响。
      if ((kind === 'research' || kind === 'leaf') && node.expect_exit !== undefined) {
        logger.warn({ node: id, executor: node.executor, expect_exit: node.expect_exit }, '[omd/executor-dag][oracle-exit-scope] expect_exit 只对 executor:command 生效 → 本节点忽略 (D-K)');
      }
      return nodeExecutors[kind]({ id, node, deps });
  };

  /**
   * runNode: 单节点执行 + **L0 节点级重试** (D-11 / INV-P2-2)。
   *
   * `max_retry` 此前是纯装饰 (有 schema、进语义指纹、零消费者) —— 手写 plan 显式写了会被静默忽略。
   * 语义: 失败则最多再试 `max_retry` 次, 每次把**上一次的失败输出**注入 prompt (不是原样重放 ——
   * 原样重放对确定性失败是纯烧钱)。用尽仍 failed → 交上层 (verifier 升级 / 外层 fixpoint)。
   *
   * **每次尝试的 usage 全部计入**最终结果: 丢弃的尝试也真花了钱, 不记账就是账本对不上
   * (同 escalation 补丁那条"尝试的 token 不丢账")。
   *
   * start 事件与起跑时刻在**这一层**打, 不在 runNodeOnce —— 一个节点对外仍是一次 start,
   * 内部试了几次是实现细节; durationMs 也该覆盖全部尝试。
   */
  const runNode = async (id: string): Promise<LeafResult> => {
    const node = plan!.nodes[id]!;
    nodeStartedAt.set(id, Date.now());
    emitNodeEvent({ type: 'start', id, kind: nodeKind(node) });
    /**
     * 这一次失败还给不给重试。
     *
     * ## 为什么不是常量 (2026-08-26)
     *
     * 原来是 `node.max_retry ?? 0` —— 与**失败的性质**无关的一个常数。后果:
     * conductor 画图时不写 max_retry(它几乎从不写), 于是任何失败都零重试。
     * repo-checks.ts 的文件头注释明写「FAIL → 引擎按既有 L0 重试机制」, 而那条通道
     * 从设计之日起就没通过电: 两发实装 run 的完整日志里「L0 节点级重试」出现 0 次。
     *
     * 判据本仓早就有了, 只是没人接: `FAILURE_KIND_INFO[kind].retryable` 是**三态**
     * (true / false / null), node-failure.ts 的注释还专门写了「把『不知道』记成 false
     * 会让 heal 回路白白放弃一个本可重试的节点」。这里把它接上。
     *
     * ## 两条规则(2026-08-26 二改,收窄)
     *
     * 1. **显式 max_retry 压过一切** —— conductor 写了就听它的, 包括写 0。
     * 2. **抛错 → 给 1 次**, 其余一律 0。`node-failure.ts:10` 已经写明: 最典型的可重试失败
     *    (429 / 网络) 是 generate 抛出来的, 不是 status='failed' —— 只看 status 的重试恰好
     *    漏掉最该重试的那类。抛错这条路径**没有 failureKind 可查**, 引擎不补就永远没人补。
     *
     * ## 为什么**不**拿 FAILURE_KIND_INFO.retryable 做自动重试
     *
     * 初版这么写过, 全量当场 11 红 (G-3 引擎接缝 / G-4 quorum fail-skip / 产物闸 等,
     * 它们断言的正是「失败后零 generate 调用、零执行零 token」)。
     *
     * 根因是我把**知识**当成了**策略**: `retryable` 回答的是「原样重试有没有可能成功」,
     * 而 `stall` 这一格的 nextAction 写得很清楚 —— 「换池 / 重试, 是 **provider 侧**的事」。
     * 那是给上层 (heal 回路 / conductor 重画 / owner) 的判断依据, 不是「引擎当场再跑一遍」
     * 的授权。照它自动重试, 超时类失败会原地翻倍等待, 而这一轮几乎必然同样超时。
     *
     * 三态表仍然有用, 只是**消费者不是这里** —— 它服务的是失败之后由谁、以什么方式再来一次。
     *
     * 上限就是 1: 这是「让通道通电」, 不是「多试几次碰运气」。要更多轮 conductor 显式写。
     */
    const budgetFor = (prevErr: unknown, leafForDomain: LeafResult | undefined): number => {
      // S3 片 5 (D-1/D-2, INV-1/2/3): 域判定与判词合成**同源** (retry-domain.ts 的 classifyRetryDomain
      // 与 oracle-red.ts 的 findRedOracles 逐字一致) —— 确定性 oracle 说「不」是判词不是故障,
      // 把 max_retry 当常数会让 retry-masking 把红洗成绿 (止损行点名的不变量重设计)。
      // 「没能说话」(timed-out / 抛错 / 非 command 的失败) 走 generation 域, 现行语义逐字节不变。
      const domain = leafForDomain
        ? classifyRetryDomain(leafForDomain.kind, leafForDomain.failureKind)
        : 'generation';
      return retryBudgetFor(domain, node.max_retry, prevErr !== undefined);
    };
    const budget = node.max_retry ?? 0; // 只给日志用 —— 真判定走 budgetFor
    // 上一次的败因 → 下一次的 prompt。**抛错也算一次失败**: 最典型的可重试失败 (429 / 网络抖动)
    // 是 generate 抛出来的, 不是 status='failed' —— 只看 status 的重试恰好漏掉最该重试的那类。
    const causeOf = (prevLeaf: LeafResult | undefined, prevErr: unknown): string => {
      const body = prevLeaf
        ? prevLeaf.output || '(无输出)'
        : `[抛错] ${prevErr instanceof Error ? prevErr.message : String(prevErr)}`;
      return (
        `\n\n[上一次尝试失败]\n${body.slice(0, 600)}\n` +
        '请针对这个失败原因改变做法; 原样重复上一次的做法只会再失败一次。'
      );
    };
    const spent: ModelUsage[] = []; // 被丢弃的尝试的 usage — 也真花了钱, 不记账就是账本对不上
    let leaf: LeafResult | undefined;
    let thrown: unknown;
    // S2 (2026-08-25, 片 3): 节点级档 2 阶梯状态 (D-1, D-7, INV-6)。
    //   - rung1Reading: 档 1 (普通 attempt) 命中空转口径时填一次 (空 → 待 ladder 启用后再填)
    //   - rung2Dispatched: 档 2 已派发一次, 不允许档 3 (INV-6)
    //   - rung2Decision: 档 2 决策 (片 1 纯函数产物), 进 LeafResult.spinLadderReport
    //   - rung2Disabled: ladder 显式不可用 (config 未配 / 阈值未注入) → 走既有 max_retry 路径
    //     (INV-8: 无 spin 史 / 未启用 ladder 节点行为逐字节不变)
    const rung1Reading: SpinLadderReading | null = null;
    let rung2Dispatched = false;
    let rung2Decision: SpinRung2Decision | null = null;
    const rung2Threshold = config.spinRung2?.threshold;
    const rung2Pools = config.spinRung2?.pools;
    const rung2Enabled = rung2Threshold !== undefined;
    rung2DispatchByNode.set(id, undefined); // 起始清零
    try {
    for (let attempt = 0; ; attempt++) {
      // S2: 派发前检查上一 attempt 是否 spin-fused → 档 2 决策 (INV-1, D-2)
      if (leaf?.failureKind === 'spin-fused' && !rung2Dispatched && rung2Enabled && leaf !== undefined) {
        // 契约 D-5: 座位坐标取不到 = 该维度不可用, 按**试尽**处理。不许编占位坐标 ——
        // 假坐标查池必然落空, 却会被下游读成一次真的换脑 (§静默坑 1: 别拿 unknown 抹平
        // 「没有」「查不到」「不适用」三种情形)。原实现给 currentCoord 兜了一个
        // `provider:model` 形态的占位串 (此处刻意不写出那个字面值 —— 写出来
        // src/eval/seat-coordinate-gate.test.ts 的字面坐标闸会连注释一起判红, 而它报得对)。
        if (leaf.model === undefined) {
          rung2Dispatched = true;
          logger.warn(
            { node: id, reason: 'leaf-coord-missing' },
            '[omd/executor-dag][spin-rung2-ladder] leaf 座位坐标缺失 → 档 2 维度不可用, 记试尽 (契约 D-5)',
          );
        } else {
          const accumUsageIn = spent.reduce((a, b) => a + b.in, 0) + (leaf.usage?.in ?? 0);
          const dim = chooseSpinRung2Dimension({ accumUsageIn, threshold: rung2Threshold! });
          rung2Decision = buildSpinRung2Decision({
            dimension: dim,
            currentCoord: leaf.model,
            pools: rung2Pools ?? { cheap: [], mid: [], strong: [] },
            accumulatedUsageIn: accumUsageIn,
          });
          rung2Dispatched = true;
          rung2DispatchByNode.set(id, rung2Decision); // runLeafNode 读这里
          logger.info(
            { node: id, rung2Kind: rung2Decision.kind, accumUsageIn, from: rung2Decision.from, to: rung2Decision.to },
            '[omd/executor-dag][spin-rung2-ladder] 档 1 命中空转 → 派发档 2 重试',
          );
        }
      } else if (leaf?.failureKind === 'spin-fused' && !rung2Dispatched && !rung2Enabled) {
        // ladder 未启用 (config 没注入阈值) → 走既有 max_retry 路径,
        // 不静默给节点升档 (INV-8 存量语义不变)
        logger.debug({ node: id }, '[omd/executor-dag][spin-rung2-ladder] spin-fused 但 ladder 未启用 → 走既有 max_retry 路径');
      }
      if (attempt > 0) logger.info({ node: id, attempt, budget }, '[omd/executor-dag] L0 节点级重试 (带上次失败原因)');
      const causeNote = attempt === 0 ? undefined : causeOf(leaf, thrown);
      try {
        leaf = await runNodeOnce(id, causeNote ? { causeNote } : undefined);
        thrown = undefined;
      } catch (err) {
        thrown = err;
        leaf = undefined;
      }
      // S2: 档 2 也命中空转口径 → 阶梯终止 (D-7, INV-6), 越过剩余 max_retry 预算
      if (leaf?.failureKind === 'spin-fused' && rung2Dispatched && rung2Decision !== null) {
        const r2Reading: SpinLadderReading = {
          dimension: rung2Decision.kind,
          criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
          blockerSignature: leaf.output?.slice(0, 200) ?? 'spin-fused',
          outcome: 'fail',
        };
        const r1Reading: SpinLadderReading = rung1Reading ?? {
          dimension: SPIN_LADDER_RUNG1_DIMENSION,
          criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
          blockerSignature: leaf.output?.slice(0, 200) ?? 'spin-fused',
          outcome: 'fail',
        };
        const report = buildSpinLadderReport({ rung1: r1Reading, rung2: r2Reading });
        logger.warn(
          { node: id, rung2Kind: rung2Decision.kind, accumUsageIn: spent.reduce((a, b) => a + b.in, 0) + (leaf.usage?.in ?? 0) },
          '[omd/executor-dag][spin-rung2-ladder] 档 2 再次空转 → 节点终止 (越过 max_retry 预算)',
        );
        leaf = { ...leaf, spinLadderReport: report };
        break;
      }
      if (leaf && leaf.status !== 'failed') break; // done / skipped — 重试无意义
      if (attempt >= budgetFor(thrown, leaf)) break; // 预算用尽 (oracle 域判否越过 max_retry; 抛错补一次, 见 budgetFor)
      // S3 片 5 / INV-2 闸登记面: oracle 域判否越过 max_retry 这一动作的判词。同一 id 在多个出口
      // 不重复登记 (gate-registry.ts 的 GATE_REGISTRY 单条), 但只要这条闸**真的**拦下过 retry,
      // 这行日志就是它的活体证据 (gate-coverage 闸扫整串)。
      if (leaf && classifyRetryDomain(leaf.kind, leaf.failureKind) === 'oracle') {
        logger.warn(
          { node: id, attempt, maxRetry: node.max_retry },
          '[omd/executor-dag][retry-domain-mask] oracle 域判否 → 越过 max_retry, 节点终止 (D-2 / INV-2)',
        );
      }
      if (leaf) spent.push(leaf.usage);
    }
    } finally {
      // 清闭包, 防止下次同 id 节点起跑时残留 (节点不会复用, 但守卫成本为零)
      rung2DispatchByNode.set(id, undefined);
    }
    // 最后一次是抛错 → 原样抛回, 维持既有 failedFromThrow 隔离路径 (败因不丢, INV-6 不连坐)。
    if (!leaf) throw thrown;
    if (leaf.status === 'failed' && budget > 0 && !rung2Dispatched) {
      logger.warn({ node: id, budget }, '[omd/executor-dag] L0 重试预算用尽仍 failed → 交上层 (verifier 升级 / 外层 fixpoint)');
    }
    return spent.length ? { ...leaf, usage: spent.reduce((a, b) => addUsage(a, b), leaf.usage) } : leaf;
  };

  // ── 依赖驱动 ready-set 调度 (取代逐层 barrier) ──
  // 节点的所有真实 dep settle (depOutputs 已写) 即入 ready → 立刻可跑, 不等同层最慢节点。
  // 治 M3 深 DAG (实测 7 层) 的逐层 barrier 尾延迟: 旧法每层等最慢叶, 深链时空转损耗叠加。
  // 正确性: indeg 归零 ⟺ 全 dep 已 settle ⟹ buildLeafPrompt 必见全部 dep 输出 (与旧法等价)。
  // levels 仍由 topoLevels 算 (报告 + 环检测), 仅不再驱动执行。INV-6: 单 leaf 抛错隔离成 failed, 不连坐。
  // 调度本体 (indeg/ready/三层并发闸/quorum 判定) 搬去 dag-scheduler.ts —— 它零 IO 零 config,
  // 于是这些规则第一次可以脱开 LLM 单测 (见 dag-scheduler.test.ts)。这里只留**认识 config 的那部分**:
  // 节点 → kind / 渠道键 的两个纯映射。
  //
  // per-kind 并发闸 (fanout 最大化, 2026-07-21): inproc 纯 API 等待默认不限;
  // agent/command 有本地足迹 (工具调用/CLI 抢本机 CPU·磁盘) → 独立小闸。按声明 executor 记账。
  // await 与 command 同类 (确定性零模型, 纯本地 IO + git) → 归 command 闸; 且 warm-start
  // 挑「真会打模型」的节点 (kindOf !== 'command'), await 归 command 后永不被暖发 ——
  // 否则暖发串行 await 一次 = 整图锁在 3h park 后面 (S3)。
  const schedKind = (id: string): SchedKind => {
    const n = plan!.nodes[id]!;
    if (n.executor === 'command' || n.executor === 'await') return 'command';
    if (n.executor === 'agent') return 'agent';
    return 'inproc'; // leaf/map/primitive (map/primitive 内层并发各自管理)
  };

  // ── D-23 per-channel 并发闸 (SDD v2): key = provider 前缀, 调度期由 node.model ?? kind 静态
  // 模型确定性推出 (运行期 router 选择不改记账 — 与 kind 闸「按声明记账」同哲学)。command 无
  // 模型 → 不入渠道闸。未配 channelFanout → 全部不限 (零回归)。
  // await 同样零模型 → 不入渠道闸 (park 期不该占 provider 渠道槽)。
  const schedChannel = (id: string): string | null => {
    const n = plan!.nodes[id]!;
    if (n.executor === 'command' || n.executor === 'await') return null;
    const model = n.model ?? (schedKind(id) === 'agent' ? config.agentLeafModel ?? config.leafModel : config.leafModel);
    const sep = model.indexOf(':');
    return sep >= 0 ? model.slice(0, sep) : model;
  };

  const sched = new DagScheduler(plan, {
    kindOf: schedKind,
    channelOf: schedChannel,
    statusOf: (id) => results[id]?.status, // quorum 读它 —— 调度器不持有 results
    maxFanout: config.maxFanout,
    kindFanout: config.kindFanout,
    channelFanout: config.channelFanout,
  });

  // ── fan-in 定向摘要 (扇出≥2 触发) ─────────────────────────────────────────────
  // producer settle 前 (dependents 释放前) 判定并生成: 输出被 ≥2 consumer 消费 ∧ 够长 → 跑 1 发
  // 定向摘要 (按下游目标提炼) + 全文写入磁盘留指针, 存 faninView[id]; 下游 fan-in 注入摘要而非全文。
  // 调用点在调度器 .then 内 (running 保持占位跨此 await → 收敛判据不会在摘要在飞时误触发, 见 pump)。
  // 全程 fail-open: 任何失败 → view=null → 下游回退全文注入。usage 折进 producer 的 r.usage (账本一致)。
  // `consumersOverride`: conductor 局部子图内的运行时子节点从未进过顶层 `sched` (它在
  // `executePlan` 里只对初始 `plan.nodes` 建过一次快照, 子图节点是之后才 `plan!.nodes[child.id]=`
  // 追加进去的), 于是 `sched.dependentsOf` 对它们恒返回 `[]` → 扇出闸永远短路成"全文"。
  // 内环 pump (`runConductorRound`) 已经自己算了一份 `dependentsLocal`(子图内边), 直接传进来
  // 绕开对 `sched` 的依赖; 顶层 pump 不传, 沿用 `sched.dependentsOf` (2026-08-14, INV-2 定位)。
  const maybeFaninView = async (
    id: string,
    r: LeafResult,
    consumersOverride?: string[],
  ): Promise<{ r: LeafResult; view: string | null }> => {
    try {
      if (!faninCfg.enabled) return { r, view: null };
      if (r.status !== 'done') return { r, view: null }; // 失败节点不摘要 (败因全文留给 heal)
      if (r.kind === 'map') return { r, view: null }; // map 输出是结构化 JSON 数组, 摘要会毁其可解析性
      const node = plan!.nodes[id]!;
      if (node.creative) return { r, view: null }; // 护创意交付物 (best-of-n/judge 候选需全文, 同 caveman off)
      const consumers = consumersOverride ?? sched.dependentsOf(id);
      if (consumers.length < faninCfg.minFanout) return { r, view: null }; // 扇出闸 (默认 ≥2)
      const output = r.output ?? '';
      if (output.length < faninCfg.minChars) return { r, view: null }; // 短输出摘要纯亏 (摘要器 input 即全文)
      const depGoals = consumers
        .map((c) => plan!.nodes[c]?.goal)
        .filter((g): g is string => typeof g === 'string' && g.length > 0);
      // output_schema 默认化: producer 声明了则遵之, 否则用默认 fan-in schema。
      const schema = (node.output_schema as Record<string, unknown> | undefined) ?? DEFAULT_FANIN_SCHEMA;
      const { summaryJson, usage } = await runFaninSummary({
        generate,
        traceName: `fanin-summary:${id}`,
        traceNodeId: id,
        model: faninCfg.model ?? config.leafModel,
        producerGoal: node.goal,
        output,
        depGoals,
        schema,
      });
      if (!summaryJson) return { r, view: null }; // 解析失败 → 全文兜底
      // 全文指针: continuity 在则写入磁盘并留 path (agent consumer 可自 Read); 否则仅摘要 (artifacts 字段保产物锚)。
      const fullPath = continuity ? continuity.manager.saveFaninFull(continuity.runId, id, output) : null;
      // 混合视图 (2026-08-07): 散文交给 LLM, **产物锚交给程序**。
      // 依据是同一批真实语料的实测 —— LLM 摘要保锚 31.8%(双峰: 4/9 不丢, 2/9 丢光), 而
      // fan-in consumer 里**无工具的占 47%**, 全文指针对它们无效, 丢了就永久丢。
      // 只补摘要没含的 → 摘要保住了就零新增字节 (见 composeAnchorBlock)。
      // D-6 拼回: 摘要可能丢引文 (LLM 摘要保锚实测仅 31.8%, 见 fanin-summary.ts)。view 末尾追加
      // QUOTE_BLOCK 把逐字引文段按 D-4 模板拼回; 已含于 view 的段零新增字节跳过。
      const baseView = composeFaninView(summaryJson, fullPath, output.length, extractPathAnchors(output));
      const view = baseView + quoteBlock(extractQuoteSegments(output, id), baseView);
      // 保留率读数留着: 它现在量的是**LLM 那一半**做得如何 (补回之前), 仍是基率不是闸。
      const anchorLoss = faninAnchorLoss(output, JSON.stringify(summaryJson));
      logger.info(
        {
          node: id, consumers: consumers.length, fullLen: output.length, viewLen: view.length, persisted: !!fullPath,
          pathAnchors: anchorLoss.anchors, anchorsLost: anchorLoss.lost,
          ...(anchorLoss.lost > 0 ? { anchorsLostSample: anchorLoss.lostSample } : {}),
        },
        '[omd/executor-dag] fan-in 定向摘要 (扇出≥2 → 摘要替全文注入)',
      );
      // 进账本: 两个原始计数, 供读数板判 `FANIN_ANCHOR_CAP` 该不该调 (三态见类型定义处)。
      // 只在**真做了摘要**这条路上设 —— 上面每一个 early return 都保持字段缺席, 那正是三态的第一格。
      return {
        r: { ...r, usage: addUsage(r.usage, usage), faninAnchors: [anchorLoss.anchors, anchorLoss.lost] as [number, number] },
        view,
      };
    } catch (err) {
      logger.warn(
        { node: id, err: err instanceof Error ? err.message : String(err) },
        '[omd/executor-dag] fan-in 摘要失败 → 全文兜底 (fail-open)',
      );
      return { r, view: null };
    }
  };

  // 节点抛错 → 隔离成 failed LeafResult, **保留错误消息** (issue #4: 此前 .catch(()=>null) 直接
  // 丢弃败因 → 失败节点无诊断信息)。INV-6: 单 leaf 抛错不连坐其它节点。
  const failedFromThrow = (id: string, err: unknown): LeafResult => {
    const node = plan!.nodes[id]!;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ node: id, err: msg }, '[omd/executor-dag] 节点抛错 → 隔离 failed (保留败因)');
    return {
      id,
      status: 'failed',
      failureKind: 'infra-error',
      kind: node.executor === 'agent' && config.agentRunner ? 'agent' : 'inproc',
      output: `[节点抛错] ${msg}`,
      deps: node.depends_on ?? [],
      usage: { in: 0, out: 0 },
    };
  };

  // settle: 写 results/depOutputs + 累加遥测 + 释放 dependents (indeg 归零 → 入 ready)。
  const settle = (id: string, r: LeafResult | null): void => {
    if (r == null) {
      const node = plan!.nodes[id]!;
      // settle 收到 null = 引擎侧异常 (runNode 该恒返一个 LeafResult)。这是它自己的**直接证据**,
      // 不是"排除了别的" —— 归 infra-error 而非 unclassified。
      results[id] = { id, status: 'failed', failureKind: 'infra-error', kind: node.executor === 'agent' && config.agentRunner ? 'agent' : 'inproc', output: '', deps: node.depends_on ?? [], usage: { in: 0, out: 0 } };
      depOutputs[id] = '[failed]';
    } else {
      // P1 归一化闸: 任何没过的节点都必须带 failureKind, 漏标的显式记 'unclassified'
      // (缺席读起来 = "老记录", 与"引擎里有条没交代的失败路径"结论相反 — 见 node-failure.ts)。
      const normalized = withFailureKind(r);
      // S2 后半 (C-2 / INV-6): tool_id 来自节点 toolRefs[0] (resolved 后)。若 leaf 自身已带
      // tool_id (bootstrap 路径由 bootstrap-gate 注入) → 优先保留, 否则从 plan 派生。
      // 无 toolRefs → 无 tool_id → 不发 use_event (INV-6: 不写占位)。
      const refToolId = (normalized.tool_id ?? plan!.nodes[id]?.toolRefs?.[0]) || undefined;
      results[id] = refToolId ? { ...normalized, tool_id: refToolId } : normalized;
      depOutputs[id] = r.output;
      // #240 观测绊线 (grill 2026-08-25 推荐 C · 层④告知 fail-open): failed 节点带大宗产出 =
      // 「字白取了」形态。基率 2/297 且成因已被 #241 点火坐标校验正面覆盖 —— 本行只是复发探测器,
      // goal-logs 里 grep '[#240]' 月频 > 0 才值得建 partial-live+salvage 通道 (方案 B, 见
      // docs/plan/2026-08-25-grill-240-failed-output-channel.md; 方案 A「直通下游」已永久否决)。
      if (results[id]!.status === 'failed' && r.output.length > 10_000) {
        logger.warn(
          { node: id, outputChars: r.output.length, failureKind: results[id]!.failureKind },
          '[omd/executor-dag][#240] failed 节点带大宗产出 (>10K 字) — 输出在 checkpoint, 未入下游',
        );
      }
      if (r.kind === 'conductor') {
        conductorUsage = addUsage(conductorUsage, r.usage);
      } else {
        leavesIn += r.usage.in;
        leavesOut += r.usage.out;
        leavesCacheHit += r.usage.cacheHit ?? 0;
      }
      // #144 洞 1: agent leaf 走 pi-agent-core 自己的循环, **不经 gateway.send** → 在
      // seat-usage.jsonl 里 `agent` 座一行都没有, 而 run C 的 110.9M input token 全是它烧的。
      //
      // 记在这里而不是 agent-leaf 里, 是为了让台账与 `result.usage.leavesIn/Out/CacheHit`
      // **共用同一个 `r.usage`** —— 两本账按构造对得上, 不会再出现差三个数量级的两套成本结论
      // (#144 评论「补账前必须先决定哪一套是真理源」)。
      //
      // ⚠ **只记 `kind === 'agent'`**。别顺手把别的 kind 一起记了 —— inproc/primitive/conductor/
      // research/map 的模型调用**都经网关**, 网关已经记过发级行; 在这里再记一条节点级行会把
      // 同一份 in/out 计两遍。「哪些 kind 不经网关」是这条判据的全部内容, 不是省事。
      if (r.kind === 'agent') {
        recordSeatUsage({
          ts: Date.now(),
          seat: 'agent',
          traceName: 'agent-leaf',
          model: r.model ?? config.agentLeafModel ?? config.leafModel ?? 'unknown',
          in: r.usage.in,
          out: r.usage.out,
          cacheHit: r.usage.cacheHit ?? null,
          // 与网关那条路取同一个锚 (defaults.ts 收到的 sessionId 就是这个表达式) ——
          // 两种行要能按 runId join 起来, 这个 join 键就是全部前提。
          // ⚠ 诚实边界: 两处都缺时引擎侧兜一个 randomUUID, 这里落 null (不编一个不同的 id 假装
          // 能 join)。生产路径上 continuity.runId 恒在, 缺的只有部分测试/孤立入口。
          runId: config.sessionId ?? config.continuity?.runId ?? null,
          entry: 'node',
          nodeId: id,
          ...(plan!.name ? { phase: plan!.name } : {}),
        });
      }
      // #13 逐字保真探针 (只报不拦, 与制品 lint 同一出口)。判在 settle 里是因为这一刻**同时**
      // 拿得到本节点输出与全部上游输出 —— 换个地方就得再存一份。零模型调用、纯子串比对。
      // 只对 done 的多入节点判; 判据本身在 detectVerbatimDrop 里(拿不准一律不报)。
      //
      // D-3 (2026-08-25): 上游输入 = 节点在 prompt 里真实看到的视图 (`seenUpstreamOutputs`),
      // 不是原始 `depOutputs[d]` —— 大扇入摘要把引文先脱掉, 节点从未见过的原文不再被冤枉。
      if (r.status === 'done') {
        const ups = seenUpstreamOutputs(id, plan!, depOutputs, faninView, capFanin);
        const vd = detectVerbatimDrop(id, ups, r.output ?? '');
        if (vd) {
          observe([vd]);
          // #153 D-7: goal 明写要契约源/行号/出处/逐字 → 这条检出从 advisory 升为判红输入
          // (走检测者同一毒集通道, 在 runConductorRound 判前合并处消费)。谓词不满足 → 只报不拦。
          if (gateVerbatimRed(vd, plan!.nodes[id]?.goal ?? '')) verbatimReds.add(id);
        }
      }
    }
    // C-1 (2026-08-19): 给 dag-record 的节点落库函数递 durationMs (引擎侧墙钟) + turns (leaf 内环轮数),
    // 统一两条通道: `r.usage` 已被上方 recordSeatUsage (entry:'node' seat-usage.jsonl) 与
    // `recorder.record()` (dag-runs.db 节点行) 共用, 同一对象 → INV-2 逐字相等按构造成立。
    // 这里 **不**再碰 usage —— 各自换算 = 两套会漂的成本结论 (#144), 留痕层只接一手数。
    // INV-1: 拿不到的位写 null (`nodeStartedAt` 没记到 / kind 非 conductor) —— **绝不** 编 0 占位,
    // 否则「没记」与「真零」会被算进同一分母。
    //
    // 同时 (② 覆盖判据): 引擎外层轮计数 `currentEngineRound` 进 `dagRound` 字段 (跨轮身份);
    // 同 id 上一轮已被本轮覆盖 → 在上一轮那条 LeafResult 上落 `overriddenBy = currentEngineRound`。
    // `_nodeLastSettled` 是模块级 Map<id, LeafResult>, mutate 上轮 leaf 是允许的: 上轮 results
    // 已落账, 与 computeReuse/recordSeatUsage 都解耦 (复用判 = `usage==0 ∧ skipped:true`,
    // 不读 overriddenBy; seat-usage 也只看 usage/model)。
    //
    // 同时 (③ 注入文本 token): 读 `base.injectedTokens` —— 来自 inproc 路径上游 lengths/4 的
    // 现场采集 (agent 节点 SDK 自管 prompt → 该字段未设 → 取 null, 不编 0)。
    {
      const base = results[id]!;
      const t0 = nodeStartedAt.get(id);
      const durationMs = t0 !== undefined ? Date.now() - t0 : null;
      const turns = base.kind === 'conductor' && typeof base.rounds === 'number' ? base.rounds : null;
      const injectedTokens = typeof base.injectedTokens === 'number' ? base.injectedTokens : null;
      const prev = _nodeLastSettled.get(id);
      // ② 覆盖判据: 同一节点身份被本轮重新 settle → 上一轮的 _nodeLastSettled 条目被覆盖。
      // `prev` 与 `currentEngineRound` 同 id 才算"被覆盖"; prev 缺席 = 该节点只跑过这一轮, 不需要标记。
      // **最后一轮不算被覆盖** —— 它自己进 _nodeLastSettled 后, 下一轮没有同 id, 不被任何轮覆盖。
      if (prev) {
        prev.overriddenBy = currentEngineRound;
      }
      const settledLeaf = { ...base, durationMs, turns, injectedTokens, dagRound: currentEngineRound };
      results[id] = settledLeaf;
      _nodeLastSettled.set(id, settledLeaf);
    }
    const settled = results[id]!;
    // 节点级 span: 让一条 trace 打开就是**整张图的形状**。父子关系写在 id 里 (`父::子`, D-B),
    // 所以这里不需要记账 —— recordSpan 自己从 id 解得出。
    // ⚠ command 节点一次模型都不打, 此前在观测面上**完全不存在**; 而它们常常是验收闸,
    //   一张图少了它们就不是那张图。
    recordSpan({
      traceId: obsTraceId,
      nodeId: id,
      kind: settled.kind,
      status: settled.status,
      // 复用既有的 nodeStartedAt (毫秒) —— 它记的本来就是同一件事; 另起一份必漂。
      startTime: new Date(nodeStartedAt.get(id) ?? Date.now()),
      endTime: new Date(),
      ...(settled.failureKind ? { failureKind: settled.failureKind } : {}),
    });
    emitNodeEvent(settleEvent(id, settled));
    // S2 后半 (C-2 / INV-5, INV-6): use_event 复用 settle 出口的 emitNodeEvent 链,
    // 不新增独立事件文件/表/writer (D-3)。真 tool_id 存在时发一次, (tool_id, leaf_id)
    // 在 useEventsEmitted 集合里幂等 —— settle 重入路径不重复触发。oracle_pass 的来源
    // 是**工具契约** (bootstrap-gate 三态 / plan-critic.toolRefs gate), 与 verification.pass
    // 解耦 (INV-7: tool 更新不接受 verification 输入; INV-8: verifier 红 + oracle_pass:true
    // → use_event 字节不变)。
    const settledForEvent = results[id] as LeafResult | undefined;
    if (settledForEvent?.tool_id) {
      const dedupeKey = `${settledForEvent.tool_id}\0${settledForEvent.id}`;
      if (!useEventsEmitted.has(dedupeKey)) {
        useEventsEmitted.add(dedupeKey);
        // 工具契约 oracle_pass: settled leaf done = 绿; failed 也仍记一条 (失败归因)。
        // 注: tool 契约红 (`oracle_pass:false`) 的源头是 bootstrap-gate / plan-critic 的
        // toolRefs gate, 在 node 解析期判死, settle 时已能拿到。MVP: 用 leaf.status 作
        // oracle_pass 代理 (INV-8 字节不变性由 oracle_pass 字段独立存, 与 verifier.pass 解耦)。
        const oraclePass = settledForEvent.status === 'done';
        const useEv: UseEvent = {
          tool_id: settledForEvent.tool_id,
          leaf_id: settledForEvent.id,
          success: settledForEvent.status === 'done',
          cost: 0, // 价格表未接 (S2 后半只建立信用边界, 不接 S5 tool-bandit)
          oracle_pass: oraclePass,
          ts: new Date().toISOString(),
        };
        // probe 不可能落到这里 (settledForEvent 是 leaf, 不是 probe usage 段; rejectIfProbe
        // 仍是兜底, 防御 type-forgery 把 source 塞进 leaf)。
        rejectIfProbe(useEv as unknown as { source?: string });
        emitNodeEvent(useEv as unknown as DagNodeEvent);
      }
    }
    // issue #4: 失败节点留痕。成功节点由 runNode 内成功分支落 checkpoint; failed/抛错节点此前**零记录**
    // (stdout 被 caveman 压掉、dag-runs.db 未启用、continuity 只存绿节点 → judge 截停后无法诊断)。
    // 这里补一条结构化败因 checkpoint (节点 id/executor/model/败因分类/错误消息截断)。全程 fail-open,
    // status≠'done' 故 resume 永不当绿跳过 (loadAllGreen/shouldSkip 只认 done)。skipped (D-7v2
    // quorum 级联) 同样留痕: failureKind='dep-skip', summary 含未达 quorum 的依赖清单。
    if (settled.status !== 'done' && continuity) {
      try {
        const startedAt = nodeStartedAt.get(id);
        const failText = settled.output ?? '';
        // **失败留痕加厚** (2026-08-06, failure-trace.ts):
        //   ① 全文落 `fail-<id>.txt` —— 改动前 150 份非绿 checkpoint 带全文的 **0** 份,
        //      事后诊断只有被砍过的 800 字头。
        //   ② summary 改**头+尾** —— 盘上撞 800 上限的 2 份全部是 `a && b && c` 链, 成功段
        //      刷屏占满预算、失败判词在尾巴上被切掉。短于预算原样返回, 另外 61 份逐字不变。
        //   ③ `failurePaths` = 输出里点名且盘上真有的文件 —— 「路径 → 谁写的」反查的起点。
        //      **只进可见性**: 节点成败/闸/judge 一律不看它 (同 writeCandidates 那一档)。
        const failOutputText = failText ? continuity.manager.saveNodeFailureOutput(continuity.runId, id, failText) : null;
        let failurePaths: string[] = [];
        try {
          failurePaths = blamePathCandidates(failText, { root: continuity.repoRoot ?? process.cwd() });
        } catch (err) {
          logger.warn({ node: id, err }, '[omd/executor-dag] 失败路径认领失败 (fail-open, 只丢可见性)');
        }
        continuity.manager.saveCheckpoint(continuity.runId, {
          nodeId: id,
          leafKind: settled.kind,
          status: settled.status,
          // P1: 直接抄结果上那一位 —— 此前这里**当场重新推断**一遍 (三选一: dep-skip/stall/failed),
          // 于是留痕层的成因和结果上的成因是两处独立判断, 天然会漂。归一化闸保证它恒非空。
          failureKind: settled.failureKind ?? 'unclassified',
          ...(settled.model ? { model: settled.model } : {}),
          outputPaths: [],
          artifactHashes: {},
          tokenUsage: settled.usage ?? null,
          summary: failureExcerpt(failText),
          ...(failOutputText ? { outputText: failOutputText } : {}),
          ...(failurePaths.length ? { failurePaths } : {}),
          // **这个节点读过什么** (2026-08-06)。成功节点一直有这一位 (盘上 265/322 = 82%),
          // 失败节点 **0/21** —— 而它恰恰是 `empty-artifact` 里最要紧的那个分辨:
          //   · 「读了声明的产物, 发现它已经是目标状态, 于是正确地没写」 → 不该判失败
          //   · 「什么都没读也没写, 却报『写完了』」                    → 正是闸要拦的 empty-done
          // 盘上看这两者**长得一模一样**(filesTouched 都空、盘上都没位移), 而下一步相反。
          // 今天分不开不是因为难, 是因为**没人记那一位**。先记, 攒够了再判要不要动闸。
          // ⚠ 只记不判: 产物闸一个字没改。
          ...(settled.filesRead?.length ? { inputPaths: settled.filesRead } : {}),
          // S1 埋点: failed checkpoint 也透传 watchdog (看门狗判死的叶, 盘上不该只剩 failureKind:'stall'
          // 而读不到活性; done 出口在 saveDoneCheckpoint 里同风格透传)。
          ...(settled.watchdog ? { watchdog: settled.watchdog } : {}),
          // 2026-08-16 (#145 评论① 复盘): 再补三位。`empty-artifact` 要回答的是「它这一轮
          // 到底动没动盘」, 而这三位正是那个问题的直接证据 —— 盘上此前一位都没有,
          // 上次只能靠 exec.log 里 drift 观察者顺手打印的工具名采样倒推, 挖了一整晚。
          ...(settled.shellRuns ? { shellRuns: settled.shellRuns } : {}),
          ...(settled.toolCalls !== undefined ? { toolCalls: settled.toolCalls } : {}),
          ...(settled.writeCounts ? { writeCounts: settled.writeCounts } : {}),
          ...(settled.toolSteps ? { toolSteps: settled.toolSteps } : {}),
          ...(settled.toolStepsDropped ? { toolStepsDropped: settled.toolStepsDropped } : {}),
          durationMs: startedAt ? Date.now() - startedAt : 0,
          createdAt: new Date().toISOString(),
          ...(dagGeneration ? { generation: dagGeneration } : {}),
          schemaVersion: 1,
        });
      } catch (err) {
        logger.warn({ node: id, err }, '[omd/executor-dag] 失败 checkpoint 写入磁盘失败 (fail-open)');
      }
    }
    sched.advance(id); // 拓扑推进: 释放 dependents, indeg 归零者已由调度器入 ready
  };

  // warmThenFanout: 全局暖 1 发写共享 leafSystemPrefix 缓存, 再放 pool。
  // (旧法每层暖 1 发 = 深 DAG 暖 N 次且每次阻塞该层; 共享前缀全局相同 → 单次全局暖即覆盖, 命中面更大、阻塞更少。)
  // ⚠ 2026-07-31 实测修正: 暖发要挑一个**真会打模型**的节点。
  //
  // 第一版是 `ready.shift()` —— 拿第一个就绪节点, 不问它是什么。而一张图的 L1 常常全是
  // command 节点 (跑测试/数文件/取 git log), 那些节点**一次模型都不调** —— 于是暖发把它们
  // 串行跑一遍, 拿到的 prompt-cache 收益是 **0**, 付出的是实打实的一发延迟。
  // 重启后第一跑就撞上了: 4 个 command 节点里只有 1 个在跑, 另外 3 个干等着一件与它们无关的事。
  //
  // 判据用节点自己的 executor (直接证据), 不拿"排除了别的"凑: command 节点是唯一确定不打模型的。
  // 一个都挑不出来 (整层都是 command) → **不暖**, 直接全宽放开 —— 没有可暖的东西时,
  // 暖发的正确行为是消失, 不是随便抓一个。
  // (挑非 command 的规则在 sched.takeWarmStart; size>1 前置条件留这里 —— 单节点图不值得暖。)
  const warmId = config.warmThenFanout && sched.size > 1 ? sched.takeWarmStart() : null;
  if (warmId != null) {
    const id = warmId;
    const r0 = await runNode(id).catch((e) => failedFromThrow(id, e));
    const { r: r1, view } = await maybeFaninView(id, r0); // 扇出≥2 → 摘要 (dependents 释放前)
    if (view) faninView[id] = view;
    settle(id, r1);
  }

  // ── D-7v2 quorum (SDD v2): 全部依赖 settle (indeg 归零) 后判定本节点是否还值得跑 ─────
  // requires 缺省启发: 单依赖 'all' (依赖失败还跑 = 拿 [failed] 文本当正文, 纯浪费 + 静默假成功),
  // 多依赖 fan-in 'any' (宽扇出单叶 429 不陪葬 synth; 反 happy-path: 一律 'all' 比现状更脆)。
  // 不达 quorum → status:'skipped' 级联 (settle 释放下游 → 下游同判), 零 LLM 零 worker 槽。
  // 判定本身在 dag-scheduler (sched.takeSkippable, 纯同步零 IO); 这里只做**认识 config 的两件事**:
  // 打那条 warn + 构造 skipped LeafResult (kind 要读 config.agentRunner)。
  const skippedByQuorum = (id: string, v: QuorumVerdict): LeafResult => {
    const node = plan!.nodes[id]!;
    logger.warn(
      { node: id, requires: v.requires, done: v.done, deps: v.deps.length, bad: v.bad },
      '[omd/executor-dag] 依赖未达 quorum → skipped 级联 (D-7v2)',
    );
    return {
      id,
      status: 'skipped',
      failureKind: 'dep-skip',
      kind: node.executor === 'command' ? 'command' : node.executor === 'agent' && config.agentRunner ? 'agent' : 'inproc',
      output: `[skipped: 依赖未达 quorum (requires=${v.requires}, done ${v.done}/${v.deps.length}) — ${v.bad.join(', ')}]`,
      deps: v.deps,
      usage: { in: 0, out: 0 },
    };
  };

  // worker pool: 维持 ≤cap 并发, 节点完成即补位 + 释放下游, ready 空且无在跑 → 收敛。
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      for (;;) {
        // ① quorum skip 先于 kind 闸消化 (skip 不运行不占槽, 不该被闸挡; 同步 settle 可能释放
        //    新 ready 甚至清空图 → continue 回到循环头重判收敛, 防全 skip 链上的收敛死锁)。
        const sk = sched.takeSkippable();
        if (sk) {
          try {
            settle(sk.id, skippedByQuorum(sk.id, sk.verdict));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          continue;
        }
        if (sched.isDrained()) {
          resolve();
          return;
        }
        // D-P 取消接缝①: 停止派新节点。在飞的跑到自己结束 (产物/checkpoint 一样不少),
        // 全部结清后从这里出去 —— 未起跑的节点**不伪造结果**, 由 cancelled.notRun 如实列出。
        if (isCancelled()) {
          if (sched.runningCount === 0) {
            logger.warn({ notRun: sched.readyCount }, '[omd/executor-dag] 已取消 → 停止派新节点, 收尾返回 (D-P 协作式)');
            resolve();
          }
          return;
        }
        // 全局 cap × kind × channel 三闸内选第一个可起跑节点并记账
        // (非严格 FIFO: 被闸挡住的节点让位, 保持吞吐)。null = 满闸/ready 空 → 等 settle 释放。
        const id = sched.takeRunnable();
        if (id == null) return;
        // S3 片 5 / D-7 (INV-9): 达标但部分依赖没 done → 结构化观察 (DagObservation),
        // 只报不拦 (fail-open 一层) —— 不进 upstreamText 散文, 散文进 prompt 之后就只有模型读得到。
        // 触发条件: requires 显式 'any' 或整数 K (即 dag-scheduler.ts 的 quorumVerdict 在
        // doneCount >= K 时返 null 放行), 但 deps 里有非 done 的兄弟 —— 这就是「达标但部分失败」。
        const nodeForQuorum = plan!.nodes[id];
        if (nodeForQuorum) {
          const requires = nodeForQuorum.requires as 'all' | 'any' | number | undefined;
          const deps = nodeForQuorum.depends_on ?? [];
          if (requires === 'any' || typeof requires === 'number') {
            // 读 engine 的 `results` 而非 `sched.statusOf` —— 状态真源在 results 里,
            // statusOf 是 opts 回调只对 scheduler 可见; 这里取的是 LeafResult.status。
            const unmet = deps
              .map((d) => ({ d, r: results[d] }))
              .filter(({ r }) => r !== undefined && r.status !== 'done')
              .map(({ d, r }) => `${d}(${r!.status}${r!.failureKind ? `:${r!.failureKind}` : ''})`);
            if (unmet.length > 0) {
              const unmetIds = deps.filter((d) => results[d]?.status !== 'done');
              const message = `节点 ${id} 因 requires='${requires}' 跑过, 但 ${unmet.length}/${deps.length} 依赖未 done: ${unmet.join(', ')}`;
              logger.warn(
                { node: id, requires, unmet: unmet.length, deps: deps.length },
                '[omd/executor-dag][partial-quorum-failure] 部分失败 join 留结构化观察 (D-7 / INV-9, 只报不拦)',
              );
              observations.push({ kind: 'partial-quorum-failure', nodes: [id, ...unmetIds], message });
            }
          }
        }
        // 运行时写竞争的机会面: 起跑这一刻还在飞的每一个节点, 都与本节点的窗口重叠过。
        for (const y of liveNow) {
          const [p1, p2] = [id, y].sort() as [string, string];
          overlapPairs.set(`${p1}\u0000${p2}`, [p1, p2]);
        }
        liveNow.add(id);
        runNode(id)
          .catch((e) => failedFromThrow(id, e)) // INV-6: leaf 抛错隔离成 failed (保留败因), 不连坐其它节点
          .then(async (r) => {
            // 写窗口到此为止 —— **不等 sched.release**: 那之后还有 fan-in 摘要那段 await,
            // 而摘要期一个字都不往产物上写, 算进去只会造出假重叠。
            liveNow.delete(id);
            // fan-in 定向摘要在 running-- 之前 await: 保持槽位占用跨摘要在飞 → 收敛判据 (running===0)
            // 不会误触发, dependents 也不会在摘要就绪前被释放 (settle 在此后)。fail-open, 永不抛。
            const { r: settledR, view } = await maybeFaninView(id, r);
            sched.release(id);
            if (view) faninView[id] = view;
            try {
              settle(id, settledR);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
              return;
            }
            pump();
          });
      }
    };
    pump();
  });

  // 最后再 lint 一次: 内环每轮跑的那次只覆盖有 conductor 节点的图, 而"B 读了 A 写的文件却没有边"
  // 在**平铺的普通图**上同样发生 (那种图一个 conductor 节点都没有, 上面那条路根本不经过)。
  runArtifactLint();

  // ── 运行时写竞争 (2026-08-06, 只报不拦) ────────────────────────────────────────
  // 此前 `write-race` 只有**跑前静态**那一半 (看 output_path 声明), 于是两个并发兄弟经 bash
  // 撞在同一条没声明的路径上时, 没有任何一处知道。判据与分母都在 detectRuntimeWriteRace 上。
  // ⚠ 路径解析用**这个节点自己的产物根** —— 同 collectRoundArtifacts 那条: R2 隔离档下两个 leaf
  //   各在自己的 worktree 里写 out.md, 比相对路径会把整个隔离档报成一片红。
  const raceProbe = (() => {
    // 两档证据**分开算**: 严格 = 受控写工具的事实; 推断 = 严格 ∪「命令点名要写且盘上核实过」。
    // 合并会让「这条 finding 是真的还是推出来的」永久分不开 —— 而升不升闸恰恰要看这个分野。
    const abs = (id: string, which: 'strict' | 'inferred'): ReadonlySet<string> => {
      const r = results[id];
      if (!r) return new Set();
      const paths = which === 'strict' ? (r.filesTouched ?? []) : [...(r.filesTouched ?? []), ...(r.writeCandidates ?? [])];
      if (!paths.length) return new Set();
      const root = r.artifactRoot ?? continuity?.repoRoot ?? process.cwd();
      return new Set(paths.map((p) => (p.startsWith('/') ? p : join(root, p))));
    };
    const pairs = [...overlapPairs.values()].map(([a, b]) => ({
      a,
      b,
      aPaths: abs(a, 'strict'),
      bPaths: abs(b, 'strict'),
      aInferred: abs(a, 'inferred'),
      bInferred: abs(b, 'inferred'),
    }));
    return detectRuntimeWriteRace(pairs);
  })();
  observe(raceProbe.observations);

  // ── 检查者写了东西吗 (D4 / §7.3, 2026-08-06, 只报不拦) ─────────────────────────
  // D-Q 检测者是**图内节点**: 与被它检查的兄弟共享同一棵 worktree, 而 conductor 把它排成
  // `executor:'agent'` 时它手里就是有写工具的。实测 54 跑: 23 个 detector 里 7 个是 agent (记了 writeCounts 的 4 个),
  // 那 4 个一次都没写 —— 这条纪律今天成立, 但成立的方式是**运气不是不变量**,
  // 而且真写了此前没有任何一处会知道。判据与分母都在 detectDetectorWrites 上。
  const detectorProbe = detectDetectorWrites(
    Object.values(results)
      .filter((r) => (plan?.nodes[r.id] as { detector?: unknown } | undefined)?.detector === true)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        // 缺席 ≠ 0: 这条链没人报 (旧 runner) 与"跑了但没写"是两件事, 前者进 unobserved。
        ...(r.writeCounts ? { writes: r.writeCounts[0] } : {}),
        ...(r.writeCandidates ? { writeCandidates: r.writeCandidates } : {}),
      })),
  );
  observe(detectorProbe.observations);

  // 最后再扫一次「声称 vs 引擎记录」—— **与上面那条 lint 同一个理由**: 内环那道只覆盖有 conductor
  // 节点的图, 而平铺的普通图 (`dag_run` 那条路) 一个 conductor 都没有, 上面那条路根本不经过。
  // 按 entry 数它占**一半流量**, 而此前它在账本上与"查过零检出"逐字相同 (2026-08-05 首次真跑撞到)。
  //
  // ⚠ **只进账本, 不进任何 prompt**: 平铺路没有内环 judge 可喂, 也**刻意不喂** DAG 级 verifier ——
  //   那是拨闸决定不是顺手, 而这一道是**纯测量**, 零行为风险。
  // ⚠ 面比内环那道**窄**: 只扫 output + facts, **不读产物内容** (读盘是 judge 视图专有的预算)。
  //   所以两道的数**分开记** —— 合并等于把两把不同宽度的尺子加在一起。
  {
    const nodes = Object.entries(results)
      // ⚠ **跳过 conductor 节点本身**: 它的 output 是子节点输出的**拼接**, 于是子节点那句声称
      //   会被父节点原样复述一遍 —— 而父节点手里没有子节点的 facts (bash 痕迹/退出码全在子节点上),
      //   于是一次**已经被内环放过**的诚实自验, 会在父节点这一格被反报成"无据"。
      //   (写这道扫描时当场被两条既有用例抓到, 不是推理出来的。)
      .filter(
        ([id, r]) => r !== undefined && r.status !== 'skipped' && r.kind !== 'conductor' && !claimCheckedIds.has(id),
      )
      .map(([id, r]) => ({
        id,
        output: r!.output ?? '',
        facts: engineFacts(r!, { expectExit: plan.nodes[id]?.expect_exit ?? 0, shellCap: SHELL_FACT_CAP }),
      }));
    const found = findUnsupportedClaims(nodes);
    flatCheckedNodes = nodes.length;
    flatFindings = found.length;
    observe(
      found.map((f) => ({ kind: 'unsupported-claim' as const, nodes: [f.nodeId], message: renderClaimObservation(f) })),
    );
  }

  // ── 「绿节点配空盘」后果网 (SDD 2026-08-22 · 片 3g 后续网) ───────────────────────
  // 写集全空闸: `done` 且声明了 `write_set` 且写集里**一个文件都不在盘上** ⇒ 出观察 (D-1
  // 只报不判)。判据刻意窄到「**一个都不在**」(D-2): 少几个太常见, 会刷屏; 「一个都不在」
  // 在正常交付里不可能。根用 `execRoot ?? repoRoot ?? cwd` (D-4, 隔离档下断言 worktree 那棵树
  // 而不是主仓 —— 片 1.5 的同款教训)。
  //
  // ⚠ 不给 `failed` / `skipped` 节点参与判定 (D-3: 它们没承诺产出);
  // 不给无 `write_set` 的节点参与判定 (D-3: 没有合同, 不判)。
  {
    const emptyWriteSetRoot = continuity?.execRoot ?? continuity?.repoRoot ?? process.cwd();
    const emptyNodes: string[] = [];
    for (const [id, r] of Object.entries(results)) {
      if (!r || r.status !== 'done') continue;
      // (2026-08-22) 节点定义从 plan.nodes 读, 不从 LeafResult —— results 上没有 write_set。
      const node = plan.nodes[id] as { write_set?: readonly string[] } | undefined;
      const ws = node?.write_set;
      if (!ws || ws.length === 0) continue;
      // INV-4: 写集里**哪怕只有一个**文件在盘上 ⇒ 不报。
      // 绝对路径原样, 相对路径按执行锚解析 (与产物闸同一根, 与产物语义一致)。
      const allMissing = ws.every((p) => !existsSync(p.startsWith('/') ? p : join(emptyWriteSetRoot, p)));
      if (allMissing) emptyNodes.push(id);
    }
    if (emptyNodes.length > 0) {
      observe([{
        kind: 'empty-write-set',
        nodes: emptyNodes,
        message: `声明了 write_set 却没有产物写入磁盘 (绿节点配空盘): [${emptyNodes.join(', ')}] 全部 done, 写集里一个文件都不在盘上 — 通常是回滚把产物擦掉了 / 写错了根 / worktree 被外力清理。`,
      }]);
    }
  }

  const notRun = Object.keys(plan.nodes).filter((id) => results[id] === undefined);
  return {
    plan,
    levels,
    results,
    reusedNodes: [...reuse.keys(), ...innerReused],
    // S-51 抓法 ③: 缺席 = 不是 resume (不适用); 空数组 = resume 了但一片都没失效。两者不许压平。
    ...(specChangedNodes !== undefined ? { specChangedNodes } : {}),
    observations,
    // 两道分开记 (宽度不同, 合并即错): conductor = output+facts+产物内容; flat = output+facts。
    // 两个分母**不重叠** (内环检过的子节点被平铺那道跳过)。缺席 = 早于本次改动的记录。
    claimCheck: {
      conductor: { rounds: claimCheckRounds, nodes: claimCheckedNodes, findings: claimFindings },
      flat: { nodes: flatCheckedNodes, findings: flatFindings },
    },
    // 同上一条纪律 (2026-08-06): 「产物没变」判据的分母 —— 可比较的跨轮次数, 不是运行次数。
    artifactMove: { transitions: moveTransitions, unobserved: moveUnobserved, findings: moveFindings },
    // 同上 (2026-08-06): 运行时写竞争 —— overlaps 是有没有并发, pairs 才是撞得上的机会。
    rollback,
    writeRace: {
      overlaps: raceProbe.overlaps,
      pairs: raceProbe.pairs,
      findings: raceProbe.findings,
      pairsInferred: raceProbe.pairsInferred,
      findingsInferred: raceProbe.findingsInferred,
    },
    ...(isCancelled() ? { cancelled: { reason: cancelReason(), at: new Date().toISOString(), notRun } } : {}),
    conductorUsage,
    leavesIn,
    leavesOut,
    leavesCacheHit,
  };
}

/**
 * 跑 omd 本体内部 executor-DAG。task → conductor 规划 → 现场 fan-out leaves → results。
 * 纯 in-process, 不落 PG。conductor/leaf 模型必须显式 (无硬默认)。
 *
 * 校验回流 (config.verifier 给则启用): DAG 跑完 → verifier 审结果 → fail 且配了**可用**升级模型
 * (provider 已注册) → 用更强 conductor 模型 + 注入失败原因重规划重跑, 有界 (maxEscalations, 默认 1)。
 * **升级模型 provider 未注册 (没配 API key) → 不升级, 维持弱模型** (Nick 指令; escalationProviderReady 判)。
 */
export async function runExecutorDag(
  task: string,
  config: ExecutorDagConfig,
  prior?: PriorExec,
): Promise<ExecutorDagResult> {
  if (!config.conductorModel) throw new Error('executor-dag: conductorModel 必填 (无硬默认, 形如 provider:modelId)');
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  return runDagInternal(task, config, null, prior);
}

/**
 * D-7 预构造入口: 接受一张**预构造 ConductorPlan** (pathfinder slice-compiler 的产物), **跳过 conductor
 * LLM 步**, 直接把 plan 交下游执行机器 (ready-set 调度 / 叶子 / verify / escalate) —— 下游行为与 conductor
 * 路径**完全一致** (ConductorPlan = 接缝, 下游零感知 plan 来源; D-7「执行机器不变」)。
 * conductorModel 对纯预构造执行**非必填** —— 仅当 verifier fail 且升级模型就绪时, escalate 才用 conductor
 * 重规划 (那时需 conductorEscalationModel)。leafModel 仍必填 (叶子执行要它)。
 */
export async function runExecutorDagWithPlan(
  plan: ConductorPlan,
  config: ExecutorDagConfig,
  prior?: PriorExec,
): Promise<ExecutorDagResult> {
  if (!config.leafModel) throw new Error('executor-dag: leafModel 必填 (无硬默认, 形如 provider:modelId)');
  // 注意 task 这一位是**合成大纲**不是用户任务 (deriveTaskFromPlan 把每个节点的 goal 列出来)。
  // 所以预构造路径**不把它注进 leaf**: 那等于告诉每个节点别的节点在干什么, 正是要避免的串味
  // (2026-08-04: fault-injection 夹具当场抓到 —— 注进去后每个节点都能看见 `NODE=a`/`NODE=b`)。
  // 预构造 plan 的调用方 (slice 编译器等) 本来就把该说的写在各自 goal 里。
  return runDagInternal(deriveTaskFromPlan(plan), { ...config, leafTaskContext: config.leafTaskContext ?? false }, plan, prior);
}

/**
 * plan → 文本大纲 (节点 id/executor/deps/goal 逐行)。escalation 重规划与预构造种子共用:
 * 重规划 conductor 必须**看得见上一轮分解**才可能「只修不发明」— 只给 task 散文会让它从零
 * 重新发明 plan (id/措辞全漂), 既丢已裁决结构又把 D-21 语义指纹复用全部打空 (2026-07-25 实证:
 * conductor 路径 escTask 原本不带上轮 plan → 重规划 0 复用)。
 */
function planOutline(plan: ConductorPlan): string {
  return Object.entries(plan.nodes ?? {})
    .map(([id, n]) => {
      const node = n as { goal?: string; depends_on?: string[]; executor?: string };
      const deps = node.depends_on?.length ? ` (depends_on: ${node.depends_on.join(', ')})` : '';
      return `- [${id}]${node.executor ? ` (${node.executor})` : ''}${deps}: ${node.goal ?? ''}`;
    })
    .join('\n');
}

/**
 * 预构造 plan → escalation 重规划的种子 task (仅 verify fail 升级时喂 conductor; 正常执行不触及)。
 * ★ 必须携带**整张已编译 plan** (节点 goal = pathfinder 裁决, depends_on = blockedBy 边):
 * 只给 description (= 目的地一句话) 会让升级 conductor 从散文重新发明 plan, 把地图上
 * 已裁定的每一条决策全部丢掉 (违反 D-11 只组装不发明)。
 */
function deriveTaskFromPlan(plan: ConductorPlan): string {
  const header = plan.description?.trim() || plan.name;
  return [
    header,
    '',
    '===== 已裁决的执行分解 (预构造 plan; 重规划时**只修不发明** — 保留各节点既定目标与依赖边) =====',
    planOutline(plan),
  ].join('\n');
}

/**
 * D-4 × W2 接缝 (2026-07-29 故障注入实测揪出): **resume 的已绿预载此前不问毒集**。
 *
 * 崩溃若落在「judge 拒了 X」与「X 真的重跑」之间, 盘上 X 的 per-node checkpoint 仍是那份**被拒的
 * 产出**, resume 会把它当绿跳过 —— 被拒产出借一次崩溃复活了。`computeReuse` 的毒集闸只管 D-21
 * 那条通道 (上轮 results 注入), 管不到 continuity 这条; 两条通道都能让上轮产出进入本轮, 只堵一条
 * 等于没堵。这正是 INV-P2-6 说的"毒集丢了比不复用更坏", 只是走的是另一条路。
 *
 * 前向闭包一起清: 下游那份 checkpoint 是**吃着被拒输出**跑出来的, 同样不作数
 * (computeReuse 靠 `deps.every(check)` 免费拿到这个闭包, 这里没有那条链, 故显式求不动点)。
 *
 * 代价是崩溃后被毒节点及其下游必然重跑一次 —— 与 D-4 同一个取舍: 多花的是钱, 省下的是信任。
 */
function dropPoisonedGreens(
  greens: Map<string, NodeCheckpoint>,
  plan: ConductorPlan,
  poisoned?: ReadonlySet<string>,
  /**
   * repo 根。给了 → 丢 checkpoint 的同时**把工作区一起退回去**(A, 2026-08-16)。
   *
   * 不给 = 老行为(只丢 checkpoint)。留这个口子是因为回滚是破坏性动作,而本函数在
   * resume 预载阶段被调,调用方未必总有一个可写的树(测试/预览路径)。
   * 判据与五条与门在 `poison-rollback.ts`;这里只负责喂给它「丢了谁」与「谁还活着」。
   */
  rollbackRoot?: string,
  /**
   * 跟踪文件还原基线 (2026-08-21)。给了才动跟踪文件;省略 = 老行为(跟踪文件一律留在盘上并留证)。
   * 前提由调用方担保:执行树自该 commit 以来的改动全是本次跑写的 —— 今天只有隔离档成立。
   */
  rollbackBaseline?: string,
  // D-4/C-1 (SDD 2026-08-22): 返回**本次真回滚过**(checkpoint 被丢) 的节点 id 列表。
  // 判定逻辑**逐字不变**;返回值是新增的观察面 (C-1/INV-1) —— 调用方据此把"已回滚"节点
  // 从跨轮复用集里踢出去 (C-2/INV-3)。回滚是破坏性的, 已发生;复用只是省钱优化, 冲突时让路。
): readonly string[] {
  if (!poisoned?.size || greens.size === 0) return [];
  const blocked = new Set<string>();
  for (const [id, fp] of merkleFingerprints(plan)) if (poisoned.has(fp)) blocked.add(id);
  // 通道⑤-b: 上面那行只认**图里现在有的**节点, 而 map/conductor 的子节点是运行期才挂进去的 ——
  // 预载这一刻它们不在图里, 重算够不着。judge 恰恰最可能点名的就是它们 (它在轮结果里看得见
  // 具体哪个子节点坏了)。改判 checkpoint 自己存下来的指纹, 不依赖当前图的形状。
  for (const [id, cp] of greens) if (cp.fingerprint && poisoned.has(cp.fingerprint)) blocked.add(id);
  if (blocked.size === 0) return [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, n] of Object.entries(plan.nodes)) {
      if (blocked.has(id)) continue;
      if ((n.depends_on ?? []).some((d) => blocked.has(d))) {
        blocked.add(id);
        changed = true;
      }
    }
  }
  // **运行时展开出来的子节点一起清** (2026-07-29 补, 通道⑤): 被毒的若是 map / conductor 节点,
  // 它的子节点 id 是 `${parentId}::${key}` —— 运行期才挂进 plan.nodes, 而本函数跑在 resume 预载
  // 阶段, 那时 `plan` 里**根本没有它们**, 上面的指纹遍历与前向闭包都够不着。
  //
  // 于是原样会漏成这样: judge 拒了 conductor 节点 C → C 的绿被清、C 重新展开 → 内容没变则子节点
  // 拿到**同样的内容寻址 id** → 各自命中自己那份**被拒的** checkpoint → 整棵子树跳过。
  // 父节点重跑了, 干活的子节点一个没重跑, 被拒的产出照样交付。
  //
  // 判据用 id 前缀而不是重建子图: 子图要重建就得先跑一次展开 (一次模型调用), 而前缀是
  // `${parentId}::` 这个由 INV-U2/D-B **构造保证**的形状, 不需要跑任何东西就能判。
  // 与 map 的 `expansionHash` 变更清子树 (`key.startsWith(`${id}::`)`) 是同一手法。
  for (const parentId of [...blocked]) {
    const prefix = `${parentId}::`;
    for (const key of [...greens.keys()]) if (key.startsWith(prefix)) blocked.add(key);
  }
  // ⚠ 丢之前先把 checkpoint 留下来 —— 回滚要读它的 outputPaths/artifactHashes,
  //   而 `greens.delete` 之后就没了。顺序错一行,回滚就变成静默的 no-op。
  const droppedCps = [...blocked].map((id) => [id, greens.get(id)] as const).filter(([, cp]) => cp !== undefined);
  const dropped = [...blocked].filter((id) => greens.delete(id));
  if (dropped.length) {
    logger.warn({ dropped }, '[omd/executor-dag] resume: 毒集命中 → 丢弃这些节点的已绿 checkpoint, 强制重跑 (D-4 × W2)');
  }
  if (!rollbackRoot || droppedCps.length === 0) return dropped;
  // A (#145 评论① 复盘): 丢 checkpoint 而不动盘 = 让"重跑"名不副实 —— 重跑的 leaf 看见活已经
  // 干完, 只读不写, 然后被产物闸判 empty-artifact。run 1c9a4566 五个真交付就是这么没的。
  // 存活 green 的产物一律不许碰 (与门④), 所以先把它们收出来。
  const keepPaths = new Set<string>();
  for (const cp of greens.values()) for (const p of cp.outputPaths ?? []) keepPaths.add(p);
  const plan2 = planPoisonRollback(
    droppedCps.map(([node, cp]) => ({
      node,
      outputPaths: cp!.outputPaths ?? [],
      artifactHashes: cp!.artifactHashes ?? {},
    })),
    keepPaths,
    rollbackRoot,
    {
      hashOf: (abs) => (existsSync(abs) ? hashArtifact(abs) : null),
      // 查不了一律当**有** —— 保守方向是"不撤", 与整个模块的取舍一致 (宁可少救一次, 不许误删)。
      existsInHead: (rel) => {
        try {
          return Bun.spawnSync(['git', 'cat-file', '-e', `HEAD:${rel}`], { cwd: rollbackRoot, stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
        } catch {
          return true;
        }
      },
    },
    rollbackBaseline,
  );
  applyPoisonRollback(plan2, rollbackRoot, rollbackBaseline ? { baseline: rollbackBaseline } : {});
  return dropped;
}

/**
 * crash 路径也入账 (2026-08-14, 记账完整性闸)。
 *
 * 此前 onComplete (dag-runs.db 的唯一写点) 只在 runDagInternal 正常返回时触发 —— 中途抛错
 * (规划失败 / verifier 硬死 / 升级重规划炸) 则整段 usage **从账上消失**。实测 f2af8514:
 * 终段崩掉 (infra-error), 该相位的 token 无记录, 夜账只能给下限。
 *
 * 做法: core 每轮把 exec 交进观察槽; 抛错时用**最后一轮已知的 exec** 写一条部分记录
 * (verification.pass=false, reason 带 crash 原文) 再原样抛。诚实边界 (明写, 不是漏):
 * ① 记的是最后一轮 exec 自己的 usage —— 升级轮的累计增量在 core 局部, 拿不到, 这是下限;
 * ② 规划期就炸 (exec 从未赋值) 记不了 —— 那时没有 plan/results 可记, 编一条空的比缺席更坏;
 * ③ 进程级死 (SIGKILL/OOM) 任何 in-process 钩子都救不了, 那一格由 runs.db 僵尸清扫兜底。
 */
async function runDagInternal(
  task: string,
  config: ExecutorDagConfig,
  prebuiltPlan: ConductorPlan | null,
  prior?: PriorExec,
): Promise<ExecutorDagResult> {
  const observed: { exec?: ExecOnce; sessionId?: string; conductorModel?: string } = {};
  try {
    return await runDagInternalCore(task, config, prebuiltPlan, observed, prior);
  } catch (err) {
    const exec = observed.exec;
    if (config.onComplete && exec) {
      const partial: ExecutorDagResult = {
        plan: exec.plan,
        sessionId: observed.sessionId ?? config.sessionId ?? config.continuity?.runId ?? 'unknown',
        levels: exec.levels,
        results: exec.results,
        reusedNodes: exec.reusedNodes,
        // S-51 抓法 ③ —— 守卫用 `!== undefined` 而**不是** `.length`: 后者会把
        // 「resume 了但一片都没失效」(空数组) 压成缺席, 与「不是 resume」再也分不开 (仓规坑 ①)。
        ...(exec.specChangedNodes !== undefined ? { specChangedNodes: exec.specChangedNodes } : {}),
        ...(exec.observations.length ? { observations: exec.observations } : {}),
        claimCheck: exec.claimCheck,
        artifactMove: exec.artifactMove,
        rollback: exec.rollback,
        writeRace: exec.writeRace,
        usage: { conductor: exec.conductorUsage, leavesIn: exec.leavesIn, leavesOut: exec.leavesOut, leavesCacheHit: exec.leavesCacheHit },
        verification: {
          pass: false,
          reason: `[crash 入账 (下限)] ${((err as Error).message ?? String(err)).slice(0, 500)}`,
          attempts: 0,
          escalated: false,
          conductorModel: observed.conductorModel ?? config.conductorModel ?? '',
        },
      };
      try {
        await config.onComplete(partial);
        logger.warn({ err: (err as Error).message }, '[omd/executor-dag] run 中途抛错 → 已写部分记录入账 (crash 不丢账)');
      } catch (e) {
        logger.warn({ err: (e as Error).message }, '[omd/executor-dag] crash 入账本身失败 (证据在此, 原错误照抛)');
      }
    }
    throw err;
  }
}

async function runDagInternalCore(
  task: string,
  config: ExecutorDagConfig,
  prebuiltPlan: ConductorPlan | null,
  /** crash 入账观察槽: core 每轮把 exec/sessionId/conductorModel 塞进来, 见 runDagInternal 的注。 */
  observed: { exec?: ExecOnce; sessionId?: string; conductorModel?: string },
  /** 上一**外层轮**的 {plan, results} (D-21 跨轮复用)。轮内 escalation 的 prior 另在下方组装。 */
  prior?: PriorExec,
): Promise<ExecutorDagResult> {
  /** #158 预算时间轴的本函数级锚 (config._budgetAnchor 缺席时的回落; 升级重规划闸读它)。 */
  const runStartedAt = Date.now();
  // **D-6 启动期孤儿回收**: 进程级一次性闸, run + solve 经引擎入口只触发一次。reapOrphansOnce
  // 内部已 fail-open (INV-6/7), 这里不包 try —— 模块保证不抛, 抛了也只 warn 后吞掉。
  reapOrphansOnce();
  // sessionId: 本次 run 的 conductor+leaf 全部经 send → 同一 Langfuse session (B2)。
  // 可注入 (config.sessionId): 调用方传则跨平面关联 (派活飞轮 dispatchId ↔ Langfuse session)。
  //
  // **没注入时退 runId 而不是新造一个 UUID** (2026-07-31 修): 自造的那个 id 谁都不认识 ——
  // 手上拿着 `dag_status` 给的 runId 去 Langfuse 找, 找不到; 反过来在 Langfuse 上看见一条有问题的
  // trace, 也回不到是哪一跑。观测面与执行面各持一个 id 而没有换算关系, 等于两张互不相认的表。
  // continuity 的 runId 正是留痕库/checkpoint 用的那一个, 用它 = 三边同名。
  const sessionId = config.sessionId ?? config.continuity?.runId ?? randomUUID();
  // **解析完就写回 config**: 下游 executePlan 里 agent leaf 的观测记录 (它不经 gateway) 要落到
  // 同一条 trace 上。不写回的话, 省略 sessionId 的调用方会得到两条 trace —— 一条模型调用的、
  // 一条 agent 的, 而它们本来是同一跑。同一件事只该有一个 id, 在这里定死。
  config = { ...config, sessionId };
  // SDD D-3 (2026-08-11): 判决/重规划升级为事件。executePlan 内另有一份节点级发射器; 这里发的是
  // run 级 verdict/replan —— id/parent 取 plan.name (被审对象 = 整轮, 无单一节点可挂)。
  const emitRunEvent = (e: DagNodeEvent): void => {
    try {
      config.onNodeEvent?.(e);
    } catch {
      /* fail-open */
    }
  };
  // runLabel = 这一跑的目标, 进 Langfuse 的 trace 名 —— 列表页按 name 认 trace, 全叫一个名字
  // 等于一屏一模一样的行。截断在 langfuse 那一侧做 (那儿才知道上限)。
  // phase = 图名原文 (`goal-contract` / `goal-execute` / `goal-execute-flat`), 只在预构造图那条路
  // 上存在 —— dag_run 直跑没有图名, 那时缺席 (不编一个 'execute', §3 第 1 条)。进 per-seat 台账,
  // 让「契约段 vs 执行段各烧多少」一条查询答得出 (#144)。
  const generate =
    config.generate ?? makeDefaultGenerate(sessionId, typeof task === 'string' ? task : undefined, prebuiltPlan?.name);
  const maxPlanRetries = config.maxPlanRetries ?? 2;
  const maxEscalations = config.maxEscalations ?? 1;
  // agent 模板注册表: 注入 (测试/宿主) 或加载 (内置+.omd/agents)。每 run 载一次, 规划+执行+升级共用。
  const templates = config.agentTemplates ?? loadAgentTemplates({ root: config.continuity?.repoRoot });
  const warnedUnknownProfiles = new Set<string>();
  let conductorModel = config.conductorModel ?? '';
  // D-7: 预构造 plan → executePlan 直执 (跳过 conductor); 否则 conductor 规划 → 执行。二者下游同一机器。
  observed.sessionId = sessionId;
  observed.conductorModel = conductorModel;
  let exec: ExecOnce;
  if (prebuiltPlan) {
    exec = await executePlan(applyPlanFilters(prebuiltPlan, config), task, config, generate, { in: 0, out: 0 }, templates, prior, undefined, warnedUnknownProfiles);
  } else {
    exec = await planAndExecute(task, config, conductorModel, generate, maxPlanRetries, templates, prior, undefined, warnedUnknownProfiles);
  }
  observed.exec = exec;
  // ── 冻结节点快照(SDD 2026-08-22 「冻结判据在重规划轮里并不冻结」, C-1/C-2/D-1/D-5):
  //   在 round-1 跑完**之后**立刻快照调用方点名的节点定义(post-filter 形态, 与
  //   `s1-green 被吸进 accept` 那条「不算违约」对得齐 — 我们复原的是引擎已采纳的形态,
  //   不去反向拆「串行 command 链机械合并」)。缺省 / 空数组 → 一字节不变(D-5)。
  //   后续每次升级重规划之后, 引擎用这张快照把点名节点的定义逐字盖回(`restoreFrozenNodes`)。
  //   ⚠ 不复制 exec.results / 毒集 / 复用集 — 只 snapshot plan.nodes 的字面 (INV-5)。
  const frozenNodeSnapshot = new Map<string, ConductorPlan['nodes'][string]>();
  for (const id of config.frozenNodes ?? []) {
    const n = exec.plan.nodes[id];
    if (n) frozenNodeSnapshot.set(id, n);
  }
  let conductorUsage = exec.conductorUsage;
  let leavesIn = exec.leavesIn;
  let leavesOut = exec.leavesOut;
  let leavesCacheHit = exec.leavesCacheHit;

  // ── 3. verify + conductor 静默升级 (config.verifier 给则启用) ──────────────────
  let verification: ExecutorDagResult['verification'];
  let verifierUsage: ModelUsage = { in: 0, out: 0 };
  /** D-4 打回读数 (SDD 2026-08-10-blame-scoped-node-retry): 最近一次 verifier 打回 (契约 f 单对象; maxEscalations=1 下即唯一一次)。 */
  let blameRetry: BlameRetryLedger | undefined;
  /** plan 形状 → invalidationClosure 吃的 deps 表 (nodeId → depends_on)。 */
  const depsOf = (p: ConductorPlan): Record<string, readonly string[]> =>
    Object.fromEntries(Object.entries(p.nodes).map(([id, n]) => [id, n.depends_on ?? []]));
  if (config.verifier) {
    let attempts = 1;
    let escalated = false;
    // verifier 调不通 (模型层纠偏重试已耗尽: 连续非 JSON / 网络死) ≠ 执行失败 —— 裸 throw 会把
    // **已收敛的整 run** 掀成 infra-error 一行字, 内环产出全丢 (实测样本 f3dd34b9, 2026-08-11:
    // opus 订阅通道连回三次散文)。这里以 [verifier-error] 记账: fail-closed 不算过, 产出保全,
    // 且**不进升级重规划环** —— 判卷官坏了还替它开修复轮 = 拿引擎故障当质量信号。
    // 词表同 infraStopped:「修引擎/换池, 别加轮数」。吞异常不吞证据: 错误原文进 reason 与日志。
    let verifierDown = false;
    const runVerifier = async (): Promise<VerifierVerdict> => {
      // 闸红短路 (#145 提议 5 Phase A, 2026-08-17): 图内确定性 oracle 已经说了不 → **不请强模型**。
      // 判据与"不短路"的那几格写在 oracle-red.ts 的文件头 (「oracle 说了不」≠「oracle 没能说话」)。
      // 包在 runVerifier 里而不是调用点: 升级重规划轮末尾那次 (`verdict = await runVerifier()`)
      // 走的是同一个闭包 —— 重画之后闸还红, 那一发同样不该打。两个调用点各写一份必漂。
      // ⚠ 不置 verifierDown: 判卷官没坏, 是我们选择不问它。escalation 环照常开。
      const reds = findRedOracles(exec.results);
      if (reds.length > 0) {
        const reason = renderOracleRedVerdict(reds);
        logger.info(
          { nodes: reds.map((r) => r.id), round: attempts },
          '[omd/executor-dag] 闸红短路 → 判词由确定性 oracle 合成, 强模型判卷这一发不打',
        );
        // Phase B1 归因 (**只观测, 不路由**): 这一坨诊断里有多少行归得到本跑的写者头上。
        // 这个数决定 B2 (定向返修节点) 那个形状成不成立 —— `failure-trace.ts` 记着一条
        // 对该方向不利的旧实测 (`assert-failed` 只有 1/7 认得出路径), 但它量在 800 字
        // summary 上且 n=7。**在这里重量一次全文的**, 攒够了再决定做不做 B2。
        // fail-open 不吞证据: 尺子挂了不许把一次正常的短路带塌。
        try {
          const attribution = attributeBlame(reds.map((r) => r.excerpt).join('\n'), exec.results, {
            root: config.continuity?.repoRoot ?? process.cwd(),
          });
          const line = renderAttribution(attribution);
          logger.info({ nodes: reds.map((r) => r.id) }, `[omd/executor-dag] ${line}`);
          exec.observations.push({ kind: 'blame-attribution', nodes: reds.map((r) => r.id), message: line });
        } catch (err) {
          logger.warn({ err: (err as Error).message }, '[omd/executor-dag] 闸红归因抛错 (已吞, 只丢一行读数)');
        }
        return { pass: false, reason, usage: { in: 0, out: 0 } };
      }
      try {
        // S-33 集成接线: artifactRoot 必须给, 终审三态 (registered/unregistered/missing) 才不会
        // 全程沉默 (summarizeResults 只在 artifactRoot 存在时判产物, 见 verifier.ts:123)。
        // 2026-08-23 s1 切片 1: 取执行锚 (execRoot), 不是状态锚 (repoRoot) —— 隔离档下两棵树,
        // leaf 真写的产物只在 execRoot 这棵上, 喂 repoRoot 给 verifier ⇒ 假 missing 判词。
        return await config.verifier!({ task, plan: exec.plan, results: exec.results, artifactRoot: config.continuity?.execRoot ?? config.continuity?.repoRoot ?? process.cwd() });
      } catch (err) {
        verifierDown = true;
        const detail = String(err).slice(0, 300);
        logger.warn({ err: detail }, '[omd/executor-dag] verifier 调不通 → 判卷缺席记账 (fail-closed, 保全执行产出; 修引擎/换池, 别加轮数)');
        return { pass: false, reason: `[verifier-error] 判卷官调不通 (模型层重试已耗尽): ${detail}`, usage: { in: 0, out: 0 } };
      }
    };
    let verdict = await runVerifier();
    verifierUsage = addUsage(verifierUsage, verdict.usage);
    emitRunEvent({ type: 'verdict', id: exec.plan.name, gate: 'verifier', verdict: verdict.pass ? 'pass' : 'fail', round: attempts, ...(verdict.reason ? { reason: verdict.reason } : {}) });
    // S3 片 5 / D-4/D-5 (INV-4/5/6): verdict 幂等账本。append-only, 同 (round, kind) 幂等, 异内容同键拒。
    // runVerifier 的两个出口 (oracle-red 短路 + 真投票) 都产 substantive; catch (verifier 调不通)
    // 那个出口已经返回 `[verifier-error]` 前缀的判词 + 设 verifierDown, 性质是 infra, 走另一列。
    // 终值只从 substantive 记录里取最后一条, infra 永不进终值 (仓规坑 1: NULL ≠ 0)。
    let ledger: VerdictLedger = emptyLedger();
    const recordVerdict = (v: VerifierVerdict, kind: VerdictKind): void => {
      const entry: VerdictEntry = {
        round: attempts,
        kind,
        pass: v.pass,
        reason: v.reason,
        at: new Date().toISOString(),
      };
      const res = append(ledger, entry);
      if (res.ok) {
        ledger = res.ledger;
        // S3 片 5 / INV-11 闸登记面: ledger 真的接上 (append 成功) 的判词, 与 retry-domain-mask 同档。
        if (res.appended) {
          logger.info(
            { round: attempts, kind, pass: v.pass },
            `[omd/executor-dag][verifier-ledger] verdict 账本追加 (round=${attempts}, kind=${kind})`,
          );
        }
      } else {
        // 异内容同键 = 同 (round, kind) 但 pass/reason 不同, 账本拒绝并保留既有 —— 闸面暴露
        // 拒因, 不在 ledger 里留假影子。
        logger.warn(
          { round: attempts, kind, pass: v.pass, reason: res.reason },
          `[omd/executor-dag][verifier-ledger] verdict 账本拒: ${res.reason}`,
        );
      }
    };
    recordVerdict(verdict, isInfraVerdict(verdict.reason) ? 'infra' : 'substantive');

    let escCount = 0;
    // D-6 同因熔断 (SDD 2026-08-11-inner-loop-v2, O-2 聚类定 P0): 上一轮打回原因的归一化指纹。
    // 连续两轮同因 → 停止重试, 标 STALLED 交人。maxEscalations=1 时循环至多一轮, 本闸不触发 (零回归);
    // >1 档 (真开放目标多轮修复) 才可能连撞, 那正是它的战场。
    let lastBlameKey: string | undefined;
    let sameCauseStreak = 0;
    let circuitBroken = false;
    // #249 (2026-08-25, 片 2): 外环瘫痪绊线 —— 一轮红节点**全部**死于"越权写/空产出"类
    // 败因 (重画不能扩权, 重画就该拒), 立即停轮交人。三条同时成立才触发:
    //   ① ≥PARALYSIS_MIN_RED 个红节点
    //   ② 全员 failureKind ∈ PARALYSIS_KINDS (gate-rejected / empty-artifact)
    //   ③ 无 assert-failed 等可修类 (混因 = 模型可能修得动别的, 这一规则不该挡它)
    // 出口 = D-6 同形 (circuitBroken + break + STALLED), 零新机制;observation 点名节点 + 败因 +
    // 「重画不能扩权, 该改的是契约写集/判据」(owner 拿到 STALLED 后下一步该动什么的指针)。
    const PARALYSIS_MIN_RED = 3;
    const PARALYSIS_KINDS: ReadonlySet<NodeFailureKind> = new Set<NodeFailureKind>(['gate-rejected', 'empty-artifact']);
    // D-P 取消接缝④: 不开新的升级重规划轮 (那是一整轮重规划 + 重跑, 最贵的一种"新活")。
    // #158 预算接缝: 同一句话对预算也成立 —— 环收敛/结束后, 预算已尽还开重规划轮, 正是
    // d39b559e 「134min 收敛后又跑 30min」那段的来源。判据与 executePlan 的派发闸同源
    // (时间轴, 锚 = _budgetAnchor ?? 本函数起跑)。
    const escBudgetHit = (): string | null => {
      const msCap = config.loopBudget?.ms;
      if (msCap === undefined) return null;
      const spent = Date.now() - (config._budgetAnchor ?? runStartedAt);
      return spent >= msCap
        ? `时间预算已尽: 已用 ${Math.round(spent / 1000)}s / 上限 ${Math.round(msCap / 1000)}s`
        : null;
    };
    while (
      !verdict.pass &&
      !verifierDown &&
      config.cancelSignal?.aborted !== true &&
      escCount < maxEscalations &&
      escalationProviderReady(config.conductorEscalationModel)
    ) {
      const budgetHit = escBudgetHit();
      if (budgetHit) {
        logger.warn({ escCount }, `[omd/executor-dag] ${budgetHit} → 不开升级重规划轮 (#158)`);
        break;
      }
      const blameKey = verdict.reason
        .replace(/第\s*\d+\s*轮/g, '')
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      if (blameKey === lastBlameKey) {
        sameCauseStreak++;
        if (sameCauseStreak >= 1) {
          circuitBroken = true;
          logger.warn(
            { reason: blameKey, streak: sameCauseStreak + 1, round: escCount },
            '[omd/executor-dag][fuse-samecause] D-6 同因熔断 → 停止重试 (连撞同一根因), STALLED 交人',
          );
          break;
        }
      } else {
        sameCauseStreak = 0;
        lastBlameKey = blameKey;
      }
      // ── #249 外环瘫痪绊线 (#249 SDD 2026-08-25, D-1/D-2) ─────────────────────
      // 与 D-6 同因熔断并排, 位置在 blameKey 熔断之后、C 无效否决闸之前
      // (确定性的先问, 零 LLM, 只读 exec.results)。三类**同时**成立才熔断:
      //   ① 红节点数 ≥ PARALYSIS_MIN_RED (=3, e63f47ea 样本 8/21 取保守下界)
      //   ② 全员 failureKind ∈ PARALYSIS_KINDS (gate-rejected / empty-artifact)
      //   ③ 任意红节点 failureKind 在 PARALYSIS_KINDS 外 (assert-failed 等) → 不触发:
      //      那条线模型可能修得动别的, 重画不能扩权这一规则不该挡它。
      // 出口 = D-6 同形 (circuitBroken + break + STALLED), 零新机制。observation
      // 点名节点 id + 各自败因 + 「重画不能扩权, 该改的是契约写集/判据」——
      // 那一句是 owner 拿到 STALLED 后下一步该动什么的指针, 不能省。
      // ⚠ 证伪方式: 删掉 PARALYSIS_MIN_RED 那行 → GWT-1 必红 (2 红也能熔断);
      //              把 `every(...)` 改成 `some(...)` → GWT-2 必红 (1 红就熔断)。
      const paralysisReds = Object.values(exec.results).filter((r) => r.status !== 'done');
      if (
        paralysisReds.length >= PARALYSIS_MIN_RED &&
        paralysisReds.every((r) => r.failureKind !== undefined && PARALYSIS_KINDS.has(r.failureKind))
      ) {
        circuitBroken = true;
        const summary = paralysisReds.map((r) => `${r.id}=${r.failureKind}`).join(', ');
        logger.warn(
          { red: paralysisReds.length, kinds: [...new Set(paralysisReds.map((r) => r.failureKind))] },
          '[omd/executor-dag][fuse-paralysis] #249 外环瘫痪: 全员越权写/空产出 → 重画不能扩权, STALLED 交人 (修契约写集/判据, 别加轮数)',
        );
        exec.observations.push({
          kind: 'blame-attribution',
          nodes: paralysisReds.map((r) => r.id),
          message: `#249 外环瘫痪绊线: 本轮 ${paralysisReds.length} 个红节点全部因 ${[...new Set(paralysisReds.map((r) => r.failureKind))].join('/')} 失败, 重画不能扩权 → STALLED 交人 (修契约写集/判据, 别加轮数)。节点: ${summary}`,
        });
        break;
      }
      // ── C (2026-08-21, run 58df6b9e 复盘): 否决**已拿到机器绿**的一轮, 判词必须可证伪 ──
      //
      // 那一跑: 内环 stop={success, '冻结判据绿'} · poisoned=[] · judge 的点名因 ghost id 被丢弃,
      // 而外层 verifier 照样推翻它触发重规划 → 毒集丢绿 → 半回滚 → leaf 空转 → 5 个 dep-skip。
      // 然后重规划后的判词抱怨「5/7 成功、2 个失败」—— **那两个失败是它自己那次否决造成的**。
      //
      // 这是 fail-open: 无效的 blame 也能推翻已绿的轮次。这里改成 fail-closed 到"不改"
      // (而不是 fail-open 到"重画") —— 与本仓「finding ≠ ground truth, oracle 证伪可驳」同口径。
      // ⚠ 只在**这一轮拿到过冻结判据绿**时才拦: 没拿到机器绿的否决本来就该放行 (活确实没干完)。
      // ⚠ 基础设施故障判词 (`[verifier-error]`) 不归本闸管, 那条路自己 fail-closed。
      const freezeGreenThisRound = Object.values(exec.results).some((r) => r.freezeGreen === true);
      // ── S-44 时效锚: 这条绿说的还是这棵树吗 ──────────────────────────────────
      // 判据绿之后引擎还有写权。拿判据那一刻的锚比对现在的树, 变了 = 这条绿属于**另一棵树**,
      // 不许再拿它去挡 verifier 的否决 (否则就是「用 T1 的绿保护 T2 的树」, S-44 的原形)。
      // 三态: same → 照旧拦; changed → 不拦, 出声; unknown → **照旧拦**并出声 ——
      // 取不到锚是我们没量到, 不是它变了, fail-open 到"不改变既有行为"是这一格的正确方向。
      const freezeAnchorVerdict = ((): AnchorVerdict => {
        if (!freezeGreenThisRound) return 'unknown';
        const before = Object.values(exec.results).find((r) => r.freezeGreen === true)?.freezeAnchor ?? null;
        const after = captureTreeAnchor(config.continuity?.execRoot ?? config.continuity?.repoRoot ?? process.cwd());
        return compareTreeAnchor(before, after);
      })();
      if (freezeGreenThisRound && freezeAnchorVerdict === 'changed') {
        logger.warn(
          { round: escCount, why: describeAnchorVerdict('changed') },
          '[omd/executor-dag] S-44 时效锚: 判据绿之后工作树又被改过 → 这条绿**不再**保护本轮, 否决照常放行',
        );
        exec.observations.push({
          kind: 'blame-attribution',
          nodes: [],
          message: `S-44 时效锚: 冻结判据绿之后工作树发生改动 —— 那条绿说的是另一棵树, 本轮不再据它拦截 verifier 否决。收编前请在目标 commit 上复跑判据。`,
        });
      }
      if (freezeGreenThisRound && freezeAnchorVerdict !== 'changed' && !isInfraVerdict(verdict.reason)) {
        if (freezeAnchorVerdict === 'unknown') {
          logger.warn({ round: escCount }, '[omd/executor-dag] S-44 时效锚: 取不到工作树锚 → 判据时效**未经核对** (照旧按绿处理, 但这一格没量到)');
        }
        const veto = classifyVeto(verdict.reason, Object.keys(exec.plan.nodes));
        if (!veto.falsifiable) {
          logger.warn(
            { reason: verdict.reason.slice(0, 300), why: veto.why, round: escCount },
            '[omd/executor-dag] C 无效否决闸: verifier 推翻了冻结判据绿的一轮却给不出可核对的理由 → **不开重规划轮** (fail-closed 到"不改"; 判据绿的活留在盘上, 红判词照记, 交人审)',
          );
          exec.observations.push({
            kind: 'blame-attribution',
            nodes: [],
            message: `C 无效否决闸: verifier 否决了冻结判据绿的一轮, 但${veto.why} → 未触发重规划。判词原文: ${verdict.reason.slice(0, 300)}`,
          });
          break;
        }
        logger.info({ anchors: veto.anchors, round: escCount }, '[omd/executor-dag] C 无效否决闸: 判词可证伪 → 放行重规划');
      }
      escCount++;
      attempts++;
      escalated = true;
      logger.info(
        { from: conductorModel, to: config.conductorEscalationModel, reason: verdict.reason },
        '[omd/executor-dag] verifier 未过 → conductor 静默升级重规划',
      );
      conductorModel = config.conductorEscalationModel;
      // D-21: escTask 必带上轮 plan 大纲 (planOutline) — 重规划「只修不发明」的前提是看得见上轮
      // 分解; 未点名节点逐字保留 → 语义指纹跨轮复用零 LLM (措辞漂移 = 白白重算)。
      // Tier-0 事件触发召回 (repair-guidance.ts): 失败判词命中已知死形态 fingerprint →
      // 把「上次怎么处置的」可教指引直接喂给修复轮 (零 LLM 零 embedding; 零命中 = escTask 零变化)。
      // 登记表 = 内置 + .omd/repair-guidance.jsonl 纠正台账 (owner 2026-08-17: 验尸抓到的 leaf
      // 纠正 append 进台账, 下一次同形失败在这里被吃到 —— escalation 稀少, 逐次现读不缓存)。
      const repairGuidance = collectRepairGuidance(
        verdict.reason,
        loadRepairFingerprints({ root: config.continuity?.repoRoot }),
      );
      const escTask = [
        task,
        '',
        '===== 上一轮的执行分解 (重规划基线) =====',
        planOutline(exec.plan),
        '',
        `[上一轮校验未通过] ${verdict.reason}`,
        ...repairGuidance,
        '请基于上述分解重新规划: 只修被点名有问题的节点; 未点名节点**逐字保留**其 id/goal/字段/依赖边',
        '(引擎按语义指纹复用未变节点的上轮结果 — 任何措辞变化都会浪费一次重算)。',
      ].join('\n');
      if (repairGuidance.length > 0) {
        logger.info({ hits: repairGuidance.map((g) => g.slice(0, 40)) }, '[omd/executor-dag] Tier-0 修复指引命中 → 注入 escTask');
      }
      // D-1/D-2 (SDD 2026-08-10-blame-scoped-node-retry): verifier 判词里的 ```blame 围栏是节点级
      // 点名 —— 解析成功 → 失效闭包 = blame ∪ downstream, 闭包指纹进 D-4 毒集 (同一通道, 前向闭包
      // 免费); 解析失败 (fail-open) → 现行整轮路径, 毒集照旧从外层轮继承, 行为逐字节不变 (INV-1)。
      const blame = parseBlameVerdict(verdict.reason);
      const blameNodes = blame?.filter((e): e is { node: string; reason: string } => 'node' in e) ?? [];
      // 点名 id 不在图内 → 过滤 (契约 b); 过滤后空 → 视同 undefined → 整轮 (fail-open, 不猜)。
      const inGraph = blameNodes.filter((e) => exec.plan.nodes[e.node]);
      const closure =
        inGraph.length > 0
          ? invalidationClosure(
              inGraph.map((e) => e.node),
              depsOf(exec.plan),
            )
          : null;
      // D-3 (2026-08-11): 升级重规划成事件 —— poisoned = 失效闭包 (blame 解析失败 → 整轮, 毒集空)。
      emitRunEvent({ type: 'replan', parent: exec.plan.name, round: escCount, poisoned: closure ? [...closure] : [] });
      // D-3 反馈锚定: 每个被责备节点自己的 reason → 后缀 (格式冻结于契约 e); 非闭包节点零触碰。
      const blameAnchor = new Map<string, string>();
      if (closure) {
        for (const e of inGraph) {
          if (closure.has(e.node)) blameAnchor.set(e.node, `\n\n---\n[verifier 打回 · 第 ${escCount} 轮]\n${e.reason}\n`);
        }
      }
      const closureFps = new Set<string>();
      if (closure) {
        for (const [id, fp] of merkleFingerprints(exec.plan)) if (closure.has(id)) closureFps.add(fp);
      }
      // D-21: 上轮 plan+results 作复用匹配源 — 语义未变的节点零 LLM 注入上轮输出, 只重跑变化子图。
      // 毒集: blame 解析成功 = 闭包指纹 (D-2, 取代整轮); 失败 = 从外层轮继承 (INV-1 零回归)。
      const priorExec: PriorExec = {
        plan: exec.plan,
        results: exec.results,
        ...(closure ? { poisoned: closureFps } : prior?.poisoned?.size ? { poisoned: prior.poisoned } : {}),
      };
      // S3.6 补丁模式优先 (未补丁节点字节不动 → 复用按构造成立); 补丁失败回退整图重规划 (fail-open)。
      // 平铺图确定性重规划 (SDD 2026-08-22 「平铺图确定性重规划」): 给则**直跳过**补丁与整图两段,
      // 不请 conductor (这一发 LLM 对编译产物是冗余 —— 重算等价复用)。返回 undefined 走今天路径 (INV-3)。
      const rerunStart = Date.now();
      // 切片 (2026-08-23, 引擎自纠错片 1 续) — 重规划轮开始判词 (C-1 INV-1): 时间戳进 payload
      // (goal-worker 不 import cli.ts, 薄壳 logger 不打时间, 复用片 1 roundStampNow —— D-1/D-2)。
      // 节点数 = 上一轮 (exec 仍是上轮 exec) 图规模, 让读日志的人能直观判「重规划规模 vs 原图」。
      logger.info(
        { round: escCount, at: roundStampNow(), poisoned: closure ? closure.size : 0, nodes: Object.keys(exec.plan.nodes).length },
        '[omd/executor-dag] 重规划轮开始',
      );
      const deterministicPlan = config.deterministicReplan?.();
      let replanMode: 'patch' | 'full' | 'deterministic';
      let patched: Awaited<ReturnType<typeof tryPatchReplan>> | null = null;
      let deterministicUsage: ModelUsage = { in: 0, out: 0 };
      if (deterministicPlan) {
        replanMode = 'deterministic';
        // D2 切片 3 —— 确定性重规划空转检测 → 修补节点。
        // 实测现场 (run e7e360f6): accept 红 + 平铺图 compileBreakdown 产物逐字相同 → 闭包内
        // 节点全部 D-21 复用 → 72 秒零修复空转。本片让引擎**当场**判空转, 改合一个修补节点:
        // task = verifier 失败原文 + 「只修这些」; 写集 = 本轮 leaf 写集并集; verify = 同条
        // accept 命令。BlameRetryLedger.replanMode 仍记 'deterministic' (修 union 越出本片写
        // 集 — 真要单独记 replanMode=repair-spin 走 follow-up 切片); 空转命中的可见信号改放
        // 判词日志 + plan.name 含 `__repair_spin_` 前缀 (图谱命名空间, 与 iterate 的 __iterate_*
        // 同源, 单测可一眼锚定)。
        const spinResult = trySpinRepair({
          closure,
          deterministicPlan,
          priorPlan: exec.plan,
          // #273 判据同源: 「谁会被复用」只有 computeReuse 说了算 (done+非毒+依赖链可复用) ——
          // 指纹近似把 failed 切片当「会复用」, 修补计划替换了本要真重跑的计划 (run b13545da)。
          // 预览与 executePlan 内那次 computeReuse 同 plan 同 prior 同毒集, 结果必然一致。
          reusedIds: new Set(
            computeReuse(applyPlanFilters(deterministicPlan, config), priorExec, priorExec.poisoned).keys(),
          ),
          frozenNodes: config.frozenNodes ?? [],
          priorResults: exec.results,
          verdictReason: verdict.reason,
          escCount,
        });
        let planToRun = deterministicPlan;
        if (spinResult.kind === 'spin') {
          planToRun = spinResult.plan;
          logger.info(
            {
              round: escCount,
              replaced: deterministicPlan.name,
              repair: spinResult.plan.name,
              closureSize: closure?.size ?? 0,
              reusedPriorFps: priorExec.poisoned?.size ?? 0,
            },
            '[omd/executor-dag] 重规划空转命中 (D2 切片 3) → 合成修补节点, 不跑原确定性计划',
          );
        } else if (spinResult.kind === 'fallback') {
          // 罕见的「无 command 类 verify 节点」情形 — 修补计划合成不出来, 退回原计划继续跑
          // (INV-D2-4 fail-open 不吞证据: 记一条 warn, 仍执行原 plan)。
          logger.warn(
            { round: escCount, planName: deterministicPlan.name },
            '[omd/executor-dag] 重规划空转命中但合成修补节点失败 (无 command 类 verify) → 退回原计划 (fail-open)',
          );
        }
        exec = await executePlan(applyPlanFilters(planToRun, config), escTask, config, generate, { in: 0, out: 0 }, templates, priorExec, blameAnchor, warnedUnknownProfiles);
      } else {
        patched = await tryPatchReplan(escTask, verdict.reason, priorExec, config, conductorModel, generate, maxPlanRetries, templates, blameAnchor, closure, warnedUnknownProfiles);
        // D-3 (SDD 2026-08-11-l2-diff-replan): replanMode 记这一轮走的是补丁差量还是回落整图,
        // replanTokens 是这一轮的总账 —— 补丁成功时 exec.conductorUsage 已折进补丁尝试的 token
        // (tryPatchReplan 内部注释同证); 回落时补丁尝试 (patched.usage) 与整图重灌 (exec.conductorUsage)
        // 两段都要, 不因回落就丢补丁那段的花费 (NULL≠0)。
        replanMode = patched.exec ? 'patch' : 'full';
        if (patched.exec) {
          exec = patched.exec;
        } else {
          conductorUsage = addUsage(conductorUsage, patched.usage); // 补丁尝试的 token 不丢账
          exec = await planAndExecute(escTask, config, conductorModel, generate, maxPlanRetries, templates, priorExec, blameAnchor, warnedUnknownProfiles, 'escalation');
        }
      }
      // 冻结节点复原(SDD 2026-08-22, C-2): 补丁模式与整图重规划两条路都在这里收敛后再做。
      // 先复原先于 observed.exec = exec 是有意的 — 把复原后的 plan 一起 snapshot 给观察者。
      restoreFrozenNodes(exec, frozenNodeSnapshot, config.frozenNodes);
      observed.exec = exec;
      observed.conductorModel = conductorModel;
      const replanTokens = replanMode === 'deterministic' ? deterministicUsage : replanMode === 'patch' ? patched!.usage : addUsage(patched!.usage, exec.conductorUsage);
      const rerunWallMs = Date.now() - rerunStart;
      // D-4 打回读数入账 (SDD 契约 f): 每次打回追加一条。reuseHits = 闭包外命中数 ——
      // 闭包指纹已入毒集, reusedNodes 里不可能有闭包节点, 这个数就是「闭包外且 D-21 命中」, 无第二套判定。
      blameRetry = {
        blameSize: blameNodes.length,
        closureSize: closure?.size ?? 0,
        reuseHits: exec.reusedNodes?.length ?? 0,
        rerunWallMs,
        replanMode,
        replanTokens,
      };
      // 切片 (2026-08-23, 引擎自纠错片 1 续) — 重规划轮结束判词 (C-1 INV-2):
      // ms = 该轮墙钟, sinceRunStartMs = 距 run 起跑的墙钟 (本片交付物「第 2 轮占总墙钟百分比」
      // 的分子与分母由读日志的人自己算, 引擎不算比值 —— D-5)。
      logger.info(
        {
          round: escCount,
          at: roundStampNow(),
          ms: rerunWallMs,
          mode: replanMode,
          reuseHits: exec.reusedNodes?.length ?? 0,
          sinceRunStartMs: Date.now() - runStartedAt,
        },
        '[omd/executor-dag] 重规划轮结束',
      );
      conductorUsage = addUsage(conductorUsage, exec.conductorUsage);
      leavesIn += exec.leavesIn;
      leavesOut += exec.leavesOut;
      leavesCacheHit += exec.leavesCacheHit;
      verdict = await runVerifier();
      verifierUsage = addUsage(verifierUsage, verdict.usage);
      emitRunEvent({ type: 'verdict', id: exec.plan.name, gate: 'verifier', verdict: verdict.pass ? 'pass' : 'fail', round: attempts, ...(verdict.reason ? { reason: verdict.reason } : {}) });
      // S3 片 5: 升级重规划轮末尾的 verifier 同样进账本 —— 同一 (round, kind) 重复追加是幂等空操作;
      // `[verifier-error]` 前缀的判词记 infra, 不抢 substantive 终值的位 (INV-4/5/6)。
      recordVerdict(verdict, isInfraVerdict(verdict.reason) ? 'infra' : 'substantive');
    }

    // 配了升级模型但 provider 未注册 (没配 API key) → 显式记: 维持弱模型 (Nick: 没配 SOTA 就不升级)。
    if (!verdict.pass && !escalated && config.conductorEscalationModel && !escalationProviderReady(config.conductorEscalationModel)) {
      logger.warn(
        { escalationModel: config.conductorEscalationModel },
        '[omd/executor-dag] verifier 未过, 但升级模型 provider 未注册 → 维持弱模型 (不升级)',
      );
    }
    // S3 片 5 / INV-5/6: 终值由账本选 (substantive 的最后一条), infra 另出独立标志位
    // —— 判词轴与引擎故障轴结构层分开, 一条 substantive 都没有时是「未判卷」而不是伪造 pass:false。
    const ledgerTerminal = terminal(ledger);
    const infraFlag = infraObserved(ledger);
    const finalReason = ledgerTerminal.kind === 'judged' ? ledgerTerminal.reason : (verdict.reason ?? '');
    const finalPass = ledgerTerminal.kind === 'judged' ? ledgerTerminal.pass : false;
    verification = {
      pass: finalPass,
      reason: finalReason,
      attempts,
      escalated,
      conductorModel,
      ...(circuitBroken ? { circuitBroken: true } : {}),
      ...(infraFlag ? { infraObserved: true } : {}),
    };
    // 闸登记面: 终值选取的判词 (INV-5 第二条 GWT: ledger 全 infra 时是「未判卷」, 不许伪造 fail)。
    if (ledgerTerminal.kind === 'unjudged') {
      logger.warn(
        { attempts, infraFlag },
        '[omd/executor-dag][verifier-ledger] 终值 = 未判卷 (账本里一条 substantive 都没有), 不伪造 pass:false (INV-5)',
      );
    }
  }

  // ── 4. bandit reward 回更 (config.router 给则): 最终轮每 leaf 的 (bucket, model) 按
  //       leafCostReward 更新 (ROUTER-5 成本主信号): 成功闸 × dag 软惩罚 (×0.3, 非清零 — DAG 级
  //       连坐是归因噪声) × exp(-costUsd/scale) 连续成本效率。质量由 verifier 闸住, bandit 学"过闸最省"。
  if (config.router) {
    const dagPass = verification ? verification.pass : undefined;
    for (const leaf of Object.values(exec.results)) {
      if (leaf.kind === 'command' || !leaf.model) continue;
      config.router.recordReward(leaf.kind, leaf.model, leafCostReward(leaf, dagPass));
    }
  }

  const result: ExecutorDagResult = {
    plan: exec.plan,
    sessionId,
    levels: exec.levels,
    results: exec.results,
    reusedNodes: exec.reusedNodes,
    // S-51 抓法 ③ —— 同下面那条警告: 算出来不透传 = 等于没有, 而症状全静默。
    // 守卫是 `!== undefined` 不是 `.length` (空数组 = resume 了但没变, 是有信息的读数)。
    ...(exec.specChangedNodes !== undefined ? { specChangedNodes: exec.specChangedNodes } : {}),
    ...(exec.observations.length ? { observations: exec.observations } : {}),
    // ⚠ 这一行是**逐字重建**的又一格: executePlan 算出来了, 外层不透传就等于没有 ——
    //   而症状是沉默的 (账本里那一列恒 NULL, 读上去像"早于该改动")。写这道扫描时当场被闸抓到。
    claimCheck: exec.claimCheck,
    // 同上那条警告: 不透传 = 账本那一列恒 NULL, 而 NULL 读上去是"早于该改动", 症状全静默。
    artifactMove: exec.artifactMove,
    rollback: exec.rollback,
    writeRace: exec.writeRace,
    ...(exec.cancelled ? { cancelled: exec.cancelled } : {}),
    usage: {
      conductor: conductorUsage,
      leavesIn,
      leavesOut,
      leavesCacheHit,
      verifier: config.verifier ? verifierUsage : undefined,
    },
    verification,
    ...(blameRetry ? { blameRetry } : {}),
  };
  if (config.onComplete) {
    try {
      await config.onComplete(result);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, '[omd/executor-dag] onComplete 钩子抛错 (不阻断返回)');
    }
  }
  return result;
}
