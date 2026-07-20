import { describe, expect, test } from 'bun:test';
import { runExecutorDag, type GenerateFn } from '../../src/harness/executor-dag';

// ready-set 依赖驱动调度 (取代逐层 barrier) 的行为证明 — fake generate, 不碰 live 模型/PG。
// 关键: 旧逐层 barrier 下, 一个节点必须等"同层"所有节点 (含与它无关的慢节点) 才能进下一层;
//       ready-set 下, 节点只等它**真正的 dep**。本测试用确定性时序证明 barrier 已拆。

const CONDUCTOR = 'mimo:mimo-v2.5-pro';
const LEAF = 'deepseek:deepseek-v4-flash';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// slow(root, 120ms) + fast(root, 5ms) + dep(依赖 fast, 5ms)。
// topoLevels = [[slow, fast], [dep]] → 旧 barrier: dep 等 level0 全完 (含 slow 120ms) 才跑。
// ready-set: dep 只依赖 fast → fast 完即跑, 与 slow 并行无关。
const PLAN = JSON.stringify({
  name: 'readyset',
  nodes: {
    slow: { agent: 'x', goal: 'SLOW root' },
    fast: { agent: 'x', goal: 'FAST root' },
    dep: { agent: 'x', goal: 'DEP of fast', depends_on: ['fast'] },
  },
});

describe('executor-dag ready-set 调度 (依赖驱动, 无层 barrier)', () => {
  test('dep 只等真 dep(fast), 不等无关慢节点(slow) — barrier 下此序不可能', async () => {
    const delays: Record<string, number> = { slow: 120, fast: 5, dep: 5 };
    const events: string[] = [];
    const promptOf: Record<string, string> = {};
    const gen: GenerateFn = async ({ model, messages }) => {
      if (model === CONDUCTOR) return { text: PLAN, usage: { in: 1, out: 1 } };
      const prompt = messages.map((m) => m.content).join('\n');
      const id = prompt.match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
      promptOf[id] = prompt;
      events.push(`${id}:start`);
      await sleep(delays[id] ?? 1);
      events.push(`${id}:end`);
      return { text: `OUT:${id}`, usage: { in: 1, out: 1 } };
    };

    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen });

    // 全 done
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);

    const i = (e: string): number => events.indexOf(e);
    // 正确性: dep 仅在其真 dep(fast) 完成后才开始 (依赖序不破)
    expect(i('dep:start')).toBeGreaterThan(i('fast:end'));
    // 效率 (ready-set 核心): dep 完成早于无关的 slow — 逐层 barrier 下 dep 必排在 slow 之后, 故此序即"barrier 已拆"的判定
    expect(i('dep:end')).toBeLessThan(i('slow:end'));
    // fan-in 正确: dep 收到 fast 的输出
    expect(promptOf['dep']).toContain('OUT:fast');
  });

  test('maxFanout=1: 串行化仍尊重依赖序 (ready-set 退化为合法拓扑序)', async () => {
    const order: string[] = [];
    const gen: GenerateFn = async ({ model, messages }) => {
      if (model === CONDUCTOR) return { text: PLAN, usage: { in: 1, out: 1 } };
      const id = messages.map((m) => m.content).join('\n').match(/\[omd leaf: (\w+)\]/)?.[1] ?? '?';
      order.push(id);
      return { text: `OUT:${id}`, usage: { in: 1, out: 1 } };
    };
    const res = await runExecutorDag('t', { conductorModel: CONDUCTOR, leafModel: LEAF, generate: gen, maxFanout: 1 });
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    // fast 必在 dep 之前 (依赖序), slow 无约束
    expect(order.indexOf('fast')).toBeLessThan(order.indexOf('dep'));
  });
});

// ── per-kind 并发闸 (fanout 最大化, 2026-07-21) ──────────────────────────────────

import { runExecutorDagWithPlan as runWithPlanKind, type GenerateFn as GenKind } from '../../src/harness/executor-dag';
import type { ConductorPlan as PlanKind } from '../../src/harness/conductor-plan';

describe('kindFanout per-kind 闸', () => {
  test('agent 叶受独立小闸约束, inproc 叶同时放飞不受其挡', async () => {
    // 4 个 agent 节点 + 4 个 inproc 节点, 全无依赖。kindFanout.agent=1 → agent 串行; inproc 全并发。
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 4; i++) nodes[`a${i}`] = { agent: 'x', executor: 'agent', goal: `agent ${i}` };
    for (let i = 0; i < 4; i++) nodes[`p${i}`] = { agent: 'x', executor: 'leaf', goal: `inproc ${i}` };
    const plan = { name: 'kind-cap', nodes } as unknown as PlanKind;

    let agentNow = 0, agentPeak = 0, inprocNow = 0, inprocPeak = 0;
    const gen: GenKind = async ({ messages }) => {
      inprocNow++; inprocPeak = Math.max(inprocPeak, inprocNow);
      await new Promise((r) => setTimeout(r, 30));
      inprocNow--;
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    const agentRunner = async () => {
      agentNow++; agentPeak = Math.max(agentPeak, agentNow);
      await new Promise((r) => setTimeout(r, 30));
      agentNow--;
      return { text: 'ok', usage: { in: 1, out: 1 }, filesTouched: [] };
    };
    const res = await runWithPlanKind(plan, {
      conductorModel: '', leafModel: 'fake:leaf', generate: gen, agentRunner,
      kindFanout: { agent: 1 },
    });
    expect(Object.values(res.results).every((r) => r.status === 'done')).toBe(true);
    expect(agentPeak).toBe(1); // agent 闸生效: 永不并行
    expect(inprocPeak).toBeGreaterThanOrEqual(3); // inproc 不受 agent 闸影响, 放飞
  });

  test('kindFanout 省略 → 行为与旧全宽完全一致 (BC)', async () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) nodes[`n${i}`] = { agent: 'x', executor: 'leaf', goal: `g${i}` };
    let now = 0, peak = 0;
    const gen: GenKind = async () => {
      now++; peak = Math.max(peak, now);
      await new Promise((r) => setTimeout(r, 20));
      now--;
      return { text: 'ok', usage: { in: 1, out: 1 } };
    };
    await runWithPlanKind({ name: 'bc', nodes } as unknown as PlanKind, { conductorModel: '', leafModel: 'fake:leaf', generate: gen });
    expect(peak).toBe(5); // 全宽
  });
});
