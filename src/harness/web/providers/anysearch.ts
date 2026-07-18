/**
 * AnySearch search provider (POST api.anysearch.com/v1/search, Bearer 可选)。
 * 无 key = anonymous (IP 限流 + 每日免费额度); 有 key = 计费配额。
 * 响应形状按 anysearch.com/docs best-effort 归一 (results[] / data.results[] / data[]),
 * 首次真 e2e 后据实回填 (R6: 形状未亲验前防御式取字段)。
 */
import { ProviderError, type FetchImpl, type SearchProvider, type SearchResult } from '../types';

export class AnySearchProvider implements SearchProvider {
  readonly name = 'anysearch';
  constructor(private readonly opts: { apiKey?: string; fetchImpl?: FetchImpl } = {}) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    const res = await f('https://api.anysearch.com/v1/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, max_results: maxResults }),
      signal,
    });
    if (!res.ok) throw new ProviderError('anysearch', res.status, await res.text());
    const data = (await res.json()) as Record<string, unknown>;
    const items = pickItems(data);
    return items.slice(0, maxResults).map((r) => ({
      title: str(r.title ?? r.name),
      url: str(r.url ?? r.link),
      snippet: str(r.snippet ?? r.content ?? r.description),
    }));
  }
}

function pickItems(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const cand =
    (data.results as unknown) ??
    ((data.data as Record<string, unknown>)?.results as unknown) ??
    (data.data as unknown);
  return Array.isArray(cand) ? (cand as Array<Record<string, unknown>>) : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
