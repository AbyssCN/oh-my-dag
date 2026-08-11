/**
 * src/harness/pathfinder/types —— pathfinder 模式的**数据模型纯件** (SDD §数据模型)。
 *
 * 决策地图 (PathMap) = 跨 session 持久的**决策 DAG**: 每张票 (Ticket) 是一个待决问题,
 * blockedBy 是前置票 (编译时成 depends_on)。零 UI / 零后台 / 零 LLM —— 只是形状。
 *
 * 溯源: D-1 (pathfinder 命名) · D-2 (slice 产物) · D-9 (票类型 + executorKind) ·
 *       D-10 (票自展开 children) · D-3 (markdown 真相源 + db 索引) ·
 *       D-3 控制面统一 (2026-08-11: 票语义三类 + 裁决票不可派发, 见下 TicketClass)。
 */

/** 票类型 (D-9): research=AFK 后台调研 / grill=HITL 审议 (纪律不动手, 无代码闸) / prototype=沙盒 spike / task=待编译施工。 */
export type TicketType = 'research' | 'grill' | 'prototype' | 'task';

/** 票状态: suggested=机器建议待人确认(S-1) / open=前沿可动 / blocked=前置未散 / ruled=已裁决 / delivered=slice 已交付(终态) / escalated=`?` 上报 owner。 */
export type TicketStatus = 'suggested' | 'open' | 'blocked' | 'ruled' | 'delivered' | 'escalated';

/** slice 编译器消费的执行器种类 (D-9, 裁票时定; 与 ConductorPlan.executor 不同枚举, 编译期映射)。
 * 'goal' (D-G1.1): 票是要收敛的子目标 — deliver 分流走 detached solve, **永不进 slice 图**。 */
export type ExecutorKind = 'command' | 'inproc' | 'agent' | 'map' | 'primitive' | 'goal';

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
  /** S-1 (INV-S1-2): 建议来源 runId — suggested 出生时必填, 确认后保留作溯源。 */
  suggestedBy?: string;
  /** t3 预留 (D-S1.5): 内容寻址指纹 = sha256(type + NFC(title)); suggested 入图时算并全状态查重。 */
  fingerprint?: string;

  // ── D-5 (2026-08-11 控制面统一): 等人裁这件事的三个时刻 (ISO 8601, 调用方给) ──
  // NULL≠0 三条铁律都压在"字段有无"上, 一个都不许靠猜补:
  //  · 缺席 = **没记**, 不是 0 (当 0 就是 1970 → 每张票立刻超时 56 年)。
  //  · 缺席 也不是 "不在等" —— "在等但没记进入时刻" 是独立读数 (waiting-unknown-since)。
  //  · 判别 "没人裁" / "裁了没记" 靠 waitingSince 与 ruledAt 的**先后**, 不靠 ruling 文本有无
  //    (票可被裁过又重新升人, backend.escalate 不清 ruling → 看文本必误判)。

  /** 进入"等人裁"态 (suggested/escalated) 的时刻。缺席 = 没记上, **不可**据此算超时。 */
  waitingSince?: string;
  /** 最近一次裁决被记下的时刻。≥ waitingSince 且仍挂等人态 = 「裁了没记」(盘上有裂缝)。 */
  ruledAt?: string;
  /** 超时升级动作 (标 stale) 的执行时刻。缺席 = 本轮等待还没被标过 (幂等键)。 */
  staleAt?: string;
}

// ── D-3 (2026-08-11 控制面统一): 票语义三类 + 裁决票的类型层分家 ──────────────────

/**
 * 票语义三类 (D-3, `docs/plan/2026-08-11-control-plane-unification.md`) —— **不抹平**:
 *  - `question` 问题票: 要一个**答案** (AFK 调研 / 审议产出)。
 *  - `task`     任务票: 要**施工** (编译进 slice / 收敛 goal)。
 *  - `ruling`   裁决票: 要**人裁**。永不可派发 (INV-2) —— 它等的是 owner 的判词, 不是执行体。
 *
 * ⚠ 与 `TicketType` 是两个维度, 不是同一件事: TicketType 说"用哪条执行路数"(D-9 分派),
 * TicketClass 说"这张票要的是什么"。今天的四型票**一张都没标类** (字段缺省 = undefined),
 * 语义与改动前逐字节相同; 标类由后续切片 (散雾出口 / 票唯一入口) 逐步接上。
 */
export type TicketClass = 'question' | 'task' | 'ruling';

/** 可派发的两类 (裁决票不在内) —— `DispatchableTicket` 的判别键域。 */
export type DispatchableClass = Exclude<TicketClass, 'ruling'>;

/**
 * 裁决票 (D-3): 判别键 `ticketClass: 'ruling'` **必填**。
 *
 * **INV-2 的类型层分家就在这里**: `RulingTicket` 是 `Ticket` 的结构超集 (进得了
 * `PathMap.tickets`、进得了 render/parse 的一切 `Ticket` 口), 但**不是** `DispatchableTicket`
 * —— 派发函数的参数类型收不进它, 派发路径在类型层就不存在 (不是运行时 if)。
 *
 * ✎ 为什么判别键**不**声明在 `Ticket` 上 (反直觉但必须):
 *   若 `Ticket.ticketClass?: TicketClass` (域含 'ruling'), 则 `Ticket` 自己就不可赋给
 *   `DispatchableTicket`, 于是**每一个**持 `Ticket` 的存量调用点都要改写才编得过 ——
 *   代价是改语义无关的文件, 收益是零 (存量票本来就没标类)。把判别键留在子类型上,
 *   存量 `Ticket` 一行不动照旧可派 (存量语义不变), 而静态已知的裁决票被编译期拒。
 *   类的**运行时**读取走 `declaredTicketClass()` (类型层看不见的那半, 由派发闸兜底)。
 */
export interface RulingTicket extends Ticket {
  ticketClass: 'ruling';
}

/**
 * 派发口的参数类型 (INV-2 的物理性所在)。收得进:
 *  - 未标类的存量票 (`Ticket`, 无 `ticketClass`) ✓
 *  - 显式标 `question` / `task` 的票 ✓
 * 收不进:
 *  - `RulingTicket` ✗ —— `'ruling'` 不在 `DispatchableClass` 域内, 编译期拒 (G-4)。
 */
export type DispatchableTicket = Ticket & { ticketClass?: DispatchableClass };

/**
 * 读票上**写着的**类 (类型层看不见的那半: 从磁盘 parse 出来的票, 静态类型一律是 `Ticket`)。
 *
 * NULL≠0: 返回 `undefined` = **没标类** (存量票 / 旧图), 与显式 `'task'` 是两回事 ——
 * 别拿"缺省当 task"把两者抹平, 分辨"这张票没标"和"这张票标了任务票"靠的就是这个 undefined。
 *
 * 真相文件人可手改 (regression 1 的形态), 所以词表外的值**原样返回**给闸判断 ——
 * 派发闸只放行 `undefined | 'question' | 'task'`, 其余一律拒 (fail-closed:
 * 把 `rulingg` 这种手滑静默升格成可派票, 正是 D-3 要挡的那类越权)。
 */
export function declaredTicketClass(t: Ticket): string | undefined {
  const raw = (t as { ticketClass?: unknown }).ticketClass;
  return typeof raw === 'string' ? raw : undefined;
}

/** 裁决票判定 (运行时): 判别键逐字节等于 'ruling'。窄化到 `RulingTicket` 供调用方分流。 */
export function isRulingTicket(t: Ticket): t is RulingTicket {
  return declaredTicketClass(t) === 'ruling';
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
  /** S-1 (INV-S1-3): 建议处置台账 (append-only) — 接受率读数的数据源。缺省 = 无建议史 (旧图兼容)。 */
  suggestionsLog?: SuggestionLogEntry[];
  /** D-5 (G-5): 等人超时升级台账 (append-only)。缺省 = 没记过, **不是**记了个空 (旧图兼容)。 */
  waitingLog?: WaitingLogEntry[];
}

/**
 * D-5 (G-5): 一条"等人超时被标 stale"的记录 —— 谁超时 (ticketId) · 等了多久 (waitedMs,
 * 从 waitingSince 到 at) · 何时标的 (at)。票上的 `staleAt` 只留**本轮**窗口, 重新进入等待即被清;
 * 这份 append-only 台账留全部历史 (同一张票可以超时多轮)。
 */
export interface WaitingLogEntry {
  ticketId: string;
  /** 本轮等待的进入时刻 (票上的 waitingSince 快照)。 */
  waitingSince: string;
  /** at − waitingSince (ms)。写死数值而非现算: 台账要能脱离票单独读。 */
  waitedMs: number;
  /** 标 stale 的时刻 (调用方给的 now, 引擎不自取 Date.now — 可重放)。 */
  at: string;
}

/** S-1: 一条建议处置记录。outcome 词表与契约 GWT 同; deduped=指纹撞车, deduped-semantic=语义近邻 (r1 C1) — 分开数才调得动阈值。 */
export interface SuggestionLogEntry {
  ticketId: string;
  outcome: 'accepted' | 'edited' | 'rejected' | 'deduped' | 'deduped-semantic';
  /** ISO 时间戳 (调用方给, 引擎不自取 Date.now — 可重放)。 */
  at: string;
  /** 建议来源 runId (与 Ticket.suggestedBy 同源)。 */
  runId: string;
}
