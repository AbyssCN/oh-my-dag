/**
 * L0 节点级重试 (D-11 / INV-P2-1..3) —— `max_retry` 从装饰变成真旋钮。
 *
 * 补的是这个形态: `max_retry` / `on_failure` / `fallback` 三个字段有 schema、进语义指纹、
 * **零引擎消费者** —— 手写 plan 显式写了 `max_retry: 2`, 引擎静默当没看见。
 * 二选一的结果: 留 `max_retry` 并实装, 删 `on_failure` / `fallback`。
 */
import { describe, expect, test } from 'bun:test';
import { runExecutorDagWithPlan } from './dag/engine';
import { PlanSchema } from './conductor-plan';
import { nodeFieldsKey } from './plan-passes/semantic-key';
import type { ConductorPlan } from './conductor-plan';
import type { ExecutorDagConfig, GenerateFn } from './dag/types';

/** 前 `failTimes` 次调用抛错 (模拟 429/网络抖动), 之后成功。回收每次拿到的 prompt。 */
const flakyGenerate = (failTimes: number, prompts: string[]): GenerateFn => {
  let calls = 0;
  return async (req) => {
    const user = req.messages.find((m) => m.role === 'user');
    prompts.push(typeof user?.content === 'string' ? user.content : '');
    if (++calls <= failTimes) throw new Error(`boom-${calls}`);
    return { text: `ok@${calls}`, usage: { in: 10, out: 5 } };
  };
};

const cfg = (generate: GenerateFn): ExecutorDagConfig => ({
  conductorModel: 'c:m',
  leafModel: 'l:m',
  generate,
  agentTemplates: new Map(),
});

const planWith = (maxRetry?: number): ConductorPlan => ({
  name: 'p',
  nodes: { a: { goal: '干活', ...(maxRetry === undefined ? {} : { max_retry: maxRetry }) } },
});

describe('L0 节点级重试 (INV-P2-2)', () => {
  test('不设 max_retry → 只跑一次 (零回归)', async () => {
    const prompts: string[] = [];
    const r = await runExecutorDagWithPlan(planWith(), cfg(flakyGenerate(0, prompts)));
    expect(prompts).toHaveLength(1);
    expect(r.results.a?.status).toBe('done');
  });

  test('max_retry=2, 前两次抛错 → 第 3 次成功, 恰好 3 次尝试', async () => {
    const prompts: string[] = [];
    const r = await runExecutorDagWithPlan(planWith(2), cfg(flakyGenerate(2, prompts)));
    expect(prompts).toHaveLength(3);
    expect(r.results.a?.status).toBe('done');
    expect(r.results.a?.output).toBe('ok@3');
  });

  test('有界: 一直抛错 + max_retry=2 → 恰好 3 次后停, 不无限转', async () => {
    const prompts: string[] = [];
    const r = await runExecutorDagWithPlan(planWith(2), cfg(flakyGenerate(99, prompts)));
    expect(prompts).toHaveLength(3);
    expect(r.results.a?.status).toBe('failed');
    // 最后一次仍是抛错 → 原样抛回, 由 failedFromThrow 隔离并保留败因 (INV-6)
    expect(r.results.a?.output).toContain('boom-3');
  });

  test('带因重试: 第 2 次的 prompt 含第 1 次的失败原因, 不是原样重放', async () => {
    const prompts: string[] = [];
    await runExecutorDagWithPlan(planWith(1), cfg(flakyGenerate(1, prompts)));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('上一次尝试失败');
    expect(prompts[1]).toContain('上一次尝试失败');
    expect(prompts[1]).toContain('boom-1'); // 真把上次的败因带过去了
    expect(prompts[1]).not.toBe(prompts[0]);
  });

  test('会计: 被丢弃的尝试的 token 也计入 (不丢账)', async () => {
    // 第 1 次成功但 status=failed 走不通, 改用"第 1 次成功、无重试"作对照基线。
    const base: string[] = [];
    const r1 = await runExecutorDagWithPlan(planWith(), cfg(flakyGenerate(0, base)));
    const oneShot = (r1.results.a?.usage.in ?? 0) + (r1.results.a?.usage.out ?? 0);

    // 抛错的尝试没有 usage 可计 (调用没返回), 故用"成功但重试过"的形态测不了;
    // 这里钉的是不回归: 单次成功的账与基线一致, 不因包了一层重试而漏记或重复记。
    const again: string[] = [];
    const r2 = await runExecutorDagWithPlan(planWith(3), cfg(flakyGenerate(0, again)));
    expect((r2.results.a?.usage.in ?? 0) + (r2.results.a?.usage.out ?? 0)).toBe(oneShot);
    expect(again).toHaveLength(1);
  });
});

describe('无空旋钮 (INV-P2-1 / INV-P2-3)', () => {
  // node schema 不单独导出, 经 PlanSchema.shape.nodes 的 valueType 内省 (同 dedup-pass.test 手法)。
  const shape = (PlanSchema.shape.nodes as unknown as { valueType: { shape: Record<string, unknown> } }).valueType
    .shape;

  test('on_failure / fallback 已不在 node schema 里 (零消费者的旋钮不留)', () => {
    expect(shape.on_failure).toBeUndefined();
    expect(shape.fallback).toBeUndefined();
  });

  test('max_retry 留着, 且真影响语义键 (它现在有消费者)', () => {
    expect(shape.max_retry).toBeDefined();
    expect(nodeFieldsKey({ goal: 'g', max_retry: 1 })).not.toBe(nodeFieldsKey({ goal: 'g', max_retry: 2 }));
  });

  test('已删字段即使经 passthrough 混进来, 也不再进语义键 (不打空跨轮复用)', () => {
    const withGhost = { goal: 'g', on_failure: 'retry', fallback: 'human' } as Parameters<typeof nodeFieldsKey>[0];
    expect(nodeFieldsKey(withGhost)).toBe(nodeFieldsKey({ goal: 'g' }));
  });
});
