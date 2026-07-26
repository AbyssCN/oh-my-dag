/**
 * plain fetch provider —— **零 key、零依赖、零子进程**的抓取兜底 (2026-07-26)。
 *
 * 动机: 现有四个 provider 全要 key (tavily/anysearch 搜索 · firecrawl/jina 抓取)。开源用户手上
 * 一个 key 都没有时 web 层完全用不了。而"抓一个公开网页"这件事本身不需要任何第三方服务 ——
 * Bun 自带 fetch, 仓库自带 clean.ts (HTML → 正文)。
 *
 * owner 问过能不能用 curl: 能, 但起子进程更差 —— 要过命令白名单 (curl 刻意不在表内, 见
 * command-leaf 的"网络类不收"), 要处理超时与编码, 还多一次进程开销。内置 fetch 严格更好。
 * (pi 也查过: 它没有任何 web 工具, 那条路没有免费午餐。)
 *
 * 边界要诚实 —— 这是**兜底不是替代**:
 *   - 不执行 JS: SPA / 需要渲染的页面拿到的是骨架。要真渲染走 firecrawl/jina/scrapling。
 *   - 不过反爬: 403/429/Cloudflare 一律照抛, 由 pool 降级到下一个 provider。
 *   - 不做搜索: 它只认 URL。零 key 的**搜索**路径是 searxng (自托管)。
 */
import { ProviderError, type FetchImpl, type FetchProvider, type FetchResult } from '../types';
import { stripHtmlToText } from '../clean';

/** 装成常见浏览器 —— 不少站点对空 UA 直接 403。不是反爬手段, 只是别看起来像坏掉的脚本。 */
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 单页硬顶 (MEDIA-3 同族): 超大页截断而不是撑爆下游 context。 */
const MAX_BYTES = 2_000_000;

export class PlainFetchProvider implements FetchProvider {
  readonly name = 'plain';
  constructor(private readonly opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {}) {}

  async fetch(url: string, opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<FetchResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const timeoutMs = this.opts.timeoutMs ?? 20_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    // 调用方给了 signal 就跟着一起中止 (两个来源任一触发即停)。
    opts.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      const res = await f(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      });
      if (!res.ok) {
        throw new ProviderError('plain', res.status, `plain fetch ${res.status} ${url}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const body = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw;
      // raw=true → 原样回 (调用方要自己清洗); 否则 HTML 去标签成正文。
      const text = opts.raw || !/html/i.test(contentType) ? body : stripHtmlToText(body);
      const title = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(body)?.[1]?.trim();
      return { url, text, ...(title ? { title } : {}), ...(contentType ? { contentType } : {}) };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const msg = (e as Error).name === 'AbortError' ? `plain fetch 超时 (${timeoutMs}ms)` : (e as Error).message;
      throw new ProviderError('plain', undefined, msg);
    } finally {
      clearTimeout(timer);
    }
  }
}
