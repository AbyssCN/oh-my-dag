/**
 * src/tui/render/table —— **表格**(TUI SDD §7.5.3,切片 S11;S5 推迟到有消费者的这一片)。
 *
 * ## 这是「同一个坑的第三次出现」
 *
 * §7.5.3 原话:列宽分配**必须用 `visibleWidth` 不能用 `.length`**。HUD 里要显示 goal 与节点名,
 * 都是中文 —— `'节点'.length === 2` 而它占 **4 列**。用 `.length` 算出来的列宽会让每一行
 * 超出分配的格子,整张表错位。
 *
 * 所以这里**一个字符宽度都不自己算**,全走 pi-tui 的 `visibleWidth` / `truncateToWidth`
 * (与 `render/line.ts` 同一把尺子)。三处共用一个函数,不各写各的。
 *
 * ## 分列策略:先按内容要多宽,再按缺口等比削
 *
 * 不做"平均分" —— 平均分会让 `status` 这种 4 列的列拿到 20 列,而节点名被砍成两个字。
 * 削的时候**从最宽的那一列开始削**,因为它最经得起削。
 */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/** 列之间的分隔。两个空格 —— S6 白名单里只有 ASCII 靠得住,竖线也是(`|` 在白名单)。 */
export const COL_SEP = '  ';

/**
 * 渲染一张表。第一行是表头(调用方自己传进 `rows[0]` 与否随意,这里不特殊对待任何一行)。
 *
 * @param rows 每行的单元格。**行内单元格数不齐时按最长的补空**,不抛 ——
 *   一张少一格的表画出来是可读的,而一个异常会把整个 HUD 打掉。
 * @param width 整张表的总列数上限。
 * @returns 每行一个字符串,**每行的可见宽度都 ≤ width**。
 */
export function renderTable(rows: string[][], width: number): string[] {
  if (rows.length === 0 || width <= 0) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols === 0) return rows.map(() => '');

  // ① 每列的天然宽度 = 该列最宽单元格的**可见宽度**(不是 .length —— 见文件头)。
  const natural: number[] = [];
  for (let c = 0; c < cols; c++) {
    natural[c] = Math.max(0, ...rows.map((r) => visibleWidth(r[c] ?? '')));
  }

  // ② 放不下就削,从最宽的列开始 —— 平均削会把窄列削成负数,宽列却还是超。
  const sepTotal = visibleWidth(COL_SEP) * (cols - 1);
  const budget = width - sepTotal;
  const widths = [...natural];
  let over = widths.reduce((a, b) => a + b, 0) - budget;
  while (over > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 0) <= 1) break; // 全削到 1 还放不下 → 下面整行再截一次兜底
    widths[widest] = (widths[widest] as number) - 1;
    over--;
  }

  // ③ 逐格截断 + 右侧补齐。**最后一列不补空格** —— 补了会在行尾留下看不见的空白,
  //    终端里选中复制时带出来一串尾随空格。
  return rows.map((r) => {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const w = widths[c] as number;
      const cell = truncateToWidth(r[c] ?? '', w);
      cells.push(c === cols - 1 ? cell : cell + ' '.repeat(Math.max(0, w - visibleWidth(cell))));
    }
    // 兜底再截一次: ② 里"全削到 1 还放不下"那条路会漏出超宽行。
    return truncateToWidth(cells.join(COL_SEP), width);
  });
}
