/**
 * src/harness/review —— 跨模型对抗审查方法论 + prompt 模版 (SDD §11 Codex-in-the-loop)。
 *
 * identity 的「工作流 + 编排」节只放 G1/G2/G3 决策骨架 (轮数上限); 重资产 (anti-slop
 * accept/reject 准则 + 维度 prompt 模版) 在这一层代码, 不进冻结前缀 (GP-8: 200 行模版进
 * frozen prefix 会烧 cache)。omd 当 conductor 跑对抗审查时, 从这里 buildReviewPrompt /
 * buildGateReview 造 prompt 派给 review subagent (或 cross-model Codex)。
 */
export {
  REJECT_CRITERIA,
  ACCEPT_CRITERIA,
  ROUND_CAPS,
  screenFinding,
  type ReviewGate,
  type ScreenResult,
} from './criteria';
export {
  buildReviewPrompt,
  buildGateReview,
  buildSpecReviewPrompt,
  type ReviewDimension,
  type ReviewPromptOpts,
  type SpecReviewPromptOpts,
} from './templates';
export {
  reviewActivates,
  isMandatoryReview,
  resolveReviewModel,
  type AgentRole,
  type ReviewRouting,
  type MandatoryReviewInput,
} from './routing';
export {
  runReview,
  DIMS_BY_GATE,
  SPEC_SKIPPED_NOTE,
  type ReviewFinding,
  type RunReviewResult,
  type RunReviewOpts,
  type RunReviewDeps,
} from './run';
