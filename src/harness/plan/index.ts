/**
 * plan barrel —— omd plan mode (P1 脊柱: A mode闸 + B 审议循环 + E 模型座舱)。
 * SDD/plan: ~/.claude/plans/typed-questing-waterfall.md。
 */
export {
  createPathfinderModeState,
  type PathfinderModeState,
  type PathfinderModeStatus,
} from './mode';
export {
  ensurePlanToggleKeyFree,
  type EnsurePlanKeyOpts,
  type EnsurePlanKeyResult,
  type EnsurePlanKeyReason,
} from './keybindings-setup';
export { PlanLedger, type PlanRef, type PlanLedgerInit } from './ledger';
// plan-extension/overlay 已撤 (2026-07-25 owner 裁决, 见 mode.ts 头注); readonly-gate 已退役 (D-5)。
export { extractUrls, stripUrls } from './url-detect';
export {
  createDefaultWebRetriever,
  type WebRetriever,
  type FetchedRef,
  type ExecFn,
  type DefaultRetrieverOpts,
} from './web-retriever';
export {
  createDistiller,
  DISTILL_DEFAULT_MODEL,
  DEFAULT_LENSES,
  type DistillFn,
  type DistillResult,
  type DistillerOpts,
  type DistillLens,
} from './distill';
export {
  contextStage,
  contextStageNote,
  CRYSTALLIZE_THRESHOLD,
  COMPACT_PRESERVE_INSTRUCTIONS,
  type ContextStage,
} from './context-monitor';
export {
  createSessionStore,
  type SessionStore,
  type SessionCrystal,
  type SessionRef,
} from './session-store';
export {
  bestOfNPlan,
  DEFAULT_PLAN_LENSES,
  BESTOFN_DEFAULT_MODEL,
  councilDeepPlan,
  DEFAULT_COUNCIL_DEEP_LENSES,
  DEFAULT_COUNCIL_DEEP_FRAMINGS,
  DEFAULT_COUNCIL_DEEP_CRITERIA,
  type PlanLens,
  type PlanCandidate,
  type BestOfNVerdict,
  type BestOfNResult,
  type BestOfNOpts,
  type CouncilDeepOpts,
} from './best-of-n';
export {
  classifyTaskComplexity,
  shouldSpawnAgents,
  grillOfferThreshold,
  type ComplexityLevel,
  type ComplexitySignals,
} from './complexity';
export {
  runFixpoint,
  defaultEnrich,
  DEFAULT_MAX_ROUNDS,
  type FixpointVerdict,
  type FixpointRound,
  type FixpointStatus,
  type FixpointResult,
  type FixpointOpts,
  type RoundRunner,
  type FixpointJudge,
  type EnrichFn,
} from './fixpoint';
export {
  iterateExecutorDag,
  summarizeDagResult,
  type IterateConfig,
  type IterateResult,
} from './iterate';
export {
  makeLlmConvergenceJudge,
  CONVERGENCE_VERDICT_SCHEMA,
  DEFAULT_CONVERGENCE_THRESHOLD,
  type LlmJudgeOpts,
} from './llm-judge';
