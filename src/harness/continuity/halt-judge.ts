/**
 * src/harness/continuity/halt-judge.ts — 停机闸栈 (SDD §2 C6).
 *
 * L1 确定性(零模型) → L2 goal judge (deepseek:deepseek-v4-flash) → L3 fail-open.
 *
 * 消费方: dag-build driver (C6 接线)。
 *   驱动方需将 callModel (responseSchema=judgeVerdictSchema) 包装成 GenerateFn,
 *   text 输出为 JSON, haltJudge 内部 parse + Zod 校验。
 *
 * 路由:
 *   L1 截停 → hard_fail / cap_exhausted / 继续 heal
 *   L1 放行 + noJudge → all_green (绕开 L2, 完全信任 oracle)
 *   L1 放行 + L2 judgeUsed≥judgeCap → cap_exhausted
 *   L1 放行 + L2 调用 → JudgeVerdict 路由:
 *     ok=true → judge_ok 收敛
 *     impossible=true → judge_impossible
 *     ok=false + 配额有余 → continue (reason 供 fix-DAG 注入)
 *     ok=false + 配额耗尽 → cap_exhausted
 *   L2 抛错 → L3 degraded (放行 oracle 绿的结果, 宁误放不活锁)
 *
 * @module
 */

import { z } from 'zod';
import type { GenerateFn } from '../executor-dag';
import type { HaltVerdict, JudgeVerdict } from './types';
import { logger } from '../logger';

// ── L1 types ────────────────────────────────────────────────────────────────

/** 叶子节点状态快照 (L1 输入)。 */
export interface LeafState {
  id: string;
  status: 'done' | 'failed';
  kind: 'inproc' | 'agent' | 'command' | 'map' | 'primitive';
}

export interface L1Input {
  leafStates: LeafState[];
  /** 已执行的 heal 次数。 */
  healed: number;
  /** heal 上限。 */
  healCap: number;
}

// ── L2 types ────────────────────────────────────────────────────────────────

/** L2 goal judge 的结构化快照输入 (≤1.5k tok)。 */
export interface JudgeInput {
  /** 用户目标。 */
  goal: string;
  /** oracle 终验摘要 (oracle.summary + digest 头)。 */
  oracleSummary: string;
  /** 本轮更改的文件路径列表。 */
  changedFiles: string[];
  leafStates: LeafState[];
  healed: number;
}

export interface HaltDeps {
  /** 模型调用函数。driver 应传 GenerateFn (包装 callModel + responseSchema)。 */
  generate: GenerateFn;
  /** L2 judge 模型坐标。缺省 'deepseek:deepseek-v4-flash'。 */
  judgeModel?: string;
  /** L2 调用配额上限。缺省 2。 */
  judgeCap?: number;
  /** 当前已发生的 L2 调用次数 (driver 维护计数器)。 */
  judgeUsed: number;
  /** 跳过 L2 (--no-judge)。缺省 false。 */
  noJudge?: boolean;
}

// ── Zod schema for JudgeVerdict ─────────────────────────────────────────────

/** L2 goal judge 响应 schema (INV-3 validated parse)。 */
export const judgeVerdictSchema = z.object({
  ok: z.boolean().describe('goal 已达到, 可收敛'),
  impossible: z.boolean().describe('agent 自称不可达, judge 独立确认'),
  reason: z.string().describe('引用输入中的事实, 禁提输入外的路径/符号'),
}) satisfies z.ZodType<JudgeVerdict>;

// ── L1: deterministic halt check ────────────────────────────────────────────

/**
 * L1 确定性停机检查 (零模型)。
 *
 * 规则:
 *   1. 任一 leaf 'failed' → hard_fail stop。
 *   2. 全部 done → continue (进入 L2)。
 *   3. heal 耗尽 (healed ≥ healCap) 仍有未完成 → cap_exhausted stop。
 *   4. 否则 → continue (调用方继续 heal 循环)。
 *
 * 不是全部 done 的 case 由 dag-build L1 在 DAG 层面处理:
 *   - healed < healCap → driver 继续 heal 循环 (复用既有 branch/healed 机制)
 *   - healed ≥ healCap → cap_exhausted stop
 */
export function l1Halt(input: L1Input): HaltVerdict {
  const { leafStates, healed, healCap } = input;

  // Rule 1: 硬失败
  for (const ls of leafStates) {
    if (ls.status === 'failed') {
      return {
        kind: 'stop',
        reason: 'hard_fail',
        evidence: `node ${ls.id} (${ls.kind}) status=failed`,
      };
    }
  }

  const allDone = leafStates.every(ls => ls.status === 'done');

  // Rule 3: heal 耗尽 + 未完全 ok
  if (!allDone && healed >= healCap) {
    const undone = leafStates.filter(ls => ls.status !== 'done').length;
    return {
      kind: 'stop',
      reason: 'cap_exhausted',
      evidence: `${undone}/${leafStates.length} leaf 未完成, heal ${healed}/${healCap}`,
    };
  }

  // Rule 2: 全部 done → 放行到 L2
  if (allDone) {
    return { kind: 'continue', reason: 'all done, proceed L2' };
  }

  // Rule 4: 未完成但 heal 配有余 → 继续 heal
  const undone = leafStates.filter(ls => ls.status !== 'done').length;
  return { kind: 'continue', reason: `${undone} leaf 待 heal, ${healed}/${healCap} rounds used` };
}

// ── L2: goal judge prompt ───────────────────────────────────────────────────

/**
 * 构建 L2 goal judge 的结构化快照 prompt (≤1.5k tok)。
 *
 * 纪律:
 *   - 只依据输入判断
 *   - reason 必须引用输入中的事实
 *   - 禁提输入外的路径/符号
 */
export function buildJudgePrompt(input: JudgeInput): string {
  const files =
    input.changedFiles.length > 0
      ? input.changedFiles.map(f => `  - ${f}`).join('\n')
      : '  (本轮无变更)';

  const states = input.leafStates
    .map(ls => `  - ${ls.id}: ${ls.status} (${ls.kind})`)
    .join('\n');

  return `你是一个目标收敛评判员。判断当前工作迭代是否已达到用户设定的目标。

## 目标
${input.goal}

## Oracle 终验摘要
${input.oracleSummary}

## 本轮变更文件
${files}

## 叶子节点状态
${states}

## Heal 轮数
${input.healed}

—— 依据以上输入判断。reason 必须引用输入中的具体事实，禁止引用输入中不存在的路径或符号。输出严格 JSON 格式 { ok, impossible, reason }。`;
}

// ── L3: fail-open fallback ──────────────────────────────────────────────────

/**
 * L3 fail-open: judge 调用挂/超时/解析失败 → degraded 降级。
 *
 * L3 只在 oracle 绿 (所有节点 done) 的前提下触发。
 * 宁误放不活锁 —— oracle 已是可靠主闸。
 */
function l3Fallback(err: unknown): HaltVerdict {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn({ err }, 'judge_degraded: L2 call failed, falling through on oracle verdict');
  return {
    kind: 'stop',
    reason: 'degraded',
    evidence: `judge error: ${msg}`,
  };
}

// ── Main halt judge: L1 → L2 → L3 ──────────────────────────────────────────

/**
 * 完整停机闸栈 (L1 → L2 → L3)。
 *
 * 调用方 (dag-build driver) 应在 oracle 全绿后调用此函数。
 * 调用方维护 judgeUsed 计数器，每次调用前递增。
 *
 * @returns HaltVerdict — 停机判定。kind='continue' 时调用方可注入 reason 进下一轮 heal。
 */
export async function haltJudge(
  l1: L1Input,
  judge: JudgeInput,
  deps: HaltDeps,
): Promise<HaltVerdict> {
  // ── L1: 确定性检查 ───────────────────────────────────────────
  const l1Verdict = l1Halt(l1);
  if (l1Verdict.kind === 'stop') return l1Verdict;

  // L1 放行: 全部 done。此时可进入 L2。

  // ── 跳过 L2? ─────────────────────────────────────────────────
  if (deps.noJudge) {
    logger.info('--no-judge: skipping L2, accepting all_green');
    return { kind: 'stop', reason: 'all_green' };
  }

  // ── Judge 配额用尽? ───────────────────────────────────────────
  const cap = deps.judgeCap ?? 2;
  if (deps.judgeUsed >= cap) {
    return {
      kind: 'stop',
      reason: 'cap_exhausted',
      evidence: `judge cap ${cap} exhausted after ${deps.judgeUsed} call(s)`,
    };
  }

  // ── L2: goal judge ───────────────────────────────────────────
  const model = deps.judgeModel ?? 'deepseek:deepseek-v4-flash';
  const prompt = buildJudgePrompt(judge);

  let verdictObj: JudgeVerdict;
  try {
    const resp = await deps.generate({
      messages: [
        {
          role: 'system',
          content:
            'You are a convergence judge evaluating whether a coding iteration has met its goal. '
            + 'Respond ONLY with a single JSON object matching the schema: '
            + '{ ok: boolean, impossible: boolean, reason: string }. '
            + 'Never include extra keys or markdown fences.',
        },
        { role: 'user', content: prompt },
      ],
      model,
      thinkingLevel: 'off',
    });

    // 从 text 解析 JSON (GenerateFn 不保 responseSchema, driver 应包 callModel 出 JSON)
    const parsed = JSON.parse(resp.text);
    verdictObj = judgeVerdictSchema.parse(parsed);
  } catch (err) {
    // ── L3: fail-open ──────────────────────────────────────────
    return l3Fallback(err);
  }

  // ── 路由 JudgeVerdict ────────────────────────────────────────

  if (verdictObj.impossible) {
    // agent 自称不可达且 judge 独立确认
    return {
      kind: 'stop',
      reason: 'judge_impossible',
      evidence: verdictObj.reason,
    };
  }

  if (verdictObj.ok) {
    // 收敛
    return {
      kind: 'stop',
      reason: 'judge_ok',
      evidence: verdictObj.reason,
    };
  }

  // not-ok, not impossible
  const nextUsed = deps.judgeUsed + 1;
  if (nextUsed >= cap) {
    // 本次已是最后一发 judge 配额, 仍 not-ok
    return {
      kind: 'stop',
      reason: 'cap_exhausted',
      evidence: `judge cap ${cap} exhausted; last verdict: ${verdictObj.reason}`,
    };
  }

  // 配额有余: 继续, inject reason 供 fix-DAG
  return {
    kind: 'continue',
    reason: verdictObj.reason,
  };
}
