/**
 * src/harness/dag/engine-fanout-cap.test —— P3 S8 / INV-14: 进程级在飞上限在引擎派发点生效。
 *
 * 反向自检: engine.ts 派发点去掉 `acquireLeafSlot` 那一跳 → cap=2 那条 maxActive 变 4, 红;
 * `configureLeafSlots(config.maxInflightLeaves)` 那行删掉 → 同红 (cap 永远不配)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ConductorPlan } from '../conductor-plan';
import { runExecutorDagWithPlan } from './engine';
import { _resetLeafSlotsForTest, leafSlotStats } from './fanout-semaphore';
import type { ExecutorDagConfig } from './types';

afterEach(() => _resetLeafSlotsForTest());

const plan = (): ConductorPlan =>
  ({
    name: 'p',
    nodes: Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, { executor: 'agent', goal: `改 ${id}` }])),
  }) as unknown as ConductorPlan;

const runWith = async (extra: Partial<ExecutorDagConfig>): Promise<{ maxActive: number; runs: number }> => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const r = await runExecutorDagWithPlan(plan(), {
    conductorModel: 'c:m',
    leafModel: 'l:m',
    agentLeafModel: 'l:m',
    generate: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as never,
    agentRunner: async () => {
      active++;
      runs++;
      maxActive = Math.max(maxActive, active);
      await new Promise((res) => setTimeout(res, 15));
      active--;
      return { text: '完整产出', usage: { in: 1, out: 1 }, filesTouched: ['src/x.ts'] };
    },
    ...extra,
  } as ExecutorDagConfig);
  expect(Object.values(r.results).every((n) => n.status === 'done')).toBe(true);
  return { maxActive, runs };
};

describe('maxInflightLeaves', () => {
  test('★ cap=2 ⇒ 四个独立 agent 节点同时在飞 ≤ 2, 且四个都跑完', async () => {
    const { maxActive, runs } = await runWith({ maxInflightLeaves: 2 });
    expect(runs).toBe(4);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(leafSlotStats()).toMatchObject({ cap: 2, inflight: 0, waiting: 0 });
  });

  test('缺席 ⇒ 不限 (四个一起飞), 且不动既有 cap', async () => {
    const { maxActive, runs } = await runWith({});
    expect(runs).toBe(4);
    expect(maxActive).toBe(4);
    expect(leafSlotStats().cap).toBeUndefined();
  });
});
