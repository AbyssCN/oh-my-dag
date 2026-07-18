/**
 * src/harness/web/pool —— WebSearchPool: 多 provider 编排 (失效/轮换/聚合 + 额度)。
 *
 * 解 rpiv 给不了的三件事:
 *   failover  — 默认挂了 (错误/额度耗尽) 自动换下一个, 保可用性。
 *   rotate    — 多 key 各自额度独立, 每次挑**用得最少**的, 把负载摊开 (the owner: "3 个 api 轮额度不共享")。
 *   aggregate — 全发并行, 按 URL 去重合并 (the owner: "也可以一起用"), 质量最高最费。
 *
 * 额度事实层 = QuotaStore (sqlite); limit 在每个 entry 上 (undefined = keyless 无限)。
 * 纯逻辑 (provider/quota/now 全注入) → 是 TDD 头号靶子, 高风险接缝必测死。
 */
import type { SearchProvider, SearchResult } from './types';
import { normalizeUrl } from './types';
import type { QuotaStore } from './quota-store';

export type PoolMode = 'failover' | 'rotate' | 'aggregate';

export interface SearchEntry {
  name: string;
  provider: SearchProvider;
  /** 每窗口额度上限; undefined = keyless 无限 (如 duckduckgo)。 */
  limit?: number;
  /** 默认 true; toggle 关掉后不参与任何模式。 */
  enabled?: boolean;
}

export interface PoolSearchResult {
  results: SearchResult[];
  /** 实际服务的 provider (failover/rotate = 1 个, aggregate = N 个)。 */
  providers: string[];
  mode: PoolMode;
}

export interface ProviderStatus {
  name: string;
  enabled: boolean;
  limit: number | null;
  used: number;
  /** 剩余额度; keyless = null (无限)。 */
  remaining: number | null;
  exhausted: boolean;
}

export interface WebSearchPool {
  search(
    query: string,
    maxResults?: number,
    opts?: { mode?: PoolMode; signal?: AbortSignal },
  ): Promise<PoolSearchResult>;
  setMode(mode: PoolMode): void;
  /** 设 failover/rotate 的优先 provider (rotate 仅作平额度时的 tiebreak)。 */
  setDefault(name: string): void;
  toggle(name: string, enabled: boolean): void;
  status(now?: number): ProviderStatus[];
}

interface ResolvedEntry extends SearchEntry {
  enabled: boolean;
}

export function createWebSearchPool(opts: {
  entries: SearchEntry[];
  quota: QuotaStore;
  mode?: PoolMode;
  defaultProvider?: string;
  now?: () => number;
}): WebSearchPool {
  if (opts.entries.length === 0) throw new Error('WebSearchPool: at least one entry required');
  const now = opts.now ?? (() => Date.now());
  const entries: ResolvedEntry[] = opts.entries.map((e) => ({ ...e, enabled: e.enabled !== false }));
  const byName = new Map(entries.map((e) => [e.name, e]));
  let mode: PoolMode = opts.mode ?? 'failover';
  let defaultProvider = opts.defaultProvider;
  if (defaultProvider && !byName.has(defaultProvider)) {
    throw new Error(`WebSearchPool: unknown defaultProvider "${defaultProvider}"`);
  }

  const quota = opts.quota;
  const usedOf = (e: ResolvedEntry, t: number) => quota.used(e.name, t);
  const isExhausted = (e: ResolvedEntry, t: number) => e.limit != null && usedOf(e, t) >= e.limit;
  const available = (t: number) => entries.filter((e) => e.enabled && !isExhausted(e, t));

  /** 按 failover 优先序: default 先, 其余按配置序。 */
  function failoverOrder(cands: ResolvedEntry[]): ResolvedEntry[] {
    if (!defaultProvider) return cands;
    const head = cands.filter((e) => e.name === defaultProvider);
    const tail = cands.filter((e) => e.name !== defaultProvider);
    return [...head, ...tail];
  }

  /** rotate 序: 用得最少的先 (摊额度), 平局 → default 先 → 配置序。 */
  function rotateOrder(cands: ResolvedEntry[], t: number): ResolvedEntry[] {
    const idx = new Map(entries.map((e, i) => [e.name, i]));
    return [...cands].sort((a, b) => {
      const ua = usedOf(a, t);
      const ub = usedOf(b, t);
      if (ua !== ub) return ua - ub;
      if (a.name === defaultProvider) return -1;
      if (b.name === defaultProvider) return 1;
      return (idx.get(a.name)! - idx.get(b.name)!);
    });
  }

  /** 顺序尝试, 首个成功即记额度并返回; 全失败抛聚合错误。 */
  async function tryInOrder(
    ordered: ResolvedEntry[],
    query: string,
    maxResults: number,
    t: number,
    signal?: AbortSignal,
  ): Promise<PoolSearchResult> {
    const errors: string[] = [];
    for (const e of ordered) {
      try {
        const results = await e.provider.search(query, maxResults, signal);
        quota.record(e.name, t);
        return { results, providers: [e.name], mode };
      } catch (err) {
        errors.push(`${e.name}: ${(err as Error).message}`);
      }
    }
    throw new Error(`all search providers failed: ${errors.join(' | ')}`);
  }

  /** aggregate: 并行全发, 成功的记额度, 按 URL 去重 + 跨 provider round-robin 交织。 */
  async function aggregate(
    cands: ResolvedEntry[],
    query: string,
    maxResults: number,
    t: number,
    signal?: AbortSignal,
  ): Promise<PoolSearchResult> {
    const settled = await Promise.allSettled(
      cands.map((e) => e.provider.search(query, maxResults, signal)),
    );
    const served: string[] = [];
    const lists: SearchResult[][] = [];
    settled.forEach((s, i) => {
      const e = cands[i];
      if (e && s.status === 'fulfilled') {
        quota.record(e.name, t);
        served.push(e.name);
        lists.push(s.value);
      }
    });
    if (served.length === 0) throw new Error('aggregate: all providers failed');

    // round-robin 交织 (每 provider 的 rank-0 先, 再 rank-1...), 按归一化 URL 去重。
    const seen = new Set<string>();
    const merged: SearchResult[] = [];
    const maxLen = Math.max(0, ...lists.map((l) => l.length));
    for (let rank = 0; rank < maxLen && merged.length < maxResults; rank++) {
      for (const list of lists) {
        if (merged.length >= maxResults) break;
        const r = list[rank];
        if (!r) continue;
        const key = normalizeUrl(r.url);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
    }
    return { results: merged, providers: served, mode };
  }

  return {
    async search(query, maxResults = 10, searchOpts = {}) {
      const useMode = searchOpts.mode ?? mode;
      const t = now();
      const cands = available(t);
      if (cands.length === 0) {
        throw new Error('WebSearchPool: no available provider (all disabled or quota-exhausted)');
      }
      if (useMode === 'aggregate') {
        return aggregate(cands, query, maxResults, t, searchOpts.signal);
      }
      const ordered =
        useMode === 'rotate' ? rotateOrder(cands, t) : failoverOrder(cands);
      return tryInOrder(ordered, query, maxResults, t, searchOpts.signal);
    },
    setMode(m) {
      mode = m;
    },
    setDefault(name) {
      if (!byName.has(name)) throw new Error(`WebSearchPool: unknown provider "${name}"`);
      defaultProvider = name;
    },
    toggle(name, enabled) {
      const e = byName.get(name);
      if (!e) throw new Error(`WebSearchPool: unknown provider "${name}"`);
      e.enabled = enabled;
    },
    status(t = now()) {
      return entries.map((e) => {
        const used = usedOf(e, t);
        return {
          name: e.name,
          enabled: e.enabled,
          limit: e.limit ?? null,
          used,
          remaining: e.limit != null ? Math.max(0, e.limit - used) : null,
          exhausted: isExhausted(e, t),
        };
      });
    },
  };
}
