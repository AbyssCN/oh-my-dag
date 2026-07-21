/**
 * src/harness/model-router —— executor leaf 模型选型的**在线学习路由器** (B-2 Q-router, D70 econ 线)。
 *
 * 静态 fleet 路由 (fleet.ts resolveExecutorModel) 是人写死的 prior; 这一层在其上加一个**自演化**
 * 策略: 对每个 bucket (executor kind = inproc/agent), 从一个**配置的候选模型池**里用 ε-greedy 选,
 * 跑完按 reward (leaf 成功 × DAG verifier 是否通过) 更新, 学出"对这类 leaf 哪个模型最划算"。
 *
 * 与 `src/model/routing.ts` (DecideRouting) 正交: 那个是**成本侧**确定性升降级 (预算耗尽强制降级);
 * 这个是**质量侧**学习选型。两者可叠 (budget exhausted 时外层强制 cheap, 不到时 bandit 自由选)。
 *
 * **ship 安全 (开源默认零回归)**: pool 未配 / 单元素 → select 直接返 fallback (= 今天的静态模型),
 * recordReward no-op。用户在 env 列 ≥2 模型才开启学习。冷启动: pool[0] 先被选 (optimistic init 让
 * 每个 arm 先各试一次) → **把静态默认列 pool[0] = day-1 行为等同今天**, 之后才据 reward 偏移。
 *
 * **reward 信号 (2026-07-21 成本化重构)**: 质量是**闸**不是学习信号 —— verifier/tsc 挡不合格产出,
 * bandit 学的是"能通过闸的 arm 里哪个最省" (leafCostReward): leaf 成功闸 (failed=0, 逐叶干净归因)
 * × DAG 软惩罚 (verifier fail → ×0.3, 非清零 — DAG 级连坐是归因噪声, 衰减不放大) × 连续成本效率
 * exp(-costUsd/scale)。二值质量 reward 在个人流量下永不收敛 (均值分不开); 连续成本信号几十次即分。
 *
 * Invariants:
 *  ROUTER-1 model-agnostic: arm = 'provider:modelId' 坐标, 零硬编 provider 分支。
 *  ROUTER-2 no-op 安全: pool ≤1 → select 返 fallback / recordReward 不写 (无"选择"则不学)。
 *  ROUTER-3 reward ∈ [0,1] (越界钳); 增量均值, 不存全历史。
 *  ROUTER-4 只学**配置过的 arm**: recordReward 的 model ∉ pool[bucket] → 丢弃 (防脏数据)。
 *  ROUTER-5 成本主信号: reward = 成功闸 × dag 软惩罚 × exp(-cost/scale); unpriced → 中性 0.5
 *           (fail-open 不奖不罚, 防无价模型靠 cost=0 通吃)。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger';
import { resolveMultimodalPool } from '../model/role-models';
import { computeCost } from '../model/cost-ledger';
import type { PriceTable } from '../model/econ-types';
import type { ModelUsage } from '../model/types';

// 类型单一真理源 = leaf-runners.ts (executor-dag 只认接口形状, 不 import 实现) — 这里 re-export 保旧调用面。
export type { LeafModelRouter } from './leaf-runners';
import type { LeafModelRouter } from './leaf-runners';

export interface ModelRouterOpts {
  /** bucket → 候选模型坐标池 ('provider:modelId')。pool[0] = 静态默认 (冷启动先选它)。 */
  pools?: Record<string, string[]>;
  /** 探索率 (默认 0.1)。 */
  epsilon?: number;
  /** SQLite 路径 (默认 '.omd/model-router.db'); ':memory:' 或注入 db = 瞬时/测试。 */
  path?: string;
  db?: Database;
  /** 注入式随机源 (测试确定化)。默认 Math.random。 */
  rng?: () => number;
}

interface ArmStat {
  n: number;
  mean: number;
}

/** 每 arm 当前状态 (审计 / TUI 展示)。 */
export interface RouterArmEntry {
  bucket: string;
  model: string;
  n: number;
  meanReward: number;
}

export interface ModelRouterHandle extends LeafModelRouter {
  /** 列所有已学 arm 状态 (按 bucket, 再按 meanReward 降序)。 */
  arms(): RouterArmEntry[];
  close(): void;
}

/**
 * 造 ε-greedy executor 选型路由器 (SQLite 持久, 跨 session 复利)。
 *
 * @param opts pools (bucket→候选模型, pool[0]=静态默认) + epsilon + 持久化路径 + 注入 rng
 */
export function createModelRouter(opts: ModelRouterOpts = {}): ModelRouterHandle {
  const pools = opts.pools ?? {};
  const epsilon = opts.epsilon ?? 0.1;
  const rng = opts.rng ?? Math.random;
  const path = opts.path ?? '.omd/model-router.db';
  if (!opts.db && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = opts.db ?? new Database(path);
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS omd_router_arms (
      bucket      TEXT NOT NULL,
      model       TEXT NOT NULL,
      n           INTEGER NOT NULL DEFAULT 0,
      mean_reward REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, model)
    )
  `);
  const qStat = db.query(`SELECT n, mean_reward AS mean FROM omd_router_arms WHERE bucket = ? AND model = ?`);
  const qUpsert = db.query(
    `INSERT INTO omd_router_arms (bucket, model, n, mean_reward) VALUES (?, ?, ?, ?)
     ON CONFLICT(bucket, model) DO UPDATE SET n = excluded.n, mean_reward = excluded.mean_reward`,
  );
  const qAll = db.query(`SELECT bucket, model, n, mean_reward AS meanReward FROM omd_router_arms ORDER BY bucket ASC, mean_reward DESC`);

  const stat = (bucket: string, model: string): ArmStat => {
    const row = qStat.get(bucket, model) as { n: number; mean: number } | null;
    return row ? { n: row.n, mean: row.mean } : { n: 0, mean: 0 };
  };

  return {
    select(bucket, fallback) {
      const pool = pools[bucket];
      // ROUTER-2: 无真实选择 → 静态 fallback (单 arm 时返该 arm, 让用户显式选的模型生效)。
      if (!pool || pool.length === 0) return fallback;
      if (pool.length === 1) return pool[0]!;

      // ε explore: 随机 arm。
      if (rng() < epsilon) {
        const pick = pool[Math.floor(rng() * pool.length)] ?? pool[0]!;
        return pick;
      }
      // exploit: argmax meanReward; 未试 (n=0) → optimistic (+∞) 确保每 arm 先各试一次,
      // 且按 pool 顺序 → pool[0] (静态默认) 冷启动先被选 (day-1 等同今天)。
      let best = pool[0]!;
      let bestScore = -Infinity;
      for (const m of pool) {
        const s = stat(bucket, m);
        const score = s.n === 0 ? Infinity : s.mean;
        if (score > bestScore) {
          bestScore = score;
          best = m;
        }
      }
      return best;
    },

    recordReward(bucket, model, reward) {
      const pool = pools[bucket];
      // ROUTER-2 + ROUTER-4: 无真实选择 / 非配置 arm → 不学 (省 DB 写 + 防脏)。
      if (!pool || pool.length <= 1 || !pool.includes(model)) return;
      const r = Math.max(0, Math.min(1, reward)); // ROUTER-3 钳
      const cur = stat(bucket, model);
      const n = cur.n + 1;
      const mean = cur.mean + (r - cur.mean) / n; // 增量均值, 不存全历史
      qUpsert.run(bucket, model, n, mean);
    },

    arms() {
      return qAll.all() as RouterArmEntry[];
    },
    close() {
      db.close();
    },
  };
}

/**
 * 从 env 读 pool 配置造路由器 (wiring 助手)。OMD_ROUTER_POOL_<BUCKET> = 逗号分隔模型坐标
 * (pool[0]=静态默认); OMD_ROUTER_EPSILON。**未配任何 pool → 仍返路由器但全 no-op** (= 静态)。
 * 开源用户在 .env 列模型即开启学习, 零配置 = 零回归。
 */
export function createModelRouterFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { path?: string; db?: Database; rng?: () => number } = {},
): ModelRouterHandle {
  const pools: Record<string, string[]> = {};
  for (const bucket of ['inproc', 'agent']) {
    const raw = env[`OMD_ROUTER_POOL_${bucket.toUpperCase()}`]?.trim();
    if (raw) {
      const arms = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (arms.length) pools[bucket] = arms;
    }
  }
  // 多模态 leaf 池 (config.multimodalPool, onboard 页多选): bucket 'multimodal'。runtime hook —
  // 多模态 leaf 派发时以 bucket='multimodal' 调 router.select() 即从此池 ε-greedy 选 (mimo/gemini/kimi…)。
  // 单元素/空 → no-op = 静态 (同 inproc/agent 的 ship 安全语义)。
  const mmPool = resolveMultimodalPool();
  if (mmPool.length) pools.multimodal = mmPool;
  const epsilon = env.OMD_ROUTER_EPSILON ? Number.parseFloat(env.OMD_ROUTER_EPSILON) : undefined;
  if (Object.keys(pools).length) {
    logger.info({ pools, epsilon }, '[omd/model-router] bandit 选型启用 (env pool 已配)');
  }
  return createModelRouter({ pools, epsilon: Number.isFinite(epsilon) ? epsilon : undefined, ...opts });
}

// ---------------------------------------------------------------------------
// leafCostReward —— 成本主信号 reward (ROUTER-5, 2026-07-21 成本化重构)。
// ---------------------------------------------------------------------------

/** exp 衰减尺度: 单叶成本 = scale 时 reward≈0.37; 远小于 scale ≈1。默认 $0.005/叶。 */
const DEFAULT_COST_SCALE_USD = 0.005;

/** DAG 级 verifier fail 的软惩罚系数 (连坐是归因噪声 → 衰减不清零, 成本项仍主导学习)。 */
const DAG_FAIL_FACTOR = 0.3;

export interface LeafRewardOpts {
  /** exp 衰减尺度 (USD)。默认 env OMD_ROUTER_COST_SCALE 或 0.005。 */
  scaleUsd?: number;
  /** 注入价表 (测试)。默认 DEFAULT_PRICES。 */
  prices?: PriceTable;
}

/**
 * 单叶 reward ∈ [0,1]:
 *   failed leaf → 0 (逐叶干净归因, 失败 = 白烧)。
 *   done leaf   → dagFactor × costFactor
 *     dagFactor  = verifier fail 时 0.3 (软惩罚), 无 verifier / pass 时 1。
 *     costFactor = exp(-costUsd/scale) — 连续、单调、有界; 便宜 arm 高分。
 *     unpriced (价表无坐标) → 0.5 中性 (不奖不罚, 防 cost=0 通吃; 补价表即启成本学习)。
 */
export function leafCostReward(
  leaf: { status: string; model?: string; usage?: ModelUsage },
  dagPass: boolean | undefined,
  opts: LeafRewardOpts = {},
): number {
  if (leaf.status !== 'done') return 0;
  const dagFactor = dagPass === false ? DAG_FAIL_FACTOR : 1;
  if (!leaf.model || !leaf.usage) return 0.5 * dagFactor; // 无计量 → 中性
  const scale = opts.scaleUsd ?? envCostScale() ?? DEFAULT_COST_SCALE_USD;
  const { costUsd, unpriced } = computeCost(leaf.usage, leaf.model, opts.prices);
  const costFactor = unpriced ? 0.5 : Math.exp(-costUsd / scale);
  return dagFactor * costFactor;
}

function envCostScale(): number | undefined {
  const raw = process.env.OMD_ROUTER_COST_SCALE?.trim();
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
