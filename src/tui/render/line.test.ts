/**
 * L1 判据:单行渲染(TUI SDD §9 第一层,切片 S5)。
 *
 * 三个坑各一条,都是**实测出来的**而不是想出来的:
 *  ① CJK 按列宽不按字符数 —— `.length` 版本在这里当场对不上;
 *  ② `truncateToWidth` 自己**不管换行**(实测 `'a\nb'` 原样返回);
 *  ③ 窄到 0 列时画不出东西是对的,报错不是。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { fitLine } from './line';

describe('fitLine —— 恰好一行, 不超宽', () => {
  // 反向自检 (2026-08-07 实跑): 把 fitLine 的 truncateToWidth 换成原样返回 text
  // → 下面「超宽必须被截」「CJK 按列宽」两条当场红。
  test('放得下就原样返回, 不平白加省略号', () => {
    expect(fitLine('hello', 5)).toBe('hello');
  });

  test('★ 超宽必须被截 —— 截完的可见宽度 <= width', () => {
    const out = fitLine('hello world', 5);
    expect(visibleWidth(out)).toBeLessThanOrEqual(5);
    expect(out).not.toBe('hello world');
  });

  test('★ CJK 按**列宽**算, 不是字符数 —— 用 .length 的版本会超宽一倍', () => {
    // '你好世界啊' 是 5 个字符、10 列。按 .length 判会认为 5 列放得下 → 实际画 10 列 → 超宽。
    const out = fitLine('你好世界啊', 5);
    expect(visibleWidth(out)).toBeLessThanOrEqual(5);
    expect('你好世界啊'.length).toBe(5); // 这一行就是"为什么 .length 靠不住"的证据
  });

  test('★ 换行/制表符被拍平 —— 一个混进状态行的 \\n 会让这"一行"变两行, 而宽度检查还是过的', () => {
    // 实测: truncateToWidth('a\nb', 5) 原样返回 'a\nb' —— 它只管宽度不管换行。
    const out = fitLine('a\nb\tc\r\nd', 20);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\t');
    expect(out).toBe('a b c d');
  });

  test('width <= 0 → 空串, 不抛', () => {
    expect(fitLine('abc', 0)).toBe('');
    expect(fitLine('abc', -3)).toBe('');
  });

  test('宽度 1..3 的极窄档也不超宽(省略号自己也要放得下)', () => {
    for (const w of [1, 2, 3]) {
      expect(visibleWidth(fitLine('abcdef', w))).toBeLessThanOrEqual(w);
    }
  });

  test('ANSI 不计宽 —— 带色的串不会因为控制码被提前截掉', () => {
    expect(visibleWidth(fitLine('\x1b[32mhello\x1b[0m', 5))).toBe(5);
  });
});
