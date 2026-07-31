/**
 * **暖发选谁**(2026-07-31,重启后第一跑当场撞出来的)。
 *
 * 暖发的用处是:先串行跑一个节点把 prompt-cache 写热,再放开其余去命中共享冻结前缀。
 * 所以它成立的前提是 —— **那一发真的会打模型**。
 *
 * 第一版是 `ready.shift()`,拿第一个就绪节点、不问它是什么。而一张图的 L1 常常全是 command
 * 节点(跑测试 / 数文件 / 取 git log),那些节点**一次模型都不调**:暖发把它们串行跑一遍,
 * 拿到的缓存收益是 **0**,付出的是实打实的一发延迟。重启后跑的第一张图就是这个形状 ——
 * 4 个 command 节点里只有 1 个在跑,另外 3 个干等着一件与它们无关的事。
 *
 * 判据用节点自己的 `executor`(直接证据),而不是"排除了别的"。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from '../../src/harness/executor-dag';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig } from '../../src/harness/executor-dag-types';

/** 记最大同时在飞数 —— 「并行没并行」的唯一硬判据。 */
function makeCommandRunner() {
  let inFlight = 0;
  let peak = 0;
  const runner = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    return { text: 'ok', usage: { in: 0, out: 0 }, exitCode: 0 };
  };
  return { runner, peak: () => peak };
}

const cfg = (commandRunner: () => Promise<{ text: string; usage: { in: number; out: number }; exitCode: number }>): ExecutorDagConfig =>
  ({
    conductorModel: 'c:m',
    leafModel: 'l:m',
    warmThenFanout: true,
    generate: async () => ({ text: 'out', usage: { in: 1, out: 1 } }),
    commandRunner,
  }) as unknown as ExecutorDagConfig;

const cmdPlan = (n: number): ConductorPlan =>
  ({
    name: 'p',
    nodes: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`c${i}`, { goal: `第 ${i} 条`, executor: 'command', command: 'echo hi' }]),
    ),
  }) as unknown as ConductorPlan;

describe('暖发 · 整层都是 command 时不暖 (没有可暖的东西时它该消失)', () => {
  test('★ 3 个 command 节点全并行 —— 暖发不该白白串行掉一个', async () => {
    const { runner, peak } = makeCommandRunner();
    await runExecutorDagWithPlan(cmdPlan(3), cfg(runner));
    // 修之前这里是 1 (暖发抓走第一个串行跑, 其余才放开) —— 而那一发的缓存收益是 0。
    expect(peak()).toBe(3);
  });
});

describe('暖发 · 有会打模型的节点时, 照旧先暖一发', () => {
  test('leaf 与 command 混在一层 → command 不会被抓去当暖发', async () => {
    const { runner, peak } = makeCommandRunner();
    const plan = {
      name: 'p',
      nodes: {
        c0: { goal: '数文件', executor: 'command', command: 'echo hi' },
        c1: { goal: '取 log', executor: 'command', command: 'echo hi' },
        L: { goal: '想一想' }, // inproc leaf —— 它才是该被暖的那个
      },
    } as unknown as ConductorPlan;
    await runExecutorDagWithPlan(plan, cfg(runner));
    // 暖发挑走了 leaf, 两个 command 因此仍然是并行的
    expect(peak()).toBe(2);
  });
});
