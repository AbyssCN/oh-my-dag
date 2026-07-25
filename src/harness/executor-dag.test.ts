/**
 * executor-dag 引擎核心测试 (SDD v2 dag-engine-fusion-refactor S1)。
 * 覆盖: G-1 ready-set 调度回归 · G-4 quorum fail-skip (D-7v2) · G-11v2 零回归。
 * 全部经 runExecutorDagWithPlan (预构造 plan, 跳过 conductor) + 注入 fake generate — 零真实 LLM。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './executor-dag';
import type { ConductorPlan } from './conductor-plan';
import type { DagNodeEvent, ExecutorDagConfig, GenerateFn } from './executor-dag-types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 从 buildLeafPrompt 产出的 user prompt 里解析节点 id (`[omd leaf: <id>]` 行)。 */
const leafId = (prompt: string): string => /\[omd leaf: ([^\]]+)\]/.exec(prompt)?.[1] ?? '?';

/**
 * fake generate: 按节点 id 记录调用/并发/prompt; goal 含 "FAIL" 的节点抛错 (→ failedFromThrow 隔离)。
 */
function makeGenerate(opts: { delayMs?: number } = {}): {
  generate: GenerateFn;
  calls: string[];
  prompts: Record<string, string>;
  maxActive: () => number;
} {
  const calls: string[] = [];
  const prompts: Record<string, string> = {};
  let active = 0;
  let peak = 0;
  const generate: GenerateFn = async (req) => {
    const prompt = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const id = leafId(prompt);
    calls.push(id);
    prompts[id] = prompt;
    active++;
    peak = Math.max(peak, active);
    if (opts.delayMs) await sleep(opts.delayMs);
    active--;
    if (prompt.includes('FAIL')) throw new Error(`节点 ${id} 注入失败`);
    return { text: `out:${id}`, usage: { in: 1, out: 1 } };
  };
  return { generate, calls, prompts, maxActive: () => peak };
}

function makeConfig(generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig {
  return {
    conductorModel: 'test:conductor',
    leafModel: 'test:leaf',
    generate,
    agentTemplates: new Map(),
    ...extra,
  };
}

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 'test-plan', nodes });

describe('G-1 ready-set 调度 (回归)', () => {
  test('A settle 后 B/C 并发 (maxActive ≥ 2)', async () => {
    const { generate, calls, maxActive } = makeGenerate({ delayMs: 25 });
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '根' },
        B: { goal: '叶B', depends_on: ['A'] },
        C: { goal: '叶C', depends_on: ['A'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.A!.status).toBe('done');
    expect(r.results.B!.status).toBe('done');
    expect(r.results.C!.status).toBe('done');
    expect(calls[0]).toBe('A'); // A 先于 B/C
    expect(maxActive()).toBeGreaterThanOrEqual(2); // B/C 并发在飞
  });

  test('maxFanout=1 严格串行且按拓扑序', async () => {
    const { generate, calls, maxActive } = makeGenerate({ delayMs: 5 });
    await runExecutorDagWithPlan(
      plan({
        A: { goal: '根' },
        B: { goal: '叶B', depends_on: ['A'] },
        C: { goal: '叶C', depends_on: ['B'] },
      }),
      makeConfig(generate, { maxFanout: 1 }),
    );
    expect(maxActive()).toBe(1);
    expect(calls).toEqual(['A', 'B', 'C']);
  });
});

describe('G-4 quorum fail-skip (D-7v2)', () => {
  test("单依赖链: A 失败 → B/C 级联 skipped, 零执行零 token", async () => {
    const { generate, calls } = makeGenerate();
    const events: DagNodeEvent[] = [];
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '会 FAIL 的根' },
        B: { goal: '叶B', depends_on: ['A'] },
        C: { goal: '叶C', depends_on: ['B'] },
      }),
      makeConfig(generate, { onNodeEvent: (e) => events.push(e) }),
    );
    expect(r.results.A!.status).toBe('failed');
    expect(r.results.B!.status).toBe('skipped');
    expect(r.results.C!.status).toBe('skipped');
    expect(r.results.B!.output).toContain('quorum');
    expect(r.results.B!.usage).toEqual({ in: 0, out: 0 });
    expect(calls).toEqual(['A']); // B/C 从未调模型
    // skipped 节点不发 start, 只发 settle(status:'skipped')
    expect(events.filter((e) => e.type === 'start').map((e) => (e as { id: string }).id)).toEqual(['A']);
    const settles = events.filter((e) => e.type === 'settle') as Array<{ id: string; status: string }>;
    expect(settles.find((e) => e.id === 'B')?.status).toBe('skipped');
    expect(settles.find((e) => e.id === 'C')?.status).toBe('skipped');
  });

  test("多依赖 fan-in 缺省 'any': 1/3 sibling 失败, synth 照跑且见失败占位", async () => {
    const { generate, prompts } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        s1: { goal: '甲' },
        s2: { goal: '乙 FAIL' },
        s3: { goal: '丙' },
        synth: { goal: '合成', depends_on: ['s1', 's2', 's3'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.s2!.status).toBe('failed');
    expect(r.results.synth!.status).toBe('done');
    expect(prompts.synth).toContain('out:s1');
    expect(prompts.synth).toContain('out:s3');
    expect(prompts.synth).toContain('注入失败'); // s2 失败占位注入, 非静默
  });

  test("多依赖全失败: 'any' 也 skipped", async () => {
    const { generate, calls } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        s1: { goal: '甲 FAIL' },
        s2: { goal: '乙 FAIL' },
        synth: { goal: '合成', depends_on: ['s1', 's2'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.synth!.status).toBe('skipped');
    expect(calls.sort()).toEqual(['s1', 's2']);
  });

  test('requires:K — done 依赖不足 K → skipped; 达到 K → 跑', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        g1: { goal: '候选1' },
        g2: { goal: '候选2 FAIL' },
        g3: { goal: '候选3 FAIL' },
        judge3: { goal: '判3', depends_on: ['g1', 'g2', 'g3'], requires: 3 },
        judge1: { goal: '判1', depends_on: ['g1', 'g2', 'g3'], requires: 1 },
      }),
      makeConfig(generate),
    );
    expect(r.results.judge3!.status).toBe('skipped');
    expect(r.results.judge1!.status).toBe('done');
  });

  test("requires:'all' 显式覆盖多依赖缺省", async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        s1: { goal: '甲' },
        s2: { goal: '乙 FAIL' },
        strict: { goal: '严合成', depends_on: ['s1', 's2'], requires: 'all' },
      }),
      makeConfig(generate),
    );
    expect(r.results.strict!.status).toBe('skipped');
  });
});

describe('D-23 per-channel 并发闸', () => {
  test('渠道 cap=1 → 同渠道节点串行, 未列渠道不限', async () => {
    const { generate, maxActive } = makeGenerate({ delayMs: 20 });
    await runExecutorDagWithPlan(
      plan({
        a: { goal: '甲', model: 'slowchan:m1' },
        b: { goal: '乙', model: 'slowchan:m1' },
        c: { goal: '丙', model: 'freechan:m2' },
      }),
      makeConfig(generate, { channelFanout: { slowchan: 1 } }),
    );
    // slowchan 两节点串行 → 全局并发峰值 ≤ 2 (1 slowchan + 1 freechan); 无闸时应为 3。
    expect(maxActive()).toBeLessThanOrEqual(2);
  });

  test('channelFanout 未配 → 行为不变 (全并发)', async () => {
    const { generate, maxActive } = makeGenerate({ delayMs: 20 });
    await runExecutorDagWithPlan(
      plan({
        a: { goal: '甲', model: 'slowchan:m1' },
        b: { goal: '乙', model: 'slowchan:m1' },
        c: { goal: '丙', model: 'freechan:m2' },
      }),
      makeConfig(generate),
    );
    expect(maxActive()).toBe(3);
  });
});

describe('D-8v2 primitive 候选池轮转', () => {
  test('parallel primitive 的 goals 按 candidates 跨池轮转; 未配则全走 leafModel', async () => {
    const models: string[] = [];
    const generate: GenerateFn = async (req) => {
      models.push(req.model);
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runExecutorDagWithPlan(
      plan({
        p: { kind: 'primitive', primitive: 'parallel', params: { goals: ['甲', '乙', '丙'] } },
      }),
      makeConfig(generate, { primitiveCandidates: ['famA:m1', 'famB:m2'] }),
    );
    expect(models.sort()).toEqual(['famA:m1', 'famA:m1', 'famB:m2']); // 3 路轮转 2 候选
    models.length = 0;
    await runExecutorDagWithPlan(
      plan({ p: { kind: 'primitive', primitive: 'parallel', params: { goals: ['甲', '乙'] } } }),
      makeConfig(generate),
    );
    expect(new Set(models)).toEqual(new Set(['test:leaf'])); // 池未配 → 零回归
  });
});

describe('G-11v2 零回归', () => {
  test('全绿链行为不变: 状态/输出/用量账本', async () => {
    const { generate, prompts } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({
        A: { goal: '根' },
        B: { goal: '叶', depends_on: ['A'] },
      }),
      makeConfig(generate),
    );
    expect(r.results.A!.status).toBe('done');
    expect(r.results.B!.status).toBe('done');
    expect(prompts.B).toContain('out:A'); // 前驱输出注入
    expect(r.usage.leavesIn).toBe(2);
    expect(r.usage.leavesOut).toBe(2);
    expect(r.levels).toEqual([['A'], ['B']]);
  });

  test('幻象 dep (引用不存在 id) 视为已满足, 不进 quorum 分母', async () => {
    const { generate } = makeGenerate();
    const r = await runExecutorDagWithPlan(
      plan({ A: { goal: '根', depends_on: ['ghost'] } }),
      makeConfig(generate),
    );
    expect(r.results.A!.status).toBe('done');
  });
});
