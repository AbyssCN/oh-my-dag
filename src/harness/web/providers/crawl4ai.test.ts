import { describe, expect, test } from 'bun:test';
import { Crawl4aiProvider } from './crawl4ai';
import { ProviderError } from '../types';

// 注入 fetchImpl → 单测永不打真网络 (NAS 关机时这套测试也必须绿)。
const jsonOk = (body: unknown, capture?: (req: { url: string; init: RequestInit }) => void) =>
  (async (url: string, init: RequestInit) => {
    capture?.({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

describe('Crawl4aiProvider', () => {
  test('markdown 正文 + fit 过滤 (默认档: 服务端裁掉导航只留正文)', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = new Crawl4aiProvider({
      baseUrl: 'http://nas:11235',
      fetchImpl: jsonOk({ markdown: '# 标题\n正文', success: true }, (r) => (seen = r)),
    });
    const r = await p.fetch('https://e.example/a');
    expect(r.text).toContain('正文');
    expect(r.contentType).toBe('text/markdown');
    expect(seen?.url).toBe('http://nas:11235/md');
    expect(JSON.parse(String(seen?.init.body))).toMatchObject({ url: 'https://e.example/a', f: 'fit' });
  });

  test('baseUrl 尾斜杠不产生 //md (配置里带不带斜杠都得对)', async () => {
    let seen: { url: string } | undefined;
    const p = new Crawl4aiProvider({
      baseUrl: 'http://nas:11235/',
      fetchImpl: jsonOk({ markdown: 'x', success: true }, (r) => (seen = r)),
    });
    await p.fetch('https://e.example/a');
    expect(seen?.url).toBe('http://nas:11235/md');
  });

  test('raw=true → f:raw (调用方要未裁剪的面)', async () => {
    let seen: { init: RequestInit } | undefined;
    const p = new Crawl4aiProvider({
      baseUrl: 'http://nas:11235',
      fetchImpl: jsonOk({ markdown: 'x', success: true }, (r) => (seen = r)),
    });
    await p.fetch('https://e.example/a', { raw: true });
    expect(JSON.parse(String(seen?.init.body)).f).toBe('raw');
  });

  test('★ 200 + success:false 必须抛 —— 否则 pool 把空正文当成功, 不再降级到下一个 provider', async () => {
    const p = new Crawl4aiProvider({
      baseUrl: 'http://nas:11235',
      fetchImpl: jsonOk({ success: false, detail: '目标站拒绝' }),
    });
    expect(p.fetch('https://e.example/a')).rejects.toThrow(ProviderError);
  });

  test('HTTP 错误 → ProviderError 带 status (pool 据此降级)', async () => {
    const p = new Crawl4aiProvider({
      baseUrl: 'http://nas:11235',
      fetchImpl: (async () => new Response('boom', { status: 502 })) as unknown as typeof fetch,
    });
    expect(p.fetch('https://e.example/a')).rejects.toMatchObject({ provider: 'crawl4ai', status: 502 });
  });

  test('非 http(s) URL 直接拒 (SSRF 面, 与其它 provider 同闸)', async () => {
    const p = new Crawl4aiProvider({ baseUrl: 'http://nas:11235', fetchImpl: jsonOk({ markdown: 'x' }) });
    expect(p.fetch('file:///etc/passwd')).rejects.toThrow();
  });
});
