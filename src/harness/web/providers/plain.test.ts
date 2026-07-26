import { describe, expect, test } from 'bun:test';
import { PlainFetchProvider } from './plain';
import { ProviderError } from '../types';

// 零 key 抓取兜底: 内置 fetch + clean, 不起子进程 (curl 要过命令白名单且多一次进程开销)。
// 注入 fetchImpl → 单测永不打真网络。

const ok = (body: string, ct = 'text/html') =>
  (async () => new Response(body, { status: 200, headers: { 'content-type': ct } })) as unknown as typeof fetch;

describe('PlainFetchProvider', () => {
  test('HTML → 正文 (去标签), 并抽出 title', async () => {
    const p = new PlainFetchProvider({ fetchImpl: ok('<html><head><title>标题</title></head><body><p>正文内容</p><script>x=1</script></body></html>') });
    const r = await p.fetch('https://e.example/a');
    expect(r.title).toBe('标题');
    expect(r.text).toContain('正文内容');
    expect(r.text).not.toContain('<p>');
  });

  test('raw=true 跳过清洗 (调用方要原始 HTML 时)', async () => {
    const p = new PlainFetchProvider({ fetchImpl: ok('<p>x</p>') });
    expect((await p.fetch('https://e.example/a', { raw: true })).text).toContain('<p>');
  });

  test('非 HTML content-type 原样返回 (json/txt 不该被去标签)', async () => {
    const p = new PlainFetchProvider({ fetchImpl: ok('{"a":1}', 'application/json') });
    expect((await p.fetch('https://e.example/a.json')).text).toBe('{"a":1}');
  });

  test('HTTP 错误 → ProviderError 带 status (pool 据此降级到下一个 provider)', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch,
    });
    try {
      await p.fetch('https://e.example/a');
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).status).toBe(403);
    }
  });

  test('429 被识别成配额错 (pool 的 failover 判据)', async () => {
    const p = new PlainFetchProvider({
      fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
    });
    await p.fetch('https://e.example/a').catch((e) => expect((e as ProviderError).isQuota).toBe(true));
  });

  test('超时 → ProviderError 而不是裸 AbortError', async () => {
    const p = new PlainFetchProvider({
      timeoutMs: 5,
      fetchImpl: ((_u: string, o: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => o.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))))as unknown as typeof fetch,
    });
    await p.fetch('https://e.example/slow').catch((e) => {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as Error).message).toContain('超时');
    });
  });
});
