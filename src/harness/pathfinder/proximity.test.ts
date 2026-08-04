/**
 * proximity —— r1 片1 契约测试(GWT-R1-1/2/4 + 边界)。
 * 注意 GWT-R1-2 例子按 INV-R1-2 勘误(单轮不增不算,见 proximity.ts hasCollapsed 注)。
 */
import { describe, expect, test } from 'bun:test';
import { clusterCount, hasCollapsed } from './proximity';

describe('clusterCount (GWT-R1-1/4)', () => {
  const TEXTS = ['deploy the api server', 'deploy api server now', 'database migration plan'];

  test('GWT-R1-1: 词袋重叠高的两条同簇, 无关的自成一簇 → 2 簇', () => {
    expect(clusterCount(TEXTS)).toBe(2);
  });

  test('INV-R1-1: 确定性 — 同输入 100 次结果不变', () => {
    const first = clusterCount(TEXTS);
    for (let i = 0; i < 100; i++) expect(clusterCount(TEXTS)).toBe(first);
  });

  test('GWT-R1-4: threshold=1.01 不可能连边 → n 簇 (退化=全新颖, 不崩)', () => {
    expect(clusterCount(TEXTS, { threshold: 1.01 })).toBe(3);
  });

  test('空集 → 0; 单条 → 1; 完全相同文本 → 1 簇', () => {
    expect(clusterCount([])).toBe(0);
    expect(clusterCount(['x'])).toBe(1);
    expect(clusterCount(['same text here', 'same text here'])).toBe(1);
  });

  test('embed 注入位: 常向量 embed → 全部同簇 (语义档换法的接缝)', () => {
    expect(clusterCount(TEXTS, { embed: () => [1, 0, 0] })).toBe(1);
  });

  test('已知边界 (记录不是愿望): 未分词中文近似句在词袋空间各自成簇', () => {
    // 「查A的上限」整句是单 token, 与「A的上限是多少」零重叠 → 语义 embed 接入前这是真实行为。
    expect(clusterCount(['查A的上限', 'A的上限是多少'])).toBe(2);
  });
});

describe('hasCollapsed (GWT-R1-2, INV-R1-2)', () => {
  test('连续 k=2 轮不增 → true', () => {
    expect(hasCollapsed([3, 5, 5, 5])).toBe(true);
    expect(hasCollapsed([3, 5, 5, 4])).toBe(true); // 降也算不增
  });

  test('单轮不增不算 (spec 勘误例)', () => {
    expect(hasCollapsed([3, 5, 5])).toBe(false);
  });

  test('新簇重置', () => {
    expect(hasCollapsed([3, 5, 5, 6])).toBe(false);
  });

  test('观测不足 k+1 → false; k<=0 → false', () => {
    expect(hasCollapsed([3, 5])).toBe(false);
    expect(hasCollapsed([])).toBe(false);
    expect(hasCollapsed([5, 5, 5], 0)).toBe(false);
  });

  test('k=1 档: 一次不增即坍塌 (给敏感场景留旋钮)', () => {
    expect(hasCollapsed([3, 5, 5], 1)).toBe(true);
    expect(hasCollapsed([3, 5], 1)).toBe(false);
  });
});
