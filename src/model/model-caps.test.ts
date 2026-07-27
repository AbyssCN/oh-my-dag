/**
 * per-model 能力表回归 (owner 2026-07-28)。
 * 锁住的是"发错一个字面量就 400 整节点挂"的那类错配 —— 数字与词表全部对官网 + 实打探针。
 */
import { describe, expect, it } from 'bun:test';
import { capsFor, maxOutputFor } from './model-caps';
import { reasoningEffortFor } from './index';

describe('model-caps 官方口径', () => {
  it('输出上限按模型各自的官方值, 不是同 provider 取最大', () => {
    expect(maxOutputFor('deepseek-v4-pro')).toBe(384_000); // api-docs.deepseek.com
    expect(maxOutputFor('glm-5.2')).toBe(128_000); // docs.bigmodel.cn
    expect(maxOutputFor('qwen3.7-plus')).toBe(65_536); // qwencloud.com
    expect(maxOutputFor('minimax-m3')).toBe(131_072); // platform.minimaxi.com
    expect(maxOutputFor('kimi-k3')).toBe(131_072); // platform.kimi.ai 默认值
    expect(maxOutputFor('mimo-v2.5-pro')).toBe(128_000); // mimo.mi.com
  });

  it('未登记模型 → undefined (调用方走保守兜底, 不瞎猜)', () => {
    expect(maxOutputFor('some-unknown-model')).toBeUndefined();
    expect(capsFor('some-unknown-model')).toBeUndefined();
  });

  it('kimi-k3 标注拒收 temperature/topP (2026-07-27 实测 400)', () => {
    expect(capsFor('kimi-k3')?.rejects).toEqual(['temperature', 'topP']);
    expect(capsFor('deepseek-v4-pro')?.rejects).toBeUndefined();
  });
});

describe('reasoning_effort 按模型解析', () => {
  it('qwen 的 xhigh 不许升成 max —— 实测 max 被 400 拒', () => {
    expect(reasoningEffortFor('opencode-go', 'xhigh', 'qwen3.7-plus')).toBe('high');
    expect(reasoningEffortFor('opencode-go', 'xhigh', 'qwen3.7-plus')).not.toBe('max');
  });

  it('deepseek/glm 的 xhigh 走 max (官方支持)', () => {
    expect(reasoningEffortFor('opencode-go', 'xhigh', 'deepseek-v4-pro')).toBe('max');
    expect(reasoningEffortFor('opencode-go', 'xhigh', 'glm-5.2')).toBe('max');
  });

  it('deepseek 收 low/medium 字面量 (官方语义等同 high, 但发过去不 400)', () => {
    expect(reasoningEffortFor('opencode-go', 'low', 'deepseek-v4-pro')).toBe('low');
    expect(reasoningEffortFor('opencode-go', 'medium', 'deepseek-v4-pro')).toBe('medium');
  });

  it('mimo 词表封顶 high (直连端点实测 max/minimal 均 400)', () => {
    expect(reasoningEffortFor('opencode-go', 'xhigh', 'mimo-v2.5-pro')).toBe('high');
    expect(reasoningEffortFor('opencode-go', 'low', 'mimo-v2.5-pro')).toBe('low');
  });

  it('同一聚合渠道下不同家族拿到不同词表 (修掉按 provider 一刀切)', () => {
    const xhigh = (m: string): string | undefined => reasoningEffortFor('opencode-go', 'xhigh', m);
    expect(xhigh('deepseek-v4-pro')).toBe('max');
    expect(xhigh('qwen3.7-plus')).toBe('high');
    expect(new Set([xhigh('deepseek-v4-pro'), xhigh('qwen3.7-plus')]).size).toBe(2);
  });

  it('未登记模型仍走 provider 表 / 保守兜底 (行为不回退)', () => {
    expect(reasoningEffortFor('deepseek', 'xhigh', undefined)).toBe('max');
    expect(reasoningEffortFor('mimo', 'xhigh', undefined)).toBe('high');
    expect(reasoningEffortFor('unknown-provider', 'xhigh', undefined)).toBe('high');
  });

  it("'off' 恒不发", () => {
    expect(reasoningEffortFor('opencode-go', 'off', 'deepseek-v4-pro')).toBeUndefined();
    expect(reasoningEffortFor('opencode-go', undefined, 'deepseek-v4-pro')).toBeUndefined();
  });
});
