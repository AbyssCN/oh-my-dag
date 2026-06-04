/** Firecrawl fetch provider (POST api.firecrawl.dev/v1/scrape, Bearer)。云 API, 服务端已渲染+清洗成 markdown。 */
import {
  assertHttpUrl,
  ProviderError,
  type FetchImpl,
  type FetchProvider,
  type FetchResult,
} from '../types';

interface FirecrawlRaw {
  data?: { markdown?: string; html?: string; metadata?: { title?: string } };
}

export class FirecrawlProvider implements FetchProvider {
  readonly name = 'firecrawl';
  constructor(private readonly opts: { apiKey: string; fetchImpl?: FetchImpl }) {}

  async fetch(url: string, opts: { raw?: boolean; signal?: AbortSignal } = {}): Promise<FetchResult> {
    assertHttpUrl(url);
    const f = this.opts.fetchImpl ?? fetch;
    const formats = opts.raw ? ['html'] : ['markdown'];
    const res = await f('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({ url, formats }),
      signal: opts.signal,
    });
    if (!res.ok) throw new ProviderError('firecrawl', res.status, await res.text());
    const data = (await res.json()) as FirecrawlRaw;
    return {
      url,
      text: opts.raw ? (data.data?.html ?? '') : (data.data?.markdown ?? ''),
      title: data.data?.metadata?.title,
      contentType: opts.raw ? 'text/html' : 'text/markdown',
    };
  }
}
