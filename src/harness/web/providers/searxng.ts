/**
 * SearXNG search provider —— 自托管 metasearch, **免 key、无限量、查询不出本机**。
 * 端点 GET <baseUrl>/search?q=&format=json;聚合 Google/Bing/DDG 等。
 *
 * 为什么值得进来 (2026-07-26): 现有搜索 provider (tavily/anysearch) 全要 key —— 开源用户手上
 * 一个 key 都没有时 web 层完全用不了。SearXNG 是唯一的零成本入口 (自己跑一个实例, 设 SEARXNG_URL)。
 * 与 plain fetch provider 配成一对: **零 key 搜 + 零 key 抓**, 整条 web 链路不依赖任何第三方账号。
 *
 * 移植自 fusang/src/xihe/web/providers/searxng.ts (omd 侧 SearchProvider 接口无 SearchOpts, 故去掉
 * time_range —— 时间窗在 omd 侧由 retrieve 层处理)。
 */
import { ProviderError, type FetchImpl, type SearchProvider, type SearchResult } from '../types';

interface SearxngRaw {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export class SearxngProvider implements SearchProvider {
  readonly name = 'searxng';
  constructor(private readonly opts: { baseUrl: string; fetchImpl?: FetchImpl }) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    let res: Response;
    try {
      res = await f(url, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
    } catch (e) {
      // 实例没起来是最常见的失败 —— 说清楚而不是抛一个裸 fetch 错。
      throw new ProviderError('searxng', undefined, `连不上 SearXNG (${base}): ${(e as Error).message}`);
    }
    if (!res.ok) throw new ProviderError('searxng', res.status, (await res.text()).slice(0, 300));
    const data = (await res.json()) as SearxngRaw;
    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  }
}
