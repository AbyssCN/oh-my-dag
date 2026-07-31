/**
 * per-model 能力表回归 (owner 2026-07-28)。
 * 锁住的是"发错一个字面量就 400 整节点挂"的那类错配 —— 数字与词表全部对官网 + 实打探针。
 */
import { describe, expect, it } from 'bun:test';
import { capsFor, maxOutputFor, samplingFor, _resetDroppedKnobShoutForTest } from './model-caps';
import { logger } from '../logger';
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

/**
 * 采样参数过滤 + **丢弃要出声**(2026-07-31)。
 *
 * 起因: codex 拒 temperature 而 judge 就坐那个座位 → 环每轮拿不到裁决、空转 65 分钟。
 * 修法是让 pi 通道也查这张表 —— 但静默丢弃换来的是**更安静的失效**:
 * best-of-N / distill 拿 temperature/topP 当发散度旋钮, 丢掉之后 N 个 lens 塌成同一档采样,
 * 「以为在发散、其实在跑 N 遍同一个」。所以这份网钉的不是"过滤对不对", 是**丢弃有没有出声**。
 */
describe('samplingFor —— 过滤 + 丢弃告警', () => {
  it('不拒的坐标原样放行', () => {
    _resetDroppedKnobShoutForTest();
    expect(samplingFor('deepseek-v4-flash', { temperature: 0.7, topP: 0.9 })).toEqual({ temperature: 0.7, topP: 0.9 });
  });

  it('★ 拒收的旋钮被丢掉, 且**只丢它** —— 不连坐没被拒的那个', () => {
    _resetDroppedKnobShoutForTest();
    // gpt-5 只登记了拒 temperature (topP 未验过, 刻意没列)。
    expect(samplingFor('gpt-5.6-sol', { temperature: 0.7, topP: 0.9 })).toEqual({ topP: 0.9 });
    // kimi-k3 两个都拒。
    expect(samplingFor('kimi-k3', { temperature: 0.7, topP: 0.9 })).toEqual({});
  });

  it('★ 丢弃时吼一次, 之后同 (坐标,旋钮) 不再吼 —— 噪音里没人看得见第一条', () => {
    _resetDroppedKnobShoutForTest();
    const seen: string[] = [];
    const orig = logger.warn.bind(logger);
    (logger as unknown as { warn: unknown }).warn = (_o: unknown, m: string) => void seen.push(m);
    try {
      samplingFor('gpt-5.6-sol', { temperature: 0.7 });
      samplingFor('gpt-5.6-sol', { temperature: 0.3 }); // 同坐标同旋钮 → 不再吼
      samplingFor('kimi-k3', { temperature: 0.7 }); // 换坐标 → 各自吼一次
      samplingFor('gpt-5.6-sol', { topP: 0.9 }); // gpt-5 不拒 topP → 不该吼
    } finally {
      (logger as unknown as { warn: unknown }).warn = orig;
    }
    expect(seen.length).toBe(2);
    // 告示要说出**丢的是什么意图**, 不能只说"参数被过滤了"。
    expect(seen[0]).toContain('发散度');
    expect(seen[0]).toContain('gpt-5.6-sol');
  });

  it('调用方没给旋钮 → 没有意图被丢, 不作声 (别把"本来就没设"念成"被丢了")', () => {
    _resetDroppedKnobShoutForTest();
    const seen: string[] = [];
    const orig = logger.warn.bind(logger);
    (logger as unknown as { warn: unknown }).warn = (_o: unknown, m: string) => void seen.push(m);
    try {
      expect(samplingFor('gpt-5.6-sol', {})).toEqual({});
    } finally {
      (logger as unknown as { warn: unknown }).warn = orig;
    }
    expect(seen).toEqual([]);
  });

  it('未登记的坐标 → 原样放行 (表管的是"已知会炸", 不是白名单)', () => {
    _resetDroppedKnobShoutForTest();
    expect(samplingFor('some-unregistered-model', { temperature: 0.5 })).toEqual({ temperature: 0.5 });
  });
});
