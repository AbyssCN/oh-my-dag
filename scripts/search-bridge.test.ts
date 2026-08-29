/**
 * 检索桥(2026-08-29)。
 *
 * 反向自检(逐条实测会红):
 *   · 去掉 token 比对那一行 → 「错 token 401」红;
 *   · 把「空结果 + 有错 → 502」那一支删掉 → 「搜挂了不许伪装成没搜到」红;
 *   · 把 `omd` 那一格拿掉 → 「谁服务的/谁挂了要带回去」红。
 */
import { describe, expect, test } from 'bun:test';
import { handleSearch, type PoolReply, type SearchBridgeDeps } from './search-bridge';

const TOKEN = 'tok-abc';
const ok = (results: PoolReply['results'], extra: Partial<PoolReply> = {}): SearchBridgeDeps => ({
  token: TOKEN,
  search: async () => ({ results, providers: ['tavily'], ...extra }),
});
const u = (path: string) => new URL(`http://h${path}`);

describe('鉴权与路由', () => {
  test('对的 token → 200', async () => {
    const r = await handleSearch(u(`/s/${TOKEN}/search?q=hi`), ok([{ title: 't', url: 'u', snippet: 's' }]));
    expect(r.status).toBe(200);
  });

  test('错 token → 401, 且不提示哪里错 (说"token 错了"等于告诉扫描器路径对了)', async () => {
    const r = await handleSearch(u('/s/wrong/search?q=hi'), ok([]));
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.json)).not.toContain('token');
  });

  test('别的路径 → 404 (桥只暴露检索这一个面)', async () => {
    for (const p of ['/search', `/s/${TOKEN}/fetch`, `/s/${TOKEN}/`, '/admin']) {
      expect((await handleSearch(u(p), ok([]))).status).toBe(404);
    }
  });

  test('缺 q → 400', async () => {
    expect((await handleSearch(u(`/s/${TOKEN}/search`), ok([]))).status).toBe(400);
    expect((await handleSearch(u(`/s/${TOKEN}/search?q=%20%20`), ok([]))).status).toBe(400);
  });
});

describe('SearXNG 形状', () => {
  test('snippet → content, 键名与 SearxngProvider 逐字对得上', async () => {
    const r = await handleSearch(u(`/s/${TOKEN}/search?q=hi&format=json`), ok([{ title: 'T', url: 'U', snippet: 'S' }]));
    const j = r.json as { results: Array<{ title: string; url: string; content: string }> };
    expect(j.results).toEqual([{ title: 'T', url: 'U', content: 'S' }]);
  });

  test('maxResults 有上限, 非法值退回默认 (别让调用方一发把配额烧穿)', async () => {
    let seen = 0;
    const deps: SearchBridgeDeps = { token: TOKEN, search: async (_q, n) => { seen = n; return { results: [], providers: [] }; } };
    await handleSearch(u(`/s/${TOKEN}/search?q=x&maxResults=999`), deps);
    expect(seen).toBe(50);
    await handleSearch(u(`/s/${TOKEN}/search?q=x&maxResults=abc`), deps);
    expect(seen).toBe(10);
  });
});

describe('★ 空结果与失败必须分得开', () => {
  test('真的没搜到 (零错误) → 200 + 空数组', async () => {
    const r = await handleSearch(u(`/s/${TOKEN}/search?q=hi`), ok([]));
    expect(r.status).toBe(200);
    expect((r.json as { results: unknown[] }).results).toEqual([]);
  });

  test('★ 空结果 + provider 抛错 → 502, 不许伪装成"没搜到"', async () => {
    // 这条是本文件存在的主要理由: 200 + 空数组会让调研节点照着"网上查不到"往下写。
    const r = await handleSearch(u(`/s/${TOKEN}/search?q=hi`), ok([], { errors: ['tavily: 429 quota'] }));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain('429 quota');
  });

  test('有结果但一半 provider 挂了 → 200, 错误原文照样带回去 (留了证据才看得见)', async () => {
    const r = await handleSearch(u(`/s/${TOKEN}/search?q=hi`), ok([{ title: 't', url: 'u', snippet: 's' }], { errors: ['anysearch: 500'] }));
    expect(r.status).toBe(200);
    const j = r.json as { omd: { providers: string[]; errors?: string[] } };
    expect(j.omd.errors).toEqual(['anysearch: 500']);
    expect(j.omd.providers).toEqual(['tavily']);
  });

  test('search 抛异常 → 502 + 原文 (不吞)', async () => {
    const deps: SearchBridgeDeps = { token: TOKEN, search: async () => { throw new Error('boom'); } };
    const r = await handleSearch(u(`/s/${TOKEN}/search?q=hi`), deps);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).toContain('boom');
  });
});
