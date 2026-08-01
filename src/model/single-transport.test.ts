/**
 * 两条传输并成一条之后, **原来只长在原生那条上的东西必须还在** (2026-08-01)。
 *
 * 这份网不是在测"能不能发出去" (那是 pi-transport.test.ts 的活), 而是在测**搬家有没有掉东西**。
 * 掉东西的代价不对称: 掉一个采样旋钮不报错, 只是让 N 个 lens 悄悄跑成同一份; 掉一个上限不报错,
 * 只是朝一个 65K 的模型要 384K。这类退步没有任何红灯, 只能靠断言钉住。
 *
 * 全假件注入 (setPiTransportDepsForTest), 零网络。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { AssistantMessage, Context, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import { setPiTransportDepsForTest, type PiModel, type PiTransportDeps } from './pi-transport';
import { callModel } from './index';
import { clearProviders, registerProvider } from './providers';
import { _resetDroppedKnobShoutForTest } from './model-caps';

const ZERO: Usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Call {
  model: PiModel;
  options?: SimpleStreamOptions;
}

/** 假 pi 面: 记下每次 completeSimple 的入参, 并把 onPayload 真跑一遍 (那正是 body 改写的落点)。 */
function harness(catalog?: (p: string, m: string) => PiModel | undefined): {
  calls: Call[];
  bodies: Record<string, unknown>[];
} {
  const calls: Call[] = [];
  const bodies: Record<string, unknown>[] = [];
  const deps: PiTransportDeps = {
    getModel: (p, m) => catalog?.(p, m),
    getModels: () => [],
    completeSimple: async (model: PiModel, _ctx: Context, options?: SimpleStreamOptions) => {
      calls.push({ model, options });
      const body: Record<string, unknown> = { model: model.id };
      const next = await options?.onPayload?.(body, model);
      bodies.push((next as Record<string, unknown>) ?? body);
      return {
        role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: ZERO, stopReason: 'stop', timestamp: 1,
      } as AssistantMessage;
    },
    getEnvApiKey: () => 'env-key',
    getOAuthProvider: () => undefined,
    getOAuthApiKey: async () => null,
    authPath: '/nonexistent/auth.json',
    now: () => 0,
  };
  setPiTransportDepsForTest(deps);
  return { calls, bodies };
}

afterEach(() => {
  setPiTransportDepsForTest();
  clearProviders();
  _resetDroppedKnobShoutForTest();
});

const ask = (model: string, over: Record<string, unknown> = {}): Promise<unknown> =>
  callModel({ messages: [{ role: 'user', content: 'ping' }], model, ...over } as never);

describe('★ effort 词表跟着搬过来了 (发错 reasoning_effort 不是降级, 是 400)', () => {
  test('caps 登记过的模型走实测词表: mimo xhigh → high (它拒 max)', async () => {
    const { calls } = harness();
    registerProvider('mimo', { baseUrl: 'http://m', apiKey: 'k', api: 'openai-compatible' });
    await ask('mimo:mimo-v2.5-pro', { thinkingLevel: 'xhigh' });
    expect(calls[0]?.options?.reasoning).toBe('high');
  });

  test('deepseek xhigh → max; low 原样发出 (探针证明它收, 于是调档意图能原样出门)', async () => {
    // ⚠ 词表记的是「**接受**哪些字面量」而不是「语义上等价于谁」: deepseek 官方说 low 等同 high,
    // 但探针证明它确实收 —— 收就列上, 否则调档的意图在出门前就被我们自己吃掉了。
    const { calls } = harness();
    registerProvider('deepseek', { baseUrl: 'http://d', apiKey: 'k', api: 'openai-compatible' });
    await ask('deepseek:deepseek-v4-flash', { thinkingLevel: 'xhigh' });
    expect(calls[0]?.options?.reasoning).toBe('max');
    await ask('deepseek:deepseek-v4-flash', { thinkingLevel: 'low' });
    expect(calls[1]?.options?.reasoning).toBe('low');
  });

  test('caps 没登记 → 档位原样交给 pi (由它按目录 thinkingLevelMap 夹, 别用我们的保守兜底压成 high)', async () => {
    const { calls } = harness();
    registerProvider('gw', { baseUrl: 'http://g', apiKey: 'k', api: 'openai-compatible' });
    await ask('gw:some-unlisted-model', { thinkingLevel: 'xhigh' });
    expect(calls[0]?.options?.reasoning).toBe('xhigh');
  });

  test("thinkingLevel 'off' / 非 reasoning 模型 → 一个字都不发", async () => {
    const { calls } = harness((p, m) =>
      p === 'flat' ? ({ ...FLAT, id: m } as PiModel) : undefined,
    );
    registerProvider('flat', { baseUrl: 'http://f', apiKey: 'k', api: 'openai-compatible' });
    await ask('flat:x', { thinkingLevel: 'high' });
    expect(calls[0]?.options?.reasoning).toBeUndefined();
  });
});

const FLAT: PiModel = {
  id: 'x', name: 'x', api: 'openai-completions', provider: 'flat', baseUrl: 'http://f',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100, maxTokens: 100,
};

describe('★ 采样旋钮不许被悄悄吃掉 (发散度是 best-of-N 的全部意义)', () => {
  test('topP 经 onPayload 落进 body 的 top_p —— pi 的 options 表达不了它, 但 body 可以', async () => {
    const { bodies } = harness();
    registerProvider('mimo', { baseUrl: 'http://m', apiKey: 'k', api: 'openai-compatible' });
    await ask('mimo:mimo-v2.5-pro', { topP: 0.85, temperature: 0.25 });
    expect(bodies[0]?.top_p).toBe(0.85);
  });

  test('caps 说这个模型拒 topP → 不发 (但那是**判据拒**, 不是"我们表达不了")', async () => {
    const { bodies } = harness();
    registerProvider('og', { baseUrl: 'http://o', apiKey: 'k', api: 'openai-compatible' });
    await ask('og:kimi-k3', { topP: 0.9, temperature: 0.5 });
    expect(bodies[0]?.top_p).toBeUndefined();
  });

  test('temperature 同样按 caps 过滤 (codex 拒它 —— 那一发 400 让 goal 环永不收敛)', async () => {
    const { calls } = harness();
    registerProvider('cx', { baseUrl: 'http://c', apiKey: 'k', api: 'openai-compatible' });
    await ask('cx:gpt-5.6-sol', { temperature: 0.7 });
    expect(calls[0]?.options?.temperature).toBeUndefined();
  });
});

describe('★ 输出上限跟着搬过来了', () => {
  test('req.maxTokens 收敛到该模型官方上限 (别朝 qwen 要 deepseek 的 384K)', async () => {
    const { calls } = harness();
    registerProvider('og', { baseUrl: 'http://o', apiKey: 'k', api: 'openai-compatible' });
    await ask('og:qwen3.7-plus', { maxTokens: 300_000 });
    expect(calls[0]?.options?.maxTokens).toBe(65_536); // caps: qwen3.7 官方上限
  });

  test('模型自己的上限**压过** provider 级聚合值 (那正是 model-caps 当初治的 bug)', async () => {
    const { calls } = harness();
    // models.json 的 provider 级 maxTokens = 条目内最大值 (deepseek 的 384K)。
    registerProvider('og', { baseUrl: 'http://o', apiKey: 'k', api: 'openai-compatible', maxTokens: 384_000 });
    await ask('og:qwen3.7-plus');
    expect(calls[0]?.model.maxTokens).toBe(65_536);
  });
});

describe('★ JSON 模式跟着搬过来了 (丢了不报错, 只是 parse 重试悄悄变多)', () => {
  test('responseSchema 在场 → chat-completions body 带 response_format', async () => {
    const { bodies } = harness();
    registerProvider('mimo', { baseUrl: 'http://m', apiKey: 'k', api: 'openai-compatible' });
    const { z } = await import('zod');
    await ask('mimo:mimo-v2.5-pro', { responseSchema: z.object({ ok: z.boolean() }) });
    expect(bodies[0]?.response_format).toEqual({ type: 'json_object' });
  });

  test('没有 responseSchema → 不塞 response_format (别给不要 JSON 的调用加约束)', async () => {
    const { bodies } = harness();
    registerProvider('mimo', { baseUrl: 'http://m', apiKey: 'k', api: 'openai-compatible' });
    await ask('mimo:mimo-v2.5-pro');
    expect(bodies[0]?.response_format).toBeUndefined();
  });
});

describe('registry 的端点与凭证仍是权威', () => {
  test('registry 的 apiKey 直接用 (不去 auth.json/env 找)', async () => {
    const { calls } = harness();
    registerProvider('mimo', { baseUrl: 'http://m', apiKey: 'registry-key', api: 'openai-compatible' });
    await ask('mimo:mimo-v2.5-pro');
    expect(calls[0]?.options?.apiKey).toBe('registry-key');
  });

  test('registry 未注册 → 走目录 + env key (旧的第二条路原样)', async () => {
    const { calls } = harness((p, m) =>
      p === 'cat' ? ({ ...FLAT, id: m, provider: 'cat', baseUrl: 'https://cat' } as PiModel) : undefined,
    );
    await ask('cat:m1');
    expect(calls[0]?.model.baseUrl).toBe('https://cat');
    expect(calls[0]?.options?.apiKey).toBe('env-key');
  });
});
