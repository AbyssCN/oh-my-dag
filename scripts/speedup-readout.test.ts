/**
 * `scripts/speedup-readout.ts` 纯函数面 —— 契约钉死的真值断言。
 *
 * 只测纯函数 (analyzeRun / shapeBucket / median), 不开 DB, 不跑 CLI。
 * Fixtures 与手算真值来自上游契约 §8; 实现可能未到位, 文件缺失时
 * import 阶段即红 (frozen-tests 应在实装落地后转绿)。
 *
 * 反向自检 (锁死判据力):
 *  - 把 diamond 的 criticalMs 期望改 400 ⇒ 红 (Σ 与关键路径是分开量的);
 *  - 把 shapeBucket('one-decision-then-fanout') 改判 'unknown' ⇒ 红;
 *  - 注释写 "关键路径 = 600" 但断言 speedup === 3 ⇒ 红 (test 与实装背书互证)。
 */
import { describe, expect, test } from 'bun:test';
import {
  analyzeRun,
  median,
  shapeBucket,
  type RunNode,
} from './speedup-readout';

describe('analyzeRun', () => {
  test('§8.1 线性链 speedup=1', () => {
    const linear: RunNode[] = [
      { id: 'A', deps: [], durationMs: 100 },
      { id: 'B', deps: ['A'], durationMs: 200 },
      { id: 'C', deps: ['B'], durationMs: 300 },
    ];
    expect(analyzeRun(linear)).toEqual({
      kind: 'ok',
      totalMs: 600,
      criticalMs: 600,
      speedup: 1,
    });
  });

  test('§8.2 菱形 650/450 (toBeCloseTo 高精度)', () => {
    const diamond: RunNode[] = [
      { id: 'A', deps: [], durationMs: 100 },
      { id: 'B', deps: ['A'], durationMs: 200 },
      { id: 'C', deps: ['A'], durationMs: 300 },
      { id: 'D', deps: ['B', 'C'], durationMs: 50 },
    ];
    const r = analyzeRun(diamond);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error(`unexpected verdict: ${r.kind}`);
    expect(r.totalMs).toBe(650);
    expect(r.criticalMs).toBe(450);
    expect(r.speedup).toBeCloseTo(650 / 450, 10);
  });

  test('§8.3 全并行 speedup=3', () => {
    const parallel: RunNode[] = [
      { id: 'A', deps: [], durationMs: 100 },
      { id: 'B', deps: [], durationMs: 100 },
      { id: 'C', deps: [], durationMs: 100 },
    ];
    expect(analyzeRun(parallel)).toEqual({
      kind: 'ok',
      totalMs: 300,
      criticalMs: 100,
      speedup: 3,
    });
  });

  test('§8.4 durationMs 缺失 30% -> excluded-missing (超 20% 阈值)', () => {
    const missingThirtyPercent: RunNode[] = [
      { id: 'N1', deps: [], durationMs: null },
      { id: 'N2', deps: [], durationMs: null },
      { id: 'N3', deps: [], durationMs: null },
      { id: 'N4', deps: [], durationMs: 100 },
      { id: 'N5', deps: [], durationMs: 100 },
      { id: 'N6', deps: [], durationMs: 100 },
      { id: 'N7', deps: [], durationMs: 100 },
      { id: 'N8', deps: [], durationMs: 100 },
      { id: 'N9', deps: [], durationMs: 100 },
      { id: 'N10', deps: [], durationMs: 100 },
    ];
    expect(analyzeRun(missingThirtyPercent)).toEqual({
      kind: 'excluded-missing',
      missingRatio: 0.3,
    });
  });

  test('§8.5 环 -> invalid-cycle (带超时, 死循环即红)', () => {
    const cycle: RunNode[] = [
      { id: 'A', deps: ['B'], durationMs: 100 },
      { id: 'B', deps: ['A'], durationMs: 200 },
    ];
    const t0 = performance.now();
    const r = analyzeRun(cycle);
    const elapsed = performance.now() - t0;
    expect(r).toEqual({ kind: 'invalid-cycle' });
    // 跑这俩点 + 一次 DFS 的活不该比 1000ms 长 —— 真死循环会涨到秒级+,
    // 失败信息直接指明是递归爆栈而非业务判据不对。
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('shapeBucket', () => {
  test('§8.6 absent 三例 (null / undefined / 空串)', () => {
    expect(shapeBucket(null)).toBe('absent');
    expect(shapeBucket(undefined)).toBe('absent');
    expect(shapeBucket('')).toBe('absent');
  });

  test('§8.6 known (isKnownShapeId 真)', () => {
    expect(shapeBucket('one-decision-then-fanout')).toBe('known');
  });

  test('§8.6 unknown 两例 (未注册 id / 纯空白)', () => {
    expect(shapeBucket('not-a-real-shape')).toBe('unknown');
    expect(shapeBucket('   ')).toBe('unknown');
  });
});

describe('median', () => {
  test('§8.7 奇数个取中间值', () => {
    expect(median([1, 3, 2])).toBe(2);
  });

  test('§8.7 偶数个取中间两值算术平均', () => {
    expect(median([1, 4, 2, 3])).toBe(2.5);
  });
});