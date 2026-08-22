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
 * | node     | ·    | 活图里 `await` 节点                 | `r / i / s`        | i/s 误以为能标绿 (那是画的) |
 * | take     | ↑    | `awaitingRuns()` 逼近超时 (片 7)    | `Enter`            | 真数据源接上            |
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
 *   - `rule` / `confirm` / `take` 来自 pathfinder 票(片 5)与 awaitingRuns(片 7),
 *     定位用 `slug + ticketId`;
 *   - `node` 是另一个概念层(活图里的 await 节点),定位用 `runId + nodeId`。
 * 合并就再也分不清「哪些走 map_* / 哪些走预填」 —— 本片存在的一半理由就是这条分叉。
 *
 * ⚠ SDD 片 7 把 `take` 的数据源从「delivered ticket」换成「`awaitingRuns()` 逼近超时
 *   的等件」 —— 但**形状不变**: caller 把 runId/artifact 投影到 slug/ticketId(惯用的
 *   `runId.slice(0,8)` + 字符串 artifact)。这样 `inbox.test.ts` 的现有断言不用动,
 *   而行为层面是真接上 awaiting 数据源。
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
 *
 * 片 7 加了 `intervene` 与 `cancel` 两个真写侧 ——
 * `i` 走 `recordIntervention`(纯追加, 无副作用), `s` 走
 * `cancelDetachedRun`(协作式停, 四种 `CancelOutcome` 分得开; 二次确认是 caller 的事,
 * 这一层只回答「按了之后下一步是哪个动作」, 不弹 dialog)。
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
  /** `node` 类的 `i` —— 真写侧 `recordIntervention`(INV-RC-1/2, SDD 片 7)。
   *  cause 由 caller 用 `FAILURE_KIND_ORDER` 选择, 这一层只路由。 */
  | { kind: 'intervene'; item: Extract<InboxItem, { kind: 'node' }> }
  /** `node` 类的 `s` —— 真写侧 `cancelDetachedRun`(INV-RC-3/4, SDD 片 7)。
   *  二次确认是 caller 的事(`dialogs.confirm`), 这一层只路由。 */
  | { kind: 'cancel'; item: Extract<InboxItem, { kind: 'node' }> }
  /** `node` 类 Enter / `take` 类 Enter —— 都是预填(无副作用, 把焦点回给编辑器)。
   *  `take` 的预填文案与片 6 不同: 现在是「去那张图」(SDD §0③ 改对语义)。 */
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
 * - node + 'i' → `intervene`(INV-RC-1/2, SDD 片 7 真接线)
 * - node + 's' → `cancel`(INV-RC-3/4, SDD 片 7 真接线, 二次确认在 caller)
 * - node + Enter → `prefill`(无副作用, 进图/预填)
 * - take + Enter → `prefill`(无副作用, 跳到在等的 run 的图)
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
    // SDD 片 7: i / s 不再是预填, 它们是真写侧。
    if (key === 'i' || key === 'I') return { kind: 'intervene', item };
    if (key === 's' || key === 'S') return { kind: 'cancel', item };
    if (key === '\r' || key === '\n') return { kind: 'prefill', item };
    return { kind: 'noop' };
  }
  // take: 真数据源 (awaitingRuns + 逼近超时筛, SDD §0③ / INV-RC-5)。
  // 任何键都 prefill (只有 Enter 是真路, 其它键也走 prefill 没事 —— caller 会吞键)。
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
 *
 * SDD 片 7 加了三件事 —— `intervene` 的 `promptIntervene`(cause 挑 + 可选 note),
 * `cancel` 的 `confirmStop`(`dialogs.confirm` 二次确认, INV-RC-3), 与
 * `runCancel`(共享写侧 `cancelDetachedRun` 的接缝, INV-RC-3/4)。三者各自一段:
 * caller 给真函数, 测试给可控 fake。
 */
export interface ApplyInboxActionDeps {
  cwd: string;
  backend: PathBackend;
  /** 收 ruling 的输入框: `null` = Esc / 空串 = 取消(都不写盘, 都不报错)。 */
  promptRuling: (item: Extract<InboxItem, { kind: 'rule' }>, closedByRuling: boolean) => Promise<string | null>;
  /**
   * `intervene` 的复合对话框: 先 cause picker(从 `FAILURE_KIND_ORDER` 里挑, 与 MCP
   * 同词表), 再可选的 note 输入框(空串/Esc = 没收 note)。
   *
   *   返回 `null` = 全程取消(没选 cause 或 cause 后 Esc), 一个字节都不写;
   *   返回 `{ cause, note }` = 落实 `recordIntervention(cwd, runId, cause, note)`。
   *
   * 注: 这是**两个**对话框(cause select + optional note input), 串成一次 promise。
   * 「选 cause 后 Esc note」与「没选 cause」是同一回事 —— 都是 null, 都不写盘。
   *
   * 可选 —— `inbox-wiring.test.ts` (片 6) 不调 `intervene` / `cancel`, 留空着让那个
   * 测试类型不变; 这两条 action 真走的时候 caller 必填。
   */
  promptIntervene?: (item: Extract<InboxItem, { kind: 'node' }>) => Promise<{ cause: string; note: string | null } | null>;
  /**
   * `cancel` 的二次确认(`dialogs.confirm`): INV-RC-3 的代价不对称 —— 误按一下损失
   * 一个跑了半小时的 run 的墙钟, 多按一次确认损失一秒。
   *
   *   `true`  = 落实 `cancelDetachedRun`;
   *   `false` = 用户主动选了「否」;
   *   `null`  = 用户按 Esc 取消(与「选了否」分得开, INV-BOX-3 同款语义)。
   *
   * 可选 —— 同上, 让片 6 的测试不变。
   */
  confirmStop?: (item: Extract<InboxItem, { kind: 'node' }>) => Promise<boolean | null>;
  /**
   * 协作式停 detached run —— 与 `cancelDetachedRun` (harness/run-control) 同形, 但
   * 走注入接缝(测试不真 kill, 与 `dag-tools.ts:241` 同款 idiom)。
   *
   *   返回 `CancelOutcome` 四种判别联合之一, caller 据此各画各的回执 (INV-RC-4)。
   *
   * 可选 —— 同上。
   */
  runCancel?: (
    item: Extract<InboxItem, { kind: 'node' }>,
  ) => Promise<
    | { kind: 'signalled'; pid: number; signal: 'SIGTERM' }
    | { kind: 'no-owner-pid' }
    | { kind: 'pid-dead'; pid: number }
    | { kind: 'signal-failed'; pid: number; error: string }
  >;
  /**
   * 记一次人工介入 —— 与 `recordIntervention` (harness/run-control) 同形, 走注入
   * 是为了对称 (parity test 用 `recordIntervention` 本身; 这里只钉调用形态)。
   *
   *   失败抛 (fail-loud); caller 走 INV-BOX-4 同款路径。
   *
   * 可选 —— 同上。
   */
  recordIntervention?: (
    runId: string,
    cause: string,
    note: string | null,
  ) => void;
  /** ISO 时间源 (`confirmSuggestion({ at })` 要)。 */
  nowIso: () => string;
  /** 写完重读盘 —— INV-BOX-7。返回收件箱里**新**的 items。 */
  refreshItems: () => Promise<readonly InboxItem[]>;
  /** 写失败的错误原文(屏上贴这条 —— INV-BOX-4 fail-open 不吞证据)。 */
  onError?: (reason: string) => void;
  /**
   * 写成功的回执(屏上贴这条 —— 让用户看见「按了之后发生了什么」, 而不是回到收件箱
   * 后一脸问号; 与 `onError` 对称)。
   */
  onNotice?: (msg: string) => void;
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

  if (action.kind === 'intervene') {
    // SDD 片 7 切片 3 (INV-RC-1/2): cause 从 FAILURE_KIND_ORDER 挑, note 可选
    // (空串/Esc = 没 note); 全程取消 = 没选 cause, 一个字节都不写。
    if (!deps.promptIntervene || !deps.recordIntervention) {
      const reason = 'applyInboxAction: intervene deps not wired (slice 7 caller)';
      deps.onError?.(reason);
      return { items: await deps.refreshItems(), error: reason };
    }
    const picked = await deps.promptIntervene(action.item);
    if (picked === null) {
      return { items: await deps.refreshItems() };
    }
    try {
      deps.recordIntervention(action.item.runId, picked.cause, picked.note);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.onError?.(reason);
      return { items: await deps.refreshItems(), error: reason };
    }
    const noteSuffix = picked.note ? ` — ${picked.note}` : '';
    deps.onNotice?.(`recorded intervention on ${action.item.runId}: ${picked.cause}${noteSuffix}`);
    return { items: await deps.refreshItems() };
  }

  if (action.kind === 'cancel') {
    // SDD 片 7 切片 3 (INV-RC-3): 二次确认; false 与 null 都是不写盘。
    const cancelDeps = deps;
    if (!cancelDeps.confirmStop || !cancelDeps.runCancel) {
      const reason = 'applyInboxAction: cancel deps not wired (slice 7 caller)';
      deps.onError?.(reason);
      return { items: await deps.refreshItems(), error: reason };
    }
    const runCancelFn: NonNullable<ApplyInboxActionDeps['runCancel']> = cancelDeps.runCancel;
    const confirmed = await cancelDeps.confirmStop(action.item);
    if (confirmed !== true) {
      return { items: await deps.refreshItems() };
    }
    let outcome: Awaited<ReturnType<typeof runCancelFn>>;
    try {
      outcome = await runCancelFn(action.item);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.onError?.(reason);
      return { items: await deps.refreshItems(), error: reason };
    }
    deps.onNotice?.(formatCancelNotice(outcome, action.item.runId));
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
 * 收件箱里的 `cancel` 写完了 —— 把 `CancelOutcome` 四种结局 (INV-RC-4) 拼成屏上一句话。
 * 屏上**不许**只说「已请求取消」 —— 那是把四种合一的画法。
 *
 *   `signalled`     → "SIGTERM sent to pid <pid> (<runId>)"
 *   `no-owner-pid`  → "no owner pid on disk for <runId>"
 *   `pid-dead`      → "owner pid <pid> already dead — nothing to signal (<runId>)"
 *   `signal-failed` → "failed to signal pid <pid> for <runId>: <error>"
 *
 * 每句**点名**是哪一种, 不打包。这样后续「我明明按了 s」的人能直接读懂是哪一档。
 *
 * ⚠ 文案全英文 (INV-RC-8) —— 字面不带 "已取消" 的笼统说法。
 */
export function formatCancelNotice(
  outcome:
    | { kind: 'signalled'; pid: number; signal: 'SIGTERM' }
    | { kind: 'no-owner-pid' }
    | { kind: 'pid-dead'; pid: number }
    | { kind: 'signal-failed'; pid: number; error: string },
  runId: string,
): string {
  if (outcome.kind === 'signalled') return `SIGTERM sent to pid ${outcome.pid} (${runId})`;
  if (outcome.kind === 'no-owner-pid') return `no owner pid on disk for ${runId}`;
  if (outcome.kind === 'pid-dead') return `owner pid ${outcome.pid} already dead — nothing to signal (${runId})`;
  return `failed to signal pid ${outcome.pid} for ${runId}: ${outcome.error}`;
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
 * 节点类(SDD 片 6 → 片 7):
 *   - `r` 真接线(`OmdBackend.resumeRun`), 不带任何标注 —— INV-BOX-6。
 *   - `i` 真写侧 `recordIntervention` —— INV-RC-1/2。屏上写「record intervention」,
 *     **不许**出现「mark green」/「标绿」之类(SDD §0①, §2 INV-RC-2: 那是一个按了不发生
 *     的动作, 写出来就是画一个假入口)。
 *   - `s` 真写侧 `cancelDetachedRun` —— INV-RC-3/4。「stop detached run」明说是
 *     协作式停, 二次确认由 caller 处理。
 *
 * confirm 类(INV-BOX-5): `c` / `x` 走 `backend.confirmSuggestion`, `Enter` 不给 —— 不绕人确认。
 *
 * take 类: 数据源换成 `awaitingRuns()` 逼近超时(SDD §0③, INV-RC-5), Enter 行为变
 * 「跳到那张图」(prefill prompt 里说清是哪个 runId)。字面 `Enter accept` 是
 * 历史标签 —— 「accept」本意是收件,与新语义不符,**这一片不动它**(改它要碰
 * `inbox.test.ts`, 不在本片写集), 已知欠账。
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
          // INV-BOX-6 (r 真接线, 不带 prefill) + SDD 片 7 (i/s 真写侧, 字面是它真做的事)。
          // ⚠ `Enter` 必须留在这一行: `decideInboxKey` 对 node 类的 Enter 仍返 `prefill`
          //    (node 没有「就地做完」的语义, 它要你去看那张图)。**屏上不说、按下去却有反应**
          //    是「不画一个点了没反应的入口」的反面 —— 一样坏, 而且更难查。
          //    `s` 后面带 `(confirm)`: 它是二次确认的 (INV-RC-3), 按一下不会立刻停图。
          ? 'r resume · i record intervention · s stop detached run (confirm) · Enter into graph'
          // ⚠ `take` **没有 owner 侧的「收」这个动作** (INV-RC-5): 一个 awaiting 由
          //    **另一个 run 的 `published` 事件**满足, 人做不了这件事。原来这里写
          //    `Enter accept` —— 那是在承诺一个不存在的动作。
          //    `decideInboxKey` 对 take 的任何键都返 `prefill`, 所以字面就写它真做的事。
          : 'Enter prefill a prompt about this wait (no owner-side accept exists)';
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