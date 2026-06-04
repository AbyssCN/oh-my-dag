/**
 * src/wright/memory — wright Tier-1 self-memory (SDD §7, V2-MEM).
 *
 * Public surface: the {@link WrightMemory} store (facts + hybrid retrieval +
 * `.edges` temporal KG), its factory, the {@link EdgeStore} seam, and the
 * pluggable {@link EmbedFn}. The write-time SAFEGUARD guards are reused verbatim
 * from src/memory/safeguards (one guard logic, two substrates — VAL-INV-9).
 */
export { WrightMemory, createWrightMemory, type WrightMemoryOptions } from './store';
export {
  SqliteEdgeStore,
  PgEdgeStore,
  EdgeOverlapError,
  EdgeStoreNotImplemented,
} from './edge-store';
export { hashEmbed, defaultEmbed, DEFAULT_EMBED_DIM } from './embed';
export type {
  EmbedFn,
  StoredFact,
  MemoryHit,
  WriteFactResult,
  TemporalEdge,
  EdgeStore,
} from './types';
