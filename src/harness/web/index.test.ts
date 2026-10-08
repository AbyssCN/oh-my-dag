/**
 * src/harness/web/index.test —— createWebStackFromEnv 的 provider 顺序闸 (2026-09-25 新建)。
 *
 * 默认序 tavily → anysearch → searxng (有 key 的优先, 为开源用户"没 key 至少能搜")。
 * 自托管 SearXNG 的 owner 要反过来: 零边际成本的先上, 付费 API 当降级位 → `OMD_WEB_ORDER`。
 * 怎么让它红: 删掉 index.ts 里按 OMD_WEB_ORDER 重排 entries 那段 → ①② 红。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createWebStackFromEnv } from './index';
import { createQuotaStore } from './quota-store';

const env = {
  TAVILY_API_KEY: 'k1',
  ANYSEARCH_API_KEY: 'k2',
  SEARXNG_URL: 'http://searx.test',
};
const names = (e: Record<string, string>) =>
  createWebStackFromEnv(e, { quota: createQuotaStore({ path: ':memory:' }) }).searchPool.status().map((s) => s.name);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('OMD_WEB_ORDER', () => {
  test('未设 → 默认序不变', () => {
    expect(names(env)).toEqual(['tavily', 'anysearch', 'searxng']);
  });

  test('① 按列表重排, 未列出的按原序垫后', () => {
    expect(names({ ...env, OMD_WEB_ORDER: 'searxng,tavily' })).toEqual(['searxng', 'tavily', 'anysearch']);
  });

  test('未配置的名字忽略, 不抛', () => {
    expect(names({ ...env, OMD_WEB_ORDER: 'brave, searxng' })).toEqual(['searxng', 'tavily', 'anysearch']);
  });

  test('② failover 真的先打排第一的 provider', async () => {
    const hosts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      hosts.push(new URL(String(input instanceof Request ? input.url : input)).host);
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { searchPool } = createWebStackFromEnv(
      { ...env, OMD_WEB_ORDER: 'searxng' },
      { quota: createQuotaStore({ path: ':memory:' }) },
    );
    await searchPool.search('q').catch(() => {});
    expect(hosts[0]).toBe('searx.test');
  });
});
