/**
 * src/wright/skills/gene-curator-adapter — CuratorAdapter<GeneRow> (Phase 2c: 第三实体 gene)。
 *
 * 完成 "一套机器三适配器" (curator-dream-adapters.md §2): facts(purify→curate 迁移中) · skills · **genes**
 * 共用同一 `curate<T>` 减熵机器, 各换信号。gene 列实现:
 *   distance  → signals_match+strategy embedding (DEDUP 近义 gene)
 *   staleness → freq=0/staleDays (PRUNE 久未复用的 gene; 对齐 inventory "90d 0-use→dormant→deprecated")
 *   isProtected → human_approved=1 (人审过的 gene 永不自动退役)
 *   tombstone/restore → genes.status='deprecated'/'active' (软删可逆)
 *
 * **R6 边界**: 只碰 genes 表 (不碰 fact/skill substrate)。staleness 用 created_at-floor (跨 adapter 统一,
 * 同 skill-adapter + registry.decayCandidates): COALESCE(last_used_at, created_at) → fresh 迁入 gene 不被
 * 立即误判 stale。floor 已落地, gene 自动治理接 flywheel 是可选下一步 (本身不在此 adapter 职责内)。
 */
import { hashEmbed } from '../memory/embed';
import type { EmbedFn } from '../memory/types';
import type { SkillRegistry, GeneRow } from './registry';
import { curate } from '../curator/curate';
import type { CuratorAdapter, CurateOptions, CurateResult } from '../curator/types';

const DAY_MS = 86_400_000;

export interface GeneCuratorOptions {
  embed?: EmbedFn;
  /** PRUNE 空闲天数 (默认 90)。 */
  staleDays?: number;
  /** dry-run: tombstone/restore no-op, 仍准确报 tombstonedIds。 */
  dryRun?: boolean;
}

/** gene 的 DEDUP 文本: signals + strategy (genes_fts 也索引这俩)。 */
function geneText(g: GeneRow): string {
  return `${g.signals_match} ${g.strategy}`.trim() || g.gene_key;
}

export function makeGeneCuratorAdapter(
  registry: SkillRegistry,
  opts: GeneCuratorOptions = {},
): CuratorAdapter<GeneRow> {
  const embedOne = opts.embed ?? ((t: string) => hashEmbed(t));
  const staleMs = (opts.staleDays ?? 90) * DAY_MS;

  return {
    id: (g) => String(g.gene_id),
    text: geneText,
    bytes: (g) => Buffer.byteLength(geneText(g), 'utf8'),
    isProtected: (g) => g.human_approved === 1, // 人审过的永不自动退役
    // created_at-floor (跨 adapter 统一): fresh 迁入 gene 用 created_at 当宽限基准, 不被立即误退役。
    isStale: (g, now) => (g.last_used_at ?? g.created_at) < now - staleMs,
    rank: (g) => g.use_count,
    embed: async (texts) => Promise.all(texts.map((t) => embedOne(t))),
    tombstone: (id) => { if (!opts.dryRun) registry.deprecateGene(Number(id)); },
    restore: (g) => { if (!opts.dryRun) registry.reactivateGene(g.gene_id); },
  };
}

/** 拉 active gene 跑一次 curate (DEDUP 近义 + PRUNE 久未用, human_approved 豁免)。 */
export function curateGenes(
  registry: SkillRegistry,
  opts: GeneCuratorOptions & CurateOptions = {},
): Promise<CurateResult> {
  const adapter = makeGeneCuratorAdapter(registry, opts);
  return curate(registry.listGenes(), adapter, opts);
}
