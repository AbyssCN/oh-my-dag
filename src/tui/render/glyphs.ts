/**
 * src/tui/render/glyphs —— **字形安全判定**(TUI SDD §7.5.2,切片 S6)。
 *
 * 读数在 `glyph-table.ts`(生成文件);这里只放**怎么用那张表**。
 *
 * ## 为什么需要它:失败模式是崩,不是难看
 *
 * 一行画超宽,pi-tui 的差分渲染会错位,严重时直接把画面顶花。而一个歧义宽度的字形
 * **在本机看着好好的,换台机器就超宽** —— 这类 bug 不会在开发者屏幕上出现一次。
 *
 * ## 四态,不是"能用/不能用"
 *
 * `safe` 已核实 · `needs-tty` 歧义宽度、**这台机器上答不了** ·
 * `unsafe` 字体/终端相关、量了也只对一台机器成立 · `unmeasured` 探针没覆盖到。
 * 后三种都不进 UI 骨架,但**理由不同**,合并之后就再也说不清"要不要去量一下"。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { NEEDS_TTY_GLYPHS, SAFE_GLYPH_WIDTHS, UNSAFE_GLYPHS } from './glyph-table';

export type GlyphVerdict = 'safe' | 'needs-tty' | 'unsafe' | 'unmeasured';

/**
 * 探针的候选集,**按"它为什么可疑"分组**,不是按好看程度。
 *
 * 放在 `src/` 而不是脚本里:分组名就是判定规则的输入(`nerdfont` / `emoji` 两组无论量出
 * 什么都不进 UI 骨架),规则与数据分家会漂。脚本 `scripts/tui-glyph-probe.ts` 只做 IO。
 */
export const GLYPH_CANDIDATES: ReadonlyArray<{ group: string; glyphs: readonly string[] }> = [
  // 基线:这几个必须是 1,量出别的说明尺子本身坏了(探针的自检)
  { group: 'baseline', glyphs: ['a', '0', ' ', '-', '|', '+', '>', '.', ':'] },
  // CJK:HUD 的 goal 标题就是中文,全角标点最容易被算成 1
  { group: 'cjk', glyphs: ['你', '好', '世', '界', '，', '。', '：', '（', '】'] },
  // block 元素:进度条要用,历史上在宽度表里出过 bug
  { group: 'block', glyphs: ['█', '▓', '▒', '░', '▁', '▄', '▀', '▏', '▎'] },
  // box drawing:画框要用
  { group: 'box', glyphs: ['─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '═', '║'] },
  // box drawing 重线/虚线/圆角族:pathfinder 散雾图与 DAG 图的 HTML 稿用的就是这一族
  // (2026-08-08 owner 指出 TUI 视觉与 HTML 稿不一致 —— 降级到轻线是偷懒, 正确做法是量它们)
  { group: 'box-heavy', glyphs: ['━', '┃', '┏', '┓', '┗', '┛', '┣', '┳', '┻', '╋', '┄', '┅', '┆', '┇', '┈', '┉', '┊', '┋'] },
  { group: 'box-round', glyphs: ['╭', '╮', '╰', '╯'] },
  // HTML 稿里的其余构图字形:上横线 ▔ · 空心圆 ◌ · 双圆 ◉ · 指针 ▼ ▲ · 链 ⛓
  { group: 'mock-extra', glyphs: ['▔', '▕', '◌', '◉', '▼', '▲', '⛓'] },
  // 箭头与几何:状态图标的常见候选
  { group: 'arrow', glyphs: ['→', '←', '↑', '↓', '⇒', '▶', '▸', '●', '○', '◆', '◇'] },
  // ⚠ 歧义宽度:CJK locale 下画 2 列,别处画 1 列。**同一字形在两台机器上不一样宽** ——
  //   这一组最阴,因为本机看着好好的。
  { group: 'ambiguous', glyphs: ['—', '…', '·', '×', '✓', '✗', '★', '☆', '⚠', '§', '°'] },
  // emoji / 变体选择符 / ZWJ / 区域指示符:pi-tui CHANGELOG 记过这几类的 bug
  { group: 'emoji', glyphs: ['✅', '❌', '🔥', '⏳', '⚠️', '👨‍👩‍👧', '🇸🇪'] },
  // Nerd Font 私用区:**Unicode 表不知道它多宽**,完全取决于装没装字体
  { group: 'nerdfont', glyphs: ['', '', '', ''] },
  // 组合符:**分解形与预组形是两个不同的探针**,必须都量。
  // ⚠ 一律写成转义:直接写 `'é'` 会被编辑器/工具链的 NFC 归一化**静默换成预组形**,
  //   于是"我以为在量组合符"其实量的是另一个码点。实测撞过一次。
  // ⚠ 而且两者判定真的不同:U+00E9(é)的 EAW 是 A(歧义),U+00E4(ä)是 N(窄)——
  //   这不是 bug,是 Unicode 表本来就这样。
  { group: 'combining', glyphs: ['e\u0301', 'a\u0308', '\u00e9', '\u00e4'] },
];

/**
 * 三套读数 → 一个判定(纯函数,探针的核心规则)。
 *
 * ⚠ **三态不是两态** ——「量了、不安全」与「这台机器上量不到」是两件事,压成一个黑名单
 * 之后就再也分不开:前者永远不该用,后者只是**还没量**。
 * (本仓 `NULL ≠ 0 ≠ 不适用` 那条纪律在读数上的形态。)
 *
 * 判定**顺序**有讲究:字体/终端相关的先判,否则 Nerd Font 私用区会被"歧义宽度"截胡 ——
 * 说明写成一句对的话、指的却是错的原因。
 *
 * @param unicode Unicode EAW 读数;`'A'` = 歧义宽度
 * @param term 真终端实际推进的列数;`null` = **没量到**(不是 0,不是猜的数)
 */
export function decideVerdict(
  group: string,
  pi: number,
  unicode: number | 'A',
  term: number | null,
): { verdict: Exclude<GlyphVerdict, 'unmeasured'>; why: string } {
  if (group === 'nerdfont') {
    return { verdict: 'unsafe', why: 'Nerd Font 私用区: Unicode 表不知道它多宽, 完全取决于装没装字体' };
  }
  if (group === 'emoji') {
    return { verdict: 'unsafe', why: `emoji / VS16 / ZWJ / 区域指示符: 各终端分歧最大 (pi-tui=${pi} unicode=${unicode})` };
  }
  if (term !== null && term !== pi) {
    return { verdict: 'unsafe', why: `真终端画了 ${term} 列, 尺子说 ${pi} 列` };
  }
  if (unicode !== 'A' && pi !== unicode) {
    return { verdict: 'unsafe', why: `两把尺子对不上: pi-tui=${pi} unicode=${unicode}` };
  }
  if (unicode === 'A') {
    // 多数现代终端把歧义宽度画成 1 列 (pi-tui 也按 1 算), 但 CJK locale 下会画 2 列。
    // 本机没有终端模拟器能回答 —— 它既不是"安全"也不是"确定不安全"。
    return term !== null
      ? { verdict: 'safe', why: `歧义宽度, 但真终端量到 ${term} 列且与尺子一致` }
      : {
          verdict: 'needs-tty',
          why: '歧义宽度 (East Asian Width = A): CJK locale 下 2 列、别处 1 列 —— 只有真终端答得了',
        };
  }
  return { verdict: 'safe', why: term !== null ? '三方一致(含真终端)' : '两把尺子一致(真终端未量)' };
}

/** emoji 与符号平面:探针只抽查了几个,但**整片区域**的终端分歧都一样大。 */
const EMOJI_PLANE_START = 0x1f300;
/** 变体选择符 VS16 / 零宽连接符 —— 它们让"一个字形"变成多码点,宽度当场分歧(实测 pi-tui 与 Unicode 表就不一致)。 */
const SEQUENCE_MODIFIERS = new Set(['‍', '️']);

/**
 * 单个字形的判定。
 *
 * ⚠ 顺序:先查明确记过的三张表,再走**兜底规则**。兜底只敢放行两类:
 * ASCII 可打印(所有终端一致)与 `visibleWidth === 2` 的非 emoji 字(CJK 表意/全角,EAW 是 W/F 不歧义)。
 * 其余一律 `unmeasured` —— 没量过就说没量过。
 */
export function classifyGlyph(glyph: string): GlyphVerdict {
  if (UNSAFE_GLYPHS.has(glyph)) return 'unsafe';
  if (NEEDS_TTY_GLYPHS.has(glyph)) return 'needs-tty';
  if (SAFE_GLYPH_WIDTHS.has(glyph)) return 'safe';

  const cp = glyph.codePointAt(0) ?? 0;
  if ([...glyph].some((c) => SEQUENCE_MODIFIERS.has(c))) return 'unsafe';
  if (cp >= EMOJI_PLANE_START) return 'unsafe';
  // 换行是**行分隔符不是字形** —— 多行文案 (如 `/help`、座位表) 本来就该有它,
  // 它不占列、由 Text/ChatLog 折行处理。⚠ 但 **tab 不放行**: 制表位宽度是终端相关的,
  // 那正是 `fitLine` 要把它拍平的原因。
  if (glyph === '\n' || glyph === '\r\n') return 'safe';
  if (cp >= 0x20 && cp < 0x7f) return 'safe';
  if (visibleWidth(glyph) === 2) return 'safe';
  return 'unmeasured';
}

export interface RiskyGlyph {
  glyph: string;
  codepoint: string;
  verdict: Exclude<GlyphVerdict, 'safe'>;
}

/**
 * 扫一段 UI 文案,报出所有**不能安心画**的字形(去重,按首次出现顺序)。
 *
 * 这是 S6 的可执行判据:`glyphs.test.ts` 拿它扫 TUI 的全部 chrome 文案。
 * 第一次跑就抓到了一个真的 —— 头部那个 em dash `—` 是歧义宽度。
 */
export function findRiskyGlyphs(text: string): RiskyGlyph[] {
  const out: RiskyGlyph[] = [];
  const seen = new Set<string>();
  // 按字素簇切:'é'(e + U+0301) 是一个字形, 逐码点看会把组合符当成孤立字符误报。
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (seen.has(segment)) continue;
    seen.add(segment);
    const verdict = classifyGlyph(segment);
    if (verdict === 'safe') continue;
    out.push({
      glyph: segment,
      codepoint: [...segment].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' '),
      verdict,
    });
  }
  return out;
}
