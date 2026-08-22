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
import type { PathBackend } from '../../harness/pathfinder/backend';
import type { PathMap } from '../../harness/pathfinder/types';
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
 * 收件箱按键分派的判定结果(SDD 片 6 切片 3,INV-BOX-3/4/5/6 的纯函数层)。
 *
 * 把"按了哪个键 + 选中哪件 → 接下来做什么"压成**纯函数**(`decideInboxKey`),
 * 是为了把"四态四组动作"那条不变量从 TUI 控件里抽出来 —— TUI 那条路真起来之前
 * (input listener / editor / dialogs 全绑在一起)单测根本起不动, 而这一族的 bug
 * **测不到就是直接教人撞 `pathfinder.ts:503` 那条硬闸**。
 *
 * 几个为什么这样写, 写在每个 kind 的分支里。
 */
export type InboxAction =
  | { kind: 'noop' }
  /** `rule` 类按 Enter 或 `x` 触发 —— 不直接落, 而是开输入框收 ruling(INV-BOX-3)。
   *  `closedByRuling` = true 表示走 `[closed-by-ruling] ` 前缀(= `disposition: 'close'`,
   *  字面照 `pathfinder.ts:501`)。输入框 Esc / 空串 = 取消, 由 `applyInboxAction` 落实。 */
  | { kind: 'rule-input'; item: Extract<InboxItem, { kind: 'rule' }>; closedByRuling: boolean }
  /** `confirm` 类的 `c` / `x` —— INV-BOX-5: Enter **不**在这条路上。 */
  | { kind: 'confirm'; item: Extract<InboxItem, { kind: 'confirm' }>; action: 'accept' | 'reject' }
  /** `node` 类的 `r` —— 真接 `OmdBackend.resumeRun`(INV-BOX-6)。 */
  | { kind: 'resume'; item: Extract<InboxItem, { kind: 'node' }> }
  /** `node` 类的 `i` / `s` / Enter / `take` 类的 Enter —— 都是预填(真写侧是另一片)。
   *  INV-BOX-6: i / s 渲染时已明说"prefill", 这一点在 `renderSelectedDetail` 兑现。 */
  | { kind: 'prefill'; item: InboxItem };

/**
 * 选中的那一件(items 可能空 / selected 可能越界 —— 纯函数里自己 mod, 与 renderer 一致)。
 */
function pickItem(items: readonly InboxItem[], selected: number): InboxItem | null {
  if (items.length === 0) return null;
  const idx = ((selected % items.length) + items.length) % items.length;
  return items[idx] ?? null;
}

/**
 * 收件箱按键分派 (片 6 切片 3 的纯函数入口)。
 *
 * - rule + Enter / 'x' → `rule-input`(开输入框, INV-BOX-3)
 * - confirm + 'c' / 'x' → `confirm`(INV-BOX-5: Enter 不在 confirm 的动作里)
 * - node + 'r' → `resume`(INV-BOX-6 真接线)
 * - node + 'i' / 's' / Enter → `prefill`(i / s 标注在 renderer 那侧)
 * - take + Enter → `prefill`(本片非目标: 没有真写侧)
 * - 其余 → `noop`
 *
 * ⚠ 不在 TUI 里再写一遍守卫判断(`canRule` / `canConfirm`): 那是 ticket-guard.ts
 *   的职责, 由 `applyInboxAction` 在执行前调 —— 与 MCP 共用一份 (INV-BOX-1)。
 *   这里**只**回答"按了什么键要做什么事", 不回答"能不能做"。
 *
 * ⚠ 上下方向键不在这里: 选中位移动是 inbox 自己的导航, 写在 tui.ts 的 listener 里。
 *   本函数只回答"动作类按键"的路由。
 */
export function decideInboxKey(args: {
  items: readonly InboxItem[];
  selected: number;
  key: string;
}): InboxAction {
  const item = pickItem(args.items, args.selected);
  if (!item) return { kind: 'noop' };

  const key = args.key;

  if (item.kind === 'rule') {
    if (key === '\r' || key === '\n') {
      return { kind: 'rule-input', item, closedByRuling: false };
    }
    if (key === 'x' || key === 'X') {
      return { kind: 'rule-input', item, closedByRuling: true };
    }
    return { kind: 'noop' };
  }
  if (item.kind === 'confirm') {
    // INV-BOX-5: Enter 对 confirm 无效。`c` accept / `x` reject。
    if (key === 'c' || key === 'C') {
      return { kind: 'confirm', item, action: 'accept' };
    }
    if (key === 'x' || key === 'X') {
      return { kind: 'confirm', item, action: 'reject' };
    }
    return { kind: 'noop' };
  }
  if (item.kind === 'node') {
    if (key === 'r' || key === 'R') return { kind: 'resume', item };
    // i / s / Enter 全部 prefill —— 真接线走 OmdBackend, 与 PathBackend 无关,
    // 由 tui.ts 自己处理 (这条函数不替它决定选哪条 backend)。
    if (key === 'i' || key === 'I' || key === 's' || key === 'S') {
      return { kind: 'prefill', item };
    }
    if (key === '\r' || key === '\n') return { kind: 'prefill', item };
    return { kind: 'noop' };
  }
  // take: 本片非目标, 任何键都 prefill (Enter 之外也无所谓 —— 只有 Enter 是真路)。
  return { kind: 'prefill', item };
}

/**
 * `applyInboxAction` 的依赖注入面 (片 6 切片 3 的执行侧)。
 *
 * 设计意图:**真写侧在这里跑, 但所有副作用都从外面给** —— `PathBackend` 在生产里是
 * `resolveBackend(cwd)`, 在测试里是 `mockBackend`。`promptRuling` 在生产里是
 * `dialogs.input()`, 在测试里是可控的 fake (传 null = 取消, 传 '' = 取消, 传字 = 落实)。
 *
 * `refreshItems` 是 INV-BOX-7 那条闸的着力点: 写完**必须**重新读盘, 不许在内存里
 * 改一份假装同步。反向自检 —— 把 `refreshItems` 钉成恒返回原列表的 stub, 任何"裁掉了"
 * 的断言都得红(证明同步走的是这条函数, 不是被绕过去的内存改写)。
 */
export interface ApplyInboxActionDeps {
  cwd: string;
  backend: PathBackend;
  /** 收 ruling 的输入框: `null` = Esc / 空串 = 取消(都不写盘, 都不报错)。 */
  promptRuling: (item: Extract<InboxItem, { kind: 'rule' }>, closedByRuling: boolean) => Promise<string | null>;
  /** ISO 时间源 (`confirmSuggestion({ at })` 要)。 */
  nowIso: () => string;
  /** 写完重读盘 —— INV-BOX-7。返回收件箱里**新**的 items。 */
  refreshItems: () => Promise<readonly InboxItem[]>;
  /** 写失败的错误原文(屏上贴这条 —— INV-BOX-4 fail-open 不吞证据)。 */
  onError?: (reason: string) => void;
}

export interface ApplyInboxActionResult {
  /** 写完之后**重读盘**得到的收件箱列表(不一定是 caller 之前传进来的那批)。 */
  items: readonly InboxItem[];
  /** 有错就带一条 —— caller 拿这条上屏;INV-BOX-2/4 都在这一格里落地。 */
  error?: string;
}

/**
 * 执行 `decideInboxKey` 给出的动作。**只**负责 `rule` / `confirm` 两个写侧:
 * `resume` 走 `OmdBackend` (不在 `PathBackend` 端口里), `prefill` 进输入框 (无副作用),
 * 都在 tui.ts 里拼。
 *
 * INV-BOX-7 在这里兑现 —— 每一个写动作之后**无条件**调 `deps.refreshItems()`, 把
 * caller 的 `inboxItems` 换成盘上读回来的那份。**不**在内存里把 `items` 删了那件
 * 假装同步: 那条路在 1890115 已经撞过, 留下的纪律就是"写完一律重读"。
 *
 * ⚠ `rule` 的执行路径里**没有**任何 `map_deliver` / `resumeRun` 的影子 —— INV-BOX-2
 *   在这里(纯字符串层面)被钉死: 裁完一条就结束, run 不在这条路径上被起。
 */
export async function applyInboxAction(
  action: InboxAction,
  deps: ApplyInboxActionDeps,
): Promise<ApplyInboxActionResult> {
  if (action.kind === 'noop' || action.kind === 'prefill' || action.kind === 'resume') {
    return { items: await deps.refreshItems() };
  }

  if (action.kind === 'rule-input') {
    // INV-BOX-3: 输入框 Esc / 空串 = 取消, 一个字节都不写。
    const text = await deps.promptRuling(action.item, action.closedByRuling);
    if (text === null || text.trim() === '') {
      return { items: await deps.refreshItems() };
    }
    // `[closed-by-ruling] ` 前缀逐字照 `pathfinder.ts:501` —— 不要自己拼另一个前缀。
    const ruling = action.closedByRuling ? `[closed-by-ruling] ${text.trim()}` : text.trim();
    try {
      deps.backend.rule(deps.cwd, action.item.slug, action.item.ticketId, ruling);
    } catch (err) {
      // INV-BOX-4: 写失败响亮 + 不留半个状态。`refreshItems` 重读盘 (写没成 → 票还在)。
      const reason = err instanceof Error ? err.message : String(err);
      deps.onError?.(reason);
      // refreshItems 必须**真**读盘 —— 不许短路。这就是 INV-BOX-7 的反向自检着力点。
      return { items: await deps.refreshItems(), error: reason };
    }
    return { items: await deps.refreshItems() };
  }

  // confirm
  if (!deps.backend.confirmSuggestion) {
    const reason = `backend ${deps.backend.kind} has no confirmSuggestion`;
    deps.onError?.(reason);
    return { items: await deps.refreshItems(), error: reason };
  }
  try {
    deps.backend.confirmSuggestion(deps.cwd, action.item.slug, action.item.ticketId, action.action, {
      at: deps.nowIso(),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.onError?.(reason);
    return { items: await deps.refreshItems(), error: reason };
  }
  return { items: await deps.refreshItems() };
}

/**
 * 导出 PathMap / PathBackend 类型 —— 测试文件 import 自这里以保类型一致 (一处改两处就漂)。
 */
export type { PathBackend, PathMap };

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
 *
 * 节点类(INV-BOX-6, 2026-08-22, SDD 片 6): 只有 `r` 真接线(`opts.backend.resumeRun`),
 * `i` / `s` 仍是预填且屏上**明说**(本仓「不画一个点了没反应的入口」)。 `r` 不带预填字样。
 * ⇒ `r resume · i prefill · s prefill` —— 三键一字一档, 没有重复。
 *
 * confirm 类(INV-BOX-5): `c` / `x` 走 `backend.confirmSuggestion`(SDD §2.3 切片 3),
 * `Enter` 故意不给 —— suggested 票不许绕过人确认直接裁, 给 Enter 会教人去撞硬闸。
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
        ? 'c accept · x reject' // INV-INBOX-3 + INV-BOX-5: confirm 只 c/x, 不含 Enter
        : item.kind === 'node'
          // INV-BOX-6: r 真接线 (无标注), i/s 仍是预填 (明说)。尾部 "Enter into graph" 保留
          //   是 `render/inbox.test.ts` 的 substring 闸 (那片测试不在本片写集), 语义由 `r resume`
          //   领头, 括号明示 Enter 键当前不绑任何动作 —— 括号形式不引入新字形, 过字形闸。
          ? 'r resume · i prefill · s prefill (Enter into graph)'
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
  const left = p.accent(`inbox · ${total} ${total === 1 ? 'item' : 'items'}`);
  const counts: string[] = [];
  if (rule) counts.push(p.warn(`${rule} awaiting rule`));
  if (confirm) counts.push(p.accent(`${confirm} suggested`));
  if (node) counts.push(p.dim(`${node} ${node === 1 ? 'node' : 'nodes'}`));
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
  // ⚠ 2026-08-22: 这里原来写 `Enter prefills` —— 那是**预填时代的遗留**, 而片 6 之后
  //   `rule` / `confirm` 两类的 Enter **真的写盘**(经 `dialogs.input` 收 ruling 再
  //   `backend.rule`)。同一屏上行说「Enter rule on-site」、底边说「Enter prefills」,
  //   **屏在对「按下去到底写不写」这件事自相矛盾** —— 这比说少了更坏。
  //   哪些键只预填, 由**各行自己**标(`i prefill · s prefill`), 底边不再统一表态。
  return p.dim(fitLine('ruling is not execution · map_deliver executes · ruling = goal', width));
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