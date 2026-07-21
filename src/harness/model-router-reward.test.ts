/**
 * leafCostReward (ROUTER-5 成本主信号) 不变量:
 *   失败=0 (逐叶归因) · 便宜>贵 (连续可分) · dag fail 软惩罚×0.3 (非清零) ·
 *   unpriced=0.5 中性 (防 cost=0 通吃) · 有界 [0,1]。
 */
import { describe, expect, test } from 'bun:test';
import { leafCostReward } from './model-router';
import type { PriceTable } from '../model/econ-types';

const PRICES: PriceTable = {
  'p:cheap': { inputRate: 0.27, outputRate: 1.1 },
  'p:pricey': { inputRate: 15, outputRate: 75 },
};
const usage = { in: 2000, out: 1000 };
const opts = { scaleUsd: 0.005, prices: PRICES };

describe('leafCostReward', () => {
  test('failed leaf → 0 (无论成本)', () => {
    expect(leafCostReward({ status: 'failed', model: 'p:cheap', usage }, true, opts)).toBe(0);
    expect(leafCostReward({ status: 'failed' }, undefined, opts)).toBe(0);
  });

  test('便宜 arm reward 显著高于贵 arm (连续信号可分)', () => {
    const cheap = leafCostReward({ status: 'done', model: 'p:cheap', usage }, true, opts);
    const pricey = leafCostReward({ status: 'done', model: 'p:pricey', usage }, true, opts);
    expect(cheap).toBeGreaterThan(pricey);
    expect(cheap).toBeGreaterThan(0.5); // ~$0.0017 << scale → 高分
    expect(pricey).toBeLessThan(0.01); // ~$0.105 >> scale → 趋零
  });

  test('dag fail → ×0.3 软惩罚 (非清零); 无 verifier (undefined) = pass 同待遇', () => {
    const pass = leafCostReward({ status: 'done', model: 'p:cheap', usage }, true, opts);
    const fail = leafCostReward({ status: 'done', model: 'p:cheap', usage }, false, opts);
    const noVerifier = leafCostReward({ status: 'done', model: 'p:cheap', usage }, undefined, opts);
    expect(fail).toBeCloseTo(pass * 0.3, 10);
    expect(noVerifier).toBe(pass);
  });

  test('unpriced 坐标 → 0.5 中性 (不因 cost=0 通吃)', () => {
    expect(leafCostReward({ status: 'done', model: 'p:unknown', usage }, true, opts)).toBe(0.5);
  });

  test('无 usage/model → 0.5×dagFactor 中性', () => {
    expect(leafCostReward({ status: 'done' }, true, opts)).toBe(0.5);
    expect(leafCostReward({ status: 'done' }, false, opts)).toBeCloseTo(0.15, 10);
  });

  test('有界 [0,1]', () => {
    for (const dagPass of [true, false, undefined]) {
      for (const model of ['p:cheap', 'p:pricey', 'p:unknown', undefined]) {
        const r = leafCostReward({ status: 'done', ...(model ? { model } : {}), usage }, dagPass, opts);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
  });
});
