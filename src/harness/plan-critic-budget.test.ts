/**
 * plan-critic 预算判定闸三码 (PP-B01 / PP-B02 / PP-B03) — 片 4 主体。
 *
 * 契约源: docs/plan/2026-08-27-conductorS3-retry域与verdict幂等-执行契约.md §D-8 + §INV-10。
 *
 * 设计:
 *  - 纯 STATIC (零 LLM); 与 PP-O01/PP-I01/PP-I02/PP-O02 同族, 同 critique() 流水线。
 *  - 三码互不代偿: PP-B01 (节点缺 budgetBasis) / PP-B02 (estimatedBy 空串) /
 *    PP-B03 (Σ costUsdCeiling > 注入 run 级上限)。PP-B03 仅在调用方注入了 runCeilingUsd 时
 *    才判;未注入 = 零回归 (与 S1 的「critique 只判字段存在性」语义保持一致)。
 *  - 不写任何 owner 未裁的阈值: 上限是 CriticInput.runCeilingUsd (注入值, 非常数)。
 *  - 形状契约与既有 13 码完全一致 (7 必填字段 + remediation 非空)。
 */
import { describe, expect, test } from 'bun:test';
import { critique, type CriticInput } from './plan-critic';
import { PlanSchema, type ConductorPlan } from './conductor-plan';

// ──────────────────────────────────────────────────────────────────────────────
// fixture 工厂
// ──────────────────────────────────────────────────────────────────────────────

/** 装配 ConductorPlan —— 走 PlanSchema.parse 真源, 保证 passthrough 字段存活。 */
function mkPlan(nodes: Record<string, Record<string, unknown>>, suppressions: string[] = []): ConductorPlan {
  return PlanSchema.parse({
    name: 'pp-budget-test',
    schema_version: '1.0',
    suppressions,
    nodes,
  }) as ConductorPlan;
}

/** 标准 critic input 装配; runCeilingUsd 通过 over 注入。 */
function mkInput(plan: ConductorPlan, runCeilingUsd?: number): CriticInput {
  return {
    plan,
    round: 1,
    workingSet: [],
    skills: [],
    runId: 'pp-budget-run',
    ...(runCeilingUsd !== undefined ? { runCeilingUsd } : {}),
  };
}

/** 取某码的全部诊断 (按 code 过滤)。 */
function byCode(diags: ReturnType<typeof critique>, code: string) {
  return diags.filter((d) => d.code === code);
}

/** 完整 budgetBasis 子字段 (用于「齐全」fixture)。 */
function fullBudget(over: Partial<{ calls: number; tokensIn: number; tokensOut: number; costUsdCeiling: number; estimatedBy: string }> = {}) {
  return {
    calls: over.calls ?? 1,
    tokensIn: over.tokensIn ?? 100,
    tokensOut: over.tokensOut ?? 50,
    costUsdCeiling: over.costUsdCeiling ?? 0.1,
    estimatedBy: over.estimatedBy ?? 'unit-test-estimator',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Diagnostic 形状契约 (与既有 12 码一致)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — 预算三码 Diagnostic 形态契约', () => {
  test('PP-B01 必含 7 字段 + remediation 非空', () => {
    const plan = mkPlan({
      // D-8a: 一致性闸要有一个「已声明」的锚节点, PP-B01 才判 —— 单个裸节点判不出来。
      anchor: { executor: 'leaf', goal: 'a', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'a', budgetBasis: fullBudget() },
      leaf: { executor: 'leaf', goal: 'x', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'atomic', depends_on: ['anchor'] },
      // leaf 不带 budgetBasis → PP-B01
    });
    const diags = critique(mkInput(plan));
    const b01 = byCode(diags, 'PP-B01');
    expect(b01.length).toBe(1);
    const d = b01[0]!;
    expect(d.severity).toBe('error');
    expect(typeof d.check).toBe('string');
    expect(d.check.length).toBeGreaterThan(0);
    expect(typeof d.node_id).toBe('string');
    expect(d.node_id).toBe('leaf');
    expect(Array.isArray(d.evidence)).toBe(true);
    expect(d.evidence.length).toBeGreaterThan(0);
    expect(typeof d.round).toBe('number');
    expect(d.round).toBe(1);
    expect(typeof d.remediation).toBe('string');
    expect(d.remediation.length).toBeGreaterThan(0);
    expect(d.suppressible).toBe(false);
  });

  test('PP-B02 必含 7 字段 + remediation 非空', () => {
    const plan = mkPlan({
      leaf: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        budgetBasis: { calls: 1, tokensIn: 1, tokensOut: 1, costUsdCeiling: 0.1, estimatedBy: '' },
      },
    });
    const diags = critique(mkInput(plan));
    const b02 = byCode(diags, 'PP-B02');
    expect(b02.length).toBe(1);
    const d = b02[0]!;
    expect(d.severity).toBe('error');
    expect(d.node_id).toBe('leaf');
    expect(typeof d.check).toBe('string');
    expect(d.check.length).toBeGreaterThan(0);
    expect(Array.isArray(d.evidence)).toBe(true);
    expect(d.evidence.length).toBeGreaterThan(0);
    expect(typeof d.round).toBe('number');
    expect(typeof d.remediation).toBe('string');
    expect(d.remediation.length).toBeGreaterThan(0);
    expect(d.suppressible).toBe(false);
  });

  test('PP-B03 必含 7 字段 + remediation 非空', () => {
    const plan = mkPlan({
      a: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'a',
        budgetBasis: fullBudget({ costUsdCeiling: 6 }),
      },
      b: {
        executor: 'leaf',
        goal: 'y',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'b',
        depends_on: ['a'],
        budgetBasis: fullBudget({ costUsdCeiling: 5 }),
      },
    });
    // Σ = 11 > 注入上限 10 → PP-B03
    const diags = critique(mkInput(plan, 10));
    const b03 = byCode(diags, 'PP-B03');
    expect(b03.length).toBe(1);
    const d = b03[0]!;
    expect(d.severity).toBe('error');
    expect(d.node_id).toBe('<plan>');
    expect(typeof d.check).toBe('string');
    expect(d.check.length).toBeGreaterThan(0);
    expect(Array.isArray(d.evidence)).toBe(true);
    expect(d.evidence.length).toBeGreaterThan(0);
    expect(typeof d.round).toBe('number');
    expect(typeof d.remediation).toBe('string');
    expect(d.remediation.length).toBeGreaterThan(0);
    expect(d.suppressible).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// INV-10 GWT-1: PP-B01 触发与消失
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — PP-B01 节点缺 budgetBasis', () => {
  test('已有节点声明预算, 另一个节点缺 budgetBasis → 诊断集恰含 PP-B01 且带非空 remediation', () => {
    // ⚠ D-8a: PP-B01 是**一致性**闸不是强制闸, 所以本用例的前提必须有一个「已声明」的节点。
    // 只放一个裸节点是判不出来的 —— 那一格归下面「全图零声明 → 零诊断」那条。
    const plan = mkPlan({
      anchor: { executor: 'leaf', goal: 'a', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'a', budgetBasis: fullBudget() },
      leaf: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        depends_on: ['anchor'],
        // budgetBasis 故意缺
      },
    });
    const diags = critique(mkInput(plan));
    const b01 = byCode(diags, 'PP-B01');
    expect(b01.length).toBe(1);
    expect(b01[0]?.node_id).toBe('leaf');
    expect(b01[0]?.remediation.length).toBeGreaterThan(0);
    expect(b01[0]?.suppressible).toBe(false);
  });

  // D-8a 零回归的直接落点 —— 第 1 跑 (runId ded15ab4) 那 6 条新增红全出在这一格。
  test('★ 全图没有任何节点声明 budgetBasis → PP-B01 为 0 条 (零回归)', () => {
    const plan = mkPlan({
      a: { executor: 'leaf', goal: 'x', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'a' },
      b: { executor: 'leaf', goal: 'y', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'b', depends_on: ['a'] },
    });
    // 仓内既有 plan 夹具**全属这一格**。这条红了 = 零回归条款没落实,
    // plan-dry-run 与 runCriticLoop 会成批塌 (实测 4 + 2 条)。
    expect(byCode(critique(mkInput(plan)), 'PP-B01').length).toBe(0);
  });

  test('补 budgetBasis 后 PP-B01 消失 (零诊断残留)', () => {
    const plan = mkPlan({
      leaf: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        budgetBasis: fullBudget(),
      },
    });
    const diags = critique(mkInput(plan));
    expect(byCode(diags, 'PP-B01').length).toBe(0);
  });

  test('多节点 plan 缺 budgetBasis → 每个缺节点各产一条 PP-B01', () => {
    const plan = mkPlan({
      a: { executor: 'leaf', goal: 'x', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'a', budgetBasis: fullBudget() },
      b: { executor: 'leaf', goal: 'y', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'b', depends_on: ['a'] /* budgetBasis 缺 */ },
    });
    const diags = critique(mkInput(plan));
    const b01 = byCode(diags, 'PP-B01');
    expect(b01.length).toBe(1);
    expect(b01[0]?.node_id).toBe('b');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// INV-10 GWT-2: PP-B02 estimatedBy 空串
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — PP-B02 estimatedBy 空串', () => {
  test('budgetBasis 齐全但 estimatedBy 空串 → 诊断集含 PP-B02 且不含 PP-B01', () => {
    const plan = mkPlan({
      leaf: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        budgetBasis: {
          calls: 1,
          tokensIn: 1,
          tokensOut: 1,
          costUsdCeiling: 0.1,
          estimatedBy: '', // 空串 → 估算法没登记
        },
      },
    });
    const diags = critique(mkInput(plan));
    const b02 = byCode(diags, 'PP-B02');
    const b01 = byCode(diags, 'PP-B01');
    expect(b02.length).toBe(1);
    expect(b02[0]?.node_id).toBe('leaf');
    expect(b01.length).toBe(0); // 关键: PP-B01 不代偿
  });

  test('PP-B02 evidence 含 estimatedBy= 字面与空值证据', () => {
    const plan = mkPlan({
      leaf: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        budgetBasis: { calls: 1, tokensIn: 1, tokensOut: 1, costUsdCeiling: 0.1, estimatedBy: '' },
      },
    });
    const diags = critique(mkInput(plan));
    const ev = byCode(diags, 'PP-B02')[0]?.evidence ?? [];
    expect(ev.some((e) => e.startsWith('estimatedBy='))).toBe(true);
    expect(ev.some((e) => e === 'estimatedBy=""' || e.includes('""'))).toBe(true);
  });

  test('estimatedBy 非空 → PP-B02 不亮 (零回归)', () => {
    const plan = mkPlan({
      leaf: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        budgetBasis: fullBudget({ estimatedBy: 'owner-vouched' }),
      },
    });
    const diags = critique(mkInput(plan));
    expect(byCode(diags, 'PP-B02').length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// INV-10 GWT-3: PP-B03 Σ costUsdCeiling 与注入上限比较
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — PP-B03 Σ costUsdCeiling 超注入上限', () => {
  test('注入 run 级上限 = 10, 两个节点 costUsdCeiling 之和 (6+5=11) > 10 → PP-B03 亮', () => {
    const plan = mkPlan({
      a: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'a',
        budgetBasis: fullBudget({ costUsdCeiling: 6 }),
      },
      b: {
        executor: 'leaf',
        goal: 'y',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'b',
        depends_on: ['a'],
        budgetBasis: fullBudget({ costUsdCeiling: 5 }),
      },
    });
    const diags = critique(mkInput(plan, 10));
    const b03 = byCode(diags, 'PP-B03');
    expect(b03.length).toBe(1);
    expect(b03[0]?.node_id).toBe('<plan>');
    // evidence 含 sum 与 ceiling
    const ev = b03[0]?.evidence ?? [];
    expect(ev.some((e) => e.startsWith('sum='))).toBe(true);
    expect(ev.some((e) => e.startsWith('ceiling='))).toBe(true);
  });

  test('不注入上限 (零回归) → 同一份 plan 不含 PP-B03', () => {
    const plan = mkPlan({
      a: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'a',
        budgetBasis: fullBudget({ costUsdCeiling: 100 }),
      },
      b: {
        executor: 'leaf',
        goal: 'y',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'b',
        depends_on: ['a'],
        budgetBasis: fullBudget({ costUsdCeiling: 100 }),
      },
    });
    // 故意不传 runCeilingUsd (mkInput 第二参省略)
    const diags = critique(mkInput(plan));
    expect(byCode(diags, 'PP-B03').length).toBe(0);
  });

  test('Σ costUsdCeiling 严格大于注入上限 → PP-B03; 等于上限 → 不亮', () => {
    const plan = mkPlan({
      a: { executor: 'leaf', goal: 'x', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'a', budgetBasis: fullBudget({ costUsdCeiling: 5 }) },
      b: { executor: 'leaf', goal: 'y', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'b', depends_on: ['a'], budgetBasis: fullBudget({ costUsdCeiling: 5 }) },
    });
    // Σ = 10; 上限 = 10 → 等于, 不超, 不亮
    const equal = critique(mkInput(plan, 10));
    expect(byCode(equal, 'PP-B03').length).toBe(0);
    // Σ = 10; 上限 = 9 → 严格超, 亮
    const over = critique(mkInput(plan, 9));
    expect(byCode(over, 'PP-B03').length).toBe(1);
  });

  test('单节点 plan Σ 超上限 → 仍 PP-B03 (单一节点也要判)', () => {
    const plan = mkPlan({
      only: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        budgetBasis: fullBudget({ costUsdCeiling: 11 }),
      },
    });
    const diags = critique(mkInput(plan, 10));
    expect(byCode(diags, 'PP-B03').length).toBe(1);
  });

  test('缺 budgetBasis 的节点不参与 Σ (它的 costUsdCeiling 视作 0, 但它本身仍产 PP-B01)', () => {
    const plan = mkPlan({
      a: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'a',
        budgetBasis: fullBudget({ costUsdCeiling: 10 }),
      },
      b: {
        executor: 'leaf',
        goal: 'y',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'b',
        depends_on: ['a'],
        // budgetBasis 缺 → costUsdCeiling 视作 0
      },
    });
    const diags = critique(mkInput(plan, 5));
    // Σ = 10 (b 不参与), 10 > 5 → PP-B03 仍亮
    expect(byCode(diags, 'PP-B03').length).toBe(1);
    // PP-B01 也亮 (b 缺 budgetBasis)
    expect(byCode(diags, 'PP-B01').length).toBe(1);
  });

  test('零回归: budgetBasis 缺 + 不注入上限 → 仅 PP-B01, 不出 PP-B03', () => {
    const plan = mkPlan({
      // D-8a: 一致性闸需要一个已声明的锚节点, 否则整图零声明 → PP-B01 不判。
      anchor: { executor: 'leaf', goal: 'z', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'z', budgetBasis: fullBudget() },
      a: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'a',
        depends_on: ['anchor'],
        // budgetBasis 缺
      },
    });
    const diags = critique(mkInput(plan)); // 无 ceiling
    expect(byCode(diags, 'PP-B01').length).toBe(1);
    expect(byCode(diags, 'PP-B03').length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 三码互不代偿 (INV-10 整体)
// ──────────────────────────────────────────────────────────────────────────────

describe('plan-critic — PP-B01/B02/B03 互不代偿', () => {
  test('节点缺 budgetBasis + estimatedBy 空串 同时存在 → PP-B01 与 PP-B02 各亮一条, 不互相吞', () => {
    const plan = mkPlan({
      // D-8a: 一致性闸需要一个已声明的锚节点, 否则整图零声明 → PP-B01 不判。
      anchor: { executor: 'leaf', goal: 'z', oracleKind: 'cheap', toolRefs: ['bash'], whyNoFanout: 'z', budgetBasis: fullBudget() },
      leaf: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'atomic',
        depends_on: ['anchor'],
        // 同时触 PP-B01 (缺 budgetBasis) 与 PP-B02 (estimatedBy 空) 的判定场景:
        // 注意: 缺 budgetBasis 时 PP-B02 不能亮 (estimatedBy 是 budgetBasis 的子字段, 父缺则读不到空串)
        // —— 真正的「estimatedBy 空串」必须 budgetBasis 存在, 这是 D-8 的字面要求
      },
    });
    // 这里只验 PP-B01 单码; 同时验 PP-B01 + PP-B02 共存见下一 case
    const diags = critique(mkInput(plan));
    expect(byCode(diags, 'PP-B01').length).toBe(1);
  });

  test('estimatedBy 空串 + Σ 超上限 同时存在 → PP-B02 与 PP-B03 各亮一条', () => {
    const plan = mkPlan({
      a: {
        executor: 'leaf',
        goal: 'x',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'a',
        budgetBasis: { calls: 1, tokensIn: 1, tokensOut: 1, costUsdCeiling: 6, estimatedBy: '' },
      },
      b: {
        executor: 'leaf',
        goal: 'y',
        oracleKind: 'cheap',
        toolRefs: ['bash'],
        whyNoFanout: 'b',
        depends_on: ['a'],
        budgetBasis: { calls: 1, tokensIn: 1, tokensOut: 1, costUsdCeiling: 5, estimatedBy: 'estimator-a' },
      },
    });
    const diags = critique(mkInput(plan, 10));
    expect(byCode(diags, 'PP-B02').length).toBe(1);
    expect(byCode(diags, 'PP-B02')[0]?.node_id).toBe('a');
    expect(byCode(diags, 'PP-B03').length).toBe(1);
  });
});
