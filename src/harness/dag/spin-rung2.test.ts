/**
 * spin-rung2 SDD S2 片 1 —— 决策纯函数与阶梯类型 (反向自检)。
 *
 * ## 钉的是什么
 *
 * S2 单节点选择器与阶梯报告的形状, 在本片冻结; 下游 (片 2 runner/片 3 engine/片 4 持久化)
 * 不得另写同义类型。本测试文件**只用本片新建的两个文件** —— 写集 = IMPL 写集, 不依赖别的实装。
 *
 * ## 反向自检 (改这块前先跑一遍; 下面是必红清单, 红了才算闸活着)
 *
 *   ① `SPIN_RUNG2_DIMENSIONS` 多 / 少 / 改值 → 「互斥二元」与「不返第三种」红;
 *   ② `chooseSpinRung2Dimension` 把 `>` 换成 `>=` (或反过来) → 「阈值边界归属」红;
 *   ③ `chooseSpinRung2Dimension` 加 `retry` 返值 → 「返值域恰二元」红;
 *   ④ `pickHigherTierSeat` 把 mid 空返 cheap[0] 而非 null → 「INV-3 试尽如实」红;
 *   ⑤ `pickHigherTierSeat` 在 strong 返 strong[0] 而非 null → 「INV-3 试尽如实」红;
 *   ⑥ `pickHigherTierSeat` 在坐标池外返 cheap[0] 而非 null → 「INV-3 坐标池外不假装」红;
 *   ⑦ `SpinLadderReading` 任一具名字段缺失 → 「INV-7 四字段齐备」红;
 *   ⑧ `buildSpinLadderReport` 改为数组而非元组 (允许长度 1 / 3) → 「INV-7 恰两档」红 (编译期)。
 */
import { describe, expect, it } from 'bun:test';

import {
  buildSpinLadderReport,
  buildSpinRung2Decision,
  chooseSpinRung2Dimension,
  judgeRung2Outcome,
  pickHigherTierSeat,
  RUNG_2,
  SPIN_LADDER_RUNG1_DIMENSION,
  SPIN_LADDER_OUTCOMES,
  SPIN_RUNG2_DIMENSIONS,
  type SpinLadderReading,
  type SpinLadderReport,
  type SpinRung2Decision,
  type SpinRung2Dimension,
  type SpinRung2StampPools,
} from './spin-rung2';

// ── 共享 fixture: cheap→mid→strong 三池 ───────────────────────────────────
const POOLS: SpinRung2StampPools = {
  cheap: ['cheap:c1'],
  mid: ['mid:m1', 'mid:m2'],
  strong: ['strong:s1'],
};

// ── 1. 常数 (具名, prompt 与测试共用同一份) ────────────────────────────────
describe('常数 (D-3 / INV-7 / RUNG 配对) — RUNG_2 / DIMENSIONS / OUTCOMES', () => {
  it('★ RUNG_2 === 2 (档位常数, 改值会与 RUNG_1 配对跑偏)', () => {
    expect(RUNG_2).toBe(2);
  });

  it('★ SPIN_RUNG2_DIMENSIONS 恰二元 (INV-2 互斥, 改值 / 增减红)', () => {
    expect([...SPIN_RUNG2_DIMENSIONS].sort()).toEqual(['fresh-context', 'seat-upgrade']);
    expect(SPIN_RUNG2_DIMENSIONS.length).toBe(2);
  });

  it('SPIN_LADDER_OUTCOMES 含 success / fail / pending 三态 (报告出口前归一为 success/fail)', () => {
    expect([...SPIN_LADDER_OUTCOMES].sort()).toEqual(['fail', 'pending', 'success']);
  });

  it('SPIN_LADDER_RUNG1_DIMENSION === "spin-route" (档 1 reading 维度字面, 与 SpinRouteEvent 同族)', () => {
    expect(SPIN_LADDER_RUNG1_DIMENSION).toBe('spin-route');
  });
});

// ── 2. 选择函数:阈值二元 + 边界归属 (INV-2 测试固定) ───────────────────────
describe('chooseSpinRung2Dimension (INV-2 / D-3: 阈值二元, 等于阈值由测试锁定)', () => {
  it('accumUsageIn < threshold → seat-upgrade', () => {
    expect(chooseSpinRung2Dimension({ accumUsageIn: 99, threshold: 100 })).toBe('seat-upgrade');
  });

  it('★ accumUsageIn === threshold → seat-upgrade (边界归属, 测试固定, IMPL 不得改)', () => {
    // SDD: 严格 `>` 才走 fresh-context; 阈值归属 = seat-upgrade, 此处冻结, 不允许 IMPL 改向。
    expect(chooseSpinRung2Dimension({ accumUsageIn: 100, threshold: 100 })).toBe('seat-upgrade');
  });

  it('accumUsageIn > threshold → fresh-context', () => {
    expect(chooseSpinRung2Dimension({ accumUsageIn: 101, threshold: 100 })).toBe('fresh-context');
  });

  it('阈值 0 时仍二元 (域 number, 接受 0 / 负数; 仅作分母分子不假设语义)', () => {
    expect(chooseSpinRung2Dimension({ accumUsageIn: -1, threshold: 0 })).toBe('seat-upgrade');
    expect(chooseSpinRung2Dimension({ accumUsageIn: 0, threshold: 0 })).toBe('seat-upgrade');
    expect(chooseSpinRung2Dimension({ accumUsageIn: 1, threshold: 0 })).toBe('fresh-context');
  });

  it('返回值类型恰为 SpinRung2Dimension (编译期闸: TS 已拒 retry/第三种; 此处断言运行期不漂)', () => {
    const a: SpinRung2Dimension = chooseSpinRung2Dimension({ accumUsageIn: 50, threshold: 100 });
    const b: SpinRung2Dimension = chooseSpinRung2Dimension({ accumUsageIn: 200, threshold: 100 });
    expect((SPIN_RUNG2_DIMENSIONS as readonly string[]).includes(a)).toBe(true);
    expect((SPIN_RUNG2_DIMENSIONS as readonly string[]).includes(b)).toBe(true);
  });
});

// ── 3. 坐标升级选择器 (D-5 / INV-3: 试尽如实) ─────────────────────────────
describe('pickHigherTierSeat (D-5 cheap→mid→strong 固定次序; INV-3 空池/顶档/池外如实)', () => {
  it('cheap → mid (取 mid 池首个, 跨池是 owner 决策非本片)', () => {
    expect(pickHigherTierSeat({ currentCoord: 'cheap:c1', pools: POOLS })).toBe('mid:m1');
  });

  it('mid → strong', () => {
    expect(pickHigherTierSeat({ currentCoord: 'mid:m1', pools: POOLS })).toBe('strong:s1');
  });

  it('★ strong → null (已在最高档 = 试尽, INV-3)', () => {
    expect(pickHigherTierSeat({ currentCoord: 'strong:s1', pools: POOLS })).toBeNull();
  });

  it('★ mid 池空 → null (高一档池空, INV-3 不静默回退原模型)', () => {
    expect(
      pickHigherTierSeat({ currentCoord: 'cheap:c1', pools: { ...POOLS, mid: [] } }),
    ).toBeNull();
  });

  it('★ strong 池空 → null (mid → 强升级无候选)', () => {
    expect(
      pickHigherTierSeat({ currentCoord: 'mid:m1', pools: { ...POOLS, strong: [] } }),
    ).toBeNull();
  });

  it('★ 当前坐标不在任何池 → null (坐标池外, 不假装换脑, INV-3)', () => {
    expect(pickHigherTierSeat({ currentCoord: 'unknown:x', pools: POOLS })).toBeNull();
  });
});

// ── 4. 组装 SpinRung2Decision (D-3, INV-3, INV-4) ─────────────────────────
describe('buildSpinRung2Decision (组装; 互斥二分 + 试尽如实 + fresh-context 不改 to)', () => {
  it('seat-upgrade 返 from / to / accumUsageIn / evidencePackHash (无 exhausted)', () => {
    const d: SpinRung2Decision = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'cheap:c1',
      pools: POOLS,
      accumulatedUsageIn: 50,
      evidencePackHash: 'pack-abc',
    });
    expect(d.kind).toBe('seat-upgrade');
    expect(d.from).toBe('cheap:c1');
    expect(d.to).toBe('mid:m1');
    expect(d.accumulatedUsageIn).toBe(50);
    expect(d.evidencePackHash).toBe('pack-abc');
    expect(d.targetPoolExhausted).toBeUndefined();
  });

  it('★ seat-upgrade 但高一档池空 → targetPoolExhausted: true, to 缺席 (INV-3 不回退)', () => {
    const d = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'cheap:c1',
      pools: { ...POOLS, mid: [] },
      accumulatedUsageIn: 50,
    });
    expect(d.kind).toBe('seat-upgrade');
    expect(d.from).toBe('cheap:c1');
    expect(d.to).toBeUndefined();
    expect(d.targetPoolExhausted).toBe(true);
  });

  it('★ seat-upgrade 但 currentCoord 不在池 → targetPoolExhausted: true (不假装换脑)', () => {
    const d = buildSpinRung2Decision({
      dimension: 'seat-upgrade',
      currentCoord: 'unknown:x',
      pools: POOLS,
      accumulatedUsageIn: 50,
    });
    expect(d.kind).toBe('seat-upgrade');
    expect(d.from).toBe('unknown:x');
    expect(d.to).toBeUndefined();
    expect(d.targetPoolExhausted).toBe(true);
  });

  it('★ fresh-context 返 from === 派发前坐标, to 缺席 (INV-4 同座位 + 丢历史)', () => {
    const d = buildSpinRung2Decision({
      dimension: 'fresh-context',
      currentCoord: 'mid:m1',
      pools: POOLS,
      accumulatedUsageIn: 5000,
      evidencePackHash: 'pack-xyz',
    });
    expect(d.kind).toBe('fresh-context');
    expect(d.from).toBe('mid:m1');
    expect(d.to).toBeUndefined(); // INV-4: fresh-context 不换模型, 不写 to
    expect(d.accumulatedUsageIn).toBe(5000);
    expect(d.evidencePackHash).toBe('pack-xyz');
    expect(d.targetPoolExhausted).toBeUndefined();
  });

  it('evidencePackHash 缺席时省略该字段 (无档 1 史时, INV-8 存量语义不变)', () => {
    const d = buildSpinRung2Decision({
      dimension: 'fresh-context',
      currentCoord: 'cheap:c1',
      pools: POOLS,
      accumulatedUsageIn: 200,
    });
    expect('evidencePackHash' in d).toBe(false);
  });
});

// ── 5. SpinLadderReading / SpinLadderReport 形状 (INV-7) ───────────────────
describe('SpinLadderReading / SpinLadderReport (INV-7: 四字段齐备 + 恰两档)', () => {
  const r1: SpinLadderReading = {
    dimension: 'spin-route',
    criterionDiff: { kind: 'no-history', literal: '本节点无 self_check,无判据可 diff' },
    blockerSignature: 'sig-A',
    outcome: 'fail',
  };
  const r2: SpinLadderReading = {
    dimension: 'seat-upgrade',
    criterionDiff: { kind: 'diff', added: ['c1'], removed: [] },
    blockerSignature: 'sig-A',
    outcome: 'fail',
  };

  it('★ SpinLadderReading 四具名字段皆在 (INV-7 字面点名)', () => {
    expect('dimension' in r1).toBe(true);
    expect('criterionDiff' in r1).toBe(true);
    expect('blockerSignature' in r1).toBe(true);
    expect('outcome' in r1).toBe(true);
  });

  it('★ SpinLadderReport.readings 元组长度恰为 2 (INV-7 档 1 + 档 2, 缺档红)', () => {
    const report: SpinLadderReport = buildSpinLadderReport({ rung1: r1, rung2: r2 });
    expect(report.readings.length).toBe(2);
  });

  it('buildSpinLadderReport 档 1 在 idx 0 / 档 2 在 idx 1 (位置即档位, 不复述 rung)', () => {
    const report = buildSpinLadderReport({ rung1: r1, rung2: r2 });
    expect(report.readings[0]).toBe(r1);
    expect(report.readings[1]).toBe(r2);
  });

  it('★ SpinLadderReading.dimension 字面集合 (档 1 恒 spin-route, 档 2 = SPIN_RUNG2_DIMENSIONS)', () => {
    // 档 1 reading 的 dimension 必须 == SPIN_LADDER_RUNG1_DIMENSION
    expect(r1.dimension).toBe(SPIN_LADDER_RUNG1_DIMENSION);
    // 档 2 reading 的 dimension 必须在 SPIN_RUNG2_DIMENSIONS 内
    expect((SPIN_RUNG2_DIMENSIONS as readonly string[]).includes(r2.dimension)).toBe(true);
  });

  it('criterionDiff 接受 spin-route 的两种形态 (no-history 字面 / diff 结构, NULL ≠ 编造)', () => {
    expect(r1.criterionDiff.kind).toBe('no-history');
    expect(r2.criterionDiff.kind).toBe('diff');
    expect((r2.criterionDiff as { kind: 'diff'; added: string[]; removed: string[] }).added).toEqual([
      'c1',
    ]);
  });
});

// ── 6. 档 2 判据再导出 = S1 同款 (D-9 不另写散文) ─────────────────────────
describe('judgeRung2Outcome (D-9: 复用 S1 的具名判据, 不另写同义函数)', () => {
  it('touched 增长 → success (与 S1 同款, 跨档位一致)', () => {
    expect(
      judgeRung2Outcome({ touchedBefore: 10, touchedNow: 11, failSetBefore: null, failSetNow: null }),
    ).toBe('success');
  });

  it('failSet 严格缩小 (有 added=0 有 removed>0) → success', () => {
    expect(
      judgeRung2Outcome({
        touchedBefore: 10,
        touchedNow: 10,
        failSetBefore: ['a', 'b', 'c'],
        failSetNow: ['a', 'b'],
      }),
    ).toBe('success');
  });

  it('failSet added > 0 (虽 removed > 0 但非严格缩小) → fail', () => {
    expect(
      judgeRung2Outcome({
        touchedBefore: 10,
        touchedNow: 10,
        failSetBefore: ['a', 'b'],
        failSetNow: ['b', 'c'],
      }),
    ).toBe('fail');
  });

  it('两件皆无变化 → fail (= 再次命中既有空转口径, 试尽, 节点终止为 failed)', () => {
    expect(
      judgeRung2Outcome({
        touchedBefore: 10,
        touchedNow: 10,
        failSetBefore: ['a'],
        failSetNow: ['a'],
      }),
    ).toBe('fail');
  });
});
