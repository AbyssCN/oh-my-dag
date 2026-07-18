import { send } from '../model/gateway';
import type { GenerateFn } from './executor-dag-types';

// leaf 满 cap 溢出目标。Nick 2026-06-23: fleet 走 GO 订阅 → 溢出也 GO DeepSeek flash; 非该模型直接放行。
export const LEAF_OVERFLOW_MODEL = process.env.OMD_LEAF_OVERFLOW_MODEL || 'opencode-go:deepseek-v4-flash';

/**
 * 默认 generate: 经 gateway send() → 自动出 Langfuse trace (B2 预算下沉)。
 * **预算下沉**: 不再自包 makeBudgetedCall(callModel) —— 复用 gateway 终端的单一 budgetedCall, 避免双重预算。
 * overflowModel=LEAF_OVERFLOW_MODEL (meta) → 主 leaf provider 满 cap 时溢出不排队 (保留 overflow-spill 接缝;
 *   fleet 单 provider=opencode-go 时 spill 目标同源, 无害; 配跨 provider overflow 仍生效)。
 * sessionId 把一次 runExecutorDag 的全部 conductor+leaf 调用归到同一 Langfuse session (主路径 trace 可读)。
 */
export function makeDefaultGenerate(sessionId: string): GenerateFn {
  return async (req) => {
    const r = await send({
      messages: req.messages,
      model: req.model,
      thinkingLevel: req.thinkingLevel,
      meta: { role: 'omd-leaf', overflowModel: LEAF_OVERFLOW_MODEL, sessionId },
    });
    return { text: r.text, usage: r.usage };
  };
}

/**
 * 共享冻结 leaf 前缀 (契约 §10.2 VAL-INV-8): **字节稳定**(无时间戳/随机) → 所有 inproc leaf 共享
 * 这段, 暖发后被 prompt-cache 命中。改这段 = 全 leaf cache 失效, 故保持稳定。
 */
export const LEAF_SYSTEM_PREFIX =
  'You are a omd executor leaf inside a deterministic DAG. You receive ONE atomic step with its ' +
  'goal and any predecessor outputs. Execute exactly that step and return its result directly — no ' +
  'preamble, no meta-commentary, no asking for clarification. Be concise and faithful to the goal.';

/**
 * ponytail 倾向 (构建相位, leaf-only)。leafPonytail 开时附到 leaf prompt 末。
 * v2 (2026-06-20, Nick 锁): 从"最小代码"重构成"最小**系统**" — 全局优先, 不让局部最小化造全局耦合/破碎。
 * 4 道护栏: ①复用>本地最小 + 不重决结构 (leaf 视野窄, 结构归架构) ②respect 已规划 DEFER/契约/seam
 * (planned≠speculative) ③minimal≠incomplete (砍行不砍 case/类型/错误路径) ④前端审美红线 (UI/UX 保真不在砍范围)。
 * conductor 不挂 (规划相位要发散)。
 */
export const PONYTAIL_LEAF_DISPOSITION =
  '<ponytail>Optimize for the SIMPLEST WHOLE, not the smallest piece. You see only THIS node — so never ' +
  're-decide structure: implement minimally WITHIN the contract/interface/types the architecture already set, and REUSE what exists.\n' +
  'Ladder (stop at the first rung that holds): ' +
  '(1) does it need to exist? skip speculative/unrequested work — BUT a documented DEFER, a planned seam, or a ' +
  'contract surface is DELIBERATE architecture, not speculation: keep it. ' +
  '(2) reuse an existing module/helper/dep before writing your own — a 5th local copy because yours is "minimal" is GLOBAL bloat. ' +
  '(3) stdlib/native over new code. (4) one line over fifty. (5) only then the minimum code that works.\n' +
  'Minimal means fewer LINES, never fewer CASES: do not drop an edge case, a type, a validation, or an error path to ' +
  'look smaller — that is not simplification, it is a bug. Keep the public surface the contract promised.\n' +
  'NEVER lazy on these (deliverables, not bloat): ' +
  '(a) correctness invariants at trust boundaries — input validation, balance/ledger/append-only guards, ' +
  'statutory/legal values, error handling that prevents data loss, security, accessibility; ' +
  '(b) frontend EXPERIENCE — visual hierarchy, motion, micro-interactions, spacing, empty/error/loading states, ' +
  'responsive behavior, polish. Lazy applies to code STRUCTURE, never to the rendered UI/UX — treat aesthetic fidelity like a correctness invariant.\n' +
  'If your piece seems to need a NEW abstraction or to change an interface, that is an ARCHITECTURE signal — flag it, do not invent it locally. ' +
  'Non-trivial logic leaves ONE runnable check. Lazy code without its check is unfinished.</ponytail>';
