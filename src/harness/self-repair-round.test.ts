/**
 * 自修环 R2 轮表的纯函数闸。四槽、diff 三态、集合比对与策略轮换都在此冻结。
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCriteriaDiff,
  buildRepairFollowUp,
  compareCriteriaFailures,
  FIRST_ROUND_LITERAL,
  UNPARSABLE_LITERAL,
  repairMRotateEnabled,
  strategyForRound,
  type CriteriaDiff,
  type RepairFollowUpSlots,
} from './self-repair-round';

const noRotateEnv = { OMD_REPAIR_M_ROTATE: '0' } as NodeJS.ProcessEnv;

describe('R2 判据 diff 与四槽 follow-up', () => {
  test('INV-2: added/removed 排序去重，intersection 不入清单', () => {
    expect(compareCriteriaFailures(['b', 'a', 'a'], ['b', 'c'])).toEqual({
      added: ['c'],
      removed: ['a'],
    });
  });

  test('INV-3: 首轮、可解析红集、不可解析红集三态严格分开', () => {
    expect(buildCriteriaDiff(null, null)).toEqual({ kind: 'first-round', literal: FIRST_ROUND_LITERAL });
    expect(buildCriteriaDiff(['a'], null)).toEqual({ kind: 'unparsable', literal: UNPARSABLE_LITERAL });
    // 终裁补 (静默坑 1): 「没有上一轮」与「上一轮不可解析」两个 null 来源必须分开 ——
    // 第三参显式给「有没有上一轮」, 不给则沿老口径。
    expect(buildCriteriaDiff(null, null, true)).toEqual({ kind: 'unparsable', literal: UNPARSABLE_LITERAL });
    expect(buildCriteriaDiff(['a'], ['a', 'b'])).toEqual({
      kind: 'diff',
      added: ['b'],
      removed: [],
    });
  });

  test('INV-1: buildRepairFollowUp 四槽全必填；缺一槽编译期红', () => {
    const full: RepairFollowUpSlots = {
      criteriaScene: '[判据现场]',
      criteriaDiff: { kind: 'first-round', literal: FIRST_ROUND_LITERAL },
      previousAttempt: '上轮尝试',
      strategy: '本轮策略',
    };
    expect(buildRepairFollowUp(full)).toBe(
      `[判据现场]\n[判据现场]\n\n[判据 diff]\nfirst-round —— ${FIRST_ROUND_LITERAL}\n\n[上轮尝试与结果]\n上轮尝试\n\n[本轮策略]\n本轮策略`,
    );

    // @ts-expect-error INV-1: 四槽全必填，缺一槽必须由 tsc 拒绝。
    buildRepairFollowUp({
      criteriaScene: '[判据现场]',
      criteriaDiff: { kind: 'first-round', literal: FIRST_ROUND_LITERAL },
      previousAttempt: '上轮尝试',
    });
  });

  test('INV-3: unparsable 不渲染 added/removed 字样', () => {
    const diff: CriteriaDiff = { kind: 'unparsable', literal: UNPARSABLE_LITERAL };
    const text = buildRepairFollowUp({
      criteriaScene: '[判据现场]',
      criteriaDiff: diff,
      previousAttempt: '上轮尝试',
      strategy: '本轮策略',
    });
    expect(text).not.toContain('added');
    expect(text).not.toContain('removed');
    expect(text).toContain('unparsable');
  });
});

describe('R2 策略槽轮换与恒 M7 对照臂', () => {
  test('INV-4: 轮换臂按 R1–R4 映射，R5 夹到 R4', () => {
    const strategies = [1, 2, 3, 4, 5].map((round) => strategyForRound(round));
    expect(strategies.slice(0, 4).every((s) => s.length > 0)).toBe(true);
    expect(new Set(strategies.slice(0, 4)).size).toBe(4);
    expect(strategies[4]).toBe(strategies[3]);
  });

  test('INV-4: OMD_REPAIR_M_ROTATE=0 时每轮恒发 M7', () => {
    const rotate = [1, 2, 3, 4].map((round) => strategyForRound(round, noRotateEnv));
    expect(new Set(rotate).size).toBe(1);
    expect(strategyForRound(1, noRotateEnv)).toBe(strategyForRound(4, noRotateEnv));
    expect(repairMRotateEnabled(noRotateEnv)).toBe(false);
    expect(repairMRotateEnabled({})).toBe(true);
  });
});
