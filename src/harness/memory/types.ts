/**
 * src/harness/memory/types — omd Tier-1 self-memory contracts (SDD §7, V2-MEM).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ BOUNDARY NOTICE (two memory layers, do not conflate)                      │
 * │   src/harness/memory/  → Tier-1: omd's OWN self-memory (SQLite, per-agent,│
 * │                        ships WITH the agent — facts/edges/retrieval).     │
 * │   src/memory/        → Tier-2: omd DOMAIN memory (PG, host-injected —    │
 * │                        client entities / 18 会计 namespace / compliance).  │
 * │ omd accesses Tier-2 through a HostAdapter (it does not own it). The two  │
 * │ never share a substrate (SQLite vs PG) — VAL-INV-9. The SAFEGUARD pure     │
 * │ functions (validateFactWrite / checkEvolve / detectConflict) are shared    │
 * │ verbatim from src/memory/safeguards — one guard logic, two substrates.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import type { ValidatedFact } from '../../memory/safeguards/namespaces';

// ---------------------------------------------------------------------------
// Embedding seam — the vector leg of hybrid retrieval is pluggable.
// ---------------------------------------------------------------------------

/**
 * Maps text → a fixed-width dense vector. The default (`hashEmbed`) is a
 * zero-dependency deterministic local embedder so Tier-1 runs standalone and
 * tests stay hermetic; a real semantic embedder (OpenAI / local vLLM) is
 * injected by passing a different `EmbedFn`. ALL vectors in one store MUST come
 * from the same EmbedFn — mixing dims makes cosine meaningless (guarded: a dim
 * mismatch scores 0 rather than throwing).
 */
export type EmbedFn = (text: string) => number[] | Promise<number[]>;

// ---------------------------------------------------------------------------
// StoredFact — a ValidatedFact plus its Tier-1 storage envelope.
// ---------------------------------------------------------------------------

export interface StoredFact {
  /** Opaque row id (uuid). */
  id: string;
  /** The validated fact (passed validateFactWrite). */
  fact: ValidatedFact;
  /** Denormalised for fast same-namespace conflict scans. */
  namespace: string;
  /** Per-namespace IDENTITY key (entity + discriminators) — supersession id.
   *  See NAMESPACE_IDENTITY_FIELDS / identityKeyOf. */
  identityKey: string;
  /** Lexical projection of the fact's value fields (FTS5 + display). */
  text: string;
  /** Dense vector from the store's EmbedFn (vector leg of retrieval). */
  embedding: number[];
  /** Write instant (epoch ms). */
  createdAt: number;
  /** Soft-delete tombstone (SHRINK-INV-3): null = live, epoch ms = pruned. */
  deletedAt: number | null;
}

// ---------------------------------------------------------------------------
// Retrieval — hybrid (FTS5 BM25 ⊕ vector cosine) fused via RRF.
// ---------------------------------------------------------------------------

export interface MemoryHit {
  fact: ValidatedFact;
  id: string;
  text: string;
  /** Reciprocal-rank-fusion score (higher = better). */
  rrf: number;
  /** 1-based rank in the vector leg (absent = not retrieved by vector). */
  vecRank?: number;
  /** 1-based rank in the BM25 leg (absent = not retrieved by lexical). */
  bmRank?: number;
  vecSim?: number;
  bmScore?: number;
}

// ---------------------------------------------------------------------------
// writeFact outcome — the SAFEGUARD pipeline's verdict (REJECT-by-default).
// ---------------------------------------------------------------------------

import type { InboxPayload } from '../../memory/safeguards/conflict-detector';

/**
 * Tier-1 write contract (composition of the three shared SAFEGUARD functions):
 *   1. validateFactWrite — REJECT-by-default floor (malformed/banned/schema/…).
 *   2. checkEvolve(existing, incoming) over the same (namespace, entityKey):
 *        insert | evolve | replace → stored (same-identity agent facts are
 *        SUPERSEDED, not coexisted — Tier-1 keeps memory sharp, not a tape);
 *        reject → an immutable human_verified fact stands.
 *   3. On an immutable-human reject whose VALUE diverges, detectConflict builds
 *      a raise payload so the daemon can surface it to the owner (who may retract) —
 *      the human fact is NOT silently overwritten, but the divergence is seen.
 */
export type WriteFactResult =
  /** Stored. `action` distinguishes a fresh insert from a self-evolve/replace. */
  | { status: 'written'; id: string; action: 'insert' | 'replace' | 'evolve' }
  /** Refused by validateFactWrite or by an immutable human_verified lock.
   *  `raiseToInbox` is present iff an immutable human fact diverged in value. */
  | { status: 'rejected'; reason: string; banned?: boolean; raiseToInbox?: InboxPayload };

// ---------------------------------------------------------------------------
// EdgeStore — temporal-KG seam (the hardest extraction, SDD §7).
// ---------------------------------------------------------------------------

/**
 * A bitemporal edge: a (subject —predicate→ object) relation valid over a
 * half-open instant range [validFrom, validTo). validTo = null ⇒ still current.
 *
 * The load-bearing invariant (EDGE-INV-1, no-overlap): for one logical edge
 * identity (subject, predicate, object) at most ONE row is valid at any instant.
 * PG enforces this with a `btree_gist EXCLUDE` (DB-level, see src/memory/
 * temporal.ts for the domain tables); SQLite has no EXCLUDE, so SqliteEdgeStore
 * enforces it in application code (check-before-insert inside a transaction —
 * sound because omd is the single writer of its own Tier-1 store).
 */
export interface TemporalEdge {
  subject: string;
  predicate: string;
  object: string;
  validFrom: Date;
  /** null ⇒ open-ended current edge. */
  validTo: Date | null;
  /** Opaque structured payload (weight, source, …). */
  payload?: Record<string, unknown>;
}

export interface EdgeStore {
  /** Insert a new edge. Throws on EDGE-INV-1 violation (overlap with a live
   *  edge of the same identity). Use {@link invalidate} to supersede instead. */
  put(edge: TemporalEdge): Promise<void>;
  /** Point-in-time read: edges whose validity range contains `t`. */
  asOf(t: Date, filter?: { subject?: string; predicate?: string }): Promise<TemporalEdge[]>;
  /**
   * Supersede a currently-open edge: close it at `at` (validTo = at) and open a
   * successor starting at `at`. The half-open ranges abut without overlapping,
   * so EDGE-INV-1 holds. The ONLY legal way to change a current temporal fact.
   */
  invalidate(
    identity: { subject: string; predicate: string; object: string },
    at: Date,
    successor: Omit<TemporalEdge, 'validFrom'>,
  ): Promise<void>;
}
