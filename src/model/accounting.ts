/**
 * src/model/accounting.ts — V2-ECON 计量回路接线 (B-1, 2026-06-04)。
 *
 * 把 frozen-contract 的纯函数 (computeCost/evaluateBudget) 组装成**有状态 session ledger**,
 * 经一个**观察者钩子**接到 callModel 出口 —— callModel 仍只 RETURN usage 不持久 (守 INV-4),
 * 它只 `emitModelUsage(usage, model)` 通知; 持久/记账是 ledger 的活 (accounting 层 ≠ callModel 内)。
 *
 * 这条回路接通 = 实时 token/成本可见 + 预算闸 (warn/exhausted) + 为 D69-5 routing 喂 BudgetState。
 */
import type { ModelUsage } from './types';
import type { BudgetState, CostBreakdown, PriceTable } from './econ-types';
import { computeCost } from './cost-ledger';
import { evaluateBudget } from './budget';

// ── 观察者钩子 (callModel 出口 → emit; ledger 订阅) ──────────────────────────────
type UsageObserver = (usage: ModelUsage, model: string) => void;
const observers = new Set<UsageObserver>();

/** 注册 usage 观察者 (ledger 用)。返回 detach。多订阅安全 (Set, 不互相覆盖)。 */
export function observeModelUsage(fn: UsageObserver): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

/** callModel 成功出口调用 — 只通知不持久 (守 INV-4)。观察者抛错不影响主流程。 */
export function emitModelUsage(usage: ModelUsage, model: string): void {
  for (const fn of observers) {
    try {
      fn(usage, model);
    } catch {
      /* 计量不下沉主流程 (ECON-3 fail-open) */
    }
  }
}

// ── session ledger ─────────────────────────────────────────────────────────────
export interface PerModelStat {
  calls: number;
  costUsd: number;
  in: number;
  out: number;
}

export interface LedgerState {
  spentUsd: number;
  cacheSavingsUsd: number;
  calls: number;
  unpriced: number;
  budget: BudgetState;
  byModel: Record<string, PerModelStat>;
}

export interface CostLedger {
  /** 记一次调用; 返回该次成本分解 + 当前预算态。 */
  record(usage: ModelUsage, model: string): { breakdown: CostBreakdown; budget: BudgetState };
  state(): LedgerState;
  reset(): void;
}

export function createCostLedger(
  opts: { limitUsd?: number; prices?: PriceTable; warnFraction?: number } = {},
): CostLedger {
  const limitUsd = opts.limitUsd ?? 0; // ≤0 = 无限额, budget 恒 'ok' (ECON-3)
  const warnFraction = opts.warnFraction ?? 0.8;
  let spentUsd = 0;
  let cacheSavingsUsd = 0;
  let calls = 0;
  let unpriced = 0;
  const byModel: Record<string, PerModelStat> = {};

  return {
    record(usage, model) {
      const breakdown = computeCost(usage, model, opts.prices);
      spentUsd += breakdown.costUsd;
      cacheSavingsUsd += breakdown.cacheSavingsUsd;
      calls += 1;
      if (breakdown.unpriced) unpriced += 1;
      const m = (byModel[model] ??= { calls: 0, costUsd: 0, in: 0, out: 0 });
      m.calls += 1;
      m.costUsd += breakdown.costUsd;
      m.in += usage.in;
      m.out += usage.out;
      return { breakdown, budget: evaluateBudget(spentUsd, limitUsd, { warnFraction }) };
    },
    state() {
      return {
        spentUsd,
        cacheSavingsUsd,
        calls,
        unpriced,
        budget: evaluateBudget(spentUsd, limitUsd, { warnFraction }),
        byModel: { ...byModel },
      };
    },
    reset() {
      spentUsd = 0;
      cacheSavingsUsd = 0;
      calls = 0;
      unpriced = 0;
      for (const k of Object.keys(byModel)) delete byModel[k];
    },
  };
}

/** 把 ledger 订阅到 callModel 观察者 (每次模型调用自动记账)。返回 detach。 */
export function attachLedger(ledger: CostLedger): () => void {
  return observeModelUsage((usage, model) => ledger.record(usage, model));
}
