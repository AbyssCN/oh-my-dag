/**
 * src/tui/render/bar —— **进度条**(TUI SDD §7.5.3,切片 S11;S5 推迟到有消费者的这一片)。
 *
 * ## 只用白名单里的字形
 *
 * S6 初版这里是 ASCII `#` / `-`:block 元素是歧义宽度(EAW = A),CJK locale 画 2 列、
 * 别处 1 列,**没量过真终端之前不敢用**。
 *
 * 2026-08-07 真终端读数进表(`glyph-table.ts` 的 `GROUND_TRUTH = true`,量于 Windows Terminal +
 * JetBrainsMono Nerd Font Mono):那 43 个歧义字形实测**全是 1 列、与 pi-tui 一致** ——
 * `█ ░` 于是进了白名单,这里换成它们。
 *
 * ⚠ **换字形的前提是那条读数,不是好看。** `bar.test.ts` 有一条闸钉住
 * "用到的字形必须在 `SAFE_GLYPH_WIDTHS` 里" —— 表要是回到没量过的状态,这里当场红。
 *
 * ⚠ 别拿 `src/hud/fog.ts` 的 `fogBar` 来用:那一条是给 statusline 的,statusline 跑在**用户自己
 * 配好的**终端里,而 TUI 要对任意终端负责。两处判据不同,不是重复。
 */
import { visibleWidth } from '@earendil-works/pi-tui';

/** 已完成 / 未完成的填充字符。**必须都在 `SAFE_GLYPH_WIDTHS` 里**(闸在 `table.test.ts`)。 */
export const BAR_DONE = '█';
export const BAR_TODO = '░';

/**
 * `[####------] 4/10` 形状的一行进度条。
 *
 * @param width **整行**的总列数上限(含方括号与右边的计数),不是条子本身的宽度。
 *   调用方给的是"这一行能占多宽",让它自己去分配 —— 反过来每个调用点都得算一遍减法。
 *
 * 边界都按"画得出来"处理,不抛:
 *  - `total <= 0` → 空条 + `0/0`(**没有节点**与"一个都没跑完"是两回事,后者会显示 `0/N`);
 *  - `done > total` → 夹到 total(读数错了应该在上游修,UI 这里不许画出 `11/10` 这种自相矛盾);
 *  - 窄到放不下 → 优先保住计数,条子可以缩到 0 格。
 */
export function renderBar(done: number, total: number, width: number): string {
  const t = Math.max(0, Math.trunc(total));
  const d = Math.min(Math.max(0, Math.trunc(done)), t);
  const label = `${d}/${t}`;
  // 2 = 一对方括号; 1 = 方括号与计数之间的空格。
  const inner = width - visibleWidth(label) - 3;
  if (inner <= 0) return label.slice(0, Math.max(0, width));
  const filled = t === 0 ? 0 : Math.round((d / t) * inner);
  return `[${BAR_DONE.repeat(filled)}${BAR_TODO.repeat(inner - filled)}] ${label}`;
}
