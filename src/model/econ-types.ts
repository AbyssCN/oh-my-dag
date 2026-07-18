/**
 * src/model/econ-types.ts — V2-ECON 经济层 FROZEN CONTRACT (omd orchestrator artifact, 2026-06-03).
 *
 * omd 经济层 (SDD PLAN-2026-06-01-omd-agent-landing §5) 的共享类型契约。并行 agent-leaf 各实现
 * 一个模块, 全 import 此文件 → 类型对齐, 编译即拼得上 (这是并行弱模型 leaf 能 compose 的前提)。
 *
 * impl 模块 (omd leaf 写, 一文件一 leaf):
 *   - usage-normalise.ts : NormaliseUsage  —— 三形 (MiMo 嵌套 / DeepSeek 顶层 / Anthropic cache_read) → ModelUsage
 *   - cost-ledger.ts     : ComputeCost + DEFAULT_PRICES —— 账本核心 (cost / cacheSavings)
 *   - budget.ts          : EvaluateBudget —— 预算状态机 (ok / warn / exhausted)
 *   - routing.ts         : DecideRouting  —— 升降级路由 (escalate / downgrade / hold)
 *
 * 不变量 (impl 必守; 偏离 → 回流改本契约, 非 silent override):
 *  - ECON-1 · model-agnostic: 全经 'provider:model' 坐标 + 注入价表, 零硬编 provider 分支 (normalise 内的
 *    三形识别除外 —— 那是 provider raw shape 的 accidental 适配, essential 计价逻辑无 provider 分支)。
 *  - ECON-2 · cacheHit ⊆ in: miss = in - cacheHit; 命中段按 cacheHitRate (省略 = inputRate·0.1) 计价。
 *  - ECON-3 · fail-open 计量: 价表缺 'provider:model' → costUsd=0 + unpriced:true, 绝不抛 (计量不 sink 主流程)。
 *  - ECON-4 · 升级不静默 (VAL-INV-10): RoutingDecision direction!=='hold' 必带 reason (调用方经 IM 红标回显)。
 */
import type { ModelUsage } from './types';

export type { ModelUsage };

/** per-`provider:model` 价格 (USD per 1M token)。cacheHitRate 省略 → inputRate·0.1 (ECON-2)。 */
export interface ModelPrice {
  inputRate: number;
  outputRate: number;
  cacheHitRate?: number;
}

/** 价表: 'provider:model' 坐标 → 价格。impl 提供 DEFAULT_PRICES (mimo/deepseek/claude/vllm=0), 可注入覆盖。 */
export type PriceTable = Record<string, ModelPrice>;

/** 一次 model 调用的成本分解 (ComputeCost 输出)。 */
export interface CostBreakdown {
  /** = (cacheHit·cacheHitRate + (in-cacheHit)·inputRate + out·outputRate) / 1e6。unpriced → 0。 */
  costUsd: number;
  /** cache 命中省下的钱 = cacheHit·(inputRate - cacheHitRate)/1e6 (无 cacheHit → 0)。 */
  cacheSavingsUsd: number;
  /** 价表缺该坐标 → true (costUsd=0, ECON-3)。 */
  unpriced: boolean;
}

/** 预算档 (EvaluateBudget 输出的 level)。 */
export type BudgetLevel = 'ok' | 'warn' | 'exhausted';

export interface BudgetState {
  spentUsd: number;
  limitUsd: number;
  /** spent/limit ∈ [0, ∞)。limitUsd<=0 → fraction=0 + level='ok' (无限额, 不降级)。 */
  fraction: number;
  level: BudgetLevel;
}

/** 升降级方向 (DecideRouting)。 */
export type RoutingDirection = 'escalate' | 'downgrade' | 'hold';

export interface RoutingDecision {
  direction: RoutingDirection;
  /** 选定的 'provider:model' 坐标 (hold → 原 current 坐标)。 */
  model: string;
  /** direction!=='hold' 必带 (ECON-4); hold 可空。 */
  reason?: string;
}

// ── impl 模块函数签名 (签名是契约一部分, leaf 照此实现) ───────────────────────────

/** 三形归一: provider raw usage 对象 → 标准 ModelUsage。未知/缺字段 → {in:0,out:0} fail-open。 */
export type NormaliseUsage = (raw: unknown, provider: string) => ModelUsage;

/** 账本核心: usage + 'provider:model' 坐标 (+ 可注入价表, 默认 DEFAULT_PRICES) → 成本分解。 */
export type ComputeCost = (usage: ModelUsage, coord: string, prices?: PriceTable) => CostBreakdown;

/** 预算状态机: 已花 + 限额 (+ warnFraction 默认 0.8) → BudgetState。≥1=exhausted, ≥warn=warn。 */
export type EvaluateBudget = (
  spentUsd: number,
  limitUsd: number,
  opts?: { warnFraction?: number },
) => BudgetState;

/** 升降级路由: 当前坐标 + 预算 + 质量失败计数 → 决策。预算 exhausted→降级; 质量失败攒够→升级; 否则 hold。 */
export type DecideRouting = (input: {
  current: string;
  budget: BudgetState;
  /** 攒够的质量失败信号数 (verifier fail / tool-repair / search-miss)。默认 0。 */
  qualityFailures?: number;
  /** 升级失败阈值 (默认 2) + 升降级目标坐标。 */
  escalateThreshold?: number;
  tiers?: { cheap: string; strong: string };
}) => RoutingDecision;
