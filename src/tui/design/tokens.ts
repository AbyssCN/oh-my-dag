/**
 * src/tui/design/tokens —— **边框族**(TUI 重建 plan P1;2026-08-08)。
 *
 * ## 这一片只管"框线长什么样",不管颜色
 *
 * 颜色已经有真源了(`src/tui/theme.ts` 的 `chrome.*` 语义色)。**不在这里再开一处** ——
 * 两处色源是本仓最容易静默漂移的形状。这里只回答一件事:
 * **画一条线 / 一个卡片框的时候,用哪几个字符。**
 *
 * ## 为什么值得单独一片(以及它其实是个小活)
 *
 * P0 初稿说"框线字形散在 14/47 个文件里",**那个数是错的** —— 它把
 * `// ── 座位 ────────` 这种**注释分隔线**也算成了画框。去掉注释重量:真正在代码里
 * 画框的是 6 个,其中 `glyphs.ts`(字形真源)、`path-fog.ts`(雾场画布)、
 * `dag-tree.ts`(树形)**本职就是画图**,不该被收编。
 *
 * ⇒ 真消费者只有三处,就是本片存在的全部理由:
 * - `components/dialog.ts` —— 卡片框
 * - `approval/card.ts` —— 详情分隔线
 * - `components/chat-log.ts` —— 回合分界线(它写的是 `'─'`,转义形,
 *   所以前面两次用字面量扫的时候**都没扫到它** —— 记一笔:扫字形要连转义一起扫)
 *
 * **没有第四个消费者之前,不要往这里加第四组常量。** 本仓可达性纪律:
 * 没消费者的东西不先加(`theme.ts:44-49` 是同一条)。
 *
 * ## 字形都在白名单里
 *
 * `─│┌┐└┘` 六个全部是 `render/glyph-table.ts` 里 owner 真终端量过的 safe 档,
 * 宽度 1。**换字符前先过探针**,别凭"看起来像"就换重线族。
 */

/** 卡片/分隔线用的六个字形。全部 safe 档、宽度 1。 */
export const BORDER = {
  /** 横线 */
  h: '─',
  /** 竖线 */
  v: '│',
  /** 左上 */
  tl: '┌',
  /** 右上 */
  tr: '┐',
  /** 左下 */
  bl: '└',
  /** 右下 */
  br: '┘',
} as const;

/**
 * 一条整行分隔线。
 *
 * `width` 小于 1 时给空串 —— 窄屏下 `repeat(负数)` 会抛,而一条画不下的线不值得让 UI 崩。
 */
export function rule(width: number): string {
  return width > 0 ? BORDER.h.repeat(width) : '';
}

/**
 * 卡片框三件。`width` 是**整框外宽**,`innerWidth = width - 4`
 * (左右各一个竖线 + 一个空格)。
 *
 * 标题由调用方先截好 —— 这里不做截断,因为截断要认 CJK 宽度,那是 `render/line` 的活,
 * 在这里再实现一遍就是第二处真源。
 */
export const card = {
  /** `┌─ 标题 ────┐`;`titleWidth` 传标题的**可见宽度**(不是 `.length`)。 */
  top(title: string, width: number, titleWidth: number): string {
    return `${BORDER.tl}${BORDER.h} ${title} ${rule(Math.max(0, width - titleWidth - 5))}${BORDER.tr}`;
  },
  /** `│ 内容 │`;`pad` 由调用方按可见宽度算好。 */
  side(line: string, pad: number): string {
    return `${BORDER.v} ${line}${' '.repeat(Math.max(0, pad))} ${BORDER.v}`;
  },
  /** `└────┘` */
  bottom(width: number): string {
    return `${BORDER.bl}${rule(Math.max(0, width - 2))}${BORDER.br}`;
  },
} as const;
