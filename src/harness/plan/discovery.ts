/**
 * plan/discovery —— U2 发现型循环 (loop-until-dry) 原语。
 *
 * SDD: docs/migration/0010-u2-discovery-loop-sdd.md。收敛型循环 (fixpoint/iterate) 朝已知
 * 目标收敛;本原语治 **未知规模** 任务 (review/audit/research 事前不知有几个发现):
 * 固定 fanout 宽度必然欠采样尾部 → 用「连续 K 轮零新增才停」替代「猜宽度」。
 *
 * D1: 独立原语,不 wrap runFixpoint (其 judge 契约=纯函数,塞跨轮 seen 累加器会腐蚀
 * load-bearing 契约);镜像其有界终止 + degenerate/failed 分级脚手架。
 * 全注入可单测: roundRunner/keyOf/enrichGap 全外来,零模型零 DB。
 *
 * 不变量 (SDD §2.2):
 *  INV-D1 单调累加: items = keyOf 去重后所有 fresh 并集; seen 只增不减。
 *  INV-D2 有界终止: rounds ≤ maxRounds。
 *  INV-D3 真收敛: converged ⟺ 观测到连续 dryThreshold 轮零新增; exhausted/budget 绝不假报。
 *  INV-D4 反假 dry: dryStreak 只在轮完全成功时推进; roundRunner 抛 → failed/degenerate。
 *  INV-D5 无声截断: exhausted/budget_halt 必 log「覆盖可能不全」(调用方消费 status 同责)。
 *  INV-D6 归一化 key: keyOf 输出归一化 (调用方责任; 引擎只做精确 key 去重, 近重 DEFER)。
 */
import { logger } from '../logger';

export interface DiscoveryConfig<Item> {
  input: string;
  /** 一轮 = 一次 finder/fanout pass → 离散发现项列表。抛错 = 本轮整体崩 (INV-D4)。 */
  roundRunner: (input: string, round: number) => Promise<Item[]>;
  /** 去重身份 (归一化后, 如 `${file}:${line}:${category}` 小写去空白)。稳定跨轮。 */
  keyOf: (item: Item) => string;
  /** 连续 dry 轮数达此值 → 收敛。默认 2。 */
  dryThreshold?: number;
  /** 硬上界 (well-founded 终止)。< 1 钳到 1。 */
  maxRounds: number;
  /** 缺口注入; 缺省 = seen-avoidance (已见 key 注入「别重复找」, 零额外 LLM)。 */
  enrichGap?: (seen: Item[], round: number) => Promise<string> | string;
  /** 可选燃料阀 (D5): remaining() < floor → budget_halt。不驱动质量, 只封顶花费。 */
  budget?: { remaining(): number; floor: number };
}

export type DiscoveryStatus = 'dry' | 'exhausted' | 'budget_halt' | 'failed' | 'degenerate';

export interface DiscoveryRound<Item> {
  round: number;
  found: Item[];
  fresh: Item[];
  dryStreak: number;
}

export interface DiscoveryResult<Item> {
  items: Item[];
  rounds: DiscoveryRound<Item>[];
  status: DiscoveryStatus;
  converged: boolean;
  error?: string;
}

/** 默认缺口注入: 已见 key 清单 → 「别重复找这些」(零额外调用)。 */
function seenAvoidance<Item>(seen: Item[], keyOf: (i: Item) => string): string {
  if (seen.length === 0) return '';
  const keys = seen.map(keyOf).slice(0, 200); // 有界注入, 防 prompt 膨胀
  return `\n\n<already-found>以下发现已登记, 不要重复报告; 找它们之外的新问题:\n${keys.join('\n')}\n</already-found>`;
}

export async function runDiscoveryLoop<Item>(cfg: DiscoveryConfig<Item>): Promise<DiscoveryResult<Item>> {
  const dryThreshold = cfg.dryThreshold ?? 2;
  const maxRounds = Math.max(1, cfg.maxRounds);
  const seen = new Map<string, Item>(); // INV-D1: 只增不减
  const rounds: DiscoveryRound<Item>[] = [];
  let dryStreak = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const gap = cfg.enrichGap
      ? await cfg.enrichGap([...seen.values()], round)
      : seenAvoidance([...seen.values()], cfg.keyOf);
    const input = gap ? `${cfg.input}${gap.startsWith('\n') ? gap : `\n\n${gap}`}` : cfg.input;

    let found: Item[];
    try {
      found = await cfg.roundRunner(input, round);
    } catch (err) {
      // INV-D4: 异常轮绝不推进 dry —— finder 挂了 ≠ 没东西可找。
      const msg = err instanceof Error ? err.message : String(err);
      const status: DiscoveryStatus = round === 1 ? 'degenerate' : 'failed';
      logger.warn({ round, err: msg }, `[discovery] roundRunner 抛 → ${status} (INV-D4: 不当 dry)`);
      return { items: [...seen.values()], rounds, status, converged: false, error: msg };
    }

    const fresh = found.filter((x) => !seen.has(cfg.keyOf(x)));
    for (const x of fresh) seen.set(cfg.keyOf(x), x); // INV-D1
    dryStreak = fresh.length === 0 ? dryStreak + 1 : 0;
    rounds.push({ round, found, fresh, dryStreak });

    // 判停 (SDD §2.3 优先级)。
    if (dryStreak >= dryThreshold) {
      return { items: [...seen.values()], rounds, status: 'dry', converged: true }; // INV-D3 唯一真收敛
    }
    if (round === maxRounds) {
      logger.warn({ rounds: round, items: seen.size }, '[discovery] 触 maxRounds 仍在出新 → exhausted, 覆盖可能不全 (INV-D5)');
      return { items: [...seen.values()], rounds, status: 'exhausted', converged: false };
    }
    if (cfg.budget && cfg.budget.remaining() < cfg.budget.floor) {
      logger.warn({ round, items: seen.size }, '[discovery] 燃料阀触发 → budget_halt, 覆盖可能不全 (INV-D5)');
      return { items: [...seen.values()], rounds, status: 'budget_halt', converged: false };
    }
  }
  // 不可达 (round===maxRounds 分支必返), 防御性兜底。
  return { items: [...seen.values()], rounds, status: 'exhausted', converged: false };
}
