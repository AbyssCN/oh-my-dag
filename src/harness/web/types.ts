/**
 * src/harness/web/types —— omd web 层 provider 接口 (clean-room from rpiv-web-tools, MIT)。
 *
 * 借 rpiv 的接口**形状**(SearchProvider/FetchProvider 角色拆分 + SSRF 护栏 + 错误状态映射),
 * **不**借它的包/编排层 —— rpiv 的 factory 是硬编码 switch + 每次只选一个 provider,
 * 给不了我们要的"多 key 轮换额度 + 聚合 + 自定义来源"。轮换/聚合编排在 ./pool 自建。
 *
 * 接口刻意只一个方法: provider = 一个来源,壳越薄越好;路由/额度/降级全在 Pool。
 */

/** 搜索命中 (归一化后, 各 provider 自有字段映射到此)。 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 抓取结果 (归一化后)。text = 正文 (markdown 优先), 清洗器后续可再过一道。 */
export interface FetchResult {
  url: string;
  text: string;
  title?: string;
  contentType?: string;
}

export type ProviderRole = 'search' | 'fetch';

/** 搜索来源: 关键词 → 命中列表。maxResults 是上限提示, provider 自行 slice。 */
export interface SearchProvider {
  readonly name: string;
  search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

/** 抓取来源: 一个 URL → 内容。raw=true 跳过 provider 侧清洗 (要原始 HTML 时)。 */
export interface FetchProvider {
  readonly name: string;
  fetch(url: string, opts?: { raw?: boolean; signal?: AbortSignal }): Promise<FetchResult>;
}

/** 注入式 fetch — 默认 globalThis.fetch, 测试注入 fake 不打网络。 */
export type FetchImpl = typeof fetch;

/**
 * Provider 级错误, 带 HTTP status 让 Pool 区分降级原因:
 *   isQuota (429) → 这个 key 额度耗尽, failover 到下一个
 *   isAuth (401/403) → key 失效, 同样 failover 但值得告警
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get isQuota(): boolean {
    return this.status === 429;
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * 拒绝非 http(s) URL — 用户/模型给的 url 不能静默变成 file://、javascript:、data:
 * (new URL() 会接受但下游误用)。借自 rpiv searxng.ts:assertHttpUrl。
 */
export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL (got: ${url})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`url must be http(s) (got: ${parsed.protocol.replace(':', '')}://)`);
  }
}

/** URL 归一化 (aggregate 去重用): 去尾斜杠 + 小写 host + 去 #fragment。 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return url.replace(/\/+$/, '').toLowerCase();
  }
}
