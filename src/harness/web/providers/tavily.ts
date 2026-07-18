/** Tavily search provider (POST api.tavily.com/search, api_key in body)。dev plan 1000 calls/月。 */
import { ProviderError, type FetchImpl, type SearchProvider, type SearchResult } from '../types';

interface TavilyRaw {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  constructor(private readonly opts: { apiKey: string; fetchImpl?: FetchImpl }) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.opts.apiKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
      }),
      signal,
    });
    if (!res.ok) throw new ProviderError('tavily', res.status, await res.text());
    const data = (await res.json()) as TavilyRaw;
    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  }
}
