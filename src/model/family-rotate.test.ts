import { describe, expect, test } from 'bun:test';
import { modelFamily } from './channels';
import { rotateFamilies } from './family-rotate';

const LENS_POOL = [
  'opencode-go:qwen3.7-plus',
  'opencode-go:minimax-m3',
  'opencode-go:deepseek-v4-pro',
  'mimo:mimo-v2.5-pro',
];

describe('rotateFamilies', () => {
  test('均匀: 4 族 × n=4 → 每族恰一次', () => {
    const out = rotateFamilies(LENS_POOL, 4);
    expect(out).toHaveLength(4);
    expect(new Set(out.map(modelFamily)).size).toBe(4);
  });

  test('均匀: n=8 → 每族恰两次', () => {
    const out = rotateFamilies(LENS_POOL, 8);
    const counts = new Map<string, number>();
    for (const c of out) counts.set(modelFamily(c), (counts.get(modelFamily(c)) ?? 0) + 1);
    expect([...counts.values()].every((v) => v === 2)).toBe(true);
  });

  test('加权: mimo-v2.5-pro 权重 3 → n=8 中占 50% (4/8)', () => {
    const out = rotateFamilies(LENS_POOL, 8, { weights: { 'mimo:mimo-v2.5-pro': 3 } });
    const mimo = out.filter((c) => modelFamily(c) === 'mimo').length;
    expect(mimo).toBe(4); // 3/(3+1+1+1) × 8 = 4
    expect(out).toHaveLength(8);
    expect(new Set(out.map(modelFamily)).size).toBe(4); // 另 3 族仍都出现
  });

  test('家族内游标: 同族多坐标轮流 (不总取第一个)', () => {
    const out = rotateFamilies(['mimo:mimo-v2.5', 'mimo:mimo-v2.5-pro'], 4);
    expect(out).toEqual([
      'mimo:mimo-v2.5',
      'mimo:mimo-v2.5-pro',
      'mimo:mimo-v2.5',
      'mimo:mimo-v2.5-pro',
    ]);
  });

  test('judge 池: glm+gpt+kimi 三族 × n=3 → 三族各一', () => {
    const out = rotateFamilies(['opencode-go:glm-5.2', 'openai-codex:gpt-5.6-sol', 'kimi-coding:k3'], 3);
    expect(new Set(out.map(modelFamily))).toEqual(new Set(['glm', 'gpt', 'kimi']));
  });

  test('边界: 空池 / n≤0 → []', () => {
    expect(rotateFamilies([], 5)).toEqual([]);
    expect(rotateFamilies(LENS_POOL, 0)).toEqual([]);
  });
});
