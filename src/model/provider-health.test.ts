/**
 * provider-health 熔断测试: 上报即冷却 · 窗内 inCooldown · 窗过自愈 · 坐标/裸名归一 · reset。
 * 纯内存零网络; `now` 注入避免真时钟依赖。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { inCooldown, reportProviderFailure, resetProviderCooldowns } from './provider-health';

describe('provider-health circuit breaker', () => {
  afterEach(() => resetProviderCooldowns());

  test('未上报 → 不在冷却', () => {
    expect(inCooldown('deepseek')).toBe(false);
  });

  test('上报后窗内 → 在冷却; 窗过 → 自愈返 false', () => {
    reportProviderFailure('deepseek', 30_000);
    const t0 = Date.now();
    expect(inCooldown('deepseek', t0 + 10_000)).toBe(true); // 窗内
    expect(inCooldown('deepseek', t0 + 40_000)).toBe(false); // 窗过 → 自愈
    // 自愈后条目已清: 再查 (即便 now 回到窗内) 仍 false
    expect(inCooldown('deepseek', t0 + 10_000)).toBe(false);
  });

  test('坐标与裸名归一: 上报坐标 → 裸名查得到 (防错位漏命中)', () => {
    reportProviderFailure('deepseek:deepseek-v4-pro', 30_000);
    expect(inCooldown('deepseek', Date.now() + 1_000)).toBe(true);
    expect(inCooldown('deepseek:deepseek-v4-flash', Date.now() + 1_000)).toBe(true);
  });

  test('空串忽略, 不抛', () => {
    expect(() => reportProviderFailure('')).not.toThrow();
    expect(inCooldown('')).toBe(false);
  });

  test('reset 清全部冷却', () => {
    reportProviderFailure('mimo', 60_000);
    resetProviderCooldowns();
    expect(inCooldown('mimo', Date.now() + 1_000)).toBe(false);
  });
});
