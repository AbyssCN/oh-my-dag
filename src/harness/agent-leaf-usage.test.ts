/**
 * agent leaf 用量口径回归 (owner 2026-07-28)。
 *
 * 锁的是 ModelUsage 契约里那条 **cacheHit ⊆ in**: pi 的 `tokens.input` 不含缓存命中, 照搬会让
 * cacheHit 远大于 in (实测到过 2082%), 而成本账按 `(in − cacheHit)×全价 + cacheHit×10%` 折算 →
 * in 偏小会算出**负成本**。这条错在读数上只是难看, 在账本上是直接错账。
 */
import { describe, expect, it } from 'bun:test';
import { mapSessionUsage } from './agent-leaf';

describe('mapSessionUsage 口径换算', () => {
  it('in 补回 cacheRead → 满足 cacheHit ⊆ in', () => {
    const u = mapSessionUsage({ input: 500, output: 200, cacheRead: 9500 });
    expect(u.in).toBe(10_000); // 500 增量 + 9500 命中
    expect(u.cacheHit).toBe(9500);
    expect(u.out).toBe(200);
    expect(u.cacheHit!).toBeLessThanOrEqual(u.in); // 契约不变量
  });

  it('工具循环里缓存前缀复用几十轮也不会越界 (原 2082% 的形状)', () => {
    const u = mapSessionUsage({ input: 800, output: 2190, cacheRead: 16_650 });
    expect(u.cacheHit!).toBeLessThanOrEqual(u.in);
    expect(u.in - u.cacheHit!).toBe(800); // 未命中部分 = pi 报的增量
  });

  it('折算成本不会为负 (cacheHit 按 ~10% 价的那条算式)', () => {
    const u = mapSessionUsage({ input: 100, output: 50, cacheRead: 20_000 });
    const effective = u.in - u.cacheHit! * 0.9; // 命中段按 10% 计
    expect(effective).toBeGreaterThan(0);
  });

  it('无 cacheRead / 无 tokens → 退化为原值与零', () => {
    expect(mapSessionUsage({ input: 300, output: 100 })).toEqual({ in: 300, out: 100, cacheHit: 0 });
    expect(mapSessionUsage(undefined)).toEqual({ in: 0, out: 0 });
    expect(mapSessionUsage({})).toEqual({ in: 0, out: 0, cacheHit: 0 });
  });
});
