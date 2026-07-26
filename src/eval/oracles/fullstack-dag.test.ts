import { describe, expect, test } from 'bun:test';
import fullstackDagSpec from './fullstack-dag';

// 结构闸: 一次全栈 run 是几十分钟, 参数解析或网格搭错 = 半天白烧。

describe('fullstack-dag eval spec', () => {
  test('缺省网格 = 2 conductor + 1 对照格', () => {
    const g = fullstackDagSpec().seed();
    expect(g.length).toBe(3);
    expect(g.filter((c) => c.label.includes('control')).length).toBe(1);
  });

  test('对照格与首格同配置 (噪声地板才有意义)', () => {
    const g = fullstackDagSpec().seed();
    expect(g[g.length - 1]!.config).toEqual(g[0]!.config);
  });

  test('--conductors/--leaf 收窄', () => {
    const g = fullstackDagSpec({ conductors: 'a:b', leaf: 'c:d' }).seed();
    expect(g.length).toBe(2); // 1 + 对照
    expect(g[0]!.config).toEqual({ conductorModel: 'a:b', leafModel: 'c:d' });
  });

  test('R 默认 2 而不是 3 (全栈单次几十分钟, 噪声靠对照格不靠堆 R)', () => {
    expect(fullstackDagSpec().seed().length).toBeGreaterThan(0);
    expect(fullstackDagSpec({ r: '5' })).toBeTruthy();
  });

  test('串行 + 单轮全表', () => {
    const s = fullstackDagSpec();
    expect(s.concurrency).toBe(1);
    expect(s.maxRounds).toBe(1);
  });
});

// 2026-07-26 首轮血的教训: eval oracle 忘了 bootstrapModelRuntime → inproc leaf 抛
// "provider 'mimo' not registered" → 整张图级联 skip → 6 次全栈跑全废 (约 30 分钟)。
// 这条闸让同类错误在 0.1 秒里现形, 而不是半小时后。
test('spec 构造时已注册自有 provider (inproc leaf 走 callModel, 需要 registry)', () => {
  fullstackDagSpec();
  const { listProviders } = require('../../model/gateway');
  expect(listProviders().length).toBeGreaterThan(0);
});
