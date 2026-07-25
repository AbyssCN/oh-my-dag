import { describe, expect, test } from 'bun:test';
import { reasoningEffortFor } from './index';

// provider 档位能力 clamp (2026-07-25 实测驱动): 发错 effort 不是降级而是 HTTP 400 = 整节点白挂。
// mimo 实测接受集 = low|medium|high ('max'/'minimal' → 400); deepseek = high|max (R6)。

describe('reasoningEffortFor', () => {
  test('mimo: xhigh 降到 high 而不是发 max (max → 400 的实测)', () => {
    expect(reasoningEffortFor('mimo', 'xhigh')).toBe('high');
    expect(reasoningEffortFor('mimo-platform', 'xhigh')).toBe('high');
  });

  test('mimo: low/medium 真发出去 (此前只映 high/xhigh, 低档是哑弹)', () => {
    expect(reasoningEffortFor('mimo', 'low')).toBe('low');
    expect(reasoningEffortFor('mimo', 'medium')).toBe('medium');
    expect(reasoningEffortFor('mimo', 'high')).toBe('high');
  });

  test('deepseek: xhigh → max (它支持), low → 不发 (它不认低档, 发了是坏参数)', () => {
    expect(reasoningEffortFor('deepseek', 'xhigh')).toBe('max');
    expect(reasoningEffortFor('deepseek', 'high')).toBe('high');
    expect(reasoningEffortFor('deepseek', 'low')).toBeUndefined();
  });

  test('未知 provider: 只发 high, xhigh 降 high, 其余不发 (保守到底)', () => {
    expect(reasoningEffortFor('whatever', 'high')).toBe('high');
    expect(reasoningEffortFor('whatever', 'xhigh')).toBe('high');
    expect(reasoningEffortFor('whatever', 'low')).toBeUndefined();
    expect(reasoningEffortFor('whatever', 'medium')).toBeUndefined();
  });

  test("'off' 与未给档恒不发 (openai-兼容端点没有统一关思考开关; mimo 实测三种写法全被忽略)", () => {
    expect(reasoningEffortFor('mimo', 'off')).toBeUndefined();
    expect(reasoningEffortFor('mimo', undefined)).toBeUndefined();
  });
});
