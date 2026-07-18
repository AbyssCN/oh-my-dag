/**
 * omd core barrel —— omd 本体 (controller-first, soul-as-code)。
 * SDD: docs/plan/PLAN-2026-06-01-omd-agent-landing-SDD.md §4 V2 / §11。
 */
export { OmdController, type OmdControllerConfig } from './controller';
// tui-config: TUI 部署期策略纯函数 (hashline 判定 + env bool 解析)。
export { resolveHashlineEdit, envBool } from './tui-config';
// user-profile: 用户静态档案 (user.md) 读取 + 注入封装。
export { readUserProfile, wrapUserProfile, DEFAULT_USER_PROFILE_PATH } from './user-profile';
// memory-extension: omd 自我记忆接进 TUI (remember 工具 + 存储 emoji + human_verified 弹窗)。
export { createMemoryExtension, type MemoryExtensionOpts } from './memory-extension';
// recall-extension: omd 自我记忆检索工具 (recall tool, 与 remember 配对)。
export { createRecallExtension, type RecallExtensionOpts } from './recall-extension';
export { OMD_IDENTITY, OMD_IDENTITY_VERSION } from './identity';
export { TASTE_CORE, composeTastePersona } from './taste';
export { createIdentityExtension } from './identity-extension';
export { ensureMimoApiKey } from './mimo-env';
export {
  createOmdHooks,
  createToolGateHook,
  classifyCommand,
  DANGEROUS_PATTERNS,
  type OmdHookConfig,
  type ToolGateConfig,
  type CommandVerdict,
  type DangerousPattern,
} from './hooks';
export {
  OmdMemory,
  createOmdMemory,
  SqliteEdgeStore,
  PgEdgeStore,
  EdgeOverlapError,
  EdgeStoreNotImplemented,
  hashEmbed,
  defaultEmbed,
  DEFAULT_EMBED_DIM,
  type OmdMemoryOptions,
  type EmbedFn,
  type StoredFact,
  type MemoryHit,
  type WriteFactResult,
  type TemporalEdge,
  type EdgeStore,
} from './memory';
export {
  detectLegalClaims,
  checkProseGrounding,
  factWriteIsGrounded,
  coerceOrRepair,
  extractJson,
  GROUNDING_NUDGE,
  createGroundingNudgeExtension,
  createGroundingGateExtension,
  EMPTY_LEXICON,
  UNIVERSAL_CITATION_MARKERS,
  type LegalClaim,
  type GroundingPattern,
  type GroundingLexicon,
  type GroundingSeverity,
  type GroundingAction,
  type GroundingVerifier,
  type GroundingConfig,
  type GroundingVerdict,
  type GroundingGateOptions,
  type RepairResult,
  type RepromptFn,
  type CoerceOrRepairOpts,
} from './weak';
export {
  REJECT_CRITERIA,
  ACCEPT_CRITERIA,
  ROUND_CAPS,
  screenFinding,
  buildReviewPrompt,
  buildGateReview,
  reviewActivates,
  isMandatoryReview,
  resolveReviewModel,
  type ReviewGate,
  type ScreenResult,
  type ReviewDimension,
  type ReviewPromptOpts,
  type AgentRole,
  type ReviewRouting,
  type MandatoryReviewInput,
} from './review';
export {
  effectiveFanout,
  resolveProviderCap,
  resolveExecutorModel,
  resolveConductorModel,
  parseModelRef,
  CPU_FALLBACK_FANOUT,
  DEFAULT_PROVIDER_POOLS,
  DEFAULT_ROUTING,
  type OmdConcurrencyConfig,
  type ModelRoutingConfig,
  type ModelRef,
  type TaskKind,
} from './fleet';
export {
  runExecutorDag,
  topoLevels,
  type ExecutorDagConfig,
  type ExecutorDagResult,
  type LeafResult,
  type GenerateFn,
} from './executor-dag';
export {
  createDefaultVerifier,
  resolveVerification,
  escalationProviderReady,
  summarizeResults,
  VERIFIER_VERDICT_SCHEMA,
  type VerifierFn,
  type VerifierVerdict,
  type VerificationConfig,
  type DefaultVerifierOpts,
  type ResolveVerificationOpts,
} from './verifier';
export {
  createModelRouter,
  createModelRouterFromEnv,
  type LeafModelRouter,
  type ModelRouterOpts,
  type ModelRouterHandle,
  type RouterArmEntry,
} from './model-router';
export {
  createAgentLeafRunner,
  type AgentLeafRunner,
  type AgentLeafInput,
  type AgentLeafResult,
  type AgentLeafRunnerOpts,
  type ToolDefinition,
} from './agent-leaf';
export { cavemanRule, leafCavemanLevel, type CavemanLevel } from './caveman';
export {
  createCommandLeafRunner,
  type CommandLeafRunner,
  type CommandLeafInput,
  type CommandLeafResult,
  type CommandLeafRunnerOpts,
} from './command-leaf';
// hashline: 行锚定 patch 读改工具 (治弱模型 agent leaf edit 错位/腐烂)。
export {
  createHashlineTools,
  createHashlineCustomTools,
  createHashlineExtension,
  HASHLINE_GUIDELINES,
  HASHLINE_BLOCK_NATIVE_EDIT_REASON,
  type HashlineToolsOpts,
  type HashlineTools,
} from './hashline';
// cg-retrieve: omd 监督式自装产物 (DeepSeek agent leaf 写, omd verify) — codegraph 并行检索能力。
export { cgRetrieve, type CgRetrieveOpts } from './cg-retrieve';
// sec-audit: omd 监督式自装产物 — 多 lens 并行安全审计 (piolium 方法论 → DAG)。
export { secAudit, type SecAuditOpts } from './sec-audit';
// sast-scan: omd 自装 (T1) — 确定性 semgrep SAST 扫描 (command-leaf lens, 与 sec-audit agentic 互补)。
export { sastScan, type SastScanOpts } from './sast-scan';
// cg-audit-extension: omd 自装 (P1#3) — cgRetrieve/secAudit 封成 /cg /audit slash + dag-record 留痕。
export {
  createCgAuditExtension,
  type CgAuditExtensionOpts,
  type CgAuditDeps,
} from './cg-audit-extension';
// iterate-extension: 内层 DAG 外层 fixpoint 迭代封成 /iterate slash + dag-record 留痕。
export {
  createIterateExtension,
  type IterateExtensionOpts,
  type IterateDeps,
} from './iterate-extension';
// dag-record: DAG 运行留痕层 (轻量持久 SQLite, node 图谱可回溯重建)。
export { createDagRecorder, type DagRecorder, type DagRunRecord, type DagRunNode } from './dag-record';
// plan: omd plan mode (P1 脊柱 — shift+tab 只读审议座舱 + 模型座舱 + 复杂度路由 code 化)。
export {
  createPlanExtension,
  PLAN_DEFAULT_MODEL,
  PLAN_DEFAULT_THINKING,
  createPlanModeState,
  PlanLedger,
  PLAN_MODE_OVERLAY,
  GRILL_OVERLAY,
  isWriteTool,
  isBashMutation,
  extractUrls,
  stripUrls,
  createDefaultWebRetriever,
  createDistiller,
  contextStage,
  contextStageNote,
  CRYSTALLIZE_THRESHOLD,
  bestOfNPlan,
  DEFAULT_PLAN_LENSES,
  classifyTaskComplexity,
  shouldSpawnAgents,
  grillOfferThreshold,
  type PlanExtensionOpts,
  type PlanModeState,
  type PlanModeStatus,
  type PlanRef,
  type PlanLedgerInit,
  type WebRetriever,
  type FetchedRef,
  type DistillFn,
  type DistillResult,
  type ContextStage,
  type PlanLens,
  type BestOfNResult,
  type ComplexityLevel,
  type ComplexitySignals,
} from './plan';
// skills: 开源 curated skill bundle 复利 substrate (Phase 1 — scanner/bundle/DMI/umbrella/CLI)。
// registry = pi 之外的影子元数据 (R6 ①: 不取代 pi skill 发现); umbrella/DMI = prompt-level (R6 ②)。
export {
  SkillRegistry,
  type SkillRow,
  type GeneRow,
  type SkillExampleRow,
  type SkillTier,
  type SkillRegistryOptions,
  type EvolutionEventType,
} from './skills/registry';
export {
  suggestActions,
  type SkillAction,
  type SkillActionKind,
  type SuggestOptions,
} from './skills/action-driver';
export {
  extractTriggerQueries,
  buildTriggerEvalSet,
  type TriggerEvalItem,
} from './skills/eval-set';
// curator: 通用减熵机器 (Phase 2 — purify 的实体无关泛化; skill-adapter 是首个 consumer)。
export {
  curate,
  type CuratorAdapter,
  type CurateResult,
  type CurateOptions,
  type CurateReducerOutcome,
  type CurateShrink,
} from './curator';
export {
  makeSkillCuratorAdapter,
  curateSkills,
  type SkillCuratorOptions,
} from './skills/skill-curator-adapter';
export {
  makeGeneCuratorAdapter,
  curateGenes,
  type GeneCuratorOptions,
} from './skills/gene-curator-adapter';
export {
  createSkillFlywheelExtension,
  skillNameFromReadPath,
  summarizeSuggestions,
  refreshCurateProposal,
  type SkillFlywheelOpts,
} from './skills/flywheel-extension';
export {
  ConfirmationQueue,
  type PendingConfirm,
  type DrainOutcome,
} from './skills/confirmation-queue';
export {
  proposeSkillCandidate,
  canPromote,
  promoteSkill,
  enqueueProposals,
  enqueuePromotions,
  type SkillCandidate,
  type GateReason,
} from './skills/skill-proposer';
export {
  CORE_BUNDLE,
  BUNDLE_LAYOUT,
  isCoreSkill,
  type CoreSkillName,
  type BundleLayout,
} from './skills/bundle';
export {
  scanSkillsDir,
  syncSkillsToRegistry,
  splitFrontmatter,
  skillId,
  type ScannedSkill,
  type ScanResult,
  type SyncReport,
} from './skills/scanner';
export { setDmiInFile, readDmi, skillMdPath } from './skills/dmi';
export { buildUmbrella, type UmbrellaOptions } from './skills/umbrella';
export {
  exportBundle,
  dumpSchema,
  type ExportOptions,
  type ExportReport,
  type SkillExportStat,
} from './skills/export';
export { runCli as runSkillCli } from './skills/cli';
