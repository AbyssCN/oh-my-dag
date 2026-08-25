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
  test('conductor 节点用量进 conductor 轴，agent 节点只进 leaves 轴', async () => {
    const generate: GenerateFn = async (req) => {
      if (req.traceName === 'conductor:outer') {
        return { text: JSON.stringify(innerPlan), usage: { in: 17, out: 5, cacheHit: 3 } };
      }
      return { text: 'unused', usage: { in: 0, out: 0 } };
    };
    const agentRunner = async () => ({ text: 'agent done', usage: { in: 13, out: 7, cacheHit: 2 } });

    const r = await runExecutorDagWithPlan(
      plan({
        outer: { goal: '外层 conductor', executor: 'conductor', max_rounds: 1 },
        agent: { goal: '外层 agent', executor: 'agent', depends_on: ['outer'] },
      }),
      makeConfig(generate, { agentRunner }),
    );

    expect(r.results.outer!.kind).toBe('conductor');
    expect(r.results.agent!.kind).toBe('agent');
    expect(r.usage.conductor.in).toBe(17);
    expect(r.usage.conductor.out).toBe(5);
    expect(r.usage.conductor.cacheHit).toBe(3);
    expect(r.usage.leavesIn).toBe(13);
    expect(r.usage.leavesOut).toBe(7);
    expect(r.usage.leavesCacheHit).toBe(2);
  });

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

  test('escalation 补丁规划用量只进 conductor，不把补丁量双记进 leaves', async () => {
    registerProvider('attribution-escalation', {
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'test-key',
      api: 'openai-compatible',
    });
    let verifyCount = 0;
    const generate: GenerateFn = async (req) => {
      const system = req.messages.find((message) => message.role === 'system')?.content;
      if (typeof system === 'string' && system.includes('REPLAN-PATCH')) {
        return { text: JSON.stringify({ patch: { b: { goal: '修好的 b' } } }), usage: { in: 5, out: 4 } };
      }
      return { text: 'leaf output', usage: { in: 1, out: 1 } };
    };
    const verifier = async () => {
      verifyCount++;
      return verifyCount === 1
        ? { pass: false, reason: 'b 不合格', usage: { in: 1, out: 1 } }
        : { pass: true, reason: 'ok', usage: { in: 1, out: 1 } };
    };

    const r = await runExecutorDagWithPlan(
      plan({ a: { goal: 'a' }, b: { goal: 'b', depends_on: ['a'] } }),
      makeConfig(generate, { verifier, conductorEscalationModel: 'attribution-escalation:strong' }),
    );

    expect(r.usage.conductor.in).toBe(5);
    expect(r.usage.conductor.out).toBe(4);
    expect(r.usage.leavesIn).toBe(3);
    expect(r.usage.leavesOut).toBe(3);
  });
});
