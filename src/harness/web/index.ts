/**
 * src/harness/web —— omd 分发友好 web 栈 (search Pool 轮换/聚合 + fetch provider)。
 *
 * 默认零部署档: search = tavily/anysearch (各自 key 额度) + duckduckgo (keyless 兜底);
 *               fetch  = firecrawl (key) + jina (keyless)。
 * searxng 不打包 (the owner 定); crawl4ai/scrapling/trafilatura/browser-act = 高级自部署档, 另立。
 *
 * createWebStackFromEnv: 据 env 有哪些 key 自动装配 — 缺 key 的 provider 不入栈, 不报错。
 */
import {
  createWebSearchPool,
  type SearchEntry,
  type WebSearchPool,
  type PoolMode,
} from './pool';
import { createQuotaStore, type QuotaStore } from './quota-store';
import type { FetchProvider } from './types';
import { TavilyProvider } from './providers/tavily';
import { AnySearchProvider } from './providers/anysearch';
import { FirecrawlProvider } from './providers/firecrawl';
import { JinaProvider } from './providers/jina';
import { resolveCleaner, type Cleaner } from './clean';

export * from './types';
export * from './quota-store';
export * from './pool';
export * from './clean';
export { TavilyProvider } from './providers/tavily';
export { AnySearchProvider } from './providers/anysearch';
export { FirecrawlProvider } from './providers/firecrawl';
export { JinaProvider } from './providers/jina';

export { createWebExtension, fetchWithFallback } from './web-extension';
export { fetchRacing, defaultTier } from './fetch-racing';
export type { FetchTier } from './fetch-racing';
export { retrieveWeb, buildMarkdown } from './retrieve';
export type { RetrieveOpts, RetrieveResult, RetrievedSource } from './retrieve';
export { classifySourceTier, orderForCrawl } from './source-tier';
export type { SourceTier, TierVerdict } from './source-tier';

export interface WebStack {
  searchPool: WebSearchPool;
  fetchProviders: FetchProvider[];
  /** 正文清洗器 (trafilatura 在 → 真清洗, 否则 passthrough)。包 CleaningFetchProvider 用。 */
  cleaner: Cleaner;
  quota: QuotaStore;
}

export function createWebStackFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { quota?: QuotaStore; mode?: PoolMode } = {},
): WebStack {
  const quota = opts.quota ?? createQuotaStore();
  const entries: SearchEntry[] = [];
  if (env.TAVILY_API_KEY) {
    entries.push({
      name: 'tavily',
      provider: new TavilyProvider({ apiKey: env.TAVILY_API_KEY }),
      limit: Number(env.TAVILY_LIMIT ?? 1000),
    });
  }
  if (env.ANYSEARCH_API_KEY) {
    entries.push({
      name: 'anysearch',
      provider: new AnySearchProvider({ apiKey: env.ANYSEARCH_API_KEY }),
      limit: env.ANYSEARCH_LIMIT ? Number(env.ANYSEARCH_LIMIT) : undefined,
    });
  }
  const searchPool = createWebSearchPool({
    entries,
    quota,
    mode: opts.mode ?? 'failover',
    defaultProvider: entries[0]?.name,
  });

  const fetchProviders: FetchProvider[] = [];
  if (env.FIRECRAWL_API_KEY) fetchProviders.push(new FirecrawlProvider({ apiKey: env.FIRECRAWL_API_KEY }));
  fetchProviders.push(new JinaProvider({ apiKey: env.JINA_API_KEY })); // keyless ok

  return { searchPool, fetchProviders, cleaner: resolveCleaner(), quota };
}
