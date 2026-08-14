/**
 * src/model/minimax-native.test —— 原生直连位的闸。
 *
 * **每条都写了怎么让它红。** 三条主闸:
 * ① `thinking` **永远显式发** —— 各端点缺省不一致(OpenAI-compat 省略=开、anthropic-compat 省略=关),
 *    吃缺省就等于让"开没开思考"变成一个看不见的变量,而它值 28 个百分点的正确分;
 * ② HTTP 200 + `base_resp.status_code ≠ 0` 要**抛** —— minimax 的业务错误走这条,
 *    不查这一格,一次配额耗尽会伪装成"模型回了个空的";
 * ③ `text` 取 `content` **不取** `reasoning_content` —— 取了就等于把 pi 通道那条
 *    `<think>` 粘连自己复刻一遍(那正是本文件存在的理由)。
 */
import { describe, expect, test } from 'bun:test';
import { buildBody, minimaxCompleteRaw, thinkingTypeFor, toModelUsage } from './minimax-native';
import type { ModelMessage } from './types';

const msgs: ModelMessage[] = [
  { role: 'system', content: '只输出 JSON' },
  { role: 'user', content: '2+3' },
];

/** 假 fetch:记下请求体,回一份可控响应。 */
function fakeFetch(body: unknown, init: { status?: number; text?: string } = {}) {
  const seen: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const fn = (async (url: string, opts: { body: string; headers: Record<string, string> }) => {
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    seen.headers = opts.headers;
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => init.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const ok = (content: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 200, completion_tokens: 35, prompt_tokens_details: { cached_tokens: 128 } },
  base_resp: { status_code: 0, status_msg: '' },
  ...extra,
});

describe('thinking —— 本文件存在的主要理由', () => {
  test('★ 默认 adaptive; 只有显式 off 才 disabled', () => {
    // 证伪方式: 把 thinkingTypeFor 改成恒返 'disabled' → 这条红。
    // 读数依据 (.omd/eval/m3-thinking-mode, N=3): adaptive 100%/100% vs disabled 72%/97% ——
    // disabled 便宜一个数量级但推理题归零, 所以它只能是**显式选择**, 不能是默认。
    expect(thinkingTypeFor(undefined)).toBe('adaptive');
    expect(thinkingTypeFor('low')).toBe('adaptive');
    expect(thinkingTypeFor('xhigh')).toBe('adaptive');
    expect(thinkingTypeFor('off')).toBe('disabled');
  });

  test('★ M3 的请求体里 thinking 永远在场 (不吃端点缺省)', () => {
    // 证伪方式: 删掉 buildBody 里那行 `body.thinking = …` → 这条红。
    expect(buildBody('MiniMax-M3', msgs, { messages: msgs }).thinking).toEqual({ type: 'adaptive' });
    expect(buildBody('MiniMax-M3', msgs, { messages: msgs, thinkingLevel: 'off' }).thinking).toEqual({ type: 'disabled' });
  });

  test('M2.x 不发 thinking (它关不掉, 发了是个没意义的参数)', () => {
    expect(buildBody('MiniMax-M2.7', msgs, { messages: msgs }).thinking).toBeUndefined();
  });
});

describe('请求体', () => {
  test('responseSchema → response_format json_object (与 pi 那条同口径)', () => {
    const withSchema = buildBody('MiniMax-M3', msgs, { messages: msgs, responseSchema: {} as never });
    expect(withSchema.response_format).toEqual({ type: 'json_object' });
    expect(buildBody('MiniMax-M3', msgs, { messages: msgs }).response_format).toBeUndefined();
  });

  test('多模态 ContentPart 原样透传 (multimodalPool 就指着 minimax-cn)', () => {
    const mm: ModelMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }];
    expect((buildBody('MiniMax-M3', mm, { messages: mm }).messages as unknown[])[0]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:x' } }],
    });
  });

  test('没给的采样旋钮不发 (不替调用方编默认)', () => {
    const b = buildBody('MiniMax-M3', msgs, { messages: msgs });
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
    expect(b.max_tokens).toBeUndefined();
  });
});

describe('响应', () => {
  test('★ text 取 content, 不取 reasoning_content', async () => {
    // 证伪方式: 把 text 改成 `content + reasoning_content` (或取后者) → 这条红。
    // 那一改就是把 pi 通道的 `<think>` 粘连在自己这儿复刻一遍。
    const { fn } = fakeFetch(ok('{"n":5}', { choices: [{ message: { content: '{"n":5}', reasoning_content: '我先想想' }, finish_reason: 'stop' }] }));
    const r = await minimaxCompleteRaw('MiniMax-M3', msgs, { messages: msgs }, { fetch: fn, apiKey: 'k' });
    expect(r.text).toBe('{"n":5}');
    expect(r.text).not.toContain('我先想想');
  });

  test('★ HTTP 200 + base_resp≠0 → 抛 (业务错误不许伪装成空回复)', async () => {
    // 证伪方式: 删掉 base_resp 检查 → 这条变成"返回空字符串", 于是配额耗尽在下游
    // 长得和"模型没话说"一模一样。
    const { fn } = fakeFetch({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' }, choices: [] });
    await expect(minimaxCompleteRaw('MiniMax-M3', msgs, { messages: msgs }, { fetch: fn, apiKey: 'k' })).rejects.toThrow('1008');
  });

  test('HTTP 4xx/5xx → ModelError(http) 带 status (上游据此熔断/退避)', async () => {
    const { fn } = fakeFetch({}, { status: 429, text: 'rate limited' });
    await expect(minimaxCompleteRaw('MiniMax-M3', msgs, { messages: msgs }, { fetch: fn, apiKey: 'k' })).rejects.toThrow('429');
  });

  test('usage: in 含命中段, cacheHit ⊆ in (与 pi 那条同语义)', () => {
    expect(toModelUsage({ prompt_tokens: 200, completion_tokens: 35, prompt_tokens_details: { cached_tokens: 128 } })).toEqual({
      in: 200,
      out: 35,
      cacheHit: 128,
    });
    // 零命中不写 cacheHit 字段 (缺席 = provider 没报, 与"报了 0"不是一回事)
    expect(toModelUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ in: 10, out: 2 });
  });

  test('finish_reason 归一: max_tokens → length (上游截断守卫认这个词)', async () => {
    const { fn } = fakeFetch(ok('半截', { choices: [{ message: { content: '半截' }, finish_reason: 'max_tokens' }] }));
    const r = await minimaxCompleteRaw('MiniMax-M3', msgs, { messages: msgs }, { fetch: fn, apiKey: 'k' });
    expect(r.finishReason).toBe('length');
  });

  test('缺凭证 → config 错误当场响亮 (不静默走空)', async () => {
    // env 要真清空: 不清的话这条在**装了 key 的机器上**会绿在错误的理由上 (它测的是回落链)。
    const saved = { cn: process.env.MINIMAX_CN_API_KEY, plain: process.env.MINIMAX_API_KEY };
    delete process.env.MINIMAX_CN_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    try {
      const { fn } = fakeFetch(ok('x'));
      // provider 用一个 auth.json 里**不存在**的名字 —— 否则这条会在 env 清空后
      // 悄悄走到 auth.json 拿到真 key 而绿掉(那时它测的就不是"缺凭证"了)。
      await expect(
        minimaxCompleteRaw('MiniMax-M3', msgs, { messages: msgs }, { fetch: fn, apiKey: '', provider: 'minimax-does-not-exist' }),
      ).rejects.toThrow(/无凭证/);
    } finally {
      if (saved.cn !== undefined) process.env.MINIMAX_CN_API_KEY = saved.cn;
      if (saved.plain !== undefined) process.env.MINIMAX_API_KEY = saved.plain;
    }
  });

  test('打的是原生 chatcompletion_v2, 不是 anthropic 兼容那条', async () => {
    const { fn, seen } = fakeFetch(ok('x'));
    await minimaxCompleteRaw('MiniMax-M3', msgs, { messages: msgs }, { fetch: fn, apiKey: 'k' });
    expect(seen.url).toContain('/text/chatcompletion_v2');
    expect(seen.url).not.toContain('/anthropic');
    expect(seen.headers?.Authorization).toBe('Bearer k');
  });
});
