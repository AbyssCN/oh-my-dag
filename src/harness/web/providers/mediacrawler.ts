/**
 * MediaCrawler 中文社媒语料 provider(自托管,部署见 `deploy/mediacrawler/`)。
 *
 * **它同时是 SearchProvider 和 FetchProvider,这不是图省事**:知乎正文要登录态,
 * 普通抓取档(crawl4ai/firecrawl/jina)对它一律撞墙。采集时正文已经跟着结果回来了,
 * 于是 `search` 顺手把 url→正文记进 memo,`fetch` 只从 memo 供 —— 抓不到的 URL 直接抛,
 * 让 pool 照常降级(最终落进 `needsBrowserHarness`,与既有逃生口一致)。
 *
 * ## 三条来自真实行为的约束(照直觉写会错)
 *
 * 1. **上游单任务串行**:`crawler_manager` 全局一个子进程,第二个 start 会被拒。而
 *    `retrieveWeb` 是**并发**发多条改写 query 的 —— 所以本类内部排队(`chain`),
 *    并发调用变串行执行,不是"调用方注意别并发"。
 * 2. **产物文件累积**:同平台同日的结果**追加**进同一个 `search_contents_<date>.json`
 *    (实测 18 条→再跑一次变 36 条)。所以采集前后各扫一次 `content_id`,**只取新增**,
 *    否则第二次检索会把上一次的语料当本次结果返回。
 * 3. **status 只是"进程还在不在"**:采集完成 ≠ 拿到东西(关键词无结果也会正常结束)。
 *    零新增返回空数组,不是错误。
 *
 * 档位:分钟级、平台有风控。**不进默认搜索轮换**(装配处 `enabled: false`),要它的人显式开。
 */
import {
  ProviderError,
  type FetchImpl,
  type FetchProvider,
  type FetchResult,
  type SearchProvider,
  type SearchResult,
} from '../types';

/** MediaCrawler 支持的平台(与上游 PlatformEnum 一致)。 */
export type SocialPlatform = 'zhihu' | 'xhs' | 'dy' | 'ks' | 'bili' | 'wb' | 'tieba';

export interface MediaCrawlerOpts {
  /** 采集服务地址, 如 http://192.168.50.154:8090。 */
  baseUrl: string;
  /** 登录态 cookie 串 (`k=v; k=v`)。**凭证** —— 只从 env 进, 不落盘不进日志。 */
  cookies?: string;
  /** 默认平台 (可按调用覆盖)。 */
  platform?: SocialPlatform;
  /** 单次采集的墙钟上限 (默认 8 分钟) —— 超时抛, 不无限等。 */
  timeoutMs?: number;
  /** 轮询间隔 (默认 5s)。 */
  pollIntervalMs?: number;
  fetchImpl?: FetchImpl;
  /** 注入睡眠 → 单测零等待。 */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** 上游 JSON 记录 (只声明我们真读的字段)。 */
interface CrawlRecord {
  content_id?: string;
  content_url?: string;
  title?: string;
  desc?: string;
  content_text?: string;
}

interface DataFile {
  path: string;
}

const SNIPPET_CHARS = 300;

export class MediaCrawlerProvider implements SearchProvider, FetchProvider {
  readonly name = 'mediacrawler';
  /** url → 采集时拿到的正文 (fetch 侧唯一数据源)。 */
  private readonly corpus = new Map<string, { text: string; title?: string }>();
  /** 串行闸: 上游单任务, 并发调用在这里排队 (见头注 ①)。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: MediaCrawlerOpts) {}

  /** 已采语料的 URL 数 (读数/测试用)。 */
  get corpusSize(): number {
    return this.corpus.size;
  }

  async search(query: string, maxResults = 10, signal?: AbortSignal): Promise<SearchResult[]> {
    const run = this.chain.then(
      () => this.collect(query, maxResults, signal),
      () => this.collect(query, maxResults, signal), // 前一个失败不该拖垮后一个
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 只从 memo 供正文 —— 没有就抛, 让 pool 降级 (绝不回落到会撞登录墙的抓取)。 */
  async fetch(url: string): Promise<FetchResult> {
    const hit = this.corpus.get(url);
    if (!hit) throw new ProviderError(this.name, undefined, `未采集过此 URL: ${url}`);
    return { url, text: hit.text, title: hit.title, contentType: 'text/plain' };
  }

  private async collect(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const platform = this.opts.platform ?? 'zhihu';
    const before = new Set((await this.readRecords(platform, signal)).map((r) => r.content_id));

    const res = await this.api('/api/crawler/start', signal, {
      platform,
      login_type: this.opts.cookies ? 'cookie' : 'qrcode',
      cookies: this.opts.cookies ?? '',
      crawler_type: 'search',
      keywords: query,
      enable_comments: false,
      save_option: 'json',
      headless: true,
      max_notes_count: maxResults,
    });
    if (!res.ok) throw new ProviderError(this.name, res.status, `起采集失败: ${await res.text()}`);

    await this.waitIdle(signal);

    // 只取新增 (见头注 ②)。
    const fresh = (await this.readRecords(platform, signal)).filter(
      (r) => r.content_id && !before.has(r.content_id) && r.content_url,
    );
    const out: SearchResult[] = [];
    for (const r of fresh.slice(0, maxResults)) {
      const url = r.content_url!;
      const text = (r.content_text ?? '').trim();
      if (text) this.corpus.set(url, { text, title: r.title });
      out.push({
        title: r.title ?? '(无题)',
        url,
        snippet: (text || r.desc || '').slice(0, SNIPPET_CHARS),
      });
    }
    return out;
  }

  /** 轮询到进程退出。超时抛 —— 上游曾有"日志协程死掉 → status 永远 running"的缺陷, 不能无限等。 */
  private async waitIdle(signal?: AbortSignal): Promise<void> {
    const sleep = this.opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const interval = this.opts.pollIntervalMs ?? 5_000;
    const deadline = this.opts.timeoutMs ?? 8 * 60_000;
    for (let waited = 0; waited <= deadline; waited += interval) {
      const res = await this.api('/api/crawler/status', signal);
      if (!res.ok) throw new ProviderError(this.name, res.status, `读状态失败: ${await res.text()}`);
      const st = (await res.json()) as { status?: string; error_message?: string | null };
      if (st.status === 'error') {
        throw new ProviderError(this.name, undefined, `采集报错: ${st.error_message ?? '(无详情)'}`);
      }
      if (st.status === 'idle') return;
      await sleep(interval);
    }
    throw new ProviderError(this.name, undefined, `采集超时 (>${deadline}ms), 未回到 idle`);
  }

  private async readRecords(platform: string, signal?: AbortSignal): Promise<CrawlRecord[]> {
    const listRes = await this.api(`/api/data/files?platform=${platform}`, signal);
    if (!listRes.ok) return [];
    const { files = [] } = (await listRes.json()) as { files?: DataFile[] };
    const out: CrawlRecord[] = [];
    for (const f of files.filter((x) => x.path?.endsWith('.json'))) {
      const r = await this.api(`/api/data/files/${f.path}?preview=false`, signal);
      if (!r.ok) continue;
      const body = (await r.json()) as CrawlRecord[] | { data?: CrawlRecord[] };
      out.push(...(Array.isArray(body) ? body : (body.data ?? [])));
    }
    return out;
  }

  private api(path: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
    return body === undefined
      ? f(url, { signal })
      : f(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
  }
}
