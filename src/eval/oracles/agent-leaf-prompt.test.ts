import { describe, expect, test } from 'bun:test';
import agentLeafPromptSpec from './agent-leaf-prompt';

// eval spec 的结构闸 (不起真模型): 网格展开正确 + 串行 + 单轮全表, 别让一次几小时的跑因为
// 参数解析错而白烧。

describe('agent-leaf-prompt eval spec', () => {
  test('缺省网格 = 2 模型 × 4 档 = 8 格', () => {
    expect(agentLeafPromptSpec().seed().length).toBe(8);
  });

  test('--models/--profiles 收窄网格, label 带档位 (leaderboard 可读)', () => {
    const g = agentLeafPromptSpec({ models: 'a:b,c:d', profiles: 'weak,strong' }).seed();
    expect(g.length).toBe(4);
    expect(g.map((c) => c.label)).toContain('a:b [weak]');
    expect(g.every((c) => ['weak', 'strong'].includes(c.config.profile))).toBe(true);
  });

  test('非法档位被丢弃而不是静默当成 auto', () => {
    const g = agentLeafPromptSpec({ models: 'a:b', profiles: 'weak,zzz' }).seed();
    expect(g.map((c) => c.config.profile)).toEqual(['weak']);
  });

  test('串行 + 单轮全表 (INV: 并行争限流污染墙钟/停摆读数; 要整表不要冠军)', () => {
    const s = agentLeafPromptSpec();
    expect(s.concurrency).toBe(1);
    expect(s.maxRounds).toBe(1);
    expect(s.direction).toBe('max');
  });
});
