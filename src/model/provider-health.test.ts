/**
 * provider-health 熔断测试 (D-18/INV-5): channel:model 粒度冷却。
 *  · 上报 channel:model → 该精确组合冷却, 其它 model 同 channel 不受影响
 *  · channelInCooldown(channel) → channel 级宽门 (role-fallback 用)
 *  · 窗过自愈 · 空串忽略 · reset
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  channelInCooldown,
  inCooldown,
  reportProviderFailure,
  resetProviderCooldowns,
} from './provider-health';

describe('provider-health circuit breaker (D-18/INV-5)', () => {
  afterEach(() => resetProviderCooldowns());

  test('未上报 → 不在冷却', () => {
    expect(inCooldown('allegretto:kimi-k3')).toBe(false);
    expect(channelInCooldown('allegretto')).toBe(false);
  });

  test('上报 channel:model → 该精确组合冷却; 窗过 → 自愈', () => {
    reportProviderFailure('allegretto:kimi-k3', 30_000);
    const t0 = Date.now();
    expect(inCooldown('allegretto:kimi-k3', t0 + 10_000)).toBe(true);  // 窗内
    expect(inCooldown('allegretto:kimi-k3', t0 + 40_000)).toBe(false); // 窗过 → 自愈
    expect(inCooldown('allegretto:kimi-k3', t0 + 10_000)).toBe(false); // 自愈后条目已清
  });

  test('同 channel 不同 model 独立冷却 (D-18 核心)', () => {
    reportProviderFailure('allegretto:kimi-k3', 30_000);
    // kimi-k3 冷却中, 但同 channel 的其它 model 不受影响
    expect(inCooldown('allegretto:kimi-k3')).toBe(true);
    expect(inCooldown('allegretto:other-model')).toBe(false);
    expect(inCooldown('lite:kimi-k3')).toBe(false); // 不同 channel 也不影响
  });

  test('channelInCooldown 宽门: channel 内任一 model 冷却 → true', () => {
    reportProviderFailure('allegretto:kimi-k3', 30_000);
    expect(channelInCooldown('allegretto')).toBe(true);   // channel 有 model 在冷却
    expect(channelInCooldown('lite')).toBe(false);         // 不同 channel
  });

  test('空串忽略, 不抛', () => {
    expect(() => reportProviderFailure('')).not.toThrow();
    expect(inCooldown('')).toBe(false);
  });

  test('reset 清全部冷却', () => {
    reportProviderFailure('allegretto:kimi-k3', 60_000);
    reportProviderFailure('lite:kimi-k3', 60_000);
    resetProviderCooldowns();
    expect(inCooldown('allegretto:kimi-k3')).toBe(false);
    expect(inCooldown('lite:kimi-k3')).toBe(false);
  });
});
