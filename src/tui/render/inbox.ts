/**
 * src/tui/render/inbox —— **收件箱渲染器**(SDD 片 5 切片 2)。
 *
 * 唯一回答「现在轮到我做什么」的屏 —— `Ctrl+I` 开关。
 *
 * ## 四态四组动作(不要合并)
 *
 * | kind     | 标记 | 真源层                              | 选中展开          | 画错的代价              |
 * |----------|------|-------------------------------------|-------------------|-------------------------|
 * | rule     | ⚠    | `readAttention().awaiting` (票)     | `Enter 就地裁`    | 派活撞硬闸              |
 * | confirm  | ?    | `readAttention().suggested` (票)    | `c 收件 / x 退回` | 教人去撞 `pathfinder.ts:503` 那条硬闸 |
 * | node     | ·    | 活图里 `await` 节点                 | `Enter 进图`      | 把它当 ticket 派活      |
 * | take     | ↑    | 产物待收 (delivered 未 ack)         | `Enter 收件`      | 直接 `map_deliver` (那是执行) |
 *
 * 合并/串味 = 把硬闸撞穿(实测那张判词是这条路)。
 *
 * ## 底边常驻一句话(教育性 invariant)
 *
 * INV-INBOX-1/2 钉死:**屏上每一轮都得念**「裁决不等于执行 · map_deliver 才执行 · ruling 即 goal」 ——
 * 收件箱是唯一回答「该做什么」的地方,不念就丢。
 *
 * ## 主行带 id(可引用)
 *
 * 选中展开才出 `#226` 在对话里没法引用 —— 主行就把 id 写在状态标记后、标题前:
 *   `▸ ? 226 机器建议:…`。这样在对话里直接说「226 票」就能指向同一件。
 *
 * ## 表头分隔符单空格 / 空态跳过表头
 *
 * `4 件 1 等裁 ·  1 建议 ·  1 节点` 是「list join with ` · `」叠 leading-space count 的味道 ——
 * count 不再带 leading space, left 与 counts 间手动加 1 空格, `·` 前后就只剩各 1 空格。
 *
 * `收件箱 · 0 件` 是「画 0」, 空仓直接跳过表头, 只留那句真话与底边。
 *
 * ## 不读盘(纯函数)
 *
 * 与 `run-list` / `now-band` 同款 —— 取数在 `tui.ts`,复用 `refreshTicketBoard` 的时机;
 * render 回路里**不**再走一次盘(本仓 D-12 ②)。
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import { fitLine } from './line';

/** 色道钩子, 与 `DagPaint` / `FogPaint` 同形但精简 —— 注入式, 省略 = 恒等 (NO_COLOR / 测试)。 */
export interface InboxPaint {
  accent(s: string): string;
  dim(s: string): string;
  warn(s: string): string;
  sel(s: string): string;
}
const PLAIN: InboxPaint = {
  accent: (s) => s,
  dim: (s) => s,
  warn: (s) => s,
  sel: (s) => s,
};

/**
 * 收件箱里的一件。`kind` 四态,字段**故意不平**:
 *   - `rule` / `confirm` / `take` 来自 pathfinder 票,定位用 `slug + ticketId`;
 *   - `node` 是另一个概念层(活图里的 await 节点),定位用 `runId + nodeId`。
 * 合并就再也分不清「哪些走 map_* / 哪些走预填」 —— 本片存在的一半理由就是这条分叉。
 */
export type InboxItem =
  | { kind: 'rule'; slug: string; ticketId: string; title: string; stale?: boolean }
  | { kind: 'confirm'; slug: string; ticketId: string; title: string; stale?: boolean }
  | { kind: 'node'; runId: string; nodeId: string; title: string; stale?: boolean }
  | { kind: 'take'; slug: string; ticketId: string; title: string; stale?: boolean };

/**
 * 四态四字形。`rule = ⚠` 由 INV-5 钉死(等你 = ⚠);
 * 其余三者各自独立、互不串味 —— 串味就违反 INV-INBOX-3 的「confirm 只能走 c/x」。
 *
 * 字形全部在 `glyph-table.ts` 的 `SAFE_GLYPH_WIDTHS` 白名单里 (U+26A0 / U+003F / U+00B7 / U+2191),
 * `findRiskyGlyphs` 扫不出。
 */
export const INBOX_MARK: Record<InboxItem['kind'], string> = {
  rule: '⚠',
  confirm: '?',
  node: '·',
  take: '↑',
};

const W_SEL = 2; // `▸ ` / `  `
const W_MARK = 2; // `⚠ ` / `? ` / `· ` / `↑ `
const STALE_TXT = '✗ STALE '; // 长 7 + 1 空格 = 8

/** 主行 id 列 —— rule/confirm/take 是 ticketId(node 走 runId 前 8 + `/` + nodeId)。 */
const mainIdOf = (item: InboxItem): string =>
  item.kind === 'node'
    ? `${item.runId.slice(0, 8)}/${item.nodeId}`
    : item.ticketId;

/** 截断补 `…`;只用于标题列,正文(展开行)不走这条。CJK 列宽由 `visibleWidth` 算。 */
const clip = (text: string, cols: number): string => {
  if (cols <= 0) return '';
  if (visibleWidth(text) <= cols) return text;
  if (cols === 1) return '…';
  let out = '';
  for (const ch of text) {
    if (visibleWidth(out + ch) > cols - 1) break;
    out += ch;
  }
  return out + '…';
};

/** 该项的主色道 —— 选中不走这条(整行走 sel)。 */
const paintOf = (item: InboxItem, p: InboxPaint): ((s: string) => string) => {
  if (item.kind === 'rule' || item.kind === 'take') return p.warn;
  if (item.kind === 'confirm') return p.accent;
  return p.dim; // node
};

/**
 * 选中行的就地展开: ID + 动作提示。INV-INBOX-3 在第二行上钉死。
 *
 * **不重复标题**: 主行已是全标题, 展开再印一遍就是废字, 而且让「主行带 id」读起来双倍。
 * 展开只留 id + 动作, 标题只在主行里出现一次。
 */
function renderSelectedDetail(item: InboxItem, width: number, p: InboxPaint): string[] {
  const indent = '  '.repeat(2); // 对齐主行 marker (W_SEL + W_MARK = 4 → 视觉 4 个 space)
  const idStr =
    item.kind === 'node'
      ? `${item.runId.slice(0, 8)}/${item.nodeId}`
      : `#${item.ticketId}`;
  // 四态四组动作 —— 不要合并(SDD §2.2 钉死)。
  const hint =
    item.kind === 'rule'
      ? 'Enter rule on-site'
      : item.kind === 'confirm'
        ? 'c accept · x reject' // INV-INBOX-3: confirm must not contain 'Enter rule on-site'
        : item.kind === 'node'
          ? 'Enter into graph'
          : 'Enter accept';
  return [
    p.dim(fitLine(`${indent}${idStr}`, width)),
    p.dim(fitLine(`${indent}${hint}`, width)),
  ];
}

/** 画一行。选中 → 整行 sel;否则各段走自己的色道(marker + stale + id 走相位色, 标题走 dim)。 */
function renderRow(item: InboxItem, selected: boolean, width: number, p: InboxPaint): string {
  const selMark = selected ? '▸ ' : '  ';
  const mark = INBOX_MARK[item.kind] + ' ';
  const staleStr = item.stale ? STALE_TXT : '';
  const idStr = mainIdOf(item);
  const title = item.title;
  // 标题可用列 = 总宽 - 选择标记 - 状态标记 - stale - 1(id 前的空格) - id 列宽。
  const titleCols = Math.max(
    0,
    width - (W_SEL + W_MARK + visibleWidth(staleStr) + 1 + visibleWidth(idStr)),
  );
  const titleClip = clip(title, titleCols);
  const line = `${selMark}${mark}${staleStr}${idStr} ${titleClip}`;
  if (selected) return p.sel(fitLine(line, width));
  // 非选中: marker + stale + id 走相位色, 标题走 dim。
  const head = `${selMark}${mark}${staleStr}${idStr} `;
  return fitLine(paintOf(item, p)(head) + p.dim(titleClip), width);
}

/** 头行 + 右侧按 kind 分计。0 省略 —— 「0 件」与「列表空」不同, 后者走空分支(不画表头)。 */
function renderHeader(items: readonly InboxItem[], width: number, p: InboxPaint): string {
  let rule = 0;
  let confirm = 0;
  let node = 0;
  let take = 0;
  for (const it of items) {
    if (it.kind === 'rule') rule++;
    else if (it.kind === 'confirm') confirm++;
    else if (it.kind === 'node') node++;
    else take++;
  }
  const total = items.length;
  const left = p.accent(`inbox · ${total} items`);
  const counts: string[] = [];
  if (rule) counts.push(p.warn(`${rule} awaiting rule`));
  if (confirm) counts.push(p.accent(`${confirm} suggested`));
  if (node) counts.push(p.dim(`${node} nodes`));
  if (take) counts.push(p.dim(`${take} unreceived`));
  if (counts.length === 0) return fitLine(left, width);
  // 分隔符单空格 —— count 不带 leading space(否则 `·  X` 看着是双空格)。
  return fitLine(left + ' ' + counts.join(p.dim(' · ')), width);
}

/**
 * 底边常驻一句话。INV-INBOX-1 钉「裁决不等于执行 + map_deliver」,
 * INV-INBOX-2 钉「ruling + goal」 —— 四件全在同一条线里。
 * 字面用全 ASCII + 中文字词, 不撞 `glyphs.test.ts` 的 chrome 字形闸。
 */
function renderFooter(width: number, p: InboxPaint): string {
  return p.dim(
    fitLine('ruling is not execution · Enter prefills · map_deliver executes · ruling = goal', width),
  );
}

/** 折叠高度溢出:头 kept + 「… N more」 + 尾 3 (footer 贴底)。 */
const clampHeight = (out: string[], height: number, width: number, p: InboxPaint): string[] => {
  if (out.length <= height) return out;
  if (height <= 3) return out.slice(0, height);
  const tail = out.slice(-3);
  const kept = Math.max(0, height - tail.length - 1);
  return [...out.slice(0, kept), p.dim(fitLine(`… ${out.length - height + 1} more`, width)), ...tail];
};

/**
 * 收件箱渲染器。
 *
 * @param items        收件箱里的待办 (`InboxItem` 四态, 见类型定义)
 * @param o.width      屏宽(可见列, CJK = 2)
 * @param o.height     屏高;超出 → 头 kept + 「… N more」 + 尾 3 (footer 贴底)
 * @param o.selected   当前选中索引(负数 / 超界 → 自动 mod)
 * @param o.now        当前 ms(注入, 防 `Date.now()` 跑单测时漂移;本片暂未用,
 *                     留位给未来的「N 秒前」类显示)
 * @param o.paint      色道钩子;省略 = 恒等(NO_COLOR 与测试)
 */
export function renderInbox(
  items: readonly InboxItem[],
  o: { width: number; height: number; selected: number; now: number; paint?: InboxPaint },
): string[] {
  const p = o.paint ?? PLAIN;
  const width = o.width;
  const len = items.length;
  // 空仓: 那句真话 + 底边 —— 底边 invariant 是教育性的, 空仓也念。
  // 表头那个 `0 件` 是「画 0」, 空仓直接跳过表头。
  if (len === 0) {
    const out: string[] = [
      p.dim(fitLine('(empty · no tickets / graphs / artifacts waiting)', width)),
      renderFooter(width, p),
    ];
    return clampHeight(out, o.height, width, p);
  }
  const out: string[] = [renderHeader(items, width, p)];
  const sel = ((o.selected % len) + len) % len;
  for (let i = 0; i < len; i++) {
    out.push(renderRow(items[i]!, i === sel, width, p));
    if (i === sel) out.push(...renderSelectedDetail(items[i]!, width, p));
  }
  out.push(renderFooter(width, p));
  return clampHeight(out, o.height, width, p);
}