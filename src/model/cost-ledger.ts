/**
 * cost-ledger.ts — V2-ECON 账本核心 (omd leaf, 2026-06-03).
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
import { resolveSubscriptionProviders } from './role-models';

/**
 * 缺省价表。**key = 本仓真实 'provider:model' 坐标** (callModel/fleet 实际用的, 见 spikes + role-models),
 * 非上游 API 名 —— 否则对我们实跑模型恒 unpriced=0。rate 是合理公开价 (USD/1M), 部署可经注入价表覆盖
 * (ECON-1)。vllm self-hosted → 0。
 */
export const DEFAULT_PRICES: PriceTable = {
  // ── DeepSeek (executor 主力, deepseek-v4-flash 用得最多) ──
  //
  // 2026-08-14 核官网订正 (api-docs.deepseek.com/quick_start/pricing): 原值 0.27/1.10/0.07 与
  // 0.55/2.19/0.14 **早已过期**, 比实际贵 2–4 倍 —— 拿它算出来的成本读数全部偏高, 而这种偏差
  // 在账本上不报错、只是默默把便宜档记贵(又一条「配了不生效」的同族: 数在, 只是不对)。
  //
  // ⚠ **本表是单价, 装不下峰谷**(ModelPrice 只有三个标量, econ-types 是 FROZEN CONTRACT)。
  // 而官网同页脚注: **2026-08-16 16:00 UTC 起改峰谷计价**, 峰时 = 01:00–04:00 与 06:00–10:00 UTC
  // (= 北京时间 09:00–12:00 与 14:00–18:00):
  //     v4-flash  off-peak 0.007 / 0.22 / 0.66   ·  peak 0.014 / 0.44 / 1.32
  //     v4-pro    off-peak 0.022 / 0.66 / 1.98   ·  peak 0.044 / 1.32 / 3.96
  //
  // **owner 2026-08-15 裁: 取 off-peak 档, 接受峰时低估**(备选「给 ModelPrice 加时段维度」被否)。
  // 判据是**时段占比 + 体量不成比例**: 峰时 = 24 小时里的 7 小时, **71% 的时段是谷价**, 单点估计
  // 取 off-peak 更准; 而这本账实测年化只有 $33–117(近 7 天 deepseek 全部消耗 $0.64), 为它动
  // 冻结契约不成比例。
  //
  // ⚠ **两段已知偏差, 都写出来**(只记好消息的账本没有信息量):
  //   ① 即刻起到 2026-08-16 16:00 UTC 这 ~1 天, 实际仍是旧平价 0.14/0.28, 本表**高估**;
  //   ② 之后每天那 7 小时峰时, 本表**低估**一半(峰价 = 谷价 ×2)。
  // 两段都是有意接受的, 不是漏掉的。要精确到时段, 那是给 ModelPrice 加维度那条路, 需 owner 重裁。
  //
  // ⚠ 别把这两行读成"涨价了": off-peak 0.22/0.66 相对今天的 0.14/0.28 **本身就是涨**(1.57×/2.36×)。
  // 峰谷不是打折, 是涨价 + 给了个错峰缓冲。
  'deepseek:deepseek-v4-flash': { inputRate: 0.22, outputRate: 0.66, cacheHitRate: 0.007 },
  'deepseek:deepseek-v4-pro': { inputRate: 0.66, outputRate: 1.98, cacheHitRate: 0.022 },

  // ── MiMo (烧 token-plan 沉没额度) ──
  'mimo:mimo-v2.5-pro': { inputRate: 0.50, outputRate: 2.00, cacheHitRate: 0.10 },
  'mimo:mimo-v2.5': { inputRate: 0.50, outputRate: 2.00, cacheHitRate: 0.10 },
  // ultraspeed = 按量 3×pro (fusang .env 2026-06-11 beta 记录)
  'mimo:mimo-v2.5-pro-ultraspeed': { inputRate: 1.50, outputRate: 6.00, cacheHitRate: 0.30 },

  // ── Kimi For Coding (订阅制, 边际成本≈0 — 若列入 bandit 池会因 cost=0 通吃, 慎入池) ──
  'kimi-coding:k3': { inputRate: 0, outputRate: 0 },
  // owner 裁 (2026-08-10): kimi 上线一律 256k 档降订阅配额消耗; k3 条目留给历史账。
  'kimi-coding:k3-256k': { inputRate: 0, outputRate: 0 },

  // ── Anthropic Claude (omd 设计大脑 / conductor 可升级档) ──
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
/**
 * 坐标 → 计价通道。两半来源不同, 刻意分开:
 *
 * - `claude-code:*` **结构性**订阅 —— 该通道压根没有 API key(Agent SDK 自理凭证),
 *   配置空了也是订阅, 不许被配掉。
 * - 其余查 `config.subscriptionProviders` / `OMD_SUBSCRIPTION_PROVIDERS` —— 哪个 provider
 *   上跑的是**套餐**是你账户的事实, 换一把按量 key 同一个 provider 就该变回计价。
 *
 * 不这么分的代价(2026-08-12 装 minimax 套餐 key 当多模态池时撞的): 别家套餐掉进 `unpriced`,
 * 而「这资源不按美元算」与「我们忘了填价」印出来一模一样(都是 0), 处置却完全相反。
 *
 * 成本: 每次 statSync 一下 config(`fileConfig` 按 mtime 缓存解析结果)。账本按**调用**计,
 * 不按 token 计, 这个量级可以忽略。
 */
export function channelOf(coord: string): 'api' | 'subscription' {
  if (coord.startsWith('claude-code:')) return 'subscription';
  const i = coord.indexOf(':');
  const provider = i >= 0 ? coord.slice(0, i) : coord;
  return resolveSubscriptionProviders().includes(provider) ? 'subscription' : 'api';
}

export const computeCost: ComputeCost = (
  usage: ModelUsage,
  coord: string,
  prices?: PriceTable,
): CostBreakdown => {
  const table = prices ?? DEFAULT_PRICES;
  // 订阅通道 (owner 裁 2026-08-10 验收 P2): cost = null 非 0, channel 列判别 —— 三态:
  // 计价 (数字) / unpriced (价表缺, 0+旗) / subscription (不是美元计价的资源)。
  if (channelOf(coord) === 'subscription') {
    return { costUsd: null, cacheSavingsUsd: 0, unpriced: false, channel: 'subscription' };
  }
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
