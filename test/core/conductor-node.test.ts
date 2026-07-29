/**
 * `executor:'conductor'` 运行时异构展开 —— 第一次加厚 (P3 批次 3, 2026-07-29)。
 * 预构造外层图 + 注入 generate (conductor 调用与 leaf 调用都是假的), 零真模型。
 *
 * 这一层要钉的是 **D-C 局部调度**: conductor 的子节点**互相有边**, 所以既不能复用外层 ready-set
 * (外层的 idSet/indeg/dependents 在 run 开始就算死了, 运行期新增的子节点进不去), 也不能用 map
 * 那种扁平队列 (map 的子节点互相无边)。子图得自己算一次 ready-set。
 *
 * 以及 **不带环**: 第一次加厚只做展开 + 局部调度。环留给第二次加厚 (D-A) —— P1 的 double-loop
 * 教训是两层 verify 必须二选一, 在环搬进来**之前**先撤外层是错的顺序。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from '../../src/harness/executor-dag';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn } from '../../src/harness/executor-dag-types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const leafId = (p: string): string => /\[omd leaf: ([^\]]+)\]/.exec(p)?.[1] ?? '';

/** 三步链子图: 定契约 → 实装 → 验证 (子节点之间**有边** —— 扁平队列会跑错序)。 */
const CHAIN_SUBPLAN = JSON.stringify({
  name: 'sub',
  nodes: {
    contract: { goal: '定契约' },
    impl: { goal: '实装', depends_on: ['contract'] },
    verify: { goal: '验证', depends_on: ['impl'] },
  },
});

/**
 * fake generate: 认得出"这是 conductor 展开调用"(消息带 system plan prompt) 还是"这是 leaf 调用"。
 * @param subplanJson conductor 调用的返回
 */
function makeFake(subplanJson: string, opts: { leafDelayMs?: number } = {}) {
  const leafCalls: string[] = [];
  const leafOrder: string[] = [];
  let conductorCalls = 0;
  let active = 0;
  let peak = 0;
  const generate: GenerateFn = async (req) => {
    const user = req.messages.find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : '';
    const id = leafId(text);
    if (!id) {
      // 没有 [omd leaf: …] 行 = conductor 展开调用。
      conductorCalls++;
      return { text: subplanJson, usage: { in: 5, out: 5 } };
    }
    leafCalls.push(id);
    active++;
    peak = Math.max(peak, active);
    if (opts.leafDelayMs) await sleep(opts.leafDelayMs);
    active--;
    leafOrder.push(id);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  return { generate, leafCalls, leafOrder, conductorCalls: () => conductorCalls, peak: () => peak };
}

const cfg = (generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
  ...extra,
});

const withConductor = (extra: Record<string, unknown> = {}): ConductorPlan =>
  ({ name: 'outer', nodes: { plan_it: { goal: '把这件事做完', executor: 'conductor', ...extra } } }) as ConductorPlan;

describe('conductor 节点 — 展开', () => {
  test('展开出的子节点真被执行, 节点自身汇总成功数', async () => {
    const f = makeFake(CHAIN_SUBPLAN);
    const r = await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    expect(f.conductorCalls()).toBe(1);
    expect(f.leafCalls).toHaveLength(3);
    expect(r.results.plan_it?.status).toBe('done');
    expect(r.results.plan_it?.kind).toBe('conductor');
    expect(r.results.plan_it?.output).toContain('3/3 成功');
    // 汇总里用**原名**报告 (给人看的那一面仍然可读)。
    for (const n of ['contract', 'impl', 'verify']) expect(r.results.plan_it?.output).toContain(`[${n}]`);
  });

  test('子节点 id 是内容寻址的 `parent::fp`, 不是 conductor 起的名', async () => {
    const f = makeFake(CHAIN_SUBPLAN);
    const r = await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    const childIds = Object.keys(r.results).filter((k) => k !== 'plan_it');
    expect(childIds).toHaveLength(3);
    for (const id of childIds) expect(id.startsWith('plan_it::')).toBe(true);
    // conductor 起的名不该直接成为 id。
    for (const name of ['contract', 'impl', 'verify']) expect(r.results[name]).toBeUndefined();
  });

  test('空子图 → done 且 0 子节点 (conductor 认为无事可做, 不算失败)', async () => {
    const f = makeFake(JSON.stringify({ name: 's', nodes: {} }));
    const r = await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    // 空 nodes 过不了 PlanSchema (要求 ≥1 节点) → 展开失败, 但必须是**响亮**的 failed 而不是静默 done。
    expect(r.results.plan_it?.status).toBe('failed');
    expect(r.results.plan_it?.output).toContain('展开失败');
  });

  test('conductor 吐的不是 plan → failed 并带原因 (不静默降级成"没子节点")', async () => {
    const f = makeFake('这不是 JSON');
    const r = await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    expect(r.results.plan_it?.status).toBe('failed');
    expect(r.results.plan_it?.output).toContain('展开失败');
    expect(f.leafCalls).toHaveLength(0);
  });

  test('D-D: 子图里有 executor:conductor → 整份拒, 一个子节点都不跑', async () => {
    const f = makeFake(JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B', executor: 'conductor' } } }));
    const r = await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    expect(r.results.plan_it?.status).toBe('failed');
    expect(r.results.plan_it?.output).toContain('禁嵌套');
    expect(f.leafCalls).toHaveLength(0);
  });

  test('子图有环 → 拒 (外层建图闸管不到运行期现画的子图)', async () => {
    const f = makeFake(JSON.stringify({
      name: 's',
      nodes: { a: { goal: 'A', depends_on: ['b'] }, b: { goal: 'B', depends_on: ['a'] } },
    }));
    const r = await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    expect(r.results.plan_it?.status).toBe('failed');
    expect(r.results.plan_it?.output).toContain('有环');
  });
});

describe('conductor 节点 — D-C 局部拓扑调度', () => {
  test('子图内的边被遵守: contract → impl → verify 严格按序 (扁平队列会跑错)', async () => {
    const f = makeFake(CHAIN_SUBPLAN, { leafDelayMs: 5 });
    await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    // 用**执行完成序**判: 有边就必须先后, 且三者不可能并发 (peak=1)。
    const seq = f.leafOrder.map((id) => id.split('::')[1]!);
    expect(seq).toHaveLength(3);
    expect(f.peak()).toBe(1); // 全链串行 —— 边真的被遵守了
  });

  test('无边的兄弟并发跑 (局部调度不是无脑串行)', async () => {
    const f = makeFake(
      JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B' }, c: { goal: 'C' } } }),
      { leafDelayMs: 25 },
    );
    await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    expect(f.peak()).toBeGreaterThanOrEqual(2);
  });

  test('菱形: a → {b,c} → d —— b/c 并发, d 等两个都完', async () => {
    const f = makeFake(
      JSON.stringify({
        name: 's',
        nodes: {
          a: { goal: 'A' },
          b: { goal: 'B', depends_on: ['a'] },
          c: { goal: 'C', depends_on: ['a'] },
          d: { goal: 'D', depends_on: ['b', 'c'] },
        },
      }),
      { leafDelayMs: 15 },
    );
    const r = await runExecutorDagWithPlan(withConductor(), cfg(f.generate));
    expect(f.leafCalls).toHaveLength(4);
    expect(f.peak()).toBeGreaterThanOrEqual(2); // b/c 并发
    expect(r.results.plan_it?.output).toContain('4/4 成功');
  });

  test('maxFanout 钳住局部并发 (局部调度不绕过全局闸)', async () => {
    const f = makeFake(
      JSON.stringify({ name: 's', nodes: { a: { goal: 'A' }, b: { goal: 'B' }, c: { goal: 'C' }, d: { goal: 'D' } } }),
      { leafDelayMs: 15 },
    );
    await runExecutorDagWithPlan(withConductor(), cfg(f.generate, { maxFanout: 1 }));
    expect(f.peak()).toBe(1);
  });

  test('子节点看得见 conductor 节点自己的外层上游', async () => {
    const f = makeFake(JSON.stringify({ name: 's', nodes: { only: { goal: '干活' } } }));
    let childPrompt = '';
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      const id = leafId(text);
      if (!id) return { text: JSON.stringify({ name: 's', nodes: { only: { goal: '干活' } } }), usage: { in: 1, out: 1 } };
      if (id.startsWith('plan_it::')) childPrompt = text;
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    void f;
    await runExecutorDagWithPlan(
      { name: 'outer', nodes: {
        up: { goal: '上游' },
        plan_it: { goal: '把这件事做完', executor: 'conductor', depends_on: ['up'] },
      } } as ConductorPlan,
      cfg(generate),
    );
    expect(childPrompt).toContain('out:up'); // 父的外层上游并进了子节点的 deps
  });
});

describe('conductor 节点 — 失败隔离与事件面', () => {
  test('一个子节点失败 → conductor 节点仍 done (部分成功), 汇总如实记', async () => {
    const subplan = JSON.stringify({
      name: 's',
      nodes: { good: { goal: '正常' }, bad: { goal: 'FAIL 这个会挂' } },
    });
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      const id = leafId(text);
      if (!id) return { text: subplan, usage: { in: 1, out: 1 } };
      if (text.includes('FAIL')) throw new Error('注入失败');
      return { text: `out:${id}`, usage: { in: 1, out: 1 } };
    };
    const r = await runExecutorDagWithPlan(withConductor(), cfg(generate));
    expect(r.results.plan_it?.status).toBe('done');
    expect(r.results.plan_it?.output).toContain('1/2 成功');
  });

  test('全部子节点失败 → conductor 节点 failed', async () => {
    const subplan = JSON.stringify({ name: 's', nodes: { a: { goal: 'FAIL a' }, b: { goal: 'FAIL b' } } });
    const generate: GenerateFn = async (req) => {
      const user = req.messages.find((m) => m.role === 'user');
      const text = typeof user?.content === 'string' ? user.content : '';
      if (!leafId(text)) return { text: subplan, usage: { in: 1, out: 1 } };
      throw new Error('注入失败');
    };
    const r = await runExecutorDagWithPlan(withConductor(), cfg(generate));
    expect(r.results.plan_it?.status).toBe('failed');
  });

  test('子节点补发 settle 事件 (它们绕过外层 settle, 观察面不能因此有洞)', async () => {
    const f = makeFake(CHAIN_SUBPLAN);
    const events: DagNodeEvent[] = [];
    await runExecutorDagWithPlan(withConductor(), cfg(f.generate, { onNodeEvent: (e) => events.push(e) }));
    const settled = events.filter((e) => e.type === 'settle').map((e) => (e as { id: string }).id);
    expect(settled.filter((id) => id.startsWith('plan_it::'))).toHaveLength(3);
    expect(settled).toContain('plan_it');
  });

  test('max_nodes 钳住子图规模, 截断如实留痕', async () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) nodes[`n${i}`] = { goal: `活 ${i}` };
    const f = makeFake(JSON.stringify({ name: 's', nodes }));
    const r = await runExecutorDagWithPlan(withConductor({ max_nodes: 2 }), cfg(f.generate));
    expect(f.leafCalls).toHaveLength(2);
    expect(r.results.plan_it?.output).toContain('截断 4');
  });
});
