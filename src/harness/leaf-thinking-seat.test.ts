/**
 * src/harness/leaf-thinking-seat.test —— P3 S7 / D-18: agent 叶 thinking 按座位逐调用解析, 两个通道缺省分开。
 *
 * 反向自检:
 *  · `resolveLeafThinking` 去掉 `seat ??` 那一跳 → 「座位档生效」红;
 *  · 引擎侧把 `agentThinking` 改成 `?? 'high'` 兜底 → 「座位表没给档 ⇒ 字段缺席」红 (那正是"顺手降 worker 档"的形态);
 *  · 引擎侧不读 node.thinking → 「node.thinking 压过座位档」红。
 */
import { describe, expect, test } from 'bun:test';
import { resolveLeafThinking } from './agent-leaf';
import { runExecutorDagWithPlan } from './dag/engine';
import type { ConductorPlan } from './conductor-plan';
import type { ExecutorDagConfig } from './dag/types';
import type { AgentLeafInput } from './leaf-runners';

describe('resolveLeafThinking — 优先序 explicit > env > seat > channelDefault', () => {
  test('矩阵', () => {
    expect(resolveLeafThinking({ channelDefault: 'xhigh' })).toBe('xhigh');
    expect(resolveLeafThinking({ channelDefault: 'medium' })).toBe('medium');
    expect(resolveLeafThinking({ seat: 'low', channelDefault: 'xhigh' })).toBe('low');
    expect(resolveLeafThinking({ env: 'high', seat: 'low', channelDefault: 'xhigh' })).toBe('high');
    expect(resolveLeafThinking({ explicit: 'off', env: 'high', seat: 'low', channelDefault: 'xhigh' })).toBe('off');
  });
});

describe('引擎 → agent 叶: thinkingLevel 按 node.thinking ?? seatThinking(model) 逐调用下发', () => {
  const run = async (node: Record<string, unknown>, seatThinking?: ExecutorDagConfig['seatThinking']): Promise<AgentLeafInput> => {
    let captured: AgentLeafInput | null = null;
    const plan = { name: 'p', nodes: { W: { executor: 'agent', goal: '改文件', ...node } } } as unknown as ConductorPlan;
    await runExecutorDagWithPlan(plan, {
      conductorModel: 'c:m',
      leafModel: 'l:m',
      agentLeafModel: 'l:m',
      generate: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as never,
      agentRunner: async (input) => {
        captured = input;
        return { text: '完整产出', usage: { in: 1, out: 1 }, filesTouched: ['src/x.ts'] };
      },
      ...(seatThinking ? { seatThinking } : {}),
    } as ExecutorDagConfig);
    return captured!;
  };

  test('★ 座位表给档 ⇒ input.thinkingLevel = 座位档', async () => {
    const input = await run({}, (coord) => (coord === 'l:m' ? 'low' : undefined));
    expect(input.thinkingLevel).toBe('low');
  });

  test('★ 座位表没给档 ⇒ 字段缺席 (不下发 high 兜底, 通道缺省由 runner 自己定)', async () => {
    const input = await run({}, () => undefined);
    expect(input.thinkingLevel).toBeUndefined();
    const noSeat = await run({});
    expect(noSeat.thinkingLevel).toBeUndefined();
  });

  test('node.thinking 压过座位档', async () => {
    const input = await run({ thinking: 'high' }, () => 'low');
    expect(input.thinkingLevel).toBe('high');
  });
});
