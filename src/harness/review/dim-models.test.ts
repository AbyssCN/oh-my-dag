import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearProviders, getProvider, listProviders, registerProvider } from '../../model/providers';
import type { ProviderConfig } from '../../model/types';
import { resolveDimensionModels } from './run';

// 2026-07-26 owner: review 该是多视角 —— 同一模型跑五个维度 prompt, 五条召回共享同一套盲点。

/**
 * provider registry 隔离 —— 同 `run.test.ts` 头注的根因 (2026-09-02 定位):
 * `resolveDimensionModels` 里每个坐标都过 `roleModelWithFallback`, 首选无凭证时按**进程全局**
 * 注册表顺延。bun 自动加载仓根 `.env` (真 MIMO key) + 先跑过 `bootstrapModelRuntime()` 的用例
 * → 'mimo' 留在表里 → `ok=a:b` 被顺延成 'mimo', 全量跑红 / 单跑绿。测试间状态污染, 非实装错。
 * 反向自检: 删掉 `beforeEach` 那行 → 全量 `bun test` 下本文件当场红。
 */
let providerSnapshot: Array<[string, ProviderConfig]> = [];
beforeAll(() => {
  providerSnapshot = listProviders().map((n) => [n, getProvider(n)!] as [string, ProviderConfig]);
});
beforeEach(() => clearProviders());
afterAll(() => {
  clearProviders();
  for (const [n, cfg] of providerSnapshot) registerProvider(n, cfg);
});

const ENV = { OMD_REVIEW_DIM_MODELS: 'correctness=openai-codex:gpt-5.6-sol,security=kimi-coding:k3' };

describe('review 维度 → 模型分派', () => {
  test('点名的维度走点名坐标', () => {
    const m = resolveDimensionModels(ENV);
    expect(m.correctness).toBe('openai-codex:gpt-5.6-sol');
    expect(m.security).toBe('kimi-coding:k3');
  });

  test('未点名的维度不进表 (调用方回落 findModel)', () => {
    expect(resolveDimensionModels(ENV).boundary).toBeUndefined();
  });

  test('未配 env → 空表 = 全部回落 (零回归)', () => {
    expect(resolveDimensionModels({})).toEqual({});
  });

  test('坏条目丢弃, 不炸整轮审查 (fail-open)', () => {
    const m = resolveDimensionModels({ OMD_REVIEW_DIM_MODELS: 'correctness,=x,security=nocolon,ok=a:b' });
    expect(m.correctness).toBeUndefined();
    expect(m.security).toBeUndefined();
    expect(m.ok).toBe('a:b');
  });
});
