/**
 * src/tui/components/run-board —— **活 run 观察面** (#96, 承 2026-08-11 scratchpad 设计)。
 *
 * ## 为什么这个文件此前不存在
 *
 * 公告板 (`harness/board/run-board.ts`) 的**写侧与判定侧早就齐了**: `appendBoard` 有五个生产
 * 调用方 (goal / intervene / ignition-preflight / await-node), `liveRuns` 的 D-9 语义
 * (claimed 且无对应 terminal) 也有闸。缺的只是**把它渲染出来那一跳** —— 于是盘上有数据、
 * 没人看得见。本仓管这个形态叫**空旋钮** (机制在、生产零消费), 与 `loopBudget` / D-6 挂票
 * 同族; #96 的票面原话是「2026-08-11 scratchpad 设计的收尾件, 当时漏开票」。
 *
 * ## 渲染零写铁律
 *
 * 本模块**只读**: 入参是已经读好的 `BoardEntry[]`, 出参是行数组。不 `readBoard`、不 `appendBoard`、
 * 不碰盘。观察面一旦开始写, 它就成了参与者 —— 而公告板的全部价值在于它是**旁观者记的账**。
 * (票面把这条列在判据里: 「纯读零写(渲染零写铁律)」。)
 *
 * ## 画两样, 各自答一个不同的问题
 *
 * | 行 | 答的问题 | 数据源 |
 * |---|---|---|
 * | `▶ <runId>` | **谁在跑**, 占了哪些写集 | `liveRuns` (claimed 且无 terminal) |
 * | `⇧ <artifact>` | **谁产出了什么**, 下游可以接了 | `published` 事件 |
 *
 * ⚠ **票面第三样「await 等待中」这次没画, 因为它在板上没有位置**: `BoardEvent` 的六格
 * (`claimed/published/terminal/note/verified/intervened`) 里**没有 await**, 而 `await-node`
 * 只**读**板、从不写。也就是说「谁在等」这件事今天根本没被记下来 —— 要画它得先给板加一个事件位,
 * 那是写侧的改动, 不属于「渲染零写」这张票。
 *
 * 这里**不去推一个出来** (比如"某 artifact 至今没被 published 就算有人在等"): 那是把
 * 「没人在等」与「等这件事没被记」压成一行, 而这两件事的下一步完全不同 —— 本仓坑①
 * (`NULL` ≠ 0 ≠ 不适用) 的同一形状。缺就是缺, 单开票。
 */
import { TruncatedText } from '@earendil-works/pi-tui';
import { liveRuns, type BoardEntry } from '../../harness/board/run-board';
import { fmtDur } from '../render/dag-gantt';

/** 三种行的字形 (与 ticket-board 的 MARK 同族: 一眼可辨, 且被上色器按行首拆色)。 */
export const RUN_MARK = { live: '▶', published: '⇧' } as const;

export interface RunBoardOpts {
  /** 列宽治理; 缺席 = 原文平铺 (同 ticket-board)。 */
  width?: number;
  /** 写集最多列几条 (再多只报条数 —— 一个 run 声明 40 个文件时不该吃掉整个侧栏)。 */
  maxWriteSet?: number;
}

/** 按列宽收行 —— 走 pi-tui `TruncatedText`, 不手工 slice (全角下按列算会超宽)。 */
const fit = (line: string, width: number | undefined): string =>
  width === undefined ? line : (new TruncatedText(line).render(width)[0] ?? '');

/** 该 run 最后一次 claimed 的时刻 (liveRuns 的语义是"后写者胜", 时刻也跟着取最后一次)。 */
function claimedAt(entries: BoardEntry[], runId: string): string | undefined {
  let at: string | undefined;
  for (const e of entries) if (e.event === 'claimed' && e.runId === runId) at = e.ts;
  return at;
}

/**
 * 渲染活 run 观察面 (**纯函数, 零写**)。
 *
 * @param entries 已读好的板条目 —— 唯一真源, 本函数只读。
 * @param nowMs   现在几点 (调用方给, 不自取 Date.now —— 可重放、可测; 同 renderTicketBoard)。
 * @returns 看板行; **板上无活 run 且无产出 → `[]`** (无源恒缺席, 不画空框)。
 */
export function renderRunBoard(entries: BoardEntry[], nowMs: number, opts: RunBoardOpts = {}): string[] {
  const live = liveRuns(entries);
  // published 只画**还活着的那些 run** 产的? 不 —— 产物一旦发布就对下游有效, 哪怕产它的 run 已终态。
  // 这正是 await-node 的语义 (它匹配 published.artifact, 不问那个 run 死没死)。
  const published = entries.filter((e) => e.event === 'published' && e.artifact);
  if (live.size === 0 && published.length === 0) return [];

  const cap = opts.maxWriteSet ?? 3;
  const rows: string[] = [];
  for (const [runId, writeSet] of live) {
    const at = claimedAt(entries, runId);
    // 时长: 拿不到 claimed 时刻就不画时长 (缺席 = 没记, 不是 0 —— 画成 "0s" 会读成"刚起")。
    const dur = at ? ` ${fmtDur(Math.max(0, nowMs - Date.parse(at)))}` : '';
    const shown = writeSet.slice(0, cap);
    const more = writeSet.length > shown.length ? ` +${writeSet.length - shown.length}` : '';
    const ws = writeSet.length === 0 ? '(未声明写集)' : `${shown.join(' ')}${more}`;
    rows.push(`${RUN_MARK.live} ${runId}${dur} · ${ws}`);
  }
  for (const p of published) {
    rows.push(`${RUN_MARK.published} ${p.artifact} · ${p.runId}`);
  }
  const head = `run board · ${live.size} 活 · ${published.length} 产出`;
  return [head, ...rows].map((l) => fit(l, opts.width));
}
