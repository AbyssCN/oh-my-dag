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
  /** 实际服务的 provider (failover/rotate = 1 个, aggregate = N 个; 全员空手 = 试过的全部)。 */
  providers: string[];
  mode: PoolMode;
  /**
   * 路上被跳过的 provider 的错误原文(`name: message`)。缺席 = 没人抛。
   * 有它才分得开「链走完了确实没结果」与「一半 provider 挂了才显得没结果」——
   * 不留这一格的话, 后者会被读成前者(fail-open 可以吞异常, 不许吞证据)。
   */
  errors?: string[];
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

  /**
   * 顺序尝试, 首个**给出结果**的即记额度并返回; 全失败抛聚合错误。
   *
   * ⚠ **空手不算答**(2026-08-14 修): 原实现是"首个不抛的就返回", 于是一个 200 但
   * `results: []` 的 provider(限流软失败 / 该 query 它没索引)**把 failover 链短路掉** ——
   * 后面的 provider 一个都不试, `retrieveWeb` 拿到 0 条, `researchWebFanout` 抛
   * 「检索零结果, 无语料可研究」, 整个 research 节点失败 → 进毒集 → 语料双跑重画。
   * 也就是说 failover 此前**只保"provider 挂了"这一档, 不保"provider 空手"这一档**,
   * 而后者在盘上留下的痕迹与前者完全不同(节点抛的是"零结果"不是"provider failed"),
   * 所以一直没人把它读成 failover 的洞。现场: `.omd/continuity/42982b58-…-contract/
   * fail-contract__1zx4npofuujaj.txt`。
   *
   * **全员空手仍返空、不抛** —— 上游 `retrieveWeb` 把多条 query 放在 `Promise.all` 里,
   * 这里一抛就会把**别的 query 已经搜到的结果**一起带走。空是合法答案, 只是要在**试遍全链之后**才算数。
   */
  async function tryInOrder(
    ordered: ResolvedEntry[],
    query: string,
    maxResults: number,
    t: number,
    signal?: AbortSignal,
  ): Promise<PoolSearchResult> {
    const errors: string[] = [];
    const empties: string[] = [];
    for (const e of ordered) {
      try {
        const results = await e.provider.search(query, maxResults, signal);
        // 发出去了就记额度 —— 空手也真的用掉了一次配额, 不记会让额度账虚高。
        quota.record(e.name, t);
        if (results.length === 0) {
          empties.push(e.name);
          continue; // 换下一个 provider, 而不是把空手当答案
        }
        return { results, providers: [e.name], mode, ...(errors.length ? { errors } : {}) };
      } catch (err) {
        errors.push(`${e.name}: ${(err as Error).message}`);
      }
    }
    // 有人空手 = 链走完了, 答案确实是空 (providers 记全部试过的, 让调用方看得出链已耗尽)。
    // 一个都没空手 = 全是抛的 → 保持原语义抛聚合错误。两种"没结果"不许合并成一种。
    if (empties.length > 0) return { results: [], providers: empties, mode, ...(errors.length ? { errors } : {}) };
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
