import { describe, expect, test } from 'bun:test';
import { resolveDimensionModels } from './run';

// 2026-07-26 owner: review 该是多视角 —— 同一模型跑五个维度 prompt, 五条召回共享同一套盲点。

const ENV = { OMD_REVIEW_DIM_MODELS: 'correctness=openai-codex:gpt-5.6-sol,security=kimi-coding:k3' };

describe('review 维度 → 模型分派', () => {
  test('点名的维度走点名坐标', () => {
    const m = resolveDimensionModels(ENV, 'fallback:x');
    expect(m.correctness).toBe('openai-codex:gpt-5.6-sol');
    expect(m.security).toBe('kimi-coding:k3');
  });

  test('未点名的维度不进表 (调用方回落 findModel)', () => {
    expect(resolveDimensionModels(ENV, 'fallback:x').boundary).toBeUndefined();
  });

  test('未配 env → 空表 = 全部回落 (零回归)', () => {
    expect(resolveDimensionModels({}, 'fallback:x')).toEqual({});
  });

  test('坏条目丢弃, 不炸整轮审查 (fail-open)', () => {
    const m = resolveDimensionModels({ OMD_REVIEW_DIM_MODELS: 'correctness,=x,security=nocolon,ok=a:b' }, 'f:x');
    expect(m.correctness).toBeUndefined();
    expect(m.security).toBeUndefined();
    expect(m.ok).toBe('a:b');
  });
});
