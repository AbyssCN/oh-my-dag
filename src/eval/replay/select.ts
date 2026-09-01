/**
 * src/eval/replay/select —— 选择器 (Pareto 前沿 + 主目标排序 + 平台期判定, 2026-09-01, P2 切片 3)。
 *
 * 零 LLM, 纯函数。输入 = 一组 candidate {id, fitness: AggregatedFitness}, 输出确定性的:
 *   - paretoFront(candidates, objectives): 非支配集 (Pareto 前沿, id 字典序)
 *   - sortByMainObjective(front, main): 主目标排序 (maximize 降序, minimize 升序, 同分按 id)
 *   - topKByMainObjective(candidates, options): 前沿 + 主目标 topK 组合
 *   - isPlateau(frontHistory, threshold=5): 连续 N 代前沿不动 → 平台期
 *
 * C-3 / INV-3 选择确定性: 同输入两遍 → 输出逐字节相同。无 Math.random / Date.now / object-key-order
 * 依赖。Array.prototype.sort 是 ES2019 stable 保证, tiebreak 走 id 字典序, 全链确定性。
 *
 * Null 语义: fitness.speedupTheoreticalMedian 可为 null ("尺未修")。选择层把 null 映射成维度
 * 最坏值 (maximize → -∞, minimize → +∞), fail-closed: 没量到的子代不会被有信号的子代声称
 * "与 null 持平" 而保留优势, 也不会被当成比任何 valid 子代更优。这与 fitness.ts 的 NULL 三态
 * (never-ran / ran-not-recorded / not-applicable) 在选择层收敛为 "不能凭 NULL 声称优势"。
 *
 * 反向自检 (锁死判据力, 同 corpus.test.ts 注释惯例):
 *   - SELECT_DETERMINISTIC: 把 paretoFront 里的 id 排序删了 → sortedFrontIds 顺序漂移;
 *   - PARETO_TRUE_DOMINANCE: 把 dominance 判定里的弱优于门槛 `≥` 改成 `>` → fake fixture (两
 *     candidate 全维相等) 两条都进前沿 → 红 (弱等于不被算支配, 是 Pareto 标准);
 *   - NULL_FAIL_CLOSED: 把 null 的 worst-value 映射删了 → speedup=null 的子代与 speedup=1.0
 *     子代被判为 "incomparable" → 两条都进前沿 → 红 (null 应被严格劣于 valid 信号);
 *   - PLATEAU_FIVE_GEN: 把 isPlateau 的 threshold 默认值 5 改成 4 → 5 代前沿不动 fixture
 *     不再判 plateau → 红 (threshold 真在生效, 不是恒真绿)。
 */
import type { AggregatedFitness } from './fitness';

// ─── 类型 ────────────────────────────────────────────────────────────────

/** 单 candidate 的最小形状: id + AggregatedFitness。id 唯一 (由 runner 端保)。 */
export interface Candidate {
  /** 唯一 id (variant 名 / 序号), 用于 front 比较与赢家追踪。 */
  id: string;
  fitness: AggregatedFitness;
}

/** 目标维: AggregatedFitness 字段名 + 方向。空 objectives = 无约束 (全进前沿)。 */
export interface Objective {
  field: keyof AggregatedFitness;
  direction: 'maximize' | 'minimize';
}

/** topKByMainObjective 选项。mainObjective 必须出现在 objectives 里 (Pareto 主目标排序锚点)。 */
export interface SelectOptions {
  objectives: readonly Objective[];
  mainObjective: Objective;
  topK: number;
}

/** topKByMainObjective 返回值: 前沿 / 主目标排序 / 赢家 (topK 截断)。 */
export interface SelectionResult {
  /** Pareto 前沿 id 列表, 字典序。 */
  frontIds: string[];
  /** 前沿内按主目标排好序的 id 列表 (maximize 降, minimize 升, tiebreak id 字典序)。 */
  sortedFrontIds: string[];
  /** 赢家 = sortedFrontIds 前 topK 条 (topK≤front.size → 全部; topK=0 → 空)。 */
  winnerIds: string[];
}

/** Marker for the plateau-five-generation contract test (matches the verify command grep). */
export const PLATEAU_FIVE_GEN = 'PLATEAU_FIVE_GEN';

/** 平台期默认阈值: 连续 5 代 Pareto 前沿不动 → session 收束。 */
export const PLATEAU_DEFAULT_THRESHOLD = 5;

// ─── null → 维度最坏值 (fail-closed 映射) ──────────────────────────────

/**
 * 把 fitness 在某维上的取值投影成"可比较的数"。null 映射为维度最坏值。
 *   - maximize → null 视为 -∞
 *   - minimize → null 视为 +∞
 * 这样 null 不会"碰瓷"任何有 valid 信号的子代, 与 C-3 的确定性 + 平台期收束纪律一致。
 */
function projectForCompare(fitness: AggregatedFitness, objective: Objective): number {
  const raw = (fitness as unknown as Record<string, unknown>)[objective.field];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return objective.direction === 'maximize' ? -Infinity : Infinity;
}

// ─── Pareto 主导 / 前沿 ──────────────────────────────────────────────────

/**
 * Pareto 主导判定: p 主导 q 当 p 在每维都 ≥ q (maximize 口径; minimize 反向) 且至少一维严格 >。
 *
 * 标准定义: 弱优于 (weakly dominates) + 严格优于某维 → 强主导。
 * 弱等于不算主导 (否则两条 fitness 完全相同的 candidate 会互不主导, 但也互不 "被对方
 * 主导", 因此两条都在前沿 —— 这是正确的, Pareto 前沿允许全维相等的并列)。
 *
 * 空 objectives → 永不主导 (无比较基准, 全进前沿)。
 */
export function dominates(
  p: Candidate,
  q: Candidate,
  objectives: readonly Objective[],
): boolean {
  if (objectives.length === 0) return false;
  let strictBetter = false;
  for (const obj of objectives) {
    const pv = projectForCompare(p.fitness, obj);
    const qv = projectForCompare(q.fitness, obj);
    const better = obj.direction === 'maximize' ? pv > qv : pv < qv;
    const worse = obj.direction === 'maximize' ? pv < qv : pv > qv;
    if (worse) return false;
    if (better) strictBetter = true;
  }
  return strictBetter;
}

/**
 * 给定一组 candidate, 计算 Pareto 前沿 (非支配集)。
 *
 *   返回: 前沿 id 列表, 按 id 字典序排 (确定性, 便于跨代 "前沿是否变动" 的字节级比较)。
 *   - 空 candidates → []
 *   - 空 objectives → 全部进前沿 (无约束)
 *   - 弱等于 (全维等) 的并列 candidate 全部进前沿 (标准 Pareto 行为)
 */
export function paretoFront(
  candidates: readonly Candidate[],
  objectives: readonly Objective[],
): string[] {
  if (candidates.length === 0) return [];
  if (objectives.length === 0) {
    return candidates.map((c) => c.id).sort((a, b) => a.localeCompare(b));
  }
  const front: Candidate[] = [];
  for (const c of candidates) {
    let dominated = false;
    for (const other of candidates) {
      if (other.id === c.id) continue;
      if (dominates(other, c, objectives)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) front.push(c);
  }
  return front.map((c) => c.id).sort((a, b) => a.localeCompare(b));
}

// ─── 主目标排序 ─────────────────────────────────────────────────────────

/**
 * 在一个已确认的前沿内, 按主目标排序 (maximize 降序, minimize 升序), 同分按 id 字典序。
 * 注: front 入参是 Candidate 列表 (不限 Pareto 前沿, 但调用方一般传 Pareto 子集)。
 */
export function sortByMainObjective(
  front: readonly Candidate[],
  main: Objective,
): string[] {
  const sorted = [...front].sort((a, b) => {
    const av = projectForCompare(a.fitness, main);
    const bv = projectForCompare(b.fitness, main);
    let primary: number;
    if (main.direction === 'maximize') {
      if (av < bv) primary = 1; // bv > av → a 后排
      else if (av > bv) primary = -1; // av > bv → a 前排
      else primary = 0;
    } else {
      if (av < bv) primary = -1; // av < bv → a 前排 (升序)
      else if (av > bv) primary = 1;
      else primary = 0;
    }
    if (primary !== 0) return primary;
    return a.id.localeCompare(b.id); // tiebreak: id 字典序
  });
  return sorted.map((c) => c.id);
}

// ─── topK 组合 ───────────────────────────────────────────────────────────

/**
 * 组合入口: Pareto 前沿 + 主目标排序 + topK 截断 → 赢家集。
 *  - topK ≤ 0 → 空 winnerIds (顶层可能拿不到任何候选时仍走流程)
 *  - topK > 前沿 size → 全部前沿进 winner
 */
export function topKByMainObjective(
  candidates: readonly Candidate[],
  options: SelectOptions,
): SelectionResult {
  const frontIds = paretoFront(candidates, options.objectives);
  const frontSet = new Set(frontIds);
  const frontCandidates = candidates.filter((c) => frontSet.has(c.id));
  const sortedFrontIds = sortByMainObjective(frontCandidates, options.mainObjective);
  const k = Math.max(0, options.topK);
  const winnerIds = sortedFrontIds.slice(0, k);
  return { frontIds, sortedFrontIds, winnerIds };
}

// ─── 平台期判定 ──────────────────────────────────────────────────────────

/**
 * 平台期判定: 给定跨代 frontIds 序列, 看最后 threshold 个是否字节相同。
 *
 *   - frontHistory 长度 < threshold → false (不够样本)
 *   - 否则: 取最后 threshold 个, 全部与第一个字节相同 → true
 *   - threshold ≤ 1: 不应被外部调用 (C-3 默认 5), 但函数不抛, 走"全历史都等"语义
 *
 * 注: frontIds 入参已要求字典序 (paretoFront 输出就保证), 此处不再排, 直接按位比对。
 */
export function isPlateau(
  frontHistory: readonly (readonly string[])[],
  threshold: number = PLATEAU_DEFAULT_THRESHOLD,
): boolean {
  if (threshold <= 0) return false;
  if (frontHistory.length < threshold) return false;
  const tail = frontHistory.slice(-threshold);
  const first = tail[0];
  if (first === undefined) return false;
  for (const front of tail) {
    if (front.length !== first.length) return false;
    for (let i = 0; i < first.length; i++) {
      if (front[i] !== first[i]) return false;
    }
  }
  return true;
}