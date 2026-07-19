/**
 * src/harness/pathfinder/types —— pathfinder 模式的**数据模型纯件** (SDD §数据模型)。
 *
 * 决策地图 (PathMap) = 跨 session 持久的**决策 DAG**: 每张票 (Ticket) 是一个待决问题,
 * blockedBy 是前置票 (编译时成 depends_on)。零 UI / 零后台 / 零 LLM —— 只是形状。
 *
 * 溯源: D-1 (pathfinder 命名) · D-2 (slice 产物) · D-9 (票类型 + executorKind) ·
 *       D-10 (票自展开 children) · D-3 (markdown 真相源 + db 索引)。
 */

/** 票类型 (D-9): research=AFK 后台调研 / grill=HITL 只读审议 / prototype=沙盒 spike / task=待编译施工。 */
export type TicketType = 'research' | 'grill' | 'prototype' | 'task';

/** 票状态: open=前沿可动 / blocked=前置未散 / ruled=已裁决 / escalated=`?` 上报 owner。 */
export type TicketStatus = 'open' | 'blocked' | 'ruled' | 'escalated';

/** slice 编译器消费的执行器种类 (D-9, 裁票时定; 与 ConductorPlan.executor 不同枚举, 编译期映射)。 */
export type ExecutorKind = 'command' | 'inproc' | 'agent' | 'map' | 'primitive';

/** 一张决策票 = 决策 DAG 的一个节点。 */
export interface Ticket {
  /** 稳定 id (跨 session / 跨机不变, 也是 markdown ↔ db 的连接键)。 */
  id: string;
  type: TicketType;
  /** 待决问题 (自由文本)。 */
  title: string;
  /** 前置票 id → 编译时成 depends_on。空数组 = 无前置 (前沿候选)。 */
  blockedBy: string[];
  status: TicketStatus;
  /** 裁决内容 (status='ruled' 时填; 编译时成 PlanNode.goal)。 */
  ruling?: string;
  /** task 票用: 喂 slice 编译器决定 PlanNode 执行器种类 (D-9)。 */
  executorKind?: ExecutorKind;
  /** 自展开子票 id (research map-node 运行时发现, D-10)。★ children **不** block parent。 */
  children?: string[];
  /** 溯源到决策记录 (D-numbers)。 */
  dNumber?: string;
}

/** 一张决策地图 = 一个目的地的完整决策 DAG (稳定 key = slug, 一 repo 多图)。 */
export interface PathMap {
  /** 目的地 (人类可读的功能描述)。 */
  destination: string;
  /** 稳定 slug (markdown 文件名 + db 主键)。 */
  slug: string;
  tickets: Ticket[];
  /** 决策日志 (索引非存储, D-3): 已散尽决策的一行摘要。 */
  decisionsLog: { ticketId: string; gist: string }[];
}
