/**
 * U2 discovery-loop 纯 GWT(SDD 0010 §2.4 G1-G7;零模型零 DB,全注入)。
 */
import { test, expect } from 'bun:test';
import { runDiscoveryLoop } from '../../src/harness/plan/discovery';

interface Finding {
  file: string;
  line: number;
  category: string;
}
const keyOf = (f: Finding): string => `${f.file}:${f.line}:${f.category}`.toLowerCase().replace(/\s+/g, '');
const F = (file: string, line: number, category = 'bug'): Finding => ({ file, line, category });

test('G1 召回逼近:5 植入问题,每轮找 3 有重叠 → items 到 5 且 dry 收敛', async () => {
  const all = [F('a.ts', 1), F('b.ts', 2), F('c.ts', 3), F('d.ts', 4), F('e.ts', 5)];
  const script = [
    [all[0]!, all[1]!, all[2]!],
    [all[1]!, all[3]!, all[4]!], // 重叠 + 新
    [all[0]!, all[2]!], // 全旧 → dry 1
    [all[3]!], // 全旧 → dry 2 → 收敛
  ];
  let i = 0;
  const r = await runDiscoveryLoop<Finding>({
    input: 'audit',
    roundRunner: async () => script[Math.min(i++, script.length - 1)]!,
    keyOf,
    dryThreshold: 2,
    maxRounds: 10,
  });
  expect(r.items).toHaveLength(5);
  expect(r.status).toBe('dry');
  expect(r.converged).toBe(true);
});

test('G2 真收敛:连续两轮空 → 恰在第 2 个 dry 轮停,rounds 完整', async () => {
  const script: Finding[][] = [[F('a.ts', 1)], [], []];
  let i = 0;
  const r = await runDiscoveryLoop<Finding>({
    input: 'x',
    roundRunner: async () => script[i++] ?? [],
    keyOf,
    dryThreshold: 2,
    maxRounds: 10,
  });
  expect(r.rounds).toHaveLength(3);
  expect(r.rounds[2]!.dryStreak).toBe(2);
  expect(r.status).toBe('dry');
});

test('G3 degenerate:第 1 轮抛 → degenerate + items 空 + error', async () => {
  const r = await runDiscoveryLoop<Finding>({
    input: 'x',
    roundRunner: async () => {
      throw new Error('finder exploded');
    },
    keyOf,
    maxRounds: 5,
  });
  expect(r.status).toBe('degenerate');
  expect(r.items).toHaveLength(0);
  expect(r.error).toContain('finder exploded');
});

test('G4 反假 dry:第 2 轮抛 → failed 非 dry,已积累项保留(INV-D4)', async () => {
  let i = 0;
  const r = await runDiscoveryLoop<Finding>({
    input: 'x',
    roundRunner: async () => {
      if (++i === 2) throw new Error('partial fleet down');
      return [F('a.ts', 1)];
    },
    keyOf,
    maxRounds: 5,
  });
  expect(r.status).toBe('failed');
  expect(r.converged).toBe(false);
  expect(r.items).toHaveLength(1); // 无静默丢
});

test('G5 燃料阀:中途破 floor → budget_halt + 已累积返回', async () => {
  let calls = 0;
  let fuel = 100;
  const r = await runDiscoveryLoop<Finding>({
    input: 'x',
    roundRunner: async (_, round) => {
      calls++;
      fuel -= 60;
      return [F(`f${round}.ts`, round)]; // 每轮都出新, 永不 dry
    },
    keyOf,
    maxRounds: 10,
    budget: { remaining: () => fuel, floor: 10 },
  });
  expect(r.status).toBe('budget_halt');
  expect(r.items.length).toBe(calls);
  expect(r.converged).toBe(false);
});

test('G6 无声截断防护:每轮出新触 maxRounds → exhausted 非 converged(INV-D5)', async () => {
  const r = await runDiscoveryLoop<Finding>({
    input: 'x',
    roundRunner: async (_, round) => [F(`f${round}.ts`, round)],
    keyOf,
    maxRounds: 3,
  });
  expect(r.status).toBe('exhausted');
  expect(r.converged).toBe(false);
  expect(r.items).toHaveLength(3);
});

test('G7 归一化去重:大小写/空白变体 → 第二次非 fresh(INV-D6)', async () => {
  const script: Finding[][] = [
    [{ file: 'A.TS ', line: 1, category: 'Bug' }],
    [{ file: 'a.ts', line: 1, category: 'bug' }],
    [],
  ];
  let i = 0;
  const r = await runDiscoveryLoop<Finding>({
    input: 'x',
    roundRunner: async () => script[i++] ?? [],
    keyOf,
    dryThreshold: 2,
    maxRounds: 10,
  });
  expect(r.items).toHaveLength(1);
  expect(r.rounds[1]!.fresh).toHaveLength(0); // 变体判旧
  expect(r.status).toBe('dry');
});

test('seen-avoidance 缺省注入:第二轮 input 带 already-found 且有界', async () => {
  const inputs: string[] = [];
  const script: Finding[][] = [[F('a.ts', 1)], [], []];
  let i = 0;
  await runDiscoveryLoop<Finding>({
    input: 'base-task',
    roundRunner: async (input) => {
      inputs.push(input);
      return script[i++] ?? [];
    },
    keyOf,
    maxRounds: 5,
  });
  expect(inputs[0]).toBe('base-task');
  expect(inputs[1]).toContain('already-found');
  expect(inputs[1]).toContain('a.ts:1:bug');
});
