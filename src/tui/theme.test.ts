/**
 * L1 判据:主题(A9,切片 S18)。
 *
 * 三条,全是**会静默出错**的:
 *  ① `NO_COLOR` 下是**恒等函数**,不是"换一组浅色" —— 管道/CI 里 ANSI 会变成可见垃圾;
 *  ② 认不认 24 位色要**回落**,照发 `38;2;...` 会在老终端上吐出可见字符**并把宽度算错**;
 *  ③ 上不上色都**不改变可见宽度**(ANSI 不计宽)—— 改了的话宽度闸两种模式会给两个结论。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { MOCHA, colorEnabled, createTheme, fg24, truecolorEnabled } from './theme';

describe('开关', () => {
  test('★ NO_COLOR 只要存在就关色(哪怕是空串)', () => {
    expect(colorEnabled({ NO_COLOR: '' })).toBe(false);
    expect(colorEnabled({ NO_COLOR: '0' })).toBe(false);
    expect(colorEnabled({})).toBe(true);
  });

  test('COLORTERM 认 truecolor / 24bit', () => {
    expect(truecolorEnabled({ COLORTERM: 'truecolor' })).toBe(true);
    expect(truecolorEnabled({ COLORTERM: '24bit' })).toBe(true);
    expect(truecolorEnabled({ COLORTERM: '' })).toBe(false);
    expect(truecolorEnabled({})).toBe(false);
  });
});

describe('fg24', () => {
  test('hex → 24 位前景 SGR, 且自闭合', () => {
    expect(fg24('#89b4fa')('x')).toBe('\x1b[38;2;137;180;250mx\x1b[0m');
  });

  test('★ 非法 hex 直接抛 —— 那是打字错误, 不是运行时状况', () => {
    expect(() => fg24('89b4fa')).toThrow();
    expect(() => fg24('#xyzxyz')).toThrow();
  });

  test('Mocha 逐值都是合法 hex(打错一个字符会在这里红)', () => {
    for (const [name, hex] of Object.entries(MOCHA)) {
      expect(() => fg24(hex), name).not.toThrow();
    }
  });
});

describe('★ createTheme 三档', () => {
  // 反向自检 (2026-08-07 实跑): 把关色那一档从 identity 改成照常上色
  // → 「关色下零 ANSI」当场红; 把 truecolor 回落去掉 (恒发 38;2) → 「不认时回落」红。
  const sample = (t: ReturnType<typeof createTheme>) => t.chrome.accent('abc');

  test('★ 关色 → 恒等函数, 零 ANSI', () => {
    expect(sample(createTheme({ color: false }))).toBe('abc');
    expect(sample(createTheme({ color: false, truecolor: true }))).toBe('abc');
  });

  test('★ 认 24 位 → 用 Catppuccin 逐值', () => {
    expect(sample(createTheme({ color: true, truecolor: true }))).toContain('38;2;');
  });

  test('★ 不认 24 位 → **回落 16 色**, 不许照发 38;2(老终端会吐出可见垃圾并把宽度算错)', () => {
    const out = sample(createTheme({ color: true, truecolor: false }));
    expect(out).not.toContain('38;2;');
    expect(out).toContain('\x1b[');
  });

  test('★ 三档的可见宽度完全一致 —— 不然宽度闸会给两个结论', () => {
    const w = (t: ReturnType<typeof createTheme>) => visibleWidth(t.chrome.accent('你好abc'));
    expect(w(createTheme({ color: false }))).toBe(w(createTheme({ color: true, truecolor: true })));
    expect(w(createTheme({ color: true, truecolor: false }))).toBe(w(createTheme({ color: false })));
  });

  test('markdown / editor / chrome 三个面都在(换主题时组件一行不用动)', () => {
    const t = createTheme({ color: true, truecolor: true });
    expect(typeof t.markdown.heading).toBe('function');
    expect(typeof t.markdown.highlightCode).toBe('function'); // S7 挂上去的
    expect(typeof t.editor.borderColor).toBe('function');
    expect(typeof t.chrome.dim).toBe('function');
  });
});
