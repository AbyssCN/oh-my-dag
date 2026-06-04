/**
 * cost-ledger.ts — V2-ECON 账本核心 (valar leaf, 2026-06-03).
 *
 * ComputeCost + DEFAULT_PRICES. FROZEN CONTRACT in econ-types.ts.
 *
 * 不变量:
 *   ECON-1 · model-agnostic: 经 'provider:model' 坐标 + 注入价表, 零硬编 provider 分支。
 *   ECON-2 · cacheHit ⊆ in; miss = in - cacheHit; 命中段按 cacheHitRate (省略 = inputRate·0.1) 计价。
 *   ECON-3 · fail-open 计量: 价表缺 'provider:model' → costUsd=0 + unpriced:true, 绝不抛。
 */
import type { ModelPrice, PriceTable, CostBreakdown, ComputeCost } from './econ-types';
import type { ModelUsage } from './types';

/**
 * 缺省价表。**key = 本仓真实 'provider:model' 坐标** (callModel/fleet 实际用的, 见 spikes + role-models),
 * 非上游 API 名 —— 否则对我们实跑模型恒 unpriced=0。rate 是合理公开价 (USD/1M), 部署可经注入价表覆盖
 * (ECON-1)。vllm self-hosted → 0。
 */
export const DEFAULT_PRICES: PriceTable = {
  // ── DeepSeek (executor 主力, deepseek-v4-flash 用得最多) ──
  'deepseek:deepseek-v4-flash': { inputRate: 0.27, outputRate: 1.10, cacheHitRate: 0.07 },
  'deepseek:deepseek-v4-pro': { inputRate: 0.55, outputRate: 2.19, cacheHitRate: 0.14 },

  // ── MiMo (烧 token-plan 沉没额度) ──
  'mimo:mimo-v2.5-pro': { inputRate: 0.50, outputRate: 2.00, cacheHitRate: 0.10 },
  'mimo:mimo-v2.5': { inputRate: 0.50, outputRate: 2.00, cacheHitRate: 0.10 },

  // ── Anthropic Claude (valar 设计大脑 / conductor 可升级档) ──
  'anthropic:claude-opus-4-8': { inputRate: 15, outputRate: 75, cacheHitRate: 1.50 },
  'anthropic:claude-sonnet-4-6': { inputRate: 3, outputRate: 15, cacheHitRate: 0.30 },
  'anthropic:claude-haiku-4-5': { inputRate: 0.80, outputRate: 4, cacheHitRate: 0.08 },

  // ── vLLM self-hosted — zero marginal cost ──
  'vllm:default': { inputRate: 0, outputRate: 0 },
};

/**
 * Compute cost breakdown for one model call.
 *
 * Formula (ECON-2):
 *   miss        = in - cacheHit  (cacheHit undefined → miss = in)
 *   costUsd     = (cacheHit·cacheHitRate + miss·inputRate + out·outputRate) / 1e6
 *   savingsUsd  = cacheHit·(inputRate - cacheHitRate) / 1e6
 *
 * cacheHitRate omitted → inputRate·0.1 (ECON-2).
 * coord missing from prices → costUsd=0 + unpriced=true (ECON-3 fail-open).
 */
export const computeCost: ComputeCost = (
  usage: ModelUsage,
  coord: string,
  prices?: PriceTable,
): CostBreakdown => {
  const table = prices ?? DEFAULT_PRICES;
  const price: ModelPrice | undefined = table[coord];

  if (!price) {
    return { costUsd: 0, cacheSavingsUsd: 0, unpriced: true };
  }

  const { in: inputTokens, out: outputTokens, cacheHit } = usage;
  const { inputRate, outputRate } = price;
  const cacheHitRate = price.cacheHitRate ?? inputRate * 0.1;

  const actualCacheHit = cacheHit ?? 0;
  const miss = cacheHit !== undefined
    ? Math.max(0, inputTokens - cacheHit)
    : inputTokens;

  const costUsd = (
    actualCacheHit * cacheHitRate
    + miss * inputRate
    + outputTokens * outputRate
  ) / 1_000_000;

  const cacheSavingsUsd = actualCacheHit * (inputRate - cacheHitRate) / 1_000_000;

  return { costUsd, cacheSavingsUsd, unpriced: false };
};
