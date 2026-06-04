/**
 * src/wright/curator/curate — 通用减熵 pass (DEDUP + PRUNE)。
 *
 * 把 `src/dream/purify.ts` 的可复用形状抽成实体无关的 `curate<T>`。本 phase 跑 DEDUP + PRUNE
 * (removal-only, skill 治理够用)。聚类走 curator/cluster (与 purify 共享同一原语, Phase 2b)。
 *
 * 不变量 (镜像 purify 证过性质):
 *  - 受保护项 (isProtected) 永不 tombstone, 且是 DEDUP 簇内 canonical survivor。
 *  - tombstone 幂等 (一 pass 内同 id 不重复删)。
 *  - SHRINK-1 stats: 当前 reducer 全 removal-only → count_out ≤ count_in 恒真 (held 总 true), shrink 作
 *    **减熵度量遥测**。**COMPACT (additive, 唯一能破 SHRINK-1 的 reducer) + 破时 rollback = Phase 2b**
 *    随 purify 迁入 — 不提前 ship 当前不可达的 rollback 分支 (anti-slop)。`restore` 钩子已在接口预留。
 */
import { clusterByCosine } from './cluster';
import type { CuratorAdapter, CurateOptions, CurateReducerOutcome, CurateResult } from './types';

const DEFAULT_DEDUP_THRESHOLD = 0.93;

export async function curate<T>(
  items: T[],
  adapter: CuratorAdapter<T>,
  opts: CurateOptions = {},
): Promise<CurateResult> {
  const threshold = opts.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
  const now = opts.now ?? Date.now();

  const countIn = items.length;
  const bytesIn = items.reduce((s, it) => s + adapter.bytes(it), 0);

  const tombstonedIds = new Set<string>();
  const reducers: CurateReducerOutcome[] = [];

  const tombstone = async (item: T): Promise<boolean> => {
    if (adapter.isProtected(item)) return false;       // 受保护永不删
    const id = adapter.id(item);
    if (tombstonedIds.has(id)) return false;           // 幂等
    await adapter.tombstone(id);
    tombstonedIds.add(id);
    return true;
  };
  const alive = (): T[] => items.filter((it) => !tombstonedIds.has(adapter.id(it)));

  // 1. DEDUP ----------------------------------------------------------------
  reducers.push(await runDedup(alive(), adapter, threshold, tombstone));
  // 2. PRUNE ----------------------------------------------------------------
  reducers.push(await runPrune(alive(), adapter, now, tombstone));

  // SHRINK-1 度量 (removal-only → held 恒真; 作减熵遥测)。
  const surviving = alive();
  const countOut = surviving.length;
  const bytesOut = surviving.reduce((s, it) => s + adapter.bytes(it), 0);

  return {
    reducers,
    shrink: {
      count_in: countIn, count_out: countOut, bytes_in: bytesIn, bytes_out: bytesOut,
      held: countOut <= countIn && bytesOut <= bytesIn,
    },
    rolledBack: false,
    tombstonedIds: [...tombstonedIds],
  };
}

/** DEDUP: embed → cosine 单链聚类 > 阈值 → 簇内 protected/max-rank survivor, 余 tombstone。 */
async function runDedup<T>(
  items: T[],
  adapter: CuratorAdapter<T>,
  threshold: number,
  tombstone: (item: T) => Promise<boolean>,
): Promise<CurateReducerOutcome> {
  const base: CurateReducerOutcome = { kind: 'DEDUP', in: items.length, out: items.length, tombstoned: 0, skipped: false };
  if (!adapter.embed) return { ...base, skipped: true, reason: 'no-embed' };
  if (items.length < 2) return base;

  const vectors = await adapter.embed(items.map((it) => adapter.text(it)));
  if (vectors.length !== items.length) return { ...base, skipped: true, reason: 'embed-shape-mismatch' };

  // 贪心单链聚类 (curator/cluster — 与 purify DEDUP 共享同一原语, Phase 2b)。
  const clusters = clusterByCosine(vectors, threshold);

  let tombstoned = 0;
  for (const members of clusters) {
    if (members.length < 2) continue;
    // survivor: protected 优先 (永不被删), 否则 max rank。
    const prot = members.find((idx) => adapter.isProtected(items[idx]!));
    const best = [...members].sort((a, b) => adapter.rank(items[b]!) - adapter.rank(items[a]!))[0]!;
    const survivor = prot ?? best;
    for (const idx of members) {
      if (idx === survivor) continue;
      if (await tombstone(items[idx]!)) tombstoned += 1;
    }
  }
  return { ...base, tombstoned, out: items.length - tombstoned };
}

/** PRUNE: isStale && !protected → tombstone。 */
async function runPrune<T>(
  items: T[],
  adapter: CuratorAdapter<T>,
  now: number,
  tombstone: (item: T) => Promise<boolean>,
): Promise<CurateReducerOutcome> {
  let tombstoned = 0;
  for (const it of items) {
    if (adapter.isStale(it, now) && await tombstone(it)) tombstoned += 1;
  }
  return { kind: 'PRUNE', in: items.length, out: items.length - tombstoned, tombstoned, skipped: false };
}
