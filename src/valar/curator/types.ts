/**
 * src/valar/curator/types — 通用 curator 适配器接口 (Phase 2: 一套机器三适配器的"机器"侧)。
 *
 * curator-dream-adapters.md §1/§2 的实现地基。`purify.ts` 是 fact-coupled 的**特化实现** (DEDUP/PRUNE/
 * PURGE/COMPACT over MemoryRecord); 本接口把那套**可复用形状**抽成参数化 `CuratorAdapter<T>`,
 * 让 skill (本 phase) 复用同一减熵机器, gene 后续同理。**purify→curate 迁移 = Phase 2b** (带等价测试)。
 *
 * 钩子映射 (对齐契约 §2 表):
 *   id/text/bytes = 实体身份 / DEDUP 文本 / SHRINK 字节
 *   isProtected   = 受保护名单 (fact: human_verified · skill: tier=core · gene: human_approved)
 *   isStale       = PRUNE 退役判据 (fact: isExpired · skill: freq=0/90d · gene: use_count=0/90d)
 *   rank          = DEDUP 簇内 survivor 偏好 (越大越留; fact: created_at · skill: use_count)
 *   tombstone/restore = 软删 + 可逆 (SHRINK-1 破时回滚)
 */

export interface CuratorAdapter<T> {
  /** 稳定身份 (tombstone/restore 用)。 */
  id(item: T): string;
  /** DEDUP 聚类的文本表面形 (embed 的输入)。 */
  text(item: T): string;
  /** SHRINK-1 字节计量 (信息量, 非簿记)。 */
  bytes(item: T): number;
  /** 受保护: 永不 tombstone, 且是 DEDUP 簇内 canonical survivor。 */
  isProtected(item: T): boolean;
  /** PRUNE: 该实体是否陈旧该退役 (受保护项即使 stale 也不删)。 */
  isStale(item: T, now: number): boolean;
  /** DEDUP 簇内 survivor 偏好排序 (越大越优先留)。 */
  rank(item: T): number;
  /** DEDUP 嵌入器 (text[]→vector[])。缺省 → DEDUP 跳过 ('no-embed')。 */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** 软删一个实体 (status/tier 改, 不物理删)。 */
  tombstone(id: string): void | Promise<void>;
  /** 复活一个实体 (SHRINK-1 rollback)。 */
  restore(item: T): void | Promise<void>;
}

/** 单个 reducer 的账目 (对齐 purify.ReducerOutcome 形状)。 */
export interface CurateReducerOutcome {
  kind: 'DEDUP' | 'PRUNE';
  in: number;
  out: number;
  tombstoned: number;
  skipped: boolean;
  reason?: string;
}

export interface CurateShrink {
  count_in: number;
  count_out: number;
  bytes_in: number;
  bytes_out: number;
  /** SHRINK-1: count_out ≤ count_in AND bytes_out ≤ bytes_in。 */
  held: boolean;
}

export interface CurateResult {
  reducers: CurateReducerOutcome[];
  shrink: CurateShrink;
  /** SHRINK-1 破 → 全 restore, 零副作用落地。 */
  rolledBack: boolean;
  /** 实际 tombstone 的 id (rolledBack 时为空 — 全已复活)。 */
  tombstonedIds: string[];
}

export interface CurateOptions {
  /** DEDUP cosine 阈值 (默认 0.93, 对齐 purify DEDUP_COS_THRESHOLD)。 */
  dedupThreshold?: number;
  /** PRUNE 的 now (默认 Date.now())。注入便于测试。 */
  now?: number;
}
