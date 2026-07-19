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
import type { PathMap, Ticket, TicketStatus } from './types';

/**
 * 派生票的"就绪状态"标签 (纯, 给 UI/store 贴标)。
 * 已 ruled/escalated 原样返回; 否则据前置是否全裁定 open(就绪) / blocked(前置未满足)。
 * 未知前置 id 不在 ruledSet → 视为未满足 → blocked。
 */
export function deriveStatus(ticket: Ticket, ruledSet: ReadonlySet<string>): TicketStatus {
  if (ticket.status === 'ruled' || ticket.status === 'escalated') return ticket.status;
  const ready = ticket.blockedBy.every((id) => ruledSet.has(id));
  return ready ? 'open' : 'blocked';
}

/** 已裁票 id 集合 (前沿判定的基准)。 */
function ruledSetOf(map: PathMap): Set<string> {
  return new Set(map.tickets.filter((t) => t.status === 'ruled').map((t) => t.id));
}

/**
 * 计算前沿: status 非 ruled/escalated 且 每个 blockedBy 都已裁的票。
 * 保留 map.tickets 原顺序 (稳定)。
 */
export function computeFrontier(map: PathMap): Ticket[] {
  const ruled = ruledSetOf(map);
  return map.tickets.filter(
    (t) => t.status !== 'ruled' && t.status !== 'escalated' && t.blockedBy.every((id) => ruled.has(id)),
  );
}
