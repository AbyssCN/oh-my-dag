/**
 * src/tui/render/line —— **单行渲染的唯一入口**(TUI SDD §4.1 第 2 条,切片 S5)。
 *
 * ## 为什么单行要有专门一条路
 *
 * pi 的 `Text` 组件是**折行**的(实读 `components/text.js:55` 走 `wrapTextWithAnsi`),
 * 对正文那是对的。但状态行不能折:头部一折,下面所有东西的行号就整体下移一行,
 * 而 HUD 是按行差分画的 —— 结果是**布局错位**,不是"多了一行"。
 * 所以状态行走 truncate 不走 wrap,这两种行为必须在代码里分得开。
 *
 * ## 宽度只有一个算法(§7.5.3 那条"同一判据散成三份必然漂移")
 *
 * 宽度与截断**一律**用 pi-tui 的 `visibleWidth` / `truncateToWidth`,不自己写第二套。
 * ⚠ 这不只是省事:Rich 那条路被否掉的理由之一正是"两套宽度算法打架"。
 * 自己再写一个 `.length` 版本会在 CJK 上当场对不上。
 */
import { truncateToWidth } from '@earendil-works/pi-tui';

/** 单行槽位里的换行/制表符 —— 见 {@link fitLine} 的说明,必须先拍平。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要匹配这些控制符
const LINE_BREAKERS = /[\r\n\t\v\f]+/g;

/**
 * 把任意文本塞进**恰好一行、不超过 `width` 列**。
 *
 * 两步,顺序重要:
 *  ① 先把换行/制表符拍成空格 —— ⚠ **实测 `truncateToWidth('a\nb', 5)` 原样返回 `'a\nb'`**,
 *     它只管宽度不管换行。一个混进状态行的 `\n` 会让这一"行"变成两行,
 *     而宽度检查还是过的 —— 一个**闸绿着的布局错位**。
 *  ② 再按可见宽度截断(CJK 算 2 列,ANSI 不计宽)。
 *
 * `width <= 0` 返回空串:窄到没有可画的地方时,画不出东西是对的,报错不是。
 */
export function fitLine(text: string, width: number, ellipsis = '...'): string {
  if (width <= 0) return '';
  return truncateToWidth(text.replace(LINE_BREAKERS, ' '), width, ellipsis);
}
