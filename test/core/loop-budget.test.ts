/**
 * **预算轴** —— Loop Engineering 四条停止轴里 omd 唯一缺的那条 (2026-07-31)。
 *
 * 另外三条早就有: 轮数上限 (`max_rounds`) · 空转 (D-Q 确定性判据) · 完成检查 (judge ∧ 环外 accept)。
 * 缺预算轴的后果很具体: judge 每轮说"还不行", 环就一路烧到轮数上限, **全程没有任何一处问过
 * "这已经花了多少"** —— 而实测一次 goal 执行段的 leaf in 是 43 万 token 量级。
 *
 * 这条网盯三个失效形态:
 *  ① **在飞的一轮被打断** → 半轮的钱已经花了, 打断只是把产出也扔掉。只许在轮边界停。
 *  ② **预算停被读成收敛** → 谎报成功, 比不设预算坏得多。恒 converged=false。
 *  ③ **预算停与 blocked 混成一个词** → 两个完全不同的下一步 (加预算 resume / owner 去看)
 *     读同一句话。这正是 D-P 当初给 `cancelled` 单独立词的理由, 反过来用。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from '../../src/harness/dag/types';

let root: string;
let manager: CheckpointManager;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-budget-'));
  manager = new CheckpointManager(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';
const SUB = JSON.stringify({ name: 's', nodes: { w: { goal: '干活' } } });

const plan = (): ConductorPlan =>
  ({ name: 'outer', nodes: { C: { goal: '做完', executor: 'conductor', max_rounds: 4, judge_final: true } } }) as ConductorPlan;

/** 每个 leaf 调用报固定用量 —— 于是"跑几轮"与"花多少"成正比, 预算轴可测。 */
const generate = (perCall: { in: number; out: number }): GenerateFn => async (req) => {
  const text = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  return leafId(text) ? { text: 'ok', usage: perCall } : { text: SUB, usage: perCall };
};

/** judge 恒判未收敛 —— 于是唯一能让环停下来的就是轮数或预算。 */
const judgeNever = (rounds: number[]): NonNullable<ExecutorDagConfig['judgeSend']> =>
  (async () => {
    rounds.push(1);
    const v = { converged: false, score: 0, failureReason: '还不行', rejectedNodes: [] };
    return { text: JSON.stringify(v), parsed: v, usage: { in: 1, out: 1 } };
  }) as never;

const run = (over: Partial<ExecutorDagConfig>, judgeCalls: number[] = []) =>
  runExecutorDagWithPlan(plan(), {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentTemplates: new Map(),
    continuity: { manager, runId: 'budget-run', repoRoot: root },
    generate: generate({ in: 100, out: 100 }),
    judgeSend: judgeNever(judgeCalls),
    ...over,
  } as ExecutorDagConfig);

describe('环的预算轴', () => {
  test('不设预算 → 老语义: 一路烧到轮数上限 (零回归)', async () => {
    const judged: number[] = [];
    const r = await run({}, judged);
    expect(r.results.C?.rounds).toBe(4);
    expect(r.results.C?.budgetStopped).toBeUndefined();
    expect(judged).toHaveLength(4);
  });

  test('token 预算用尽 → **在轮边界**停, 不是跑满 4 轮', async () => {
    // 每轮 ~400 token (展开 200 + leaf 200); 预算 500 → 第 2 轮跑完就该停。
    const judged: number[] = [];
    const r = await run({ loopBudget: { tokens: 500 } }, judged);
    expect(r.results.C!.rounds!).toBeLessThan(4);
    expect(r.results.C!.rounds!).toBeGreaterThanOrEqual(1);
    expect(r.results.C?.budgetStopped).toContain('token 预算用尽');
    // 停在轮边界 = judge 被调用的次数 == 真跑完的轮数 (没有半轮被腰斩)。
    expect(judged).toHaveLength(r.results.C!.rounds!);
  });

  test('**恒 converged=false** —— 预算停不许被读成收敛', async () => {
    const r = await run({ loopBudget: { tokens: 1 } });
    expect(r.results.C?.converged).toBe(false);
  });

  test('**与 blocked 是两个字段** —— 加预算 resume 就成 vs 再多钱都一样', async () => {
    const r = await run({ loopBudget: { tokens: 1 } });
    expect(r.results.C?.budgetStopped).toBeTruthy();
    expect(r.results.C?.blocked).toBeUndefined(); // 没被塞进 blocked
  });

  test('第一轮永不被预算拦 —— 预算再小也要跑一轮 (否则等于什么都没做还占了 runId)', async () => {
    const judged: number[] = [];
    const r = await run({ loopBudget: { tokens: 1 } }, judged);
    expect(r.results.C!.rounds!).toBeGreaterThanOrEqual(1);
    expect(judged.length).toBeGreaterThanOrEqual(1);
  });

  test('时间预算同轴 (ms) —— 上限 0 = 一轮不开 (#158 契约取代: 预算尽则不再开新贵活)', async () => {
    // ⚠ 旧契约「上限 0 = 第一轮跑完即停」被 #158 (owner 2026-08-17 P0) 取代: d39b559e 实证
    // "至少跑一轮"的豁免正是 90min 预算跑成 164min 的一半根因。0 预算 = 零授权, 环入口即停。
    const r = await run({ loopBudget: { ms: 0 } });
    expect(r.results.C?.budgetStopped).toContain('预算');
    expect(r.results.C?.status).toBe('failed'); // 一轮没跑, 没有可谎报的收敛
  });

  test('预算足够 → 不干扰 (证明上面不是"永远停"的空转断言)', async () => {
    const judged: number[] = [];
    const r = await run({ loopBudget: { tokens: 10_000_000, ms: 3_600_000 } }, judged);
    expect(r.results.C?.rounds).toBe(4);
    expect(r.results.C?.budgetStopped).toBeUndefined();
  });
});
