/**
 * review/routing —— 审查的激活策略 + model 路由 (SDD §11, role-model 解耦)。
 *
 * 三条政策做成可执行 (不只 identity prose):
 *   ① 审查 = 主 agent (conductor) 职责。subagent 干活**不自激活审核** —— 否则每个 leaf
 *      再 spawn 自己的 reviewer = 嵌套 spawn 爆炸 (同 Workflow 嵌套一层的约束)。
 *   ② 安全边界改写 = 硬触发: 主 agent 不可自审/不可跳, 强制独立审核 (排除 solo 直做)。
 *   ③ G 闸的审查 model **可配置可路由**, 非锁 Codex —— 路由到 Codex/GLM/Opus/任一 cross-lens
 *      (omd 三层编排: conductor/executor/verifier 各 model 可换)。
 */
import type { ReviewGate } from './criteria';

export type AgentRole = 'main' | 'sub';

/**
 * 审核是否在本 agent 激活。只有主 agent (conductor) 激活 G 闸; subagent 永不自激活
 * (政策 ①, 防嵌套 spawn 爆炸)。subagent 的产出由派它的主 agent 在汇总时审。
 */
export function reviewActivates(role: AgentRole): boolean {
  return role === 'main';
}

export interface MandatoryReviewInput {
  /** 本次改动是否触及安全边界 (fail-closed 闸/权限/不可逆破坏/认证)。 */
  securityBoundaryChange: boolean;
}

/**
 * 是否**强制**审核 (主 agent 不可跳/不可自审)。安全边界改写 → true (政策 ②)。
 * 非安全改动可由复杂度路由决定是否审 (Vibe/Lite 可不审, Full 走 G 闸)。
 */
export function isMandatoryReview(input: MandatoryReviewInput): boolean {
  return input.securityBoundaryChange === true;
}

/**
 * 每 G 闸的审查 model 路由 (政策 ③)。省略某 gate → 走 default → 走 env → undefined
 * (由 dispatch 层兜底选, **不在此硬编 Codex**)。
 */
export interface ReviewRouting {
  G1?: string;
  G2?: string;
  G3?: string;
  /** 任一 gate 未指定时的 fallback model。 */
  default?: string;
}

/**
 * 解析某 G 闸该用哪个审查 model。优先级 (高→低):
 *   env per-gate (OMD_REVIEW_MODEL_G2) > routing per-gate > env default
 *   (OMD_REVIEW_MODEL) > routing.default > undefined (caller 决定)。
 * 返回 undefined = 无显式配置, dispatch 层按自己的默认选 (绝不在此锁单一模型)。
 */
export function resolveReviewModel(
  gate: ReviewGate,
  routing: ReviewRouting = {},
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    env[`OMD_REVIEW_MODEL_${gate}`] ??
    routing[gate] ??
    env.OMD_REVIEW_MODEL ??
    routing.default
  );
}
