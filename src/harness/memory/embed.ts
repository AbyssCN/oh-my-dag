/**
 * src/harness/memory/embed — the default EmbedFn for Tier-1 retrieval.
 *
 * `hashEmbed` is a zero-dependency, deterministic, local embedder. It is NOT a
 * semantic model — it is a hashed bag-of-tokens projection that gives the vector
 * leg of hybrid retrieval a stable, hermetic signal so the store runs standalone
 * (no network, no API key) and tests are reproducible. Real semantic recall
 * comes from injecting a different {@link EmbedFn} (OpenAI / local vLLM) at
 * store construction; the BM25 lexical leg carries most of the weight either way
 * (RRF fusion degrades gracefully when one leg is weak).
 *
 * Why hashed-token rather than nothing: it makes co-occurring vocabulary cluster
 * (two facts about "vat deadline" land near each other) without pretending to
 * model meaning. The dimension is small (256) because brute-force cosine over a
 * <10k-fact Tier-1 store is the design point (no ANN index — SDD §7 "尺度不够").
 */
import type { EmbedFn } from './types';

/** Default vector width — small on purpose (brute-force exact KNN, no ANN). */
export const DEFAULT_EMBED_DIM = 256;

/** Split into lowercased alnum/CJK tokens; mirrors the BM25 tokenizer intent. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** FNV-1a 32-bit — cheap, well-distributed string hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (stays in 32-bit range).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic hashed bag-of-tokens vector, L2-normalised. Same text → same
 * vector, always. An empty / token-less string yields the zero vector (cosine
 * with anything is 0 — a no-signal hit, which is correct).
 */
export function hashEmbed(text: string, dim: number = DEFAULT_EMBED_DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const idx = h % dim;
    // Sign from a second hash bit so distinct tokens don't only ever add.
    const sign = (h & 0x80000000) !== 0 ? -1 : 1;
    v[idx] = (v[idx] ?? 0) + sign;
  }
  // L2 normalise so cosine == dot product downstream.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < dim; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/** The default EmbedFn used when a store is constructed without one. */
export const defaultEmbed: EmbedFn = (text) => hashEmbed(text);
