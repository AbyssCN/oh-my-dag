/**
 * plan barrel —— valar plan mode (P1 脊柱: A mode闸 + B 审议循环 + E 模型座舱)。
 * SDD/plan: ~/.claude/plans/typed-questing-waterfall.md。
 */
export {
  createPlanExtension,
  PLAN_DEFAULT_MODEL,
  PLAN_DEFAULT_THINKING,
  type PlanExtensionOpts,
} from './plan-extension';
export { createPlanModeState, type PlanModeState, type PlanModeStatus } from './mode';
export { PlanLedger, type PlanRef, type PlanLedgerInit } from './ledger';
export { PLAN_MODE_OVERLAY, GRILL_OVERLAY } from './overlay';
export {
  isWriteTool,
  isBashMutation,
  isDocWritePath,
  writeTargetPath,
  DEFAULT_DOC_WRITE_DIRS,
} from './readonly-gate';
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
  type PlanLens,
  type PlanCandidate,
  type BestOfNVerdict,
  type BestOfNResult,
  type BestOfNOpts,
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
