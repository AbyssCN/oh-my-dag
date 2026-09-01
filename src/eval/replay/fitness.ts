/**
 * src/eval/replay/fitness —— 回放评估器的 fitness 向量 (P1 契约 C-3, 2026-09-01)。
 *
 * 一张 plan + 原始文本 → 机械 fitness (零 LLM 判)。维:
 *   - planValidity: boolean (parsePlan ok, 复用 src/harness/conductor-plan)
 *   - fakeSerialPairs: number (假串行对计数, 详见 fakeSerialPairsOf)
 *   - speedupTheoretical: number | null (plan 口径理论加速比, 全 0 cost → null)
 *   - shapeDeclared: boolean (顶层 plan.shape 是否声明)
 *   - planningTokens: number (原始文本 token 估算, chars/4 启发式)
 *
 * 聚合: aggregateFitness(per-plan results) → rate/total/median 版。
 * shape 声明率与 planValidity 率都是按 n 归一的 0..1 数, 中位数忽略 null。
 *
 * 反向自检 (锁死判据力, 同 corpus.test.ts 注释惯例):
 *   - 在 fakeSerialPairsOf 中删 hasObservableOutput 那条早期 continue → fakeSerialPairs 从
 *     0 跳到 ≥1 (CLEAN fixture 立刻红);
 *   - 把 speedupTheoreticalOf 的 costOf 默认值从 0 改成 1 → critical 与 total 都变,
 *     clean fixture (3 节点全串行) 的 speedup 仍 = 1 但 fake-serial 变 1.0 而非 4/3;
 *   - 在 aggregateFitness 把 `valid++` 那行改成无效运算 → planValidityRate 立刻归 0
 *     (全 valid 集合也红, 证聚合真在数)。
 *
 * 决策: speedupTheoretical 走 plan 拓扑 (Σcost / criticalPath), 不用执行读数 (P0 片 1 修
 * 完 speedup-readout 之前的过渡形态)。全 0 cost → null, 严格 NULL 不编 0。
 */
import type { ConductorPlan } from '../../harness/conductor-plan';
import { parsePlan } from '../../harness/conductor-plan';

/** 单 plan 节点的形状 (PlanNode 是 zod 内部类型, 不导出, 推导 ConductorPlan['nodes'][string] 拿)。 */
type PlanNode = ConductorPlan['nodes'][string];

/** computeFitness / parsePlanAtOnce 的输入: 已通过 zod 校验的 plan + 原始文本。 */
export interface PlanFitnessInput {
  plan: ConductorPlan;
  /** parsePlan 校验用的原始模型回复 (亦用于 planningTokens 估算)。 */
  rawText: string;
}

/** 单 plan 的 fitness 向量。所有维机械算, 零 LLM 判。 */
export interface PlanFitness {
  /** parsePlan ok:true → plan 形态合格 (与 plan-validity.ts 同尺, 不写第二个判定)。 */
  planValidity: boolean;
  /** 假串行对计数: depends_on 边中「无可观察输出 ∧ 文本不含依赖 id」的对数。 */
  fakeSerialPairs: number;
  /**
   * plan 口径理论加速比 = Σcost / criticalPathCost。
   * - cost 节点 = budgetBasis.calls ?? 0;
   * - 全 0 cost → null (尺未修, NULL 不编 0);
   * - critical ≤ 0 (空图) → null。
   */
  speedupTheoretical: number | null;
  /** 顶层 plan.shape 是否声明 (非空字符串)。聚合层按 n 归一成 0..1 比率。 */
  shapeDeclared: boolean;
  /** 原始文本 token 估算 (chars/4 启发式, 跨家族稳定, 不绑具体 tokenizer)。 */
  planningTokens: number;
}

/** 多 plan 聚合: rate/total/median 版。speedupTheoreticalMedian 忽略 null (全 null → null)。 */
export interface AggregatedFitness {
  planValidityRate: number;
  fakeSerialPairsTotal: number;
  speedupTheoreticalMedian: number | null;
  shapeDeclarationRate: number;
  planningTokensTotal: number;
  n: number;
}

// ─── 假串行对 ──────────────────────────────────────────────────────────────

/**
 * 假串行对计数: depends_on 边中「无可观察输出 ∧ 文本不含依赖 id」的对数。
 *
 * 判定 (机械, 双条件):
 *   1. 被依赖端 B 无 `output_path` ∧ output_type 不是 'structured' / 'file'
 *      (即无可被 A 读取 / 解析的产物);
 *   2. 依赖端 A 的 goal/args/postcondition.spec 拼接串不含 B.id (无文本引用)。
 *
 * 两条件都满足 → 边不可能承载真实数据流, 即「为排序而 depends_on」的假串行。
 * 备注: 此判定**不**判「goal 是否真消费了 B 的产物」(那是语义判断), 只判「从结构上看
 *       没有可消费的产物也没有显式引用」。PlanSchema superRefine 已挡环, 此处不重检。
 */
export function fakeSerialPairsOf(plan: ConductorPlan): number {
  let count = 0;
  for (const [idA, nodeA] of Object.entries(plan.nodes)) {
    const deps = nodeA.depends_on ?? [];
    if (deps.length === 0) continue;
    const haystack = haystackOf(nodeA);
    for (const idB of deps) {
      if (!(idB in plan.nodes)) continue; // 悬空 deps 让 schema 挡; 这里跳过
      const nodeB = plan.nodes[idB]!;
      const hasObservableOutput =
        typeof nodeB.output_path === 'string' ||
        nodeB.output_type === 'structured' ||
        nodeB.output_type === 'file';
      if (hasObservableOutput) continue;
      if (haystack.includes(idB)) continue;
      count++;
    }
  }
  return count;
}

/** 把 A 节点「可能含依赖 id 引用」的字段拼成一个查找串。 */
function haystackOf(node: PlanNode): string {
  const goal = typeof node.goal === 'string' ? node.goal : '';
  const args = node.args ?? {};
  const spec = (node.postcondition?.spec ?? {}) as Record<string, unknown>;
  return JSON.stringify({ goal, args, spec });
}

// ─── 理论加速比 ────────────────────────────────────────────────────────────

/**
 * plan 口径理论加速比 = Σcost / criticalPathCost。
 *
 * 节点成本 = budgetBasis.calls (number) || 0。PlanSchema 已挡环, DFS 记忆化递归
 * 求最长链即可。全 0 cost (没有 budgetBasis.calls 的 plan) → null (尺未修)。
 *
 * 备注: critical path 不含 0 cost 节点会让分母为 0 — 0 cost 节点只走 pass-through
 * (不增长关键路径), 这与 speedup-readout 的 NULL pass-through 同形。
 */
export function speedupTheoreticalOf(plan: ConductorPlan): number | null {
  const ids = Object.keys(plan.nodes);
  if (ids.length === 0) return null;
  const total = ids.reduce((sum, id) => sum + costOf(plan.nodes[id]!), 0);
  if (total <= 0) return null;
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0; // 环防御 (PlanSchema 已挡, 这里兜底)
    stack.add(id);
    const node = plan.nodes[id]!;
    const deps = node.depends_on ?? [];
    let best = 0;
    for (const d of deps) {
      if (!(d in plan.nodes)) continue;
      const sub = visit(d, stack);
      if (sub > best) best = sub;
    }
    stack.delete(id);
    const v = costOf(node) + best;
    memo.set(id, v);
    return v;
  };
  let critical = 0;
  for (const id of ids) {
    const v = visit(id, new Set());
    if (v > critical) critical = v;
  }
  if (critical <= 0) return null;
  return total / critical;
}

function costOf(node: PlanNode): number {
  const calls = (node as { budgetBasis?: { calls?: unknown } }).budgetBasis?.calls;
  return typeof calls === 'number' && Number.isFinite(calls) && calls >= 0 ? calls : 0;
}

// ─── token 估算 ────────────────────────────────────────────────────────────

/** char/4 启发式 token 估算, 跨家族稳定, 不绑具体 tokenizer (合同 §回放评估器 §3 落字)。 */
export function estimateTokens(rawText: string): number {
  return Math.ceil(rawText.length / 4);
}

// ─── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 单 plan → fitness。
 *
 * parsePlan 自己不抛 (ok|error 二选一, 与 plan-validity.ts 同尺), 所以这里也不抛;
 * planValidity 维直接走 parsePlan 结果。注: 本函数不**重复**做 parsePlan 校验
 * (plan 入参已通过 ConductorPlan = z.infer<typeof PlanSchema>), 这里调用 parsePlan
 * 是为了**严格按 rawText 重测** —— plan-validity.ts 的复用点在另一文件, 本尺子
 * 自包含即可。
 */
export function computeFitness(input: PlanFitnessInput): PlanFitness {
  const parsed = parsePlan(input.rawText, {
    knownTemplates: new Set(),
    knownServers: new Set(),
  });
  return {
    planValidity: parsed.ok,
    fakeSerialPairs: fakeSerialPairsOf(input.plan),
    speedupTheoretical: speedupTheoreticalOf(input.plan),
    shapeDeclared: typeof input.plan.shape === 'string' && input.plan.shape.length > 0,
    planningTokens: estimateTokens(input.rawText),
  };
}

/**
 * 多 plan fitness 聚合。speedupTheoretical 中位忽略 null (全 null → null)。
 * n=0 → 全部 0 / null 兜底 (无信号 ≠ 满分)。
 */
export function aggregateFitness(results: readonly PlanFitness[]): AggregatedFitness {
  const n = results.length;
  if (n === 0) {
    return {
      planValidityRate: 0,
      fakeSerialPairsTotal: 0,
      speedupTheoreticalMedian: null,
      shapeDeclarationRate: 0,
      planningTokensTotal: 0,
      n: 0,
    };
  }
  let valid = 0;
  let fakeTotal = 0;
  let shapeDeclaredCount = 0;
  let tokensTotal = 0;
  const speedups: number[] = [];
  for (const r of results) {
    if (r.planValidity) valid++;
    fakeTotal += r.fakeSerialPairs;
    if (r.shapeDeclared) shapeDeclaredCount++;
    tokensTotal += r.planningTokens;
    if (r.speedupTheoretical !== null) speedups.push(r.speedupTheoretical);
  }
  return {
    planValidityRate: valid / n,
    fakeSerialPairsTotal: fakeTotal,
    speedupTheoreticalMedian: median(speedups),
    shapeDeclarationRate: shapeDeclaredCount / n,
    planningTokensTotal: tokensTotal,
    n,
  };
}

/** 升序排序后中位数;空数组 → NaN (上层 speedupTheoreticalMedian 用前过滤 null, 不会触)。 */
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = sorted.length;
  if (m % 2 === 1) return sorted[(m - 1) >> 1]!;
  return (sorted[m / 2 - 1]! + sorted[m / 2]!) / 2;
}