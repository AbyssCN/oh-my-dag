/**
 * Jina Reader fetch provider (GET r.jina.ai/<url>)。
 * keyless 基础档可用 (带 key 提限额); 服务端返回清洗好的 markdown 正文 → 零本地依赖的默认抓取。
 */
import {
  assertHttpUrl,
  ProviderError,
  type FetchImpl,
  type FetchProvider,
  type FetchResult,
} from '../types';

export class JinaProvider implements FetchProvider {
  readonly name = 'jina';
  constructor(private readonly opts: { apiKey?: string; fetchImpl?: FetchImpl } = {}) {}

  async fetch(url: string, opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<FetchResult> {
    assertHttpUrl(url);
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'X-Return-Format': opts.raw ? 'html' : 'markdown',
    };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    const res = await f(`https://r.jina.ai/${url}`, { headers, signal: opts.signal });
    if (!res.ok) throw new ProviderError('jina', res.status, await res.text());
    return {
      url,
      text: await res.text(),
      contentType: opts.raw ? 'text/html' : 'text/markdown',
    };
  }
}
