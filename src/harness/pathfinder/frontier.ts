/**
 * src/harness/pathfinder/frontier —— 前沿计算**纯函数** (组件 2, SDD §测试接缝)。
 *
 * 前沿 (ready-set) = 当前**可动**的票: 未裁决 且 所有前置都已裁。它是 HITL(grill) / AFK(research)
 * 并发的载体 (D-6): 前沿票按 type 分派, 完成回流后前沿重算。
 *
 * 纯: 只吃 PathMap 吐 Ticket[]。零 UI / 零 IO / 零 LLM。
 *
 * 容错纪律 (SDD 先红):
 *  - 未知 blockedBy id → 当作未满足 (永不 ruled), 不崩。
 *  - 自展开: children **不** block parent (children 只在 children 字段, 不进 blockedBy)。
 *  - 环: 单遍 filter, 无递归 → 天然不死循环 (环里的票谁都没裁 → 谁都不在前沿)。
 */
import type { PathMap, Ticket, TicketStatus, WaitingLogEntry } from './types';

/**
 * 派生票的"就绪状态"标签 (纯, 给 UI/store 贴标)。
 * 已 ruled/escalated 原样返回; 否则据前置是否全裁定 open(就绪) / blocked(前置未满足)。
 * 未知前置 id 不在 ruledSet → 视为未满足 → blocked。
 */
export function deriveStatus(ticket: Ticket, ruledSet: ReadonlySet<string>): TicketStatus {
  // INV-S1-1: suggested 不参与就绪推导 — 人确认前它既不 open 也不 blocked, 就是 suggested。
  if (ticket.status === 'suggested') return 'suggested';
  if (ticket.status === 'ruled' || ticket.status === 'delivered' || ticket.status === 'escalated') return ticket.status;
  const ready = ticket.blockedBy.every((id) => ruledSet.has(id));
  return ready ? 'open' : 'blocked';
}

/** 已裁票 id 集合 (前沿判定的基准; delivered 已裁且已交付, 同样满足前置)。 */
function ruledSetOf(map: PathMap): Set<string> {
  return new Set(map.tickets.filter((t) => t.status === 'ruled' || t.status === 'delivered').map((t) => t.id));
}

/**
 * 计算前沿: status 非 ruled/delivered/escalated 且 每个 blockedBy 都已裁的票。
 * 保留 map.tickets 原顺序 (稳定)。
 */
export function computeFrontier(map: PathMap): Ticket[] {
  const ruled = ruledSetOf(map);
  return map.tickets.filter(
    (t) =>
      // INV-S1-1: suggested 永不进前沿 — 机器产的票在人确认前没有任何执行力。
      t.status !== 'suggested' &&
      t.status !== 'ruled' &&
      t.status !== 'delivered' &&
      t.status !== 'escalated' &&
      t.blockedBy.every((id) => ruled.has(id)),
  );
}

// ── D-5 (2026-08-11 控制面统一): waiting_human = 带有限超时的一等状态 ────────────
//
// **不发明平行状态机**: "等人裁"今天已经在盘上有形状 —— `escalated` (`?` 上报 owner,
// board-page.ts 的「待 owner 决断」列) 与 `suggested` (机器建议待人确认), fog.ts 早把这两态
// 并作"离能动只差 owner 的一个动作"。D-5 补的不是新状态词, 是这两态缺的那半:
// **进入时刻可查 + 有限超时 + 超时后的升级动作**, 于是"人可能永远不回来"有了语义。
//
// 升级动作 (O-1 未裁, 按探索版做窄): 标 stale (票上 `staleAt`) + 台账留痕 (`map.waitingLog`)。
// 提醒通道 (TUI/gh/推送) 只留 `WaitingHumanNotifier` 一个可注入钩子, 本切片**不实装任何通道**。

/** 缺省超时 = 72h (D-5; O-1 未裁前的探索值 —— `sweepWaitingHuman` 可逐次覆盖)。 */
export const WAITING_HUMAN_TIMEOUT_MS = 72 * 60 * 60 * 1000;

/**
 * 一张票"等人裁"的读数 (NULL≠0: 四态互不抹平)。
 *  - `not-waiting`           不在等人 (这条路不适用)。
 *  - `waiting`               在等人, 且进入时刻已记 → **唯一**可判超时的一档。
 *  - `waiting-unknown-since` 在等人, 但进入时刻没记上 (旧票 / 漏记 / 人手改成坏值) →
 *                            算不出等了多久, fail-safe 不升级; 但它**不是** not-waiting,
 *                            它仍是待人的活, 只是这条读数缺了。
 *  - `ruled-unrecorded`      「裁了没记」: 裁决时刻 ≥ 本轮进入时刻, 却还挂着等人态 ——
 *                            人已经做了他那部分, 是盘上状态没落回来。催他没意义, 但要看得见。
 */
export type WaitingHumanState = 'not-waiting' | 'waiting' | 'waiting-unknown-since' | 'ruled-unrecorded';

/** 等人裁的两个现状出口 (D-5 挂靠点): 人不动它就不动的两态。 */
export function isWaitingHumanStatus(status: TicketStatus): boolean {
  return status === 'suggested' || status === 'escalated';
}

/** ISO 时刻 → ms; 缺席或不可解析 → undefined (**不**回落到 0 — 那正是 G-5 要挡的抹平)。 */
function msOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 读一张票的等人读数 (纯)。判据全在字段的**有无与先后**上, 零猜测。 */
export function waitingHumanState(t: Ticket): WaitingHumanState {
  if (!isWaitingHumanStatus(t.status)) return 'not-waiting';
  const since = msOf(t.waitingSince);
  if (since === undefined) return 'waiting-unknown-since';
  const ruled = msOf(t.ruledAt);
  // 本轮等待**之后**才有的裁决戳 = 人裁了但状态没落回盘; 更早的戳是上一轮的旧账, 不算。
  if (ruled !== undefined && ruled >= since) return 'ruled-unrecorded';
  return 'waiting';
}

/**
 * 打"进入等人态"的戳 (状态转换处调用; 转换本身不在本文件)。
 * 顺带清掉上一轮的 `staleAt` —— 新等待窗口重新计时, 旧的 stale 标不许顺延
 * (不清则幂等闸会把这张票永久排除在升级之外)。
 */
export function markWaitingHuman(ticket: Ticket, atIso: string): void {
  ticket.waitingSince = atIso;
  delete ticket.staleAt;
}

/** 提醒通道的注入点 (D-5 / O-1): 本切片只定接口, TUI/gh/推送一律不在此实装。 */
export type WaitingHumanNotifier = (entry: WaitingLogEntry) => void;

export interface SweepWaitingHumanOptions {
  /** 现在几点 (ISO, 调用方给 — 引擎不自取 Date.now, 可重放)。 */
  now: string;
  /** 超时阈值, 缺省 72h。 */
  timeoutMs?: number;
  /** 提醒钩子 (可选)。异常被吞 (fail-open) 但留 stderr 证据 — 通道的死活不许影响盘上真源。 */
  notify?: WaitingHumanNotifier;
}

/**
 * 扫一遍地图, 把超时的等人票标 stale 并写台账 (就地改 map, 由调用方经 `mutateMap` 落盘)。
 *
 * 只升级 `waiting` 一档 (G-5 的 NULL≠0):
 *  - `waiting-unknown-since` 不升级 —— 不知道等了多久就不假装知道。
 *  - `ruled-unrecorded`      不升级 —— 人已经裁了。
 *  - 已有 `staleAt`          不升级 —— 同一轮等待只标一次 (幂等; 重进等待由 markWaitingHuman 清标)。
 */
export function sweepWaitingHuman(map: PathMap, opts: SweepWaitingHumanOptions): WaitingLogEntry[] {
  const nowMs = msOf(opts.now);
  if (nowMs === undefined) throw new Error(`sweepWaitingHuman: now 不是合法 ISO 时刻: ${opts.now}`);
  const timeoutMs = opts.timeoutMs ?? WAITING_HUMAN_TIMEOUT_MS;
  const fired: WaitingLogEntry[] = [];
  for (const t of map.tickets) {
    if (waitingHumanState(t) !== 'waiting' || t.staleAt !== undefined) continue;
    const waitedMs = nowMs - msOf(t.waitingSince)!;
    if (waitedMs < timeoutMs) continue;
    t.staleAt = opts.now;
    const entry: WaitingLogEntry = { ticketId: t.id, waitingSince: t.waitingSince!, waitedMs, at: opts.now };
    map.waitingLog = [...(map.waitingLog ?? []), entry];
    fired.push(entry);
  }
  if (opts.notify) {
    for (const entry of fired) {
      try {
        opts.notify(entry);
      } catch (err) {
        // fail-open 可以吞异常, 不许吞证据 (本仓坑 2)。
        console.error(`[waiting_human] notify 失败 ticket=${entry.ticketId} at=${entry.at}: ${String(err)}`);
      }
    }
  }
  return fired;
}
