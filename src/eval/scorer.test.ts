/**
 * scorer 单测 —— parseBunTest 纯解析 + scoreRun heal-fixpoint (全注入 fake, 不起真模型)。
 * 承 SDD: 单测不烧 $, 真 build 留给 Phase ④。
 */
import { describe, expect, test } from 'bun:test';
import { parseBunTest, scoreRun, type OracleProbe } from './scorer';
import type { ExecutorDagResult } from '../harness/executor-dag-types';

describe('parseBunTest', () => {
  test('全绿 → fraction 1', () => {
    expect(parseBunTest(' 12 pass\n 0 fail\n 24 expect() calls')).toEqual({
      pass: 12, fail: 0, total: 12, fraction: 1,
    });
  });
  test('部分红 → 比例', () => {
    expect(parseBunTest(' 3 pass\n 1 fail')).toEqual({ pass: 3, fail: 1, total: 4, fraction: 0.75 });
  });
  test('无测试/构建失败 → total 0, fraction 0 (无信号≠满分)', () => {
    expect(parseBunTest('error: build failed')).toEqual({ pass: 0, fail: 0, total: 0, fraction: 0 });
    expect(parseBunTest('')).toEqual({ pass: 0, fail: 0, total: 0, fraction: 0 });
  });
  test('per-test (pass) 噪声不误匹配汇总 (行锚定 + 取最后)', () => {
    const out = '✓ foo > bar (pass)\n✓ baz (pass)\n 5 pass\n 0 fail';
    expect(parseBunTest(out).pass).toBe(5);
    expect(parseBunTest(out).fraction).toBe(1);
  });
});

function fakeResult(
  nodeCount: number,
  u: Partial<{ conductorIn: number; conductorOut: number; leavesIn: number; leavesOut: number; leavesCacheHit: number }> = {},
): ExecutorDagResult {
  const results: Record<string, unknown> = {};
  for (let i = 0; i < nodeCount; i++) results[`n${i}`] = { status: 'done' };
  return {
    results,
    usage: {
      conductor: { in: u.conductorIn ?? 0, out: u.conductorOut ?? 0 },
      leavesIn: u.leavesIn ?? 0,
      leavesOut: u.leavesOut ?? 0,
      leavesCacheHit: u.leavesCacheHit ?? 0,
    },
  } as unknown as ExecutorDagResult;
}

/** 每 probe 消费一条 (tsc, test); tsc/test 同 probe 内耦合 (test() 末尾推进游标)。 */
function seqProbe(seq: Array<{ tsc: string[]; test: string }>): OracleProbe {
  let i = 0;
  const at = () => seq[Math.min(i, seq.length - 1)]!;
  return {
    tsc: async () => at().tsc,
    test: async () => { const s = at().test; i++; return s; },
  };
}

describe('scoreRun', () => {
  test('首发即绿 → firstShot=final=1, 无 heal, runDag 只 1 次', async () => {
    let dagCalls = 0;
    const m = await scoreRun('t', { maxHeal: 2 }, {
      runDag: async () => { dagCalls++; return fakeResult(5, { conductorIn: 100, leavesIn: 50 }); },
      probe: seqProbe([{ tsc: [], test: ' 4 pass\n 0 fail' }]),
      fixTaskFor: (d) => `fix ${d}`,
    });
    expect(m.firstShotPass).toBe(1);
    expect(m.finalPass).toBe(1);
    expect(m.healRounds).toBe(0);
    expect(m.nodeCount).toBe(5);
    expect(dagCalls).toBe(1);
    expect(m.usage.conductorIn).toBe(100);
    expect(m.usage.leavesIn).toBe(50);
  });

  test('红→heal→绿: firstShot<final, healRounds=1, usage 跨轮累加', async () => {
    let dagCalls = 0;
    const m = await scoreRun('t', { maxHeal: 2 }, {
      runDag: async () => { dagCalls++; return fakeResult(6, { conductorIn: 10, leavesIn: 20 }); },
      probe: seqProbe([
        { tsc: [], test: ' 2 pass\n 2 fail' },
        { tsc: [], test: ' 4 pass\n 0 fail' },
      ]),
      fixTaskFor: (d) => `fix ${d}`,
    });
    expect(m.firstShotPass).toBe(0.5);
    expect(m.finalPass).toBe(1);
    expect(m.healRounds).toBe(1);
    expect(dagCalls).toBe(2); // 初次 + 1 heal
    expect(m.usage.conductorIn).toBe(20); // 两轮 ×10
    expect(m.usage.leavesIn).toBe(40);
  });

  test('maxHeal=0: 红也不 heal, final=firstShot', async () => {
    const m = await scoreRun('t', { maxHeal: 0 }, {
      runDag: async () => fakeResult(3),
      probe: seqProbe([{ tsc: [], test: ' 1 pass\n 1 fail' }]),
      fixTaskFor: (d) => `fix ${d}`,
    });
    expect(m.firstShotPass).toBe(0.5);
    expect(m.finalPass).toBe(0.5);
    expect(m.healRounds).toBe(0);
  });

  test('stuck: digest 逐字节不变 → 提前止损, 不烧满 maxHeal', async () => {
    let dagCalls = 0;
    const m = await scoreRun('t', { maxHeal: 3 }, {
      runDag: async () => { dagCalls++; return fakeResult(4); },
      probe: seqProbe([
        { tsc: [], test: ' 2 pass\n 2 fail' }, // 首发红 (healable)
        { tsc: [], test: ' 2 pass\n 2 fail' }, // heal 后同 digest → stuck, 停
      ]),
      fixTaskFor: (d) => `fix ${d}`,
    });
    expect(m.healRounds).toBe(1);
    expect(dagCalls).toBe(2); // 初次 + 1 heal 后 stuck 停, 没到 maxHeal=3
    expect(m.finalPass).toBe(0.5);
  });

  test('hard_fail: tsc 编译器级错 → 不进 heal', async () => {
    let dagCalls = 0;
    const m = await scoreRun('t', { maxHeal: 3 }, {
      runDag: async () => { dagCalls++; return fakeResult(2); },
      probe: seqProbe([{ tsc: ["x.ts(1,1): error TS5023: Unknown compiler option 'foo'."], test: ' 0 pass\n 1 fail' }]),
      fixTaskFor: (d) => `fix ${d}`,
    });
    expect(m.healRounds).toBe(0);
    expect(dagCalls).toBe(1);
  });
});
