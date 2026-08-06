/**
 * pi-transport + callModel 解析序测试 (统一模型层, 2026-07-19)。
 * 全假件注入 (setPiTransportDepsForTest 全键给齐 → 不加载真 pi-ai), 零网络。
 * 覆盖: 请求/响应映射 (text/usage/thinking) · 解析序 (registry 优先 → pi 目录 → config 错) ·
 * assertModelResolvable 双路 · ledger 在 pi 路上照常触发 · 错误分类 (401/429/net)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Context, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import {
  piUsageToModelUsage,
  resolvePiModel,
  setPiTransportDepsForTest,
  toPiContext,
  type PiModel,
  type PiTransportDeps,
} from './pi-transport';
import { assertModelResolvable, callModel, ModelError } from './index';
import { inCooldown, resetProviderCooldowns } from './provider-health';
import { clearProviders, registerProvider } from './providers';
import { observeModelUsage } from './accounting';

const BASE_MODEL: PiModel = {
  id: 'kimi-for-coding',
  name: 'Kimi For Coding',
  api: 'anthropic-messages',
  provider: 'kimi-coding',
  baseUrl: 'https://api.kimi.com/coding',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262144,
  maxTokens: 32768,
};

function usage(over: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
  };
}

function assistantMsg(over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'pong' }],
    api: 'anthropic-messages',
    provider: 'kimi-coding',
    model: 'k3',
    usage: usage({ input: 10, output: 5, totalTokens: 15 }),
    stopReason: 'stop',
    timestamp: 1,
    ...over,
  };
}

/** 全键假 deps (不触真 pi-ai)。calls 收集 completeSimple 入参。 */
function fakeDeps(over: Partial<PiTransportDeps> = {}): {
  deps: PiTransportDeps;
  calls: Array<{ model: PiModel; context: Context; options?: SimpleStreamOptions }>;
} {
  const calls: Array<{ model: PiModel; context: Context; options?: SimpleStreamOptions }> = [];
  const deps: PiTransportDeps = {
    getModel: (p, m) => (p === 'kimi-coding' && m === 'kimi-for-coding' ? BASE_MODEL : undefined),
    getModels: (p) => (p === 'kimi-coding' ? [BASE_MODEL] : []),
    completeSimple: async (model, context, options) => {
      calls.push({ model, context, ...(options !== undefined ? { options } : {}) });
      return assistantMsg();
    },
    getEnvApiKey: () => 'env-key',
    getOAuthProvider: () => undefined,
    getOAuthApiKey: async () => null,
    authPath: '/nonexistent/auth.json',
    now: () => 1_000,
    ...over,
  };
  return { deps, calls };
}

function authFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-transport-'));
  const p = join(dir, 'auth.json');
  writeFileSync(p, JSON.stringify(content));
  return p;
}

afterEach(() => {
  setPiTransportDepsForTest();
  clearProviders();
});

describe('resolvePiModel · 目录探针', () => {
  test('精确命中 → 目录条目原样', () => {
    const { deps } = fakeDeps();
    setPiTransportDepsForTest(deps);
    expect(resolvePiModel('kimi-coding', 'kimi-for-coding')).toBe(BASE_MODEL);
  });

  test('miss 但 provider 在目录 → 克隆首条换 id (目录滞后兜底, kimi-coding:k3)', () => {
    const { deps } = fakeDeps();
    setPiTransportDepsForTest(deps);
    const m = resolvePiModel('kimi-coding', 'k3');
    expect(m?.id).toBe('k3');
    expect(m?.api).toBe('anthropic-messages');
    expect(m?.baseUrl).toBe(BASE_MODEL.baseUrl);
  });

  test('provider 不在目录 / 空 id → undefined', () => {
    const { deps } = fakeDeps();
    setPiTransportDepsForTest(deps);
    expect(resolvePiModel('nope', 'x')).toBeUndefined();
    expect(resolvePiModel('kimi-coding', '')).toBeUndefined();
  });
});

describe('toPiContext · 请求映射', () => {
  test('system 抽 systemPrompt; user 文本 + 多模态 data URI; assistant 合成', () => {
    const ctx = toPiContext(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'prev' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          ],
        },
      ],
      BASE_MODEL,
    );
    expect(ctx.systemPrompt).toBe('be brief');
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(ctx.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'prev' }],
      stopReason: 'stop',
    });
    expect(ctx.messages[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ],
    });
  });

  test('http(s) 图链 → config 错 (pi ImageContent 无 URL 形态, 响亮不静默)', () => {
    expect(() =>
      toPiContext(
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }],
        BASE_MODEL,
      ),
    ).toThrow(ModelError);
  });
});

describe('piUsageToModelUsage · usage 语义对齐', () => {
  test('in = input+cacheRead+cacheWrite (pi input 不含缓存段); cacheHit = cacheRead', () => {
    expect(piUsageToModelUsage(usage({ input: 100, output: 7, cacheRead: 30, cacheWrite: 5 }))).toEqual({
      in: 135,
      out: 7,
      cacheHit: 30,
    });
  });

  test('无缓存 → cacheHit 不出现 (provider 不报则 undefined 语义)', () => {
    expect(piUsageToModelUsage(usage({ input: 10, output: 2 }))).toEqual({ in: 10, out: 2 });
  });
});

describe('callModel · 解析序 (registry 优先 → pi 目录 → config 错)', () => {
  // ⚠ 这条用例 2026-08-01 换过判据。原来钉的是「registry 命中 → **不探** pi 目录」(getModel 零调用),
  // 那是两条传输时代的形状: 走原生那条就跟 pi 完全无关。并成一条之后目录**必须**探 ——
  // 它供的是协议知识 (compat 怪癖 / thinkingLevelMap), 而 registry 供的是端点与凭证。
  // 现在钉的是那条分工本身: **端点和 key 必须来自 registry, 目录只能打底不能盖过它。**
  test('★ registry 命中 → 端点与凭证用 registry 的 (目录条目只打底)', async () => {
    const { deps, calls } = fakeDeps({
      // 目录里同名条目指向**别的**地址 —— 若它盖过 registry, 请求就发错地方了。
      getModel: (p, m) =>
        p === 'kimi-coding' && m === 'k3'
          ? { ...BASE_MODEL, id: 'k3', baseUrl: 'https://catalog.example', api: 'openai-completions' }
          : undefined,
    });
    setPiTransportDepsForTest(deps);
    registerProvider('kimi-coding', {
      baseUrl: 'http://own-gateway',
      apiKey: 'own',
      api: 'openai-compatible',
      defaultModel: 'k3',
    });
    assertModelResolvable('kimi-coding:k3');
    assertModelResolvable('kimi-coding'); // 裸坐标经 defaultModel — 旧行为原样
    await callModel({ messages: [{ role: 'user', content: 'ping' }], model: 'kimi-coding:k3' });
    expect(calls[0]?.model.baseUrl).toBe('http://own-gateway');
    expect(calls[0]?.options?.apiKey).toBe('own'); // registry 自带 key, 不去 auth.json/env 找
  });

  test('目录不认识的 provider (自建网关) 也能发 —— 从零捏骨架, 按 api 名定协议', async () => {
    const { deps, calls } = fakeDeps({ getModel: () => undefined, getModels: () => [] });
    setPiTransportDepsForTest(deps);
    registerProvider('my-gw', { baseUrl: 'http://gw/v1/', apiKey: 'k', api: 'openai-compatible' });
    await callModel({ messages: [{ role: 'user', content: 'ping' }], model: 'my-gw:whatever' });
    expect(calls[0]?.model.api).toBe('openai-completions');
    expect(calls[0]?.model.baseUrl).toBe('http://gw/v1'); // 尾 / 归一, 与 registerProvider 一致
    expect(calls[0]?.model.id).toBe('whatever');
  });

  test('anthropic-messages 条目映到 pi 的 anthropic 协议 (不再是本仓手写那条)', async () => {
    const { deps, calls } = fakeDeps({ getModel: () => undefined, getModels: () => [] });
    setPiTransportDepsForTest(deps);
    registerProvider('ant-gw', { baseUrl: 'http://ant', apiKey: 'k', api: 'anthropic-messages' });
    await callModel({ messages: [{ role: 'user', content: 'ping' }], model: 'ant-gw:claude-x' });
    expect(calls[0]?.model.api).toBe('anthropic-messages');
  });

  test('未注册但 pi 目录认识 → 走 pi 通道 (completeSimple), ledger 照常触发', async () => {
    const { deps, calls } = fakeDeps();
    setPiTransportDepsForTest(deps);
    const seen: Array<{ usage: { in: number; out: number }; model: string }> = [];
    const detach = observeModelUsage((u, m) => seen.push({ usage: { in: u.in, out: u.out }, model: m }));
    try {
      const res = await callModel({
        messages: [{ role: 'user', content: 'ping' }],
        model: 'kimi-coding:k3',
        thinkingLevel: 'high',
        maxTokens: 64,
        temperature: 0.1,
        retryDelayMs: 0,
      });
      expect(res.text).toBe('pong');
      expect(res.model).toBe('kimi-coding:k3');
      expect(res.usage).toEqual({ in: 10, out: 5 });
      expect(res.finishReason).toBe('stop');
      // 请求映射: 目录克隆 id + thinking 直映 + key/上限透传
      expect(calls).toHaveLength(1);
      expect(calls[0]!.model.id).toBe('k3');
      expect(calls[0]!.options?.reasoning).toBe('high');
      expect(calls[0]!.options?.apiKey).toBe('env-key');
      expect(calls[0]!.options?.maxTokens).toBe(64);
      expect(calls[0]!.options?.temperature).toBe(0.1);
      // V2-ECON: emitModelUsage 在 pi 路上照常触发 (INV-4 usage 落账)
      expect(seen).toEqual([{ usage: { in: 10, out: 5 }, model: 'kimi-coding:k3' }]);
    } finally {
      detach();
    }
  });

  test('thinkingLevel off / 非 reasoning 模型 → 不发 reasoning', async () => {
    const nonReasoning = { ...BASE_MODEL, reasoning: false };
    const { deps, calls } = fakeDeps({
      getModel: () => nonReasoning,
    });
    setPiTransportDepsForTest(deps);
    await callModel({
      messages: [{ role: 'user', content: 'x' }],
      model: 'kimi-coding:k3',
      thinkingLevel: 'high',
      retryDelayMs: 0,
    });
    expect(calls[0]!.options?.reasoning).toBeUndefined();
  });

  test('两路都不认 → 既有 config 清晰错误', async () => {
    const { deps } = fakeDeps();
    setPiTransportDepsForTest(deps);
    expect(() => assertModelResolvable('ghost:m1')).toThrow(/无法解析/);
    await expect(
      callModel({ messages: [{ role: 'user', content: 'x' }], model: 'ghost:m1', retryDelayMs: 0 }),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  test('assertModelResolvable: pi 目录路 OK; 裸 pi provider (无 model id) 仍报错', () => {
    const { deps } = fakeDeps();
    setPiTransportDepsForTest(deps);
    expect(() => assertModelResolvable('kimi-coding:k3')).not.toThrow();
    expect(() => assertModelResolvable('kimi-coding', 'verifier')).toThrow(/verifier/);
  });
});

describe('pi 通道 · 错误分类与认证', () => {
  test("stopReason 'error' + 401/429 → http 带 status; 无状态码 → transport", async () => {
    for (const [emsg, kind, status] of [
      ['401 {"type":"error"}', 'http', 401],
      ['429 rate limited', 'http', 429],
      ['socket hang up', 'transport', undefined],
    ] as const) {
      const { deps } = fakeDeps({
        completeSimple: async () => assistantMsg({ stopReason: 'error', errorMessage: emsg }),
      });
      setPiTransportDepsForTest(deps);
      const err = await callModel({
        messages: [{ role: 'user', content: 'x' }],
        model: 'kimi-coding:k3',
        maxRetries: 0,
        retryDelayMs: 0,
      }).catch((e) => e as ModelError);
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe(kind);
      expect((err as ModelError).status).toBe(status as number | undefined);
    }
  });

  /**
   * **402 要让熔断跳**(2026-08-06,两次真跑买来的)。
   *
   * 同一天两跑、两个不同 provider、同一个形状 —— 钱的问题不让熔断跳,于是自动兜底从不接管:
   * Codex「usage limit reached」· deepseek「402 Insufficient account balance」。
   * 后果不是"这一发失败"而是**整趟白跑**:`roleModelWithFallback` 那条顺延链只在
   * `usable()` 判首选不可用时才走,而 `usable()` = 有凭证 ∧ 不在冷却窗 —— 熔断不跳就永远"可用"。
   *
   * ⚠ 反向自检:把 `isProviderFault` 里的 `err.status === 402` 去掉 → 第一条断言立刻红
   *   (那正是改动前的行为);把 402 换成 400 → 第二条(对照)红。
   */
  test('402 余额不足 → 熔断跳 (而 400 请求错不跳: 换 provider 也不解决)', async () => {
    resetProviderCooldowns();
    const run = async (emsg: string): Promise<void> => {
      const { deps } = fakeDeps({
        completeSimple: async () => assistantMsg({ stopReason: 'error', errorMessage: emsg }),
      });
      setPiTransportDepsForTest(deps);
      await callModel({
        messages: [{ role: 'user', content: 'x' }],
        model: 'kimi-coding:k3',
        maxRetries: 0,
        retryDelayMs: 0,
      }).catch(() => undefined);
    };

    await run('402 {"code":"402","message":"Insufficient account balance"}');
    expect(inCooldown('kimi-coding:k3')).toBe(true); // ← 改动前是 false, 于是兜底永远不接管

    // 403 RegionError (同一天第三跑撞上): key 是好的、认证过了, 是这个**坐标**不给你用。
    // 「认证通过但不给服务」= 换一个能成 → 该熔断。⚠ 401(没认证上)刻意仍不熔断: 悄悄绕过去
    // 会把一个该让人去修的 key 配置错误藏起来。
    resetProviderCooldowns();
    await run('403 {"type":"RegionError","message":"only available hosted in China"}');
    expect(inCooldown('kimi-coding:k3')).toBe(true);

    resetProviderCooldowns();
    await run('401 unauthorized');
    expect(inCooldown('kimi-coding:k3')).toBe(false); // key 坏了该响, 不该被兜底盖住

    // 对照: 400 是**请求**错, 换后端也不解决 —— 熔断只针对"这个后端此刻不健康"。
    resetProviderCooldowns();
    await run('400 bad request');
    expect(inCooldown('kimi-coding:k3')).toBe(false);
    resetProviderCooldowns();
  });

  test('auth.json oauth access 未过期 → 直接用 (kimi-coding 无内置刷新件语义)', async () => {
    const p = authFile({ 'kimi-coding': { type: 'oauth', access: 'tok-a', refresh: 'r', expires: 5_000 } });
    const { deps, calls } = fakeDeps({ authPath: p, now: () => 1_000, getEnvApiKey: () => undefined });
    setPiTransportDepsForTest(deps);
    await callModel({ messages: [{ role: 'user', content: 'x' }], model: 'kimi-coding:k3', retryDelayMs: 0 });
    expect(calls[0]!.options?.apiKey).toBe('tok-a');
  });

  test('auth.json 过期 + 有刷新件 → getOAuthApiKey 刷新后用新 key', async () => {
    const p = authFile({ 'kimi-coding': { type: 'oauth', access: 'stale', refresh: 'r', expires: 10 } });
    const { deps, calls } = fakeDeps({
      authPath: p,
      now: () => 1_000,
      getEnvApiKey: () => undefined,
      getOAuthProvider: () => ({ getApiKey: (c) => String(c.access) }),
      getOAuthApiKey: async () => ({
        newCredentials: { access: 'fresh', refresh: 'r2', expires: 9_999 },
        apiKey: 'fresh',
      }),
    });
    setPiTransportDepsForTest(deps);
    await callModel({ messages: [{ role: 'user', content: 'x' }], model: 'kimi-coding:k3', retryDelayMs: 0 });
    expect(calls[0]!.options?.apiKey).toBe('fresh');
    // 刷新凭证已写回 auth.json (pi 语义: 刷新必持久)
    const persisted = JSON.parse(await Bun.file(p).text()) as Record<string, { access?: string }>;
    expect(persisted['kimi-coding']?.access).toBe('fresh');
  });

  test('无任何凭证 → config 错 (清晰指引)', async () => {
    const { deps } = fakeDeps({ getEnvApiKey: () => undefined });
    setPiTransportDepsForTest(deps);
    const err = await callModel({
      messages: [{ role: 'user', content: 'x' }],
      model: 'kimi-coding:k3',
      maxRetries: 0,
      retryDelayMs: 0,
    }).catch((e) => e as ModelError);
    expect((err as ModelError).kind).toBe('config');
    expect((err as ModelError).message).toContain('无凭证');
  });
});
