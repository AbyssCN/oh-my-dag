/**
 * Jev 裸 HTTP 客户端 —— 线形与五类失败两侧钉死(契约
 * `docs/plan/2026-09-22-jev-传感器-阶段0-E1-执行契约.md` INV-1 / GWT-1 / GWT-2)。
 *
 * 全部离线:`fetch` 经 `input.fetch` 注入,`env` 经 `input.env` 注入,一发真请求都不出去。
 * 真网络的那一发在 `scripts/jev-smoke.ts`(切片 5),那是探针不是测试。
 *
 * 证伪(每条要能真红):
 *  · 把 `if (!key)` 那句删掉 ⇒ 「无 key 时 fetch 调用次数为 0」红(GWT-2);
 *  · 把 URL 里的 `/v1/systemone` 改成 `/v1/ask` ⇒ 「请求打在 /v1/systemone」红;
 *  · 把 header 的 `Bearer ${key}` 改成裸 `key` ⇒ 「Authorization 形」红;
 *  · body 里漏掉 `model` ⇒ 「body 含 jev-latest」红;
 *  · 把 `timedOut` 分支删掉(超时也报 network)⇒ 「超时 why 为 timeout」红;
 *  · 把 `if (!res.ok)` 删掉 ⇒ 「非 2xx ⇒ http」红(会落进 parse 或 ok:true);
 *  · 给 `res.json()` 加 try 之外的兜底 ⇒ 「非 JSON ⇒ parse」红;
 *  · 让 `askJev` 在任一分支 throw ⇒ 「永不抛」红(每条用例都 await 它本身就是这条闸)。
 */
import { describe, expect, test } from 'bun:test';
import { JEV_DEFAULT_BASE_URL, JEV_DEFAULT_MODEL, askJev, type JevQuestion } from './jev-client';

const QUESTIONS: Record<string, JevQuestion> = { q: { type: 'noul', instructions: 'x' } };
const KEY_ENV = { TYPESAFE_API_KEY: 'sk-test-key' };

/** 记录每一发请求的假 fetch;`reply` 决定它回什么。 */
function recordingFetch(reply: () => Response): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return reply();
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 2026-09-22 curl 实测的响应形 —— 测试里逐字照抄,响应形变了这里先红。 */
const LIVE_SHAPE = {
  model: 'jev-1.13.0',
  answers: { q: { type: 'noul', noul: 0.24 } },
  usage: { input_tokens: 355, output_tokens: 40 },
};

describe('askJev 线形 (GWT-1)', () => {
  test('★ URL / header / body 三样按 D-2 的 wire 形发出, 答案与 usage 原样带回', async () => {
    const { fetch: f, calls } = recordingFetch(() => jsonResponse(LIVE_SHAPE));
    const r = await askJev({ state: { a: 1 }, questions: QUESTIONS, fetch: f, env: KEY_ENV });

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${JEV_DEFAULT_BASE_URL}/v1/systemone`);
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer sk-test-key');
    const body = String(call.init.body);
    expect(body).toContain(`"model":"${JEV_DEFAULT_MODEL}"`);
    expect(body).toContain('"type":"noul"');
    expect(JSON.parse(body).state).toEqual({ a: 1 });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.answers.q?.noul).toBe(0.24);
    expect(r.model).toBe('jev-1.13.0');
    expect(r.inputTokens).toBe(355);
    expect(r.outputTokens).toBe(40);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test('TYPESAFE_BASE_URL 覆盖 base, 末尾斜杠不会变成双斜杠', async () => {
    const { fetch: f, calls } = recordingFetch(() => jsonResponse(LIVE_SHAPE));
    await askJev({
      state: {},
      questions: QUESTIONS,
      fetch: f,
      env: { ...KEY_ENV, TYPESAFE_BASE_URL: 'https://local.test/' },
    });
    expect(calls[0]!.url).toBe('https://local.test/v1/systemone');
  });

  test('answers 里认不出的键忽略, 缺席的键不补 0 (NULL ≠ 0)', async () => {
    const { fetch: f } = recordingFetch(() => jsonResponse({ answers: { q: { type: 'noul', extra: 'junk' } } }));
    const r = await askJev({ state: {}, questions: QUESTIONS, fetch: f, env: KEY_ENV });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.answers.q).toEqual({});
    expect(r.answers.q?.noul).toBeUndefined();
    expect(r.model).toBeUndefined();
    expect(r.inputTokens).toBeUndefined();
  });
});

describe('askJev 五类失败 (INV-1): 永不抛, why 分得开', () => {
  test('★ 无 key ⇒ no-key, 且一发 fetch 都不出去 (GWT-2)', async () => {
    const { fetch: f, calls } = recordingFetch(() => jsonResponse(LIVE_SHAPE));
    const r = await askJev({ state: {}, questions: QUESTIONS, fetch: f, env: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.why).toBe('no-key');
    expect(calls.length).toBe(0);
  });

  test('fetch 抛 ⇒ network, 原文进 detail', async () => {
    const f = (async () => {
      throw new Error('ECONNREFUSED boom');
    }) as unknown as typeof fetch;
    const r = await askJev({ state: {}, questions: QUESTIONS, fetch: f, env: KEY_ENV });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.why).toBe('network');
    expect(r.detail).toContain('ECONNREFUSED');
  });

  test('★ 迟到 ⇒ timeout, 且 ms ≥ timeoutMs (超时靠 AbortController, 不靠等响应)', async () => {
    const f = ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const r = await askJev({ state: {}, questions: QUESTIONS, fetch: f, env: KEY_ENV, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.why).toBe('timeout');
    expect(r.ms).toBeGreaterThanOrEqual(20);
  });

  test('非 2xx ⇒ http, 状态码进 detail (不读 body, 500 的 body 常常也不是 JSON)', async () => {
    const { fetch: f } = recordingFetch(() => new Response('nope', { status: 503 }));
    const r = await askJev({ state: {}, questions: QUESTIONS, fetch: f, env: KEY_ENV });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.why).toBe('http');
    expect(r.detail).toBe('HTTP 503');
  });

  test('2xx 非 JSON ⇒ parse (与 http 分开: 一个换 key/配额, 一个换 base/版本)', async () => {
    const { fetch: f } = recordingFetch(() => new Response('<html>hi</html>', { status: 200 }));
    const r = await askJev({ state: {}, questions: QUESTIONS, fetch: f, env: KEY_ENV });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.why).toBe('parse');
  });
});
