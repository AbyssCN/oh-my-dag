/**
 * L1 判据:上下文压力摘要(2026-08-07)。
 *
 * 两条会静默出错的:
 *  ① **还没跑过一轮**要返回 `null` 让调用方不画这一行 —— 画一行全零会读成"跑过了、没花钱";
 *  ② **窗口未知**时不画百分比 —— 编一个分母算出来的百分比比不画更坏(它看起来是个可信的数)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import type { ContextPressure } from '../../harness/chat/usage';
import { fitLine } from './line';
import { formatPressure, humanTokens } from './pressure';

const p = (over: Partial<ContextPressure> = {}): ContextPressure => ({
  systemTokens: 12_000, harnessTokens: 8000, historyTokens: 34_000,
  usedTokens: 46_000, windowTokens: 200_000, ratio: 0.23, ...over,
});

describe('humanTokens', () => {
  test('<1000 原样, ≥1000 换 k', () => {
    expect(humanTokens(999)).toBe('999');
    expect(humanTokens(1234)).toBe('1.2k');
    expect(humanTokens(46_000)).toBe('46k');
  });

  test('不出现 0.4k 这种比原数还费劲的写法', () => {
    expect(humanTokens(400)).toBe('400');
  });
});

describe('formatPressure', () => {
  test('★ 还没跑过一轮 → null(调用方不画这一行, 而不是画一行全零)', () => {
    expect(formatPressure(null)).toBeNull();
    expect(formatPressure(p({ usedTokens: 0 }))).toBeNull();
  });

  test('★ 窗口未知 → 说"窗口未知", **不画百分比**', () => {
    const out = formatPressure(p({ windowTokens: 0, ratio: null })) as string;
    expect(out).toContain('窗口未知');
    expect(out).not.toMatch(/\d+%/);
    expect(out).not.toContain('/0');
  });

  test('窗口已知 → 画 已用/窗口 + 百分比', () => {
    expect(formatPressure(p())).toContain('ctx 46k/200k 23%');
  });

  test('★ harness 为 0 时不画那一段 —— 一个 `harness 0` 是噪声', () => {
    expect(formatPressure(p({ harnessTokens: 0 }))).not.toContain('harness');
    expect(formatPressure(p())).toContain('harness 8.0k');
  });

  test('本轮用量给了才画; cacheHit 为 0 不画 cache 段', () => {
    expect(formatPressure(p(), null)).not.toContain('本轮');
    expect(formatPressure(p(), { in: 100, out: 20 })).toContain('本轮 in 100 out 20');
    expect(formatPressure(p(), { in: 100, out: 20 })).not.toContain('cache');
    expect(formatPressure(p(), { in: 100, out: 20, cacheHit: 90 })).toContain('cache 90');
  });

  test('用量全零时不画本轮段(provider 没报 ≠ 没花钱, 但屏上不该显示一个零)', () => {
    expect(formatPressure(p(), { in: 0, out: 0 })).not.toContain('本轮');
  });

  test('★ 塞进窄屏仍不超宽(它是一条状态行, 走 fitLine)', () => {
    const line = formatPressure(p(), { in: 46_000, out: 800, cacheHit: 41_000 }) as string;
    for (const w of [20, 40, 80]) {
      expect(visibleWidth(fitLine(line, w))).toBeLessThanOrEqual(w);
    }
  });
});
