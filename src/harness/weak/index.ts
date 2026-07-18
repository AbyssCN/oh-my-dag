/**
 * src/harness/weak —— 弱模型 harness L1-L4 (SDD §6, V2-WEAK, D67 实例化)。
 *
 * 四承重柱里:
 *   L1 tool 闸   → 已在 V2-HOOK (src/harness/hooks/tool-gate, 白名单 + dangerous-cmd
 *                  fail-closed; pi 原生 typebox 管参数 schema)。此处不重出。
 *   L2 grounding → grounding.ts (法定数字必有源, 散文闸 + fact-write validateFactWrite)。
 *   L3 repair    → repair.ts (coerce + 同模型单次重问 → fail-closed)。
 *   L4 scaffold  → scaffold.ts (软标签 appendSystemPrompt, 永不单信)。
 *   L0 解码语法   → vLLM guided_json, 机会主义非依赖, 待 48GB 机器, 不在本模块。
 */
export {
  detectLegalClaims,
  checkProseGrounding,
  factWriteIsGrounded,
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
} from './grounding';
export {
  coerceOrRepair,
  extractJson,
  type RepairResult,
  type RepromptFn,
  type CoerceOrRepairOpts,
} from './repair';
export { GROUNDING_NUDGE, createGroundingNudgeExtension } from './scaffold';
export { createGroundingGateExtension, type GroundingGateOptions } from './grounding-gate';
