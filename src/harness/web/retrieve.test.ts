/**
 * web/retrieve 测试 —— query 扩展在检索层的接线 (Task B): 多轮搜索去重 · 爬取槽不超 · 改写失败降级。
 * 注入 fake WebStack (无网络) + fake expander (无模型)。
 */
import { describe, expect, test } from 'bun:test';
import { retrieveWeb } from './retrieve';
import { PassthroughCleaner } from './clean';
import type { WebStack } from './index';
import type { FetchProvider, FetchResult, SearchResult } from './types';
import type { QueryExpander } from './query-expand';

function hit(url: string): SearchResult {
  return { title: url, url, snippet: '' };
}

/** perQuery: query → 命中列表。fetchProvider 计数爬取次数。 */
function fakeStack(
  perQuery: Record<string, SearchResult[]>,
  fetchCounter?: { n: number },
): WebStack {
  const fetchProvider: FetchProvider = {
    name: 'fakefetch',
    async fetch(url): Promise<FetchResult> {
      if (fetchCounter) fetchCounter.n++;
      return { url, text: 'x'.repeat(300) }; // 够长, 过 minChars
    },
  };
  return {
    searchPool: {
      async search(q: string) {
        return { results: perQuery[q] ?? [], providers: ['fake'], mode: 'rotate' as const };
      },
    },
    fetchProviders: [fetchProvider],
    cleaner: new PassthroughCleaner(),
    quota: {},
  } as unknown as WebStack;
}

describe('retrieveWeb query 扩展', () => {
  test('原 query + 改写多轮 → URL 去重 (保首现顺序)', async () => {
    const stack = fakeStack({
      q0: [hit('http://a.com/x'), hit('http://b.com/y')],
      q1: [hit('http://b.com/y'), hit('http://c.com/z')], // b 与 q0 重
    });
    const expander: QueryExpander = async () => ['q1'];
    const r = await retrieveWeb(stack, 'q0', { expander, crawl: 0 });
    expect(r.queries).toEqual(['q0', 'q1']);
    expect(r.sources.map((s) => s.url)).toEqual([
      'http://a.com/x',
      'http://b.com/y',
      'http://c.com/z',
    ]);
  });

  test('爬取槽数不超 crawl (成本天花板不变), 即便扩展后 URL 变多', async () => {
    const counter = { n: 0 };
    const stack = fakeStack(
      {
        q0: [hit('http://a.com/1'), hit('http://a.com/2')],
        q1: [hit('http://a.com/3'), hit('http://a.com/4')],
        q2: [hit('http://a.com/5'), hit('http://a.com/6')],
      },
      counter,
    );
    const expander: QueryExpander = async () => ['q1', 'q2'];
    const r = await retrieveWeb(stack, 'q0', { expander, crawl: 2, minChars: 1, clean: false });
    expect(r.sources.length).toBe(6); // 索引全列
    expect(counter.n).toBe(2); // 只爬 2 个槽
  });

  test('改写失败 → 退回单 query, warn, 不断链', async () => {
    let warned = '';
    const stack = fakeStack({ q0: [hit('http://a.com/x')] });
    const boom: QueryExpander = async () => {
      throw new Error('模型不可用');
    };
    const r = await retrieveWeb(stack, 'q0', {
      expander: boom,
      crawl: 0,
      onWarn: (m) => (warned = m),
    });
    expect(r.queries).toEqual(['q0']);
    expect(r.sources.map((s) => s.url)).toEqual(['http://a.com/x']);
    expect(warned).toContain('模型不可用');
  });

  test('无 expander → 单 query (现有行为不变)', async () => {
    const stack = fakeStack({ q0: [hit('http://a.com/x')] });
    const r = await retrieveWeb(stack, 'q0', { crawl: 0 });
    expect(r.queries).toEqual(['q0']);
  });
});
