/**
 * F1 语料规范表 (与 judge-artifact-cases.test 同款纪律): 点位表就是语料, 表漂 = 实验作废。
 * 快照 hash 钉死 = 防泄题登记 (INV-R2-3 同条件基线的一半; GWT-R2-4 的 oracle 面)。
 */
import { describe, expect, test } from 'bun:test';
import { F1_POINTS, F1_SNAPSHOT_AFTER, F1_SNAPSHOT_BEFORE } from './f1-check';

describe('F1 语料规范表', () => {
  test('快照 hash 钉死 (防泄题登记)', () => {
    expect(F1_SNAPSHOT_BEFORE).toBe('428dd3e044857f644ca95839d0b6ecfe28d49c0c');
    expect(F1_SNAPSHOT_AFTER).toBe('2de591f4ebbfe55f2bf670952e538aabff631681');
    expect(F1_SNAPSHOT_BEFORE).not.toBe(F1_SNAPSHOT_AFTER);
  });

  test('点位表形状: 26 点位 · 12 文件 · 9 词对全覆盖 · dag_run_plan 不在词表', () => {
    expect(F1_POINTS).toHaveLength(26);
    expect(new Set(F1_POINTS.map((p) => p.file)).size).toBe(12);
    expect(new Set(F1_POINTS.map((p) => `${p.old}→${p.new}`)).size).toBeGreaterThanOrEqual(8);
    expect(F1_POINTS.some((p) => p.old === 'dag_run_plan')).toBe(false);
    for (const p of F1_POINTS) expect(p.expectedNew).toBeGreaterThan(0);
  });
});
