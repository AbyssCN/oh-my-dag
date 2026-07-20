import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan, type DagNodeEvent, type GenerateFn } from '../../src/harness/executor-dag';
import type { ConductorPlan } from '../../src/harness/conductor-plan';

// onNodeEvent 进度接缝 (MCP 派发简报/活体 status 数据源): planned → start×n → settle×n, fail-open。

const LEAF = 'fake:leaf';
const PLAN: ConductorPlan = {
  name: 'events',
  nodes: {
    a: { agent: 'x', executor: 'leaf', goal: 'step a' },
    b: { agent: 'x', executor: 'leaf', goal: 'step b', depends_on: ['a'] },
  },
} as ConductorPlan;

const okGen: GenerateFn = async ({ messages }) => {
  const id = /\[omd leaf: (\w+)\]/.exec(messages.map((m) => m.content).join('\n'))?.[1];
  return { text: `OUT:${id}`, usage: { in: 1, out: 1 } };
};

describe('executor-dag onNodeEvent', () => {
  test('planned(全节点+kind) → 每节点 start → settle(status+model 词表)', async () => {
    const events: DagNodeEvent[] = [];
    await runExecutorDagWithPlan(PLAN, { conductorModel: '', leafModel: LEAF, generate: okGen, onNodeEvent: (e) => events.push(e) });

    const planned = events.filter((e) => e.type === 'planned');
    expect(planned).toHaveLength(1);
    expect((planned[0] as { nodes: { id: string; kind: string }[] }).nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect((planned[0] as { nodes: { id: string; kind: string }[] }).nodes.every((n) => n.kind === 'leaf')).toBe(true);

    const starts = events.filter((e) => e.type === 'start').map((e) => (e as { id: string }).id);
    const settles = events.filter((e) => e.type === 'settle') as Array<{ id: string; status: string; model?: string }>;
    expect(starts.sort()).toEqual(['a', 'b']);
    expect(settles.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(settles.every((s) => s.status === 'done' && s.model === LEAF)).toBe(true);

    // 依赖序: a settle 必在 b start 之前 (b depends_on a)。
    const idx = (pred: (e: DagNodeEvent) => boolean) => events.findIndex(pred);
    expect(idx((e) => e.type === 'settle' && (e as { id: string }).id === 'a'))
      .toBeLessThan(idx((e) => e.type === 'start' && (e as { id: string }).id === 'b'));
  });

  test('失败叶 settle status=failed; 回调抛错 fail-open 不断 run', async () => {
    const gen: GenerateFn = async ({ messages }) => {
      if (messages.some((m) => m.content.includes('[omd leaf: a]'))) throw new Error('boom');
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const events: DagNodeEvent[] = [];
    const res = await runExecutorDagWithPlan(PLAN, {
      conductorModel: '', leafModel: LEAF, generate: gen,
      onNodeEvent: (e) => {
        events.push(e);
        throw new Error('observer boom'); // fail-open: 每次回调都抛
      },
    });
    expect(res.results.a!.status).toBe('failed');
    const aSettle = events.find((e) => e.type === 'settle' && (e as { id: string }).id === 'a') as { status: string };
    expect(aSettle.status).toBe('failed');
    // 观察者抛错未阻断: b 照常跑完且有事件。
    expect(events.some((e) => e.type === 'settle' && (e as { id: string }).id === 'b')).toBe(true);
  });

  test('未接回调 = 零开销零行为变化 (BC)', async () => {
    const res = await runExecutorDagWithPlan(PLAN, { conductorModel: '', leafModel: LEAF, generate: okGen });
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
  });
});
