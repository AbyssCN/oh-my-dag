/**
 * src/tui/components/ticket-board —— **决策地图票看板**(S5, SDD 2026-08-11 DAG 观察面与审核跟踪升级)。
 *
 * ## 纯渲染, 零状态, 零写 (D-12 ①③)
 *
 * 盘上 `PathMap` 是唯一真源, TUI 只是渲染后端 (事故修复先例 commit 1890115 —— 渲染路径禁碰
 * mutateMap 类写)。本组件是纯函数: 传入什么画什么, 不读盘, 不落盘, 不产独立状态。
 *
 * ## 四类票, 一条横线一格 (C-7 ①)
 *
 * - 前沿票        `·` + `frontier`   —— status=open 且前置全裁 (computeFrontier 的读法, 与 path-hud 同源)。
 * - suggested 票  `○` + `suggested`  —— 机器建议待人确认; 在等人态里, 读数照画。
 * - waiting_human `○` + `waiting …` —— suggested/escalated, 读数走 waitingHumanState 四态 (frontier.ts:74):
 *   `waiting` 显 nowMs − waitingSince 的实打实时长; `waiting-unknown-since` 画「起点未记」——
 *   **绝不编 0 时长** (NULL≠0, D-5: 起点缺席不是 0 秒, 是这条读数缺了);
 *   `ruled-unrecorded` 画「裁了没记」。
 * - stale 票      `✗ STALE` 前缀    —— 票上带 `staleAt`。字形 + 文字标签双醒目标记, 不只换颜色 (C-7 ③)。
 *
 * 字形全部在 S6 白名单 (先例 dag-tree.ts TREE_MARK ○·✓✗─), 不引入未量宽字符;
 * `─` 走 `design/tokens.ts` 的 `BORDER.h` (import 复用, 不裸写字面量 —— 边框族闸只扫字面量/转义, 见 tokens.test.ts)。
 */
import { TruncatedText, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { BORDER } from '../design/tokens';
import { computeFrontier, waitingHumanState } from '../../harness/pathfinder/frontier';
import { declaredTicketClass, type PathMap, type Ticket, type TicketStatus } from '../../harness/pathfinder/types';
import { fmtDur } from '../render/dag-gantt';

/** 状态字形 —— 与 dag-tree TREE_MARK 同一套语汇 (S6 白名单; ○=等人, ·=前沿可动, BORDER.h(─)=前置未散, ✓=已了)。 */
const MARK: Record<TicketStatus, string> = {
  open: '·',
  suggested: '○',
  escalated: '○',
  blocked: BORDER.h,
  ruled: '✓',
  delivered: '✓',
};

/** stale 票的前缀标记: 白名单字形 ✗ + 文字标签, 不只换颜色 (C-7 ③)。 */
const STALE_PREFIX = '✗ STALE';

/** 等人读数 → 看板标签 (D-5 四态直接用, 不自己发明平行状态机)。 */
function waitLabel(t: Ticket, nowMs: number): string {
  switch (waitingHumanState(t)) {
    case 'waiting': {
      const since = Date.parse(t.waitingSince!);
      // waitingHumanState 已验 waitingSince 可解析; 双保险不编 0 —— 解析失败仍画「起点未记」。
      const dur = Number.isNaN(since) ? '起点未记' : fmtDur(nowMs - since);
      return `waiting ${dur}`;
    }
    case 'waiting-unknown-since':
      return 'waiting · 起点未记';
    case 'ruled-unrecorded':
      return 'waiting · 裁了没记';
    case 'not-waiting':
      return '';
  }
}

/** 片3 (W2 执行契约) 的列宽选项。缺席 = 旧行为原文平铺 —— 既有调用者一行不改。 */
export interface TicketBoardOpts {
  /** 组件 `render(width)` 拿到的实宽。给了就逐行不溢出 (含选中态展开出来的续行)。 */
  width?: number;
  /** 选中的票 id。open question 的完整长文**只在**选中态展开 (平铺只呈现第一句)。 */
  selectedId?: string;
}

/** open question 判定走运行时读法 `declaredTicketClass` (INV-2: 判别键不在 Ticket 上, 不硬 cast)。 */
const isOpenQuestion = (t: Ticket): boolean => declaredTicketClass(t) === 'question';

/** 第一句: 到第一个问号 (半/全角) 为止, 含问号; 没有问号给全文。 */
const firstSentence = (s: string): string => /^[^??]*[??]/.exec(s)?.[0] ?? s;

/**
 * 按列宽收行 —— **必须走 pi-tui `TruncatedText`**, 不手工 `slice + '...'`:
 * slice 按 code unit 切, 全角字符下切出来的行按列算是超宽的 (片3③ 的测试逐字节钉住这条)。
 */
const fit = (line: string, width: number | undefined): string =>
  width === undefined ? line : (new TruncatedText(line).render(width)[0] ?? '');

/**
 * 渲染一张决策地图的票看板 (纯函数)。
 *
 * @param map   盘上读到的 PathMap —— 唯一真源, 本函数只读。
 * @param nowMs 现在几点 (调用方给, 引擎不自取 Date.now —— 可重放、可测)。
 * @param opts  列宽治理 (片3)。缺席 = 原文平铺, 与改动前逐字节相同。
 * @returns 看板行; 空图返回 `[]` (无源恒缺席, 空态布局不在本切片范围)。
 */
export function renderTicketBoard(map: PathMap, nowMs: number, opts: TicketBoardOpts = {}): string[] {
  if (map.tickets.length === 0) return [];
  const frontier = new Set(computeFrontier(map).map((t) => t.id));
  const head = `ticket board · ${map.destination} (${map.slug}) · ${map.tickets.length} tickets`;
  const rows = map.tickets.flatMap((t) => {
    const mark = t.staleAt !== undefined ? STALE_PREFIX : MARK[t.status];
    // open question 平铺只画第一句 —— 侧栏一行一票的密度不能被一张长问题票吃掉 (片3②)。
    const title = isOpenQuestion(t) ? firstSentence(t.title) : t.title;
    const tags = [t.status === 'open' && frontier.has(t.id) ? 'frontier' : t.status, waitLabel(t, nowMs)].filter(Boolean);
    const row = fit(`${mark} ${t.id} [${t.type}] ${title} · ${tags.join(' · ')}`, opts.width);
    // 选中态: 完整长文按列宽折行接在本票行后。展开 ≠ 可以溢出 —— 续行同吃列宽这把尺。
    if (isOpenQuestion(t) && opts.selectedId === t.id) {
      const cont =
        opts.width === undefined
          ? [`  ${t.title}`]
          : wrapTextWithAnsi(t.title, Math.max(1, opts.width - 2)).map((l) => fit(`  ${l}`, opts.width));
      return [row, ...cont];
    }
    return [row];
  });
  return [fit(head, opts.width), ...rows];
}
