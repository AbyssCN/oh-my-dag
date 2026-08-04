/**
 * FanOutQA 金标 DAG —— 结构算法的单测 + **把真实数据集的形状钉住**。
 *
 * 后半条是刻意的:选 FanOutQA 的理由全部建立在几个具体的数上(宽 5.52 / 274 题 dict /
 * 抽 40 题 ≈ 218 判分点)。**理由建立在数上,数就得有闸看着** —— 数据集换版本、
 * 文件被误改、或者我记错了,这里当场红,而不是等到实验跑完才发现选型前提没了。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dagShape, scoringPoints, shapeStats, type FanOutQuestion } from './gold-dag';

const DATA = join(import.meta.dir, 'data', 'fanout-final-dev.json');
const dev = JSON.parse(readFileSync(DATA, 'utf8')) as FanOutQuestion[];

describe('dagShape 结构算法', () => {
  test('样例形状: 1 种子 → 5 并行 = 宽 5 深 2', () => {
    const subs = [
      { id: 'seed', question: '前 5 顺位是谁' },
      ...['a', 'b', 'c', 'd', 'e'].map((k) => ({ id: k, question: `${k} 的打击手`, depends_on: ['seed'] })),
    ];
    expect(dagShape(subs)).toEqual({ nodes: 6, depth: 2, width: 5, levelWidths: [1, 5], edges: 5 });
  });

  test('纯链式: 宽恒 1, 深 = 节点数', () => {
    const subs = [
      { id: 'a', question: 'a' },
      { id: 'b', question: 'b', depends_on: ['a'] },
      { id: 'c', question: 'c', depends_on: ['b'] },
    ];
    const s = dagShape(subs);
    expect(s.width).toBe(1);
    expect(s.depth).toBe(3);
  });

  test('指向题外的依赖按已满足处理(与引擎对幻象 dep 同口径)', () => {
    const s = dagShape([{ id: 'a', question: 'a', depends_on: ['不存在'] }]);
    expect(s.depth).toBe(1);
    expect(s.edges).toBe(0); // 幻象边不计
  });

  test('环不挂死(数据里不该有, 防御性)', () => {
    const s = dagShape([
      { id: 'a', question: 'a', depends_on: ['b'] },
      { id: 'b', question: 'b', depends_on: ['a'] },
    ]);
    expect(s.nodes).toBe(2);
    expect(Number.isFinite(s.depth)).toBe(true);
  });

  test('空分解 → 全零, 不抛', () => {
    expect(dagShape([])).toEqual({ nodes: 0, depth: 0, width: 0, levelWidths: [], edges: 0 });
  });
});

describe('scoringPoints', () => {
  test('dict 按键数 / list 按长度 / 标量 1 / 空 0', () => {
    expect(scoringPoints({ a: 1, b: 2, c: 3 })).toBe(3);
    expect(scoringPoints(['x', 'y'])).toBe(2);
    expect(scoringPoints('str')).toBe(1);
    expect(scoringPoints(42)).toBe(1);
    expect(scoringPoints(null)).toBe(0);
  });
});

describe('真实 dev 数据集的形状(选型理由的闸)', () => {
  test('310 题, 且 test 集确实无答案(可用池就是 dev)', () => {
    expect(dev).toHaveLength(310);
    const testSet = JSON.parse(readFileSync(join(import.meta.dir, 'data', 'fanout-final-test.json'), 'utf8')) as unknown[];
    expect(testSet).toHaveLength(724);
    expect((testSet[0] as Record<string, unknown>).answer).toBeUndefined();
  });

  test('扇出宽度: mean≈5.5 · median 5 · ≥3 的 289 · ≥5 的 243', () => {
    const s = shapeStats(dev);
    expect(s.count).toBe(310);
    expect(s.meanWidth).toBeCloseTo(5.52, 1);
    expect(s.medianWidth).toBe(5);
    expect(s.wideAtLeast3).toBe(289);
    expect(s.wideAtLeast5).toBe(243);
  });

  test('深度几乎恒为 2(297/310)—— 这是"一跳种子 → N 条并行"的形状', () => {
    const depth2 = dev.filter((q) => dagShape(q.decomposition ?? []).depth === 2).length;
    expect(depth2).toBe(297);
    expect(shapeStats(dev).meanDepth).toBeCloseTo(1.96, 1);
  });

  test('判分点密度: dict 274 题 · 抽 40 题 ≈ 218 点(F2 跑三对只有 24)', () => {
    const dicts = dev.filter((q) => q.answer !== null && typeof q.answer === 'object' && !Array.isArray(q.answer));
    expect(dicts).toHaveLength(274);
    const pts = dicts.reduce((n, q) => n + scoringPoints(q.answer), 0);
    expect(pts).toBe(1494);
    expect(Math.round((pts / dicts.length) * 40)).toBeGreaterThanOrEqual(200); // 40 题 ≈ 218 点
  });
});
