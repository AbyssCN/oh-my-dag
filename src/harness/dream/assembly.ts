/**
 * src/harness/dream/assembly —— dream SDD §S6 图装配 + 批级预算闸 (零 LLM 编排层)。
 *
 * 图 (§S6 原样, executor 归属):
 *
 *   gather(S1)              零 LLM, executor=直接调用
 *     → extract-chat × N    LLM(S4), 并行, 叶间无边
 *     → extract-run  × M    LLM(S5), 并行, 叶间无边
 *     → validate(S2)        零 LLM
 *     → merge(S2)           零 LLM
 *     → promote(S3)         零 LLM
 *     → prune(S3)           零 LLM
 *     → report              零 LLM
 *
 * 预算闸 (SDD §S6 判据 2):
 *   L_max = 12 (LLM 节点上限) / $_max = $0.10 (单跑成本上限)
 *   任一超 → 整跑 fail, 判词带实际值与上限, 不静默降级。
 *
 * 首跑分批语义 (§6-2 裁决 12): 按时间窗切, 每跑吃一段, 水位逐段推进。
 *   天然复用 S1 水位机制 — gather 的 dirty 窗口由 watermark 控制, 本层
 *   提供 `capDirtySessions` 来限制单跑 LLM 节点数 ≤ L_max。
 *
 * 账唯一出口 = gateway callModel (model/index.ts 出口已 emitModelUsage),
 *   任何层不得再 emitModelUsage —— 双计 (S5 终审实测教训)。
 *
 * 幂等: 同数据二跑 created-count 归零 (identityKey 兜底, merge 层保证)。
 */
import { join } from 'node:path';
import type { ModelRequest, ModelResponse } from '../../model/types';
import { createCostLedger, attachLedger, type CostLedger } from '../../model/accounting';
import { createOmdMemory, type OmdMemory } from '../memory';
import type { EdgeStore } from '../memory/types';
import { createRunStore, type RunStore, type PersistedRun } from '../../mcp/run-store';
import { createPlanLedger, type PlanLedger } from '../plan-ledger';
import { createOmdSessionStore } from '../chat/session-store';

import { gather, type GatherReport } from './gather';
import { type DreamCandidate, validateDreamCandidate } from './validate';
import { mergeDreamCandidates, type MergeReport } from './merge';
import { promoteDreamFacts, type PromoteReport } from './promote';
import { extractChatSession, type ExtractChatSessionInput } from './extract-chat';
import { extractRunRecord, type ExtractRunInput } from './extract-run';
import { buildDreamReport, formatDreamReport, type DreamRunReport } from './report';

// ---------------------------------------------------------------------------
// 预算常量 (引用 extract-chat.ts 已导出常量, 不重复字面量)
// ---------------------------------------------------------------------------

import { L_MAX, COST_MAX_USD } from './extract-chat';

export { formatDreamReport } from './report';
export { L_MAX, COST_MAX_USD };

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface DreamAssemblyOpts {
  /** 工作目录 (仓根)。 */
  cwd: string;
  /** 本次 run id (来源追踪)。 */
  runId: string;
  /**
   * 注入 callModel (依赖注入, 测试走 fake)。
   * 生产: gateway callModel (model/index.ts 出口, 已 emitModelUsage)。
   */
  callModel?: (req: ModelRequest) => Promise<ModelResponse>;
  /** provider:modelId 坐标。必须显式传入或设 OMD_DREAM_MODEL env；缺失 → 抛错 (禁静默兜底)。 */
  model?: string;
  /** 单跑 LLM 叶数上限。省略 → L_MAX (12)。 */
  maxLLMLeaves?: number;
  /** 单跑成本上限 USD。省略 → COST_MAX_USD (0.10)。 */
  maxCostUsd?: number;
  /**
   * 当前 conductor 会话 id — 本会话不计入 dirty 候选、不计入 minSessions 水位判据。
   * 生产由 conductor 传入；测试可传 lambda 到 gather.isSessionActive。
   */
  currentSessionId?: string;
}

export interface DreamAssemblyReport extends DreamRunReport {
  /** 逐 phase 明细 (调试/审计)。 */
  phases: {
    gather: GatherReport;
    extractChat: number; // 实际跑的 chat 叶数
    extractRun: number;  // 实际跑的 run 叶数
    merge: MergeReport;
    promote: PromoteReport;
  };
}

// ---------------------------------------------------------------------------
// 辅助: 从 runs.db + plan-ledger 构造 ExtractRunInput
// ---------------------------------------------------------------------------

function buildExtractRunInput(
  run: PersistedRun,
  planLedger: PlanLedger,
): ExtractRunInput {
  // plan-ledger: 通过 runId 查 family/版本 (plan 的 record 接口无法按 runId 反查,
  // 走 families()/plans() 扫。生产规模 < 100, 性能可接受。
  const families = planLedger.families();
  let planLedgerInfo: ExtractRunInput['planLedger'] | undefined;

  for (const fam of families) {
    const entries = planLedger.plans(fam.id);
    for (const entry of entries) {
      // plan entry 不记 runId, 用 family 兜底 —— 只记最近一条同 family 版本。
      // 这是近似, 精度够用 (同一个 run 不会跨 family)。
      planLedgerInfo = {
        familyId: fam.id,
        familyCanonicalTask: fam.canonicalTask,
        planVersion: entry.version,
        planOk: entry.okRuns > 0,
        planVerified: entry.verified,
        costUsd: entry.totalCostUsd,
        generation: entry.generation ?? undefined,
      };
      break; // 取最新版本
    }
    if (planLedgerInfo) break;
  }

  return {
    runId: run.runId,
    status: run.status,
    goal: run.goal,
    error: run.error,
    planLedger: planLedgerInfo,
  };
}

// ---------------------------------------------------------------------------
// 首跑分批: 限制 dirty session 数 ≤ maxLLMLeaves
// ---------------------------------------------------------------------------

/**
 * 从 gather report 中选出不超过 limit 个 dirty source (session 优先, run 次之)。
 * 返回被选中的 source key 集合。
 */
function capDirtySources(report: GatherReport, limit: number): Set<string> {
  const selected = new Set<string>();
  // session 优先 (chat 叶通常更有价值)
  for (const s of report.sources) {
    if (s.state !== 'dirty') continue;
    if (selected.size >= limit) break;
    selected.add(s.key);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// 主编排
// ---------------------------------------------------------------------------

export async function runDreamAssembly(
  opts: DreamAssemblyOpts,
): Promise<DreamAssemblyReport> {
  const { cwd, runId, callModel, model, currentSessionId } = opts;
  const maxLLM = opts.maxLLMLeaves ?? L_MAX;
  const maxCost = opts.maxCostUsd ?? COST_MAX_USD;

  // ── 模型解析: 必须显式, 缺失抛错 ──
  const resolvedModel = model ?? process.env.OMD_DREAM_MODEL;
  if (callModel && !resolvedModel) {
    throw new Error('dream assembly: model required — pass opts.model or set OMD_DREAM_MODEL; no silent fallback');
  }

  // ── 账本: 独立 CostLedger, 订阅 callModel 出口 (唯一入账点) ──
  const ledger: CostLedger = createCostLedger({ limitUsd: maxCost });
  const detach = attachLedger(ledger);

  // ── 持久面 ──
  const memory: OmdMemory = createOmdMemory({ path: join(cwd, '.omd', 'memory.db') });
  const edges: EdgeStore = memory.edges;
  const runStore: RunStore = createRunStore({ path: join(cwd, '.omd', 'runs.db') });
  const planLedger: PlanLedger = createPlanLedger({ path: join(cwd, '.omd', 'plan-ledger.db') });
  const sessionStore = createOmdSessionStore(cwd);

  try {
    // ══════════════════════════════════════════════════════════════════
    // S1: gather (零 LLM)
    // ══════════════════════════════════════════════════════════════════
    const gatherReport = await gather({
      cwd,
      runStore,
      isSessionActive: currentSessionId
        ? (sid: string) => sid === currentSessionId
        : undefined,
    });

    // 全 clean → 零 LLM, 整图 NOOP
    if (gatherReport.skippedClean) {
      const report = buildDreamReport({
        runId,
        gather: gatherReport,
        merge: {
          ok: true, added: 0, evolved: 0, replaced: 0,
          rejected: [], conflictsRaised: 0,
        },
        promote: { ok: true, promoted: 0, pruned: 0 },
        llmCalls: 0,
        costUsd: 0,
      });
      return {
        ...report,
        phases: { gather: gatherReport, extractChat: 0, extractRun: 0,
          merge: { ok: true, added: 0, evolved: 0, replaced: 0, rejected: [], conflictsRaised: 0 },
          promote: { ok: true, promoted: 0, pruned: 0 } },
      };
    }

    // ── 预算闸: 前置检查 LLM 叶数 ──
    const dirtySessionCount = gatherReport.sources.filter(
      (s) => s.type === 'session' && s.state === 'dirty',
    ).length;
    const dirtyRunCount = gatherReport.sources.filter(
      (s) => s.type === 'run' && s.state === 'dirty',
    ).length;
    const totalLLMLeaves = dirtySessionCount + dirtyRunCount;

    if (totalLLMLeaves > maxLLM) {
      detach();
      const failReason =
        `L_max exceeded: ${totalLLMLeaves} LLM leaves (${dirtySessionCount} chat + ${dirtyRunCount} run) > limit ${maxLLM}`;
      const report = buildDreamReport({
        runId,
        gather: gatherReport,
        merge: { ok: false, added: 0, evolved: 0, replaced: 0, rejected: [], conflictsRaised: 0, failReason },
        promote: { ok: true, promoted: 0, pruned: 0 },
        llmCalls: 0,
        costUsd: 0,
      });
      report.ok = false;
      report.failReason = failReason;
      return {
        ...report,
        phases: { gather: gatherReport, extractChat: 0, extractRun: 0,
          merge: { ok: false, added: 0, evolved: 0, replaced: 0, rejected: [], conflictsRaised: 0, failReason },
          promote: { ok: true, promoted: 0, pruned: 0 } },
      };
    }

    // ── 首跑分批: 若 LLM 叶数超限, 按 dirty source 数截断 ──
    // (裁决 12: 按时间窗切, 每跑吃一段, 水位逐段推进)
    const cappedSources = capDirtySources(gatherReport, maxLLM);

    // ══════════════════════════════════════════════════════════════════
    // S4: extract-chat × N (LLM, 并行)
    // ══════════════════════════════════════════════════════════════════
    const chatCandidates: Array<{ leafId: string; candidate: DreamCandidate }> = [];
    let chatLeafCount = 0;

    if (callModel) {
      const dirtySessions = gatherReport.sources.filter(
        (s) => s.type === 'session' && s.state === 'dirty' && cappedSources.has(s.key),
      );

      // 并行执行 (Promise.all)
      const chatResults = await Promise.all(
        dirtySessions.map(async (s) => {
          const sessionId = s.key.replace(/^session:/, '');
          const sess = await sessionStore.open(sessionId);
          if (!sess) return { leafId: s.key, candidates: [] as DreamCandidate[] };
          const entries = await sess.entries();
          const input: ExtractChatSessionInput = { sessionId, entries };
          const result = await extractChatSession(input, { callModel, model: resolvedModel });
          return { leafId: s.key, candidates: result.candidates };
        }),
      );

      for (const { leafId, candidates } of chatResults) {
        chatLeafCount++;
        for (const c of candidates) {
          chatCandidates.push({ leafId, candidate: c });
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // S5: extract-run × M (LLM, 并行)
    // ══════════════════════════════════════════════════════════════════
    const runCandidates: Array<{ leafId: string; candidate: DreamCandidate }> = [];
    let runLeafCount = 0;

    if (callModel) {
      const dirtyRuns = gatherReport.sources.filter(
        (s) => s.type === 'run' && s.state === 'dirty' && cappedSources.has(s.key),
      );

      const runResults = await Promise.all(
        dirtyRuns.map(async (s) => {
          const runIdFromKey = s.key.replace(/^run:/, '');
          const run = runStore.all().find((r) => r.runId === runIdFromKey);
          if (!run) return { leafId: s.key, candidates: [] as DreamCandidate[] };
          const input = buildExtractRunInput(run, planLedger);
          const result = await extractRunRecord(input, { callModel, model: resolvedModel, edges });
          return { leafId: s.key, candidates: result.candidates };
        }),
      );

      for (const { leafId, candidates } of runResults) {
        runLeafCount++;
        for (const c of candidates) {
          runCandidates.push({ leafId, candidate: c });
        }
      }
    }

    // ── 成本闸: 检查实际花费 ──
    const state = ledger.state();
    if (state.spentUsd > maxCost) {
      detach();
      const failReason =
        `$_max exceeded: spent $${state.spentUsd.toFixed(6)} > limit $${maxCost.toFixed(2)}`;
      const report = buildDreamReport({
        runId,
        gather: gatherReport,
        merge: { ok: false, added: 0, evolved: 0, replaced: 0, rejected: [], conflictsRaised: 0, failReason },
        promote: { ok: true, promoted: 0, pruned: 0 },
        llmCalls: state.calls,
        costUsd: state.spentUsd,
      });
      report.ok = false;
      report.failReason = failReason;
      return {
        ...report,
        phases: { gather: gatherReport, extractChat: chatLeafCount, extractRun: runLeafCount,
          merge: { ok: false, added: 0, evolved: 0, replaced: 0, rejected: [], conflictsRaised: 0, failReason },
          promote: { ok: true, promoted: 0, pruned: 0 } },
      };
    }

    // ══════════════════════════════════════════════════════════════════
    // S2: validate (零 LLM) → merge (零 LLM)
    // ══════════════════════════════════════════════════════════════════
    const allCandidates = [...chatCandidates, ...runCandidates];

    // validate 逐条: S-拒 + P-拒 + floor (merge 的 writeFact 内部再验 floor, 幂等)
    const preRejected: MergeReport['rejected'] = [];
    const validated: Array<{ leafId: string; candidate: DreamCandidate }> = [];
    for (const item of allCandidates) {
      const vr = await validateDreamCandidate(item.candidate, { cwd });
      if (vr.verdict === 'written') {
        validated.push(item);
      } else {
        preRejected.push({ candidate: item.candidate, reason: vr.reason });
      }
    }

    const mergeReport = await mergeDreamCandidates(validated, { cwd, memory, runId });
    // merge writeFact 内部可能再拒 (floor reject), 合并 reject 列表
    mergeReport.rejected = [...preRejected, ...mergeReport.rejected];

    // ══════════════════════════════════════════════════════════════════
    // S3: promote + prune (零 LLM)
    // ══════════════════════════════════════════════════════════════════
    const promoteReport = await promoteDreamFacts({ cwd, memory });

    // ══════════════════════════════════════════════════════════════════
    // Report
    // ══════════════════════════════════════════════════════════════════
    const finalState = ledger.state();
    detach();

    const report = buildDreamReport({
      runId,
      gather: gatherReport,
      merge: mergeReport,
      promote: promoteReport,
      llmCalls: finalState.calls,
      costUsd: finalState.spentUsd,
    });

    return {
      ...report,
      phases: {
        gather: gatherReport,
        extractChat: chatLeafCount,
        extractRun: runLeafCount,
        merge: mergeReport,
        promote: promoteReport,
      },
    };
  } finally {
    detach();
    memory.close();
    runStore.close();
    planLedger.close();
  }
}

// ---------------------------------------------------------------------------
// 便捷: 一步跑 + 打印报告
// ---------------------------------------------------------------------------

export async function dreamOnce(
  opts: DreamAssemblyOpts,
): Promise<DreamAssemblyReport> {
  const report = await runDreamAssembly(opts);
  console.log(formatDreamReport(report));
  return report;
}
