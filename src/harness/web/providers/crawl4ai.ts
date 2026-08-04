/**
 * Crawl4AI fetch provider (POST <baseUrl>/md)。**自托管**(NAS `:11235`)——无 key、无配额、内网直连,
 * 服务端真跑浏览器渲染,`fit` 过滤器出清洗好的 markdown。
 *
 * 它在 fetch 池里排在 firecrawl 之前:同样是"服务端渲染+清洗"这一档,但**每次抓取零边际成本**,
 * 云 API 只当它不在(NAS 关机/跑不通)时的降级位。
 */
import {
  assertHttpUrl,
  ProviderError,
  type FetchImpl,
  type FetchProvider,
  type FetchResult,
} from '../types';

interface Crawl4aiRaw {
  markdown?: string;
  success?: boolean;
  detail?: string;
}

export class Crawl4aiProvider implements FetchProvider {
  readonly name = 'crawl4ai';
  constructor(private readonly opts: { baseUrl: string; apiToken?: string; fetchImpl?: FetchImpl }) {}

  async fetch(url: string, opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<FetchResult> {
    assertHttpUrl(url);
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiToken) headers.Authorization = `Bearer ${this.opts.apiToken}`;
    // f: 内容过滤策略 —— raw=调用方要原始面, fit=服务端裁掉导航/页脚只留正文。
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, '')}/md`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, f: opts.raw ? 'raw' : 'fit' }),
      signal: opts.signal,
    });
    if (!res.ok) throw new ProviderError('crawl4ai', res.status, await res.text());
    const data = (await res.json()) as Crawl4aiRaw;
    // 200 + success:false 是它的软失败面 (渲染失败/目标站拒绝) —— 必须转成 ProviderError,
    // 否则 pool 会把空正文当成功结果收下, 不再降级到下一个 provider。
    if (data.success === false) throw new ProviderError('crawl4ai', undefined, data.detail ?? 'crawl failed');
    return { url, text: data.markdown ?? '', contentType: 'text/markdown' };
  }
}
