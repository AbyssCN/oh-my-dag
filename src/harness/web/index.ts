/**
 * src/harness/web —— omd 分发友好 web 栈 (search Pool 轮换/聚合 + fetch provider)。
 *
 * 默认零部署档: search = tavily/anysearch (各自 key 额度) + duckduckgo (keyless 兜底);
 *               fetch  = firecrawl (key) + jina (keyless)。
 * 自部署档 (2026-08-04 接上, 有对应 env 才入栈): search 加 searxng, fetch 加 crawl4ai —— 两者都在
 * NAS 上, 零 key 零边际成本, 于是 crawl4ai 排在 firecrawl **之前**、searxng 排在有 key 的搜索源**之后**
 * (搜索按"额度贵的先用完"排, 抓取按"免费的先用"排 —— 方向相反是刻意的)。
 * 中文社媒 (知乎/小红书/微博…) 走 mediacrawler: 登录态才拿得到的正文, 它同时占 search 与 fetch 两侧
 * (采集时正文已随结果回来 → fetch 只从 memo 供)。**入池但默认关**, 见 WebStack.socialCorpus。
 * scrapling/trafilatura/browser-act 仍另立。
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
import { SearxngProvider } from './providers/searxng';
import { Crawl4aiProvider } from './providers/crawl4ai';
import { MediaCrawlerProvider } from './providers/mediacrawler';
import { PlainFetchProvider } from './providers/plain';
import { resolveCleaner, type Cleaner } from './clean';

export * from './types';
export * from './quota-store';
export * from './pool';
export * from './clean';
export { TavilyProvider } from './providers/tavily';
export { AnySearchProvider } from './providers/anysearch';
export { FirecrawlProvider } from './providers/firecrawl';
export { JinaProvider } from './providers/jina';
export { SearxngProvider } from './providers/searxng';
export { Crawl4aiProvider } from './providers/crawl4ai';
export { MediaCrawlerProvider } from './providers/mediacrawler';
export type { SocialPlatform, MediaCrawlerOpts } from './providers/mediacrawler';
export { PlainFetchProvider } from './providers/plain';

// ⚠ `web-extension` (交互-TUI 的 pi extension) **刻意不从这个 barrel 出去**: 它 import
// `pi-coding-agent`, 而 MCP 那条路径经 assemble.ts 进本 barrel —— 从这里再导一次, 整个 CLI 包
// 就跟着被拉进一个零 UI 的 stdio server。要它的只有 tui.ts, 让它直接 import 那个文件。
export { fetchRacing, defaultTier } from './fetch-racing';
export type { FetchTier } from './fetch-racing';
export { retrieveWeb, buildMarkdown } from './retrieve';
export type { RetrieveOpts, RetrieveResult, RetrievedSource, DistilledView } from './retrieve';
export { classifySourceTier, orderForCrawl } from './source-tier';
export type { SourceTier, TierVerdict } from './source-tier';
export { createModelQueryExpander, expandQueries, parseRewrites, EXPAND_SYSTEM } from './query-expand';
export type { QueryExpander } from './query-expand';
export {
  createModelSourceDistiller,
  buildDistillPrompt,
  DISTILL_SYSTEM,
  distillDefaultModel,
  DISTILL_DEFAULT_MAX_CHARS,
} from './distill-source';
export type { SourceDistiller, SourceDistillInput, SourceDistillResult } from './distill-source';

export interface WebStack {
  searchPool: WebSearchPool;
  fetchProviders: FetchProvider[];
  /**
   * 中文社媒语料面 (有 `MEDIACRAWLER_URL` 才在)。**刻意不进默认搜索轮换** —— 它分钟级、
   * 单任务串行、平台有风控, 混进轮换会把每次普通检索都拖成分钟级。
   * 两种用法:① `searchPool.toggle('mediacrawler', true)` 让它参与这一轮检索;
   * ② 直接 `stack.socialCorpus.search(...)` 单独取语料。
   */
  socialCorpus?: MediaCrawlerProvider;
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
  // 零 key 搜索入口 (2026-07-26): 自托管 SearXNG。放在**最后** —— 有 key 的 provider 优先,
  // 没 key 时它是唯一还能搜的东西, 而不是"没配 key 就整层不可用"。
  if (env.SEARXNG_URL) {
    entries.push({ name: 'searxng', provider: new SearxngProvider({ baseUrl: env.SEARXNG_URL }) });
  }
  // 中文社媒语料 (自托管 MediaCrawler): 登录态才拿得到的正文 —— 知乎/小红书/微博等。
  // **enabled: false** 入池 —— 在 status() 里可见、一个 toggle 就能开, 但绝不进默认轮换
  // (分钟级 + 单任务串行, 混进轮换会把每次普通检索都拖成分钟级)。
  const social = env.MEDIACRAWLER_URL
    ? new MediaCrawlerProvider({ baseUrl: env.MEDIACRAWLER_URL, cookies: env.MEDIACRAWLER_COOKIES })
    : undefined;
  if (social) entries.push({ name: social.name, provider: social, enabled: false });

  const searchPool = createWebSearchPool({
    entries,
    quota,
    mode: opts.mode ?? 'failover',
    defaultProvider: entries[0]?.name,
  });

  const fetchProviders: FetchProvider[] = [];
  // 排**最前**且无害: 它只供采集时已拿到正文的 URL (memo 命中即刻返回), 其余立即抛让位。
  // 知乎正文抓不到是登录墙, 后面几档谁都过不去 —— 这一档在, 那些 URL 才有内容。
  if (social) fetchProviders.push(social);
  // 自托管 Crawl4AI (NAS `:11235`) 排在云 API **之前**: 与 firecrawl 同档 (服务端渲染+清洗), 但零 key、
  // 零边际成本、内网直连 —— 云 API 只当它不在时的降级位, 不是首选。
  if (env.CRAWL4AI_URL) {
    fetchProviders.push(new Crawl4aiProvider({ baseUrl: env.CRAWL4AI_URL, apiToken: env.CRAWL4AI_TOKEN }));
  }
  if (env.FIRECRAWL_API_KEY) fetchProviders.push(new FirecrawlProvider({ apiKey: env.FIRECRAWL_API_KEY }));
  fetchProviders.push(new JinaProvider({ apiKey: env.JINA_API_KEY })); // keyless ok
  // 零 key、零依赖、零子进程的最终兜底: 内置 fetch + clean。排最后 —— 它不执行 JS 也不过反爬,
  // 是"前面全挂了至少还能抓到静态正文", 不是替代 (owner 2026-07-26 问 curl: 内置 fetch 更好,
  // 不起子进程 / 不用碰命令白名单; 另查证 pi 本身没有任何 web 工具)。
  fetchProviders.push(new PlainFetchProvider());

  return { searchPool, fetchProviders, cleaner: resolveCleaner(), quota, socialCorpus: social };
}
