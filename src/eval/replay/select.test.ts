/**
 * `src/eval/replay/select.ts` 契约 C-3 / INV-3 选择确定性真值链断言 (P2 切片 3, 2026-09-01)。
 *
 * 真值链 (四段, 逐跳写在每个 describe 注释里):
 *   · SELECT_DETERMINISTIC: 同输入两遍 → 输出逐字节相同 (frontIds / sortedFrontIds / winnerIds);
 *   · PARETO_TRUE_DOMINANCE: 弱等于不算主导 (标准 Pareto), 全维相等的两条全进前沿;
 *     严格优于的一方独占前沿; trade-off 双方都进;
 *   · NULL_FAIL_CLOSED: speedup=null 的子代被 valid 子代严格劣于 (null → 维度最坏值),
 *     不会"凭 null 持平"留在前沿;
 *   · PLATEAU_FIVE_GEN: 连续 5 代 frontIds 字节相同 → 平台期 = true; 第 5 代不同 / 历史不足 → false。
 *
 * 反向自检 (锁死判据力, 改实现 → 立刻红):
 *   - 把 paretoFront 里 `if (!dominated) front.push(c)` 改成 push 所有 candidate →
 *     PARETO_TRUE_DOMINANCE 红 (被严格支配的子代也在前沿);
 *   - 把 dominates 里的 `strictBetter` 删了, 让弱等于也算主导 → 全维相等的两条 fixture 中
 *     只剩一条在 front → 红 (标准 Pareto 不允许这种"互不主导但也不并列"形态);
 *   - 把 projectForCompare 的 null 映射删了, 让 null 直接 typeof check 抛 → NULL_FAIL_CLOSED
 *     红 (null-bearing 子代不该进入"不可比"形态);
 *   - 把 isPlateau 的 `frontHistory.length < threshold` 守卫删了, 让长度 < threshold 也走
 *     字节比对 → 历史长度 3 / threshold 5 时返 true → 红 (样本不足不该判 plateau);
 *   - 把 PLATEAU_DEFAULT_THRESHOLD 从 5 改成 4 → PLATEAU_FIVE_GEN 红 (threshold 改了, 默认
 *     fixture 不再被判 plateau)。
 */
import { describe, expect, test } from 'bun:test';
import {
  PLATEAU_DEFAULT_THRESHOLD,
  PLATEAU_FIVE_GEN,
  dominates,
  isPlateau,
  paretoFront,
  sortByMainObjective,
  topKByMainObjective,
  type Candidate,
  type Objective,
} from './select';
import type { AggregatedFitness } from './fitness';

// ─── fixture helpers ──────────────────────────────────────────────────────

/** 默认 objective 集 (P2 内环主用 5 维, 与 fitness.ts:AggregatedFitness 对齐)。 */
const DEFAULT_OBJECTIVES: readonly Objective[] = [
  { field: 'planValidityRate', direction: 'maximize' },
  { field: 'fakeSerialPairsTotal', direction: 'minimize' },
  { field: 'speedupTheoreticalMedian', direction: 'maximize' },
  { field: 'shapeDeclarationRate', direction: 'maximize' },
  { field: 'planningTokensTotal', direction: 'minimize' },
];

/** 主目标: P2 基质 = conductor 提示面, 最自然的单维主信号 = speedup。 */
const MAIN_SPEEDUP: Objective = { field: 'speedupTheoreticalMedian', direction: 'maximize' };

/** 构造一个 candidate。n 是 plan 计数 (AggregatedFitness.n), 用作其他维的乘基。 */
function makeCandidate(id: string, partial: Partial<AggregatedFitness> = {}): Candidate {
  const n = partial.n ?? 6;
  const fitness: AggregatedFitness = {
    planValidityRate: 1,
    fakeSerialPairsTotal: 0,
    speedupTheoreticalMedian: 1,
    speedupCostBasis: 'declared',
    shapeDeclarationRate: 0,
    planningTokensTotal: 100 * n,
    n,
    ...partial,
  };
  return { id, fitness };
}

// =====================================================================
// SELECT_DETERMINISTIC — 同输入两遍 → 输出逐字节相同 (P2 C-3 / INV-3)
// =====================================================================
describe('SELECT_DETERMINISTIC — 选择器确定性 (C-3 / INV-3)', () => {
  test('paretoFront 同输入两遍 → frontIds 字节相同', () => {
    const cs = [
      makeCandidate('a', { speedupTheoreticalMedian: 1.5, shapeDeclarationRate: 0.3 }),
      makeCandidate('b', { speedupTheoreticalMedian: 1.2, shapeDeclarationRate: 0.8 }),
      makeCandidate('c', { speedupTheoreticalMedian: 1.0, fakeSerialPairsTotal: 5 }),
    ];
    const f1 = paretoFront(cs, DEFAULT_OBJECTIVES);
    const f2 = paretoFront(cs, DEFAULT_OBJECTIVES);
    expect(f1.length).toBe(f2.length);
    // 字节级比对 (跨调用, 不是同引用): join 后字符串相等
    expect(f1.join('|')).toBe(f2.join('|'));
    expect(JSON.stringify(f1)).toBe(JSON.stringify(f2));
  });

  test('paretoFront 输入顺序无关: 候选重排 → 同一前沿 (id 集合相同)', () => {
    const cs1 = [
      makeCandidate('alpha'),
      makeCandidate('bravo'),
      makeCandidate('charlie'),
      makeCandidate('delta'),
    ];
    const cs2 = [cs1[3]!, cs1[1]!, cs1[0]!, cs1[2]!];
    const f1 = paretoFront(cs1, DEFAULT_OBJECTIVES);
    const f2 = paretoFront(cs2, DEFAULT_OBJECTIVES);
    expect(f1).toEqual(f2);
  });

  test('topKByMainObjective 同输入两遍 → SelectionResult 三个字段全字节相同', () => {
    // 真值链: 5 candidate Pareto 全部入前沿 (速度/假串行各 trade-off),
    //   主目标 speedup 排序 → b > a > c > e > d, topK=2 → [b, a]
    const cs = [
      makeCandidate('a', { speedupTheoreticalMedian: 1.5, fakeSerialPairsTotal: 5 }),
      makeCandidate('b', { speedupTheoreticalMedian: 2.0, fakeSerialPairsTotal: 3 }),
      makeCandidate('c', { speedupTheoreticalMedian: 1.2, fakeSerialPairsTotal: 2 }),
      makeCandidate('d', { speedupTheoreticalMedian: 0.8, fakeSerialPairsTotal: 0 }),
      makeCandidate('e', { speedupTheoreticalMedian: 1.0, fakeSerialPairsTotal: 1 }),
    ];
    const r1 = topKByMainObjective(cs, {
      objectives: DEFAULT_OBJECTIVES,
      mainObjective: MAIN_SPEEDUP,
      topK: 2,
    });
    const r2 = topKByMainObjective(cs, {
      objectives: DEFAULT_OBJECTIVES,
      mainObjective: MAIN_SPEEDUP,
      topK: 2,
    });
    // 字节级比对 (跨调用, 不是同引用): join 后字符串相等
    expect(r1.frontIds.join('|')).toBe(r2.frontIds.join('|'));
    expect(r1.sortedFrontIds.join('|')).toBe(r2.sortedFrontIds.join('|'));
    expect(r1.winnerIds.join('|')).toBe(r2.winnerIds.join('|'));
    // 序列化比对 (跨结构 byte 级)
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  test('isPlateau 同输入两遍 → 字节相同', () => {
    const h = [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b']];
    expect(isPlateau(h)).toBe(isPlateau(h));
    expect(isPlateau(h, 5)).toBe(true);
    expect(isPlateau(h, 4)).toBe(true);
  });

  test('CONTROL: 空候选列表 → 空前沿 (边界不抛)', () => {
    expect(paretoFront([], DEFAULT_OBJECTIVES)).toEqual([]);
    expect(paretoFront([], [])).toEqual([]);
  });
});

// =====================================================================
// PARETO_TRUE_DOMINANCE — Pareto 主导 / 前沿判定 (P2 C-3)
// =====================================================================
describe('PARETO_TRUE_DOMINANCE — 主导判定与前沿构成', () => {
  test('严格支配: p 在每维都 ≥ q 且至少一维 > → p 主导 q, q 不在前列', () => {
    // 真值链:
    //   p: planValidityRate=1, fakeSerialPairsTotal=0, speedup=2, shape=0.5, tokens=300
    //   q: planValidityRate=1, fakeSerialPairsTotal=2, speedup=1, shape=0.3, tokens=400
    //   p 在每维都严格 ≥ q (maximize 维 p > q, minimize 维 p < q) →
    //   dominates(p, q, ...) === true
    //   前沿 = [p]
    const p = makeCandidate('p', {
      fakeSerialPairsTotal: 0,
      speedupTheoreticalMedian: 2,
      shapeDeclarationRate: 0.5,
      planningTokensTotal: 300,
    });
    const q = makeCandidate('q', {
      fakeSerialPairsTotal: 2,
      speedupTheoreticalMedian: 1,
      shapeDeclarationRate: 0.3,
      planningTokensTotal: 400,
    });
    expect(dominates(p, q, DEFAULT_OBJECTIVES)).toBe(true);
    expect(dominates(q, p, DEFAULT_OBJECTIVES)).toBe(false);
    const front = paretoFront([p, q], DEFAULT_OBJECTIVES);
    expect(front).toEqual(['p']);
  });

  test('弱等于: 全维相等的两条都进前沿 (Pareto 标准: 弱等于不构成主导)', () => {
    // 真值链: a 与 b fitness 字段全相同 → 任一维都无 strictBetter →
    //   dominates(a, b) = false 且 dominates(b, a) = false → 两条都进前沿
    const a = makeCandidate('a');
    const b = makeCandidate('b'); // 默认 fitness 同 a
    expect(dominates(a, b, DEFAULT_OBJECTIVES)).toBe(false);
    expect(dominates(b, a, DEFAULT_OBJECTIVES)).toBe(false);
    expect(paretoFront([a, b], DEFAULT_OBJECTIVES).sort()).toEqual(['a', 'b']);
  });

  test('trade-off: 速度赢 vs 假串行赢 → 双方都进前沿', () => {
    // 真值链:
    //   x: speedup=2 (高), fakeSerialPairsTotal=5 (高) → 速度赢
    //   y: speedup=1 (低), fakeSerialPairsTotal=0 (低) → 假串行赢
    //   x 在 speedup 上 > y, 但 fakeSerialPairs 上 < y (更差) →
    //   x 不主导 y, y 不主导 x → 两条都进前沿
    const x = makeCandidate('x', { speedupTheoreticalMedian: 2, fakeSerialPairsTotal: 5 });
    const y = makeCandidate('y', { speedupTheoreticalMedian: 1, fakeSerialPairsTotal: 0 });
    expect(dominates(x, y, DEFAULT_OBJECTIVES)).toBe(false);
    expect(dominates(y, x, DEFAULT_OBJECTIVES)).toBe(false);
    expect(paretoFront([x, y], DEFAULT_OBJECTIVES).sort()).toEqual(['x', 'y']);
  });

  test('三 candidate: 全维最优者独占前沿 (主导者 + 被主导的两条都退出)', () => {
    // 真值链:
    //   big: validity=1, fakeSerial=0, speedup=3, shape=1, tokens=200 — 全维都最优
    //   x:   validity=1, fakeSerial=5, speedup=2, shape=0.5, tokens=300 — big 主导 x
    //   y:   validity=1, fakeSerial=0, speedup=1, shape=0.2, tokens=250 — big 主导 y
    //   x 与 y 之间 trade-off (x 速度赢, y 假串行赢), 但 trade-off 不能把它们救回前沿
    //   —— 已被 big 严格主导的 candidate 永远退出, 不论是否被另一个非主导者主导。
    //   前沿 = [big]
    const big = makeCandidate('big', {
      fakeSerialPairsTotal: 0,
      speedupTheoreticalMedian: 3,
      shapeDeclarationRate: 1,
      planningTokensTotal: 200,
    });
    const x = makeCandidate('x', {
      fakeSerialPairsTotal: 5,
      speedupTheoreticalMedian: 2,
      shapeDeclarationRate: 0.5,
      planningTokensTotal: 300,
    });
    const y = makeCandidate('y', {
      fakeSerialPairsTotal: 0,
      speedupTheoreticalMedian: 1,
      shapeDeclarationRate: 0.2,
      planningTokensTotal: 250,
    });
    expect(dominates(big, x, DEFAULT_OBJECTIVES)).toBe(true);
    expect(dominates(big, y, DEFAULT_OBJECTIVES)).toBe(true);
    // trade-off 验证: x 与 y 之间任一都不主导
    expect(dominates(x, y, DEFAULT_OBJECTIVES)).toBe(false);
    expect(dominates(y, x, DEFAULT_OBJECTIVES)).toBe(false);
    // 但主导者已吞掉两者 → 前沿只剩 [big]
    expect(paretoFront([big, x, y], DEFAULT_OBJECTIVES)).toEqual(['big']);
  });

  test('空 objectives = 无比较基准 → 全部进前沿', () => {
    const cs = [
      makeCandidate('a', { speedupTheoreticalMedian: 5 }),
      makeCandidate('b', { speedupTheoreticalMedian: 1 }),
      makeCandidate('c', { speedupTheoreticalMedian: 3 }),
    ];
    expect(paretoFront(cs, []).sort()).toEqual(['a', 'b', 'c']);
    expect(dominates(cs[0]!, cs[1]!, [])).toBe(false);
  });

  test('单维度 objective: 速度最高的独占前沿', () => {
    const cs = [
      makeCandidate('a', { speedupTheoreticalMedian: 1 }),
      makeCandidate('b', { speedupTheoreticalMedian: 3 }),
      makeCandidate('c', { speedupTheoreticalMedian: 2 }),
    ];
    const front = paretoFront(cs, [MAIN_SPEEDUP]);
    expect(front).toEqual(['b']);
  });
});

// =====================================================================
// NULL_FAIL_CLOSED — null-bearing 子代被严格劣于 valid 信号
// =====================================================================
describe('NULL_FAIL_CLOSED — speedup=null 在选择层被 fail-closed', () => {
  test('null-bearing 子代与 valid 子代: valid 严格胜出, null 被剔除', () => {
    // 真值链: a 的 speedupTheoreticalMedian = null ("尺未修"), b = 1.0
    //   在 speedupTheoreticalMedian (maximize) 上, null → -∞, b=1.0
    //   b 严格 > a → b 主导 a (其余维都相等) → 前沿 = [b]
    const a = makeCandidate('a', { speedupTheoreticalMedian: null });
    const b = makeCandidate('b', { speedupTheoreticalMedian: 1 });
    expect(dominates(b, a, DEFAULT_OBJECTIVES)).toBe(true);
    expect(dominates(a, b, DEFAULT_OBJECTIVES)).toBe(false);
    expect(paretoFront([a, b], DEFAULT_OBJECTIVES)).toEqual(['b']);
  });

  test('两条都 null → 弱等于 → 都进前沿 (无可比信号, 都不主导)', () => {
    // 真值链: 两 null → 都是最坏值 (-∞) → 任一维无 strictBetter → 都不主导 → 都在前沿
    const a = makeCandidate('a', { speedupTheoreticalMedian: null });
    const b = makeCandidate('b', { speedupTheoreticalMedian: null });
    expect(dominates(a, b, DEFAULT_OBJECTIVES)).toBe(false);
    expect(dominates(b, a, DEFAULT_OBJECTIVES)).toBe(false);
    expect(paretoFront([a, b], DEFAULT_OBJECTIVES).sort()).toEqual(['a', 'b']);
  });

  test('null vs null 但其余维 trade-off: null 撑不住对方优势, 严格胜出方独占前沿', () => {
    // 真值链: 两条 speedup 都 null (都映射为 -∞, 无 strict 维度), 但 fakeSerialPairs 一条 0 一条 5
    //   speedup 上无法判定主导 (都 null → 弱等于), fakeSerial 上 0 严格胜出 5 → b 严格胜出一维
    //   其余维 (shape / tokens / validity) 全相等 → b 主导 a → a 退出前沿, 前沿 = [b]
    //   注: 这条与 "凭 null 持平" 的直觉相反 —— null 是 fail-closed 的最坏值, 不能替 a 守住。
    const a = makeCandidate('a', { speedupTheoreticalMedian: null, fakeSerialPairsTotal: 5 });
    const b = makeCandidate('b', { speedupTheoreticalMedian: null, fakeSerialPairsTotal: 0 });
    expect(dominates(a, b, DEFAULT_OBJECTIVES)).toBe(false); // a 在 fakeSerial 上更差, 永远不主导 b
    expect(dominates(b, a, DEFAULT_OBJECTIVES)).toBe(true); // b 在 fakeSerial 上严格胜, 其余维等 → b 主导 a
    expect(paretoFront([a, b], DEFAULT_OBJECTIVES)).toEqual(['b']);
  });

  test('minimize 维上的 null 同样映射为 +∞ (对称 fail-closed, 走 cast 注入)', () => {
    // 真值链: planningTokensTotal 是 minimize, a = null, b = 100
    //   a → +∞ (最坏), b = 100; b < a → b 严格胜出 → b 主导 a
    //   注: AggregatedFitness.planningTokensTotal 类型上不允许 null, 此处用 cast 测
    //   projectForCompare 在 minimize 方向的对称行为 (类型闸是 fitness.ts 层, 此处只校
    //   选择器的对称映射)。
    const a = makeCandidate('a') as Candidate;
    const b = makeCandidate('b') as Candidate;
    (a.fitness as unknown as { planningTokensTotal: number | null }).planningTokensTotal = null;
    (b.fitness as unknown as { planningTokensTotal: number | null }).planningTokensTotal = 100;
    expect(dominates(b, a, DEFAULT_OBJECTIVES)).toBe(true);
    expect(dominates(a, b, DEFAULT_OBJECTIVES)).toBe(false);
    expect(paretoFront([a, b], DEFAULT_OBJECTIVES)).toEqual(['b']);
  });
});

// =====================================================================
// SORT_BY_MAIN_OBJECTIVE — 前沿内主目标排序 (P2 C-3)
// =====================================================================
describe('SORT_BY_MAIN — 前沿内主目标排序', () => {
  test('maximize 主目标: 降序排, 同分按 id 字典序', () => {
    const cs = [
      makeCandidate('charlie', { speedupTheoreticalMedian: 1.5 }),
      makeCandidate('alpha', { speedupTheoreticalMedian: 2.0 }),
      makeCandidate('bravo', { speedupTheoreticalMedian: 1.5 }),
    ];
    const sorted = sortByMainObjective(cs, MAIN_SPEEDUP);
    expect(sorted).toEqual(['alpha', 'bravo', 'charlie']); // 2.0 > 1.5=tie, bravo < charlie
  });

  test('minimize 主目标: 升序排 (planningTokensTotal 越少越优)', () => {
    const mainTokens: Objective = { field: 'planningTokensTotal', direction: 'minimize' };
    const cs = [
      makeCandidate('big', { planningTokensTotal: 1000 }),
      makeCandidate('small', { planningTokensTotal: 100 }),
      makeCandidate('mid', { planningTokensTotal: 500 }),
    ];
    expect(sortByMainObjective(cs, mainTokens)).toEqual(['small', 'mid', 'big']);
  });

  test('null 在主目标排序里被映射为最坏值 (maximize → 末尾)', () => {
    const cs = [
      makeCandidate('a', { speedupTheoreticalMedian: 1.5 }),
      makeCandidate('b', { speedupTheoreticalMedian: null }), // → -∞, 末尾
      makeCandidate('c', { speedupTheoreticalMedian: 2.0 }),
    ];
    expect(sortByMainObjective(cs, MAIN_SPEEDUP)).toEqual(['c', 'a', 'b']);
  });

  test('空前沿 → 空列表', () => {
    expect(sortByMainObjective([], MAIN_SPEEDUP)).toEqual([]);
  });
});

// =====================================================================
// TOPK — Pareto 前沿 + 主目标 + topK 截断组合 (P2 C-3)
// =====================================================================
describe('TOPK — topKByMainObjective 组合入口', () => {
  test('5 候选 → 全维度 trade-off 但 b 严格压 a → 前沿 4 条 + 主目标 top-2', () => {
    // 真值链:
    //   a: speedup=1.5, fakeSerial=5    ← b 在 speedup 和 fakeSerial 都更优 → b 主导 a (a 出)
    //   b: speedup=2.0, fakeSerial=3
    //   c: speedup=1.2, fakeSerial=2
    //   d: speedup=0.8, fakeSerial=0    ← 速度最差但假串行最优, 与 c/e trade-off
    //   e: speedup=1.0, fakeSerial=1
    //   b/c/d/e 互不主导 (速度赢 vs 假串行赢 trade-off) → 全进前沿
    //   a 被 b 严格主导 → 出前沿
    //   前沿 = [b, c, d, e], 主目标 speedup 排序 → [b(2.0), c(1.2), e(1.0), d(0.8)]
    //   topK=2 → [b, c]
    const cs = [
      makeCandidate('a', { speedupTheoreticalMedian: 1.5, fakeSerialPairsTotal: 5 }),
      makeCandidate('b', { speedupTheoreticalMedian: 2.0, fakeSerialPairsTotal: 3 }),
      makeCandidate('c', { speedupTheoreticalMedian: 1.2, fakeSerialPairsTotal: 2 }),
      makeCandidate('d', { speedupTheoreticalMedian: 0.8, fakeSerialPairsTotal: 0 }),
      makeCandidate('e', { speedupTheoreticalMedian: 1.0, fakeSerialPairsTotal: 1 }),
    ];
    const r = topKByMainObjective(cs, {
      objectives: DEFAULT_OBJECTIVES,
      mainObjective: MAIN_SPEEDUP,
      topK: 2,
    });
    expect(r.frontIds.sort()).toEqual(['b', 'c', 'd', 'e']);
    expect(r.sortedFrontIds).toEqual(['b', 'c', 'e', 'd']);
    expect(r.winnerIds).toEqual(['b', 'c']);
  });

  test('topK=0 → 空赢家 (前端拿到空集合的合法退路)', () => {
    const cs = [makeCandidate('a'), makeCandidate('b')];
    const r = topKByMainObjective(cs, {
      objectives: DEFAULT_OBJECTIVES,
      mainObjective: MAIN_SPEEDUP,
      topK: 0,
    });
    expect(r.frontIds.length).toBeGreaterThan(0);
    expect(r.winnerIds).toEqual([]);
  });

  test('topK > 前沿大小 → 全部前沿入 winner', () => {
    const cs = [
      makeCandidate('a', { speedupTheoreticalMedian: 2 }),
      makeCandidate('b', { speedupTheoreticalMedian: 1 }),
    ];
    const r = topKByMainObjective(cs, {
      objectives: DEFAULT_OBJECTIVES,
      mainObjective: MAIN_SPEEDUP,
      topK: 10,
    });
    expect(r.winnerIds.length).toBe(r.frontIds.length);
  });

  test('topK 负数 → 归零为空 (防御性)', () => {
    const cs = [makeCandidate('a'), makeCandidate('b')];
    const r = topKByMainObjective(cs, {
      objectives: DEFAULT_OBJECTIVES,
      mainObjective: MAIN_SPEEDUP,
      topK: -3,
    });
    expect(r.winnerIds).toEqual([]);
  });
});

// =====================================================================
// PLATEAU_FIVE_GEN — 连续 5 代前沿不动 → 平台期 (P2 C-3 / 设计 §1)
// =====================================================================
describe(`${PLATEAU_FIVE_GEN} — 平台期判定 (P2 C-3, 连续 5 代前沿不动)`, () => {
  test('PLATEAU_DEFAULT_THRESHOLD 锁死为 5 (合同常量, 改它必红)', () => {
    expect(PLATEAU_DEFAULT_THRESHOLD).toBe(5);
  });

  test('5 代 frontIds 字节相同 → 平台期 = true', () => {
    // 真值链: frontIds 已是字典序 (paretoFront 输出保证), 5 个 ['a', 'b', 'c'] →
    //   tail.slice(-5) 长度 = 5, 全部按位等 → 返 true
    const h = [['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c']];
    expect(isPlateau(h)).toBe(true);
    expect(isPlateau(h, 5)).toBe(true);
  });

  test('实装前天然红用例: 4 代同 + 第 5 代不同 → 平台期 = false', () => {
    // 真值链: 最后一代 ['a', 'b', 'c'] 变 ['a', 'b'] → 长度不同 → 返 false
    const h = [['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b', 'c'], ['a', 'b']];
    expect(isPlateau(h, 5)).toBe(false);
  });

  test('历史不足 5 代 → false (样本不足不该判 plateau)', () => {
    expect(isPlateau([['a', 'b'], ['a', 'b'], ['a', 'b']], 5)).toBe(false);
    expect(isPlateau([], 5)).toBe(false);
  });

  test('同长度但内容不同 → false (按位比对不放过)', () => {
    const h = [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'c'], ['a', 'b']];
    expect(isPlateau(h, 5)).toBe(false);
  });

  test('threshold 可显式调小 (4 代即收束)', () => {
    const h = [['a'], ['a'], ['a'], ['a']];
    expect(isPlateau(h, 4)).toBe(true);
    expect(isPlateau(h, 5)).toBe(false);
  });

  test('threshold=0 防御性 → false (空阈值不该判 plateau)', () => {
    expect(isPlateau([['a'], ['a'], ['a']], 0)).toBe(false);
  });

  test('CONTROL: 6 代中只有最后 5 代同 → 平台期 = true (只看末尾)', () => {
    const h = [['x', 'y'], ['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b']];
    expect(isPlateau(h, 5)).toBe(true);
  });

  test('CONTROL: 5 个 [a,b] 中最后一个反序 → false (按位比对非字典序也拒绝)', () => {
    // paretoFront 输出保证字典序, 但若上游手工传非字典序 front, 按位比对应拒绝
    const h = [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b'], ['b', 'a']];
    expect(isPlateau(h, 5)).toBe(false);
  });
});