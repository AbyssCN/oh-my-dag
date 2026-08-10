/**
 * claude-sdk-complete 契约测试(setSdkCompleteQueryForTest 接缝替换真 SDK)。
 * 钉四条:callModel 分派与选项映射 / schema 纠错轮复用(串行化)/
 * provider 错误响亮(反向自检:先证明闸会红)/ effortOf 映射。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { callModel } from './index';
import { effortOf, setSdkCompleteQueryForTest } from './claude-sdk-complete';

afterEach(() => setSdkCompleteQueryForTest(null));

const asst = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    session_id: 's',
    message: {
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
      stop_reason: 'end_turn',
    },
  }) as unknown as SDKMessage;

const success = (text: string): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: text, session_id: 's', usage: {} }) as unknown as SDKMessage;

/** 每次调用吐 script 里的下一组消息(schema 纠错要第二次不同回复)。 */
const fakeQuery = (scripts: SDKMessage[][], seen: { calls: { prompt: string; options: Options }[] } = { calls: [] }) => {
  const f = (props: { prompt: string; options: Options }) => {
    seen.calls.push(props);
    const script = scripts[Math.min(seen.calls.length - 1, scripts.length - 1)]!;
    return (async function* () {
      for (const m of script) yield m;
    })();
  };
  return { f, seen };
};

describe('callModel 分派 (claude-code:*)', () => {
  test('★ 文本完成:选项映射齐(model/maxTurns/tools/effort/systemPrompt),usage 全口径', async () => {
    const { f, seen } = fakeQuery([[asst('判词'), success('判词')]]);
    setSdkCompleteQueryForTest(f);
    const r = await callModel({
      model: 'claude-code:claude-opus-5',
      messages: [
        { role: 'system', content: '你是终审' },
        { role: 'user', content: '判一下' },
      ],
      thinkingLevel: 'high',
    });
    expect(r.text).toBe('判词');
    expect(r.model).toBe('claude-code:claude-opus-5');
    // in = 100 直读 + 40 缓存读 + 10 缓存写 = 150
    expect(r.usage).toEqual({ in: 150, out: 7, cacheHit: 40 });
    const o = seen.calls[0]!.options;
    expect(o.model).toBe('claude-opus-5');
    expect(o.maxTurns).toBe(1);
    expect(o.tools).toEqual([]);
    expect(o.effort).toBe('high');
    expect(o.systemPrompt).toBe('你是终审');
    expect(seen.calls[0]!.prompt).toBe('判一下');
  });

  test('★ responseSchema 纠错轮:第一发坏 JSON → 纠错消息串行化进第二发 prompt → 拿到 parsed', async () => {
    const { f, seen } = fakeQuery([
      [asst('不是 json'), success('不是 json')],
      [asst('{"ok":true}'), success('{"ok":true}')],
    ]);
    setSdkCompleteQueryForTest(f);
    const r = await callModel({
      model: 'claude-code:claude-opus-5',
      messages: [{ role: 'user', content: '给我 JSON' }],
      responseSchema: z.object({ ok: z.boolean() }),
      retryDelayMs: 0,
    });
    expect(r.parsed).toEqual({ ok: true });
    expect(seen.calls.length).toBe(2);
    // 纠错轮是多消息 → 角色标注串行化(差异③)
    expect(seen.calls[1]!.prompt).toContain('[user]');
    expect(seen.calls[1]!.prompt).toContain('not valid JSON');
  });

  test('★ provider 错误 → ModelError 响亮(闸的反向自检:subtype 原文在错误里)', async () => {
    const { f } = fakeQuery([[{ type: 'result', subtype: 'error_during_execution', session_id: 's' } as unknown as SDKMessage]]);
    setSdkCompleteQueryForTest(f);
    await expect(
      callModel({ model: 'claude-code:claude-opus-5', messages: [{ role: 'user', content: 'x' }], maxRetries: 0, retryDelayMs: 0 }),
    ).rejects.toThrow('error_during_execution');
  });
});

describe('effortOf 映射', () => {
  test('off→low(adaptive thinking 关不掉取最低),其余同名,缺省不发', () => {
    expect(effortOf('off')).toBe('low');
    expect(effortOf('medium')).toBe('medium');
    expect(effortOf('xhigh')).toBe('xhigh');
    expect(effortOf(undefined)).toBeUndefined();
  });
});
