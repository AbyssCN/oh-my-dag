/**
 * src/harness/dag/credit.ts —— 信用解耦三面 (SDD §5 F8) + 使用事件 (SDD §7) + I-11 探测隔离。
 *
 * 三面互不串用 (INV-7):
 *   - tool 信用: 只读工具契约 oracle_pass; 不接 verification.pass。
 *   - plan 信用: 只读 plan 消费结果; 不接 tool reward。
 *   - leaf 消费: 只记 leaf.success / leaf.usage / leaf.cost; 不写 tool/plan arm。
 *
 * probe 记录统一在 `rejectIfProbe` 被拒 (INV-10): 进了 recordReward、进了 dream extract/merge、
 * 进了任意 credit updateer 都抛错。`ProbeUsage` 与 conductor/leaves 并列存在 (INV-9), 普通
 * `aggregateLeafCost` 不读它。
 *
 * `use_event` (INV-5, INV-6) 在 `collectUseEvent` 由真实 tool_id + leaf status 派生, 六字段
 * 全部有来源, 无 tool_id 时返 null (不写占位)。`dedupeUseEvents` 钉 (tool_id, leaf_id) 唯一。
 *
 * ⚠ 本模块是**纯类型 + 纯函数**, 不 import bandit/dream/model-router (INV-5 反面) —— 那样
 * 就成了它自己污染自己。
 */

import type { ModelUsage } from '../../model/gateway';

// ─── 探测消耗 (INV-9, I-11) ──────────────────────────────────────────────────

/**
 * 探测阶段 usage 段 (与 conductor / leaves 并列持久化)。
 *
 * 三态不可压平 (仓规 §静默坑 1):
 *   - 字段**缺席** = 未采集 (probe 装配未启);
 *   - `calls: 0`    = 探了但没真调用 (probe 阶段运行, 无外部命中);
 *   - `costUsd: null` = 有调用但价格未知 (unpriced 模型);
 *
 * `computeCost` / `leafCostReward` / `DreamCandidate` / `dreamFactInput` 一律不读本段。
 */
export interface ProbeUsage {
  /** 探测调用次数 (外探针 IPC)。 */
  calls: number;
  tokensIn: number;
  tokensOut: number;
  /** prompt-cache 命中的探测 input (子集 tokensIn)。 */
  cacheHitTokens: number;
  /** null = 有调用但价格未知 (区别于 0 = 已知 0 美元)。 */
  costUsd: number | null;
}

/** probe 源标签字面量, 所有信用写入面以此判定拒收 (INV-10)。 */
export const PROBE_SOURCE = 'probe' as const;
export type ProbeSourceTag = typeof PROBE_SOURCE;

/** probe 拒收闸 (INV-10): 进了 recordReward / dream extract/merge / 任意 credit update 都抛。 */
export function rejectIfProbe(record: { source?: string } | null | undefined): void {
  if (record && typeof record === 'object' && (record as { source?: string }).source === PROBE_SOURCE) {
    throw new Error('I-11: probe 记录禁止进入信用面 (recordReward / dream / credit update 入口)');
  }
}

// ─── use_event (INV-5, INV-6) ────────────────────────────────────────────────

/** SDD §7 use_event 六字段。每一字段必须有显式来源; 缺源时本事件不得写入。 */
export interface UseEvent {
  /** 真工具引用 (节点 toolRefs[0] 或 bootstrap.test_gate.tool_id)。 */
  tool_id: string;
  /** settled leaf id。 */
  leaf_id: string;
  /** leaf 终态: done = true, failed/skipped = false。 */
  success: boolean;
  /** 该 leaf usage 经 priceTable 算出的 cost (USD)。 */
  cost: number;
  /** 工具契约 oracle_pass: tool 契约绿/红 与 verifier 红/绿 解耦。 */
  oracle_pass: boolean;
  /** 发出时间 (ISO-8601)。 */
  ts: string;
}

/**
 * 从已 settled leaf + 工具契约 oracle_pass + cost 派生 use_event。
 * 无 tool_id → 返 null (INV-6: 不写占位)。'skipped' 不写 (零消耗, 与 use_event 语义不符)。
 */
export function collectUseEvent(
  leaf: { id: string; status: string; tool_id?: string | null },
  extras: { oracle_pass: boolean; cost: number; ts?: string },
): UseEvent | null {
  if (!leaf.tool_id) return null;
  if (leaf.status !== 'done' && leaf.status !== 'failed') return null;
  return {
    tool_id: leaf.tool_id,
    leaf_id: leaf.id,
    success: leaf.status === 'done',
    cost: extras.cost,
    oracle_pass: extras.oracle_pass,
    ts: extras.ts ?? new Date().toISOString(),
  };
}

/**
 * INV-5: 同一 (tool_id, leaf_id) 在一批事件里至多一个。键 = `${tool_id}\\0${leaf_id}`。
 * 不在源头判 dedupe (settle 重入路径可能多次调 emitNodeEvent, 此处幂等兜底)。
 */
export function dedupeUseEvents(events: readonly UseEvent[]): UseEvent[] {
  const seen = new Set<string>();
  const out: UseEvent[] = [];
  for (const e of events) {
    const k = `${e.tool_id}\0${e.leaf_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// ─── 三面信用 (F8) ──────────────────────────────────────────────────────────

/** tool 信用: 唯一判别字段 = oracle_pass。verification.pass 不得进入。 */
export interface ToolCredit {
  tool_id: string;
  leaf_id: string;
  success: boolean;
  cost: number;
  oracle_pass: boolean;
  ts: string;
}

/** plan 信用: 唯一判别字段 = 消费结果 consumed。tool reward 不得进入。 */
export interface PlanCredit {
  leaf_id: string;
  consumed: boolean;
  ts: string;
}

/** leaf 消费: 唯一字段 = leaf.success / usage / cost。tool/plan arm 不得写。 */
export interface LeafCredit {
  leaf_id: string;
  success: boolean;
  usage: { in: number; out: number; cacheHit?: number };
  cost: number;
}

/** state: tool_id → 最新 ToolCredit (Map 持有). */
export type ToolCreditState = ReadonlyMap<string, ToolCredit>;
export function applyToolCredit(state: ToolCreditState, u: ToolCredit): ToolCreditState {
  rejectIfProbe(u as { source?: string });
  const clean: ToolCredit = {
    tool_id: u.tool_id,
    leaf_id: u.leaf_id,
    success: u.success,
    cost: u.cost,
    oracle_pass: u.oracle_pass,
    ts: u.ts,
  };
  const next = new Map(state);
  next.set(`${clean.tool_id}\0${clean.leaf_id}`, clean);
  return next;
}

/** state: leaf_id → 最新 PlanCredit。 */
export type PlanCreditState = ReadonlyMap<string, PlanCredit>;
export function applyPlanCredit(state: PlanCreditState, u: PlanCredit): PlanCreditState {
  rejectIfProbe(u as { source?: string });
  const clean: PlanCredit = {
    leaf_id: u.leaf_id,
    consumed: u.consumed,
    ts: u.ts,
  };
  const next = new Map(state);
  next.set(clean.leaf_id, clean);
  return next;
}

/** state: leaf_id → 最新 LeafCredit。 */
export type LeafCreditState = ReadonlyMap<string, LeafCredit>;
export function applyLeafCredit(state: LeafCreditState, u: LeafCredit): LeafCreditState {
  rejectIfProbe(u as { source?: string });
  const usage = u.usage;
  const clean: LeafCredit = {
    leaf_id: u.leaf_id,
    success: u.success,
    usage: {
      in: usage.in,
      out: usage.out,
      ...(usage.cacheHit !== undefined ? { cacheHit: usage.cacheHit } : {}),
    },
    cost: u.cost,
  };
  const next = new Map(state);
  next.set(clean.leaf_id, clean);
  return next;
}

// ─── 普通 leaf cost 聚合 (INV-9: 不读 ProbeUsage) ──────────────────────────

/**
 * 聚合 leaf credit 中的 cost (USD). 只读 LeafCredit, 不读 ProbeUsage。
 * probe cost 进 probe 段, 不进这里 (INV-9)。
 */
export function aggregateLeafCost(state: LeafCreditState): number {
  let total = 0;
  for (const c of state.values()) total += c.cost;
  return total;
}

/** 聚合 leaf token 汇总 (in/out/cacheHit), 同样不读 ProbeUsage。 */
export function aggregateLeafUsage(state: LeafCreditState): {
  leavesIn: number;
  leavesOut: number;
  leavesCacheHit: number;
} {
  let leavesIn = 0;
  let leavesOut = 0;
  let leavesCacheHit = 0;
  for (const c of state.values()) {
    leavesIn += c.usage.in;
    leavesOut += c.usage.out;
    leavesCacheHit += c.usage.cacheHit ?? 0;
  }
  return { leavesIn, leavesOut, leavesCacheHit };
}

// ─── 类型守卫: 三面互斥 (INV-7 类型层) ─────────────────────────────────────

export function isToolCredit(x: unknown): x is ToolCredit {
  return !!x && typeof x === 'object' && (x as { tool_id?: unknown }).tool_id !== undefined
    && (x as { oracle_pass?: unknown }).oracle_pass !== undefined;
}
export function isPlanCredit(x: unknown): x is PlanCredit {
  return !!x && typeof x === 'object' && (x as { consumed?: unknown }).consumed !== undefined
    && (x as { tool_id?: unknown }).tool_id === undefined
    && (x as { oracle_pass?: unknown }).oracle_pass === undefined;
}
export function isLeafCredit(x: unknown): x is LeafCredit {
  return !!x && typeof x === 'object' && (x as { usage?: unknown }).usage !== undefined
    && (x as { cost?: unknown }).cost !== undefined
    && (x as { tool_id?: unknown }).tool_id === undefined
    && (x as { consumed?: unknown }).consumed === undefined;
}

// ─── ModelUsage → LeafCredit 派生 (引擎接缝, 不在 credit.ts 里写语义) ─────

/** 引擎侧把 LeafResult 拆成 LeafCredit 的纯函数。cost 由调用方传入 (引擎知道 priceTable)。 */
export function leafCreditFromResult(
  leaf: { id: string; status: string; usage?: ModelUsage },
  cost: number,
): LeafCredit | null {
  if (!leaf.usage) return null;
  return {
    leaf_id: leaf.id,
    success: leaf.status === 'done',
    usage: {
      in: leaf.usage.in,
      out: leaf.usage.out,
      ...(leaf.usage.cacheHit !== undefined ? { cacheHit: leaf.usage.cacheHit } : {}),
    },
    cost,
  };
}
