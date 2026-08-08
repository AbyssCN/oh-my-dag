/**
 * L1 判据:token 格式化(2026-08-07)。
 *
 * `formatPressure` 已随切片②删除;它的「null 不画 / 窗口未知不画百分比」判据
 * 由 `statusbar.test.ts` 承接。
 */
import { describe, expect, test } from 'bun:test';
import { humanTokens } from './pressure';

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
