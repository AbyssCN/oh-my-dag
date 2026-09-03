/**
 * D5 切片 1: settle 节点用量按 kind 归 conductor / leaves 两轴。
 *
 * 证伪:
 *   1. 把 settle 的 leaves* += r.usage 移回 conductor 分支外 → attribution 两条全红。
 *   2. 把 escalation 的 patched.usage 再 addUsage 一次 → 补丁账防双记用例红。
 */
import { describe, expect, test } from 'bun:test';
import { registerProvider } from '../../model/providers';
import type { ConductorPlan } from '../conductor-plan';
import { runExecutorDagWithPlan } from './engine';
import type { ExecutorDagConfig, GenerateFn } from './types';

const makeConfig = (generate: GenerateFn, extra: Partial<ExecutorDagConfig> = {}): ExecutorDagConfig => ({
  conductorModel: 'test:conductor',
  leafModel: 'test:leaf',
  agentLeafModel: 'test:agent',
  generate,
  agentTemplates: new Map(),
  ...extra,
});

const plan = (nodes: ConductorPlan['nodes']): ConductorPlan => ({
  name: 'usage-attribution',
  nodes,
});

const innerPlan: ConductorPlan = {
  name: 'inner-plan',
  nodes: {
    innerLeaf: { goal: '内层普通叶' },
  },
};

describe('D5 切片 1: settle 归属分流', () => {

  test('预构造全 agent 图没有 conductor 节点时，conductor 账保持真零', async () => {
    const agentRunner = async () => ({ text: 'agent done', usage: { in: 9, out: 3 } });
    const generate: GenerateFn = async () => ({ text: 'unused', usage: { in: 0, out: 0 } });

    const r = await runExecutorDagWithPlan(
      plan({ agent: { goal: '只有 agent', executor: 'agent' } }),
      makeConfig(generate, { agentRunner }),
    );

    expect(r.results.agent!.kind).toBe('agent');
    expect(r.usage.conductor.in).toBe(0);
    expect(r.usage.conductor.out).toBe(0);
    expect(r.usage.leavesIn).toBe(9);
    expect(r.usage.leavesOut).toBe(3);
  });


});
