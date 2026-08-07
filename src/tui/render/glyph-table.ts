/**
 * src/tui/render/glyph-table —— **字形宽度探针的产物**(切片 S6)。
 *
 * ⚠ **生成文件,别手改。** 重新生成:
 *   `bun run scripts/tui-glyph-probe.ts --emit-ts > src/tui/render/glyph-table.ts`
 *
 * 真终端读数(第三套读数):**未量** ——
 * 自动化 lane 后面没有终端模拟器, 没人回答 CSI 6n。想量真值在真终端里跑 `--tty`。
 *
 * 判定三态(**不是两态**):
 *  - `SAFE` —— 两把尺子(pi-tui / Unicode EAW)一致;
 *  - `NEEDS_TTY` —— **歧义宽度**(EAW = A):CJK locale 画 2 列、别处画 1 列。
 *    不是"不安全",是**这台机器上答不了** —— 两者压成一个黑名单就再也分不开;
 *  - `UNSAFE` —— 字体私用区 / emoji / ZWJ:各终端与各字体分歧最大,一律不做 UI 骨架。
 */

/** 白名单:字形 → 已核实的列宽。测试拿它当**回归钉**,pi-tui 改了宽度表这里当场红。 */
export const SAFE_GLYPH_WIDTHS: ReadonlyMap<string, number> = new Map([
  ['a', 1], // U+0061
  ['0', 1], // U+0030
  [' ', 1], // U+0020
  ['-', 1], // U+002D
  ['|', 1], // U+007C
  ['+', 1], // U+002B
  ['>', 1], // U+003E
  ['.', 1], // U+002E
  [':', 1], // U+003A
  ['\u{4f60}', 2], // U+4F60
  ['\u{597d}', 2], // U+597D
  ['\u{4e16}', 2], // U+4E16
  ['\u{754c}', 2], // U+754C
  ['\u{ff0c}', 2], // U+FF0C
  ['\u{3002}', 2], // U+3002
  ['\u{ff1a}', 2], // U+FF1A
  ['\u{ff08}', 2], // U+FF08
  ['\u{3011}', 2], // U+3011
  ['\u{2591}', 1], // U+2591
  ['\u{25b8}', 1], // U+25B8
  ['\u{2713}', 1], // U+2713
  ['\u{2717}', 1], // U+2717
  ['\u{26a0}', 1], // U+26A0
  ['e\u{301}', 1], // U+0065 U+0301
  ['a\u{308}', 1], // U+0061 U+0308
  ['\u{e4}', 1], // U+00E4
]);

/** 歧义宽度:**未量**,不是不安全。要用它得先在真终端上量一次。 */
export const NEEDS_TTY_GLYPHS: ReadonlySet<string> = new Set([
  '\u{2588}', // U+2588 · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2593}', // U+2593 · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2592}', // U+2592 · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2581}', // U+2581 · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2584}', // U+2584 · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2580}', // U+2580 · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{258f}', // U+258F · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{258e}', // U+258E · block · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2500}', // U+2500 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2502}', // U+2502 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{250c}', // U+250C · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2510}', // U+2510 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2514}', // U+2514 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2518}', // U+2518 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{251c}', // U+251C · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2524}', // U+2524 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{252c}', // U+252C · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2534}', // U+2534 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2550}', // U+2550 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2551}', // U+2551 · box · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2192}', // U+2192 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2190}', // U+2190 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2191}', // U+2191 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2193}', // U+2193 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{21d2}', // U+21D2 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{25b6}', // U+25B6 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{25cf}', // U+25CF · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{25cb}', // U+25CB · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{25c6}', // U+25C6 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{25c7}', // U+25C7 · arrow · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2014}', // U+2014 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2026}', // U+2026 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{b7}', // U+00B7 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{d7}', // U+00D7 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2605}', // U+2605 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{2606}', // U+2606 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{a7}', // U+00A7 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{b0}', // U+00B0 · ambiguous · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
  '\u{e9}', // U+00E9 · combining · 歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了
]);

/** 确定不用:字体/终端相关,量了也只对这一台机器成立。 */
export const UNSAFE_GLYPHS: ReadonlySet<string> = new Set([
  '\u{2705}', // U+2705 · emoji · emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=2 unicode=2)
  '\u{274c}', // U+274C · emoji · emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=2 unicode=2)
  '\u{1f525}', // U+1F525 · emoji · emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=2 unicode=2)
  '\u{23f3}', // U+23F3 · emoji · emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=2 unicode=2)
  '\u{26a0}\u{fe0f}', // U+26A0 U+FE0F · emoji · emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=2 unicode=1)
  '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}', // U+1F468 U+200D U+1F469 U+200D U+1F467 · emoji · emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=2 unicode=6)
  '\u{1f1f8}\u{1f1ea}', // U+1F1F8 U+1F1EA · emoji · emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=2 unicode=2)
  '\u{e0b0}', // U+E0B0 · nerdfont · Nerd Font 私用区: Unicode 表不知道它多宽, 完全取决于装没装字体
  '\u{f00c}', // U+F00C · nerdfont · Nerd Font 私用区: Unicode 表不知道它多宽, 完全取决于装没装字体
  '\u{f061}', // U+F061 · nerdfont · Nerd Font 私用区: Unicode 表不知道它多宽, 完全取决于装没装字体
  '\u{e725}', // U+E725 · nerdfont · Nerd Font 私用区: Unicode 表不知道它多宽, 完全取决于装没装字体
]);

