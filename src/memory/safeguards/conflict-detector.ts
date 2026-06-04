/**
 * src/memory/safeguards/conflict-detector.ts — fact conflict raise (PLAN D54 §5.7).
 *
 * Design source: agent-memory-frameworks-2026-05-29.md §5.7 + §5.9.
 *
 * Two facts CONFLICT when they share a namespace AND the same entity key
 * (client_id / agent_id / …) but disagree on a value field — e.g.
 * `client.preference.format` pdf vs excel for the same client.
 *
 * Policy (§5.7): we do NOT auto-pick a winner. We RAISE to the owner (construct an
 * inbox payload) and let both facts coexist — retrieval cosine breaks the tie
 * at read time. This module is detection + raise-payload construction only; it
 * never writes the inbox table and never deletes a fact. The caller decides
 * whether to enqueue the payload.
 */
import type { ValidatedFact } from './namespaces';

/**
 * Payload handed to the caller to raise into the cloud-routine inbox
 * (valinor_inbox). Shaped to drop straight into an inbox row's payload column.
 */
export interface InboxPayload {
  kind: 'memory.fact_conflict';
  namespace: string;
  entity_key: string;
  /** The fact already in the store. */
  existing: ValidatedFact;
  /** The fact whose write triggered the conflict. */
  incoming: ValidatedFact;
  /** Field names that disagree between the two facts. */
  diverging_fields: string[];
  detected_at: string; // ISO 8601 — inbox payloads are JSON
}

export type DetectConflictResult =
  | { conflict: true; with: ValidatedFact; raiseToInbox: InboxPayload }
  | { conflict: false };

/**
 * The fields that are NOT part of identity/provenance — i.e. the "value" of a
 * fact. Identity (the namespace + entity key) and provenance (source anchors +
 * confidence) are excluded; a divergence in any remaining field is a conflict.
 */
const NON_VALUE_FIELDS = new Set<string>([
  'namespace',
  'source_event_id',
  'source_doc_id',
  'confidence',
  // entity-key fields (also the identity dimension) — handled separately
  'client_id',
  'agent_id',
  'parent_client_id',
  'person_id',
  'regulation_id',
  'opinion_id',
  'workflow_id',
  'pattern_id',
  'skill_id',
  'template_id',
  'focus_id',
]);

/** Ordered candidate fields that identify the entity a fact is *about*. */
const ENTITY_KEY_FIELDS = [
  'client_id',
  'agent_id',
  'regulation_id',
  'opinion_id',
  'workflow_id',
  'template_id',
  'focus_id',
] as const;

/**
 * Derive the entity key of a fact: the first present identity field's value,
 * or '' for namespaces with no entity dimension (firm.metric.*, compliance.*).
 * Facts in such namespaces share the empty key, so they are compared by value.
 */
export function entityKeyOf(fact: ValidatedFact): string {
  const rec = fact as unknown as Record<string, unknown>;
  for (const f of ENTITY_KEY_FIELDS) {
    const v = rec[f];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * 32-bit FNV-1a over a string → short base36 digest. Deterministic, dependency-free.
 * Used only to BOUND a HostAdapter storage key — not for security/uniqueness across
 * the whole corpus, just per-agent fact identity (hundreds of facts; 32-bit space is
 * ample). The same identity string always digests to the same handle (idempotent
 * upsert).
 */
function fnv1a36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The HostAdapter storage key for a dream-written fact: `fact:<namespace>:<digest>`
 * where digest is a bounded hash of the supersession IDENTITY key. The namespace
 * stays readable in the key; the identity is digested so the key never exceeds the
 * HostAdapter's 512-char cap even when the identity carries free-text fields
 * (valar.pattern situation+approach, valar.limit statement, user.trait …) that the
 * raw identityKeyOf string could blow past. Deterministic → the same logical fact
 * upserts rather than duplicating.
 */
export function factStorageKey(namespace: string, identityKey: string): string {
  return `fact:${namespace}:${fnv1a36(identityKey || '_')}`;
}

/** Stable scalar comparison: Dates by epoch, arrays/objects by JSON. */
function valueEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/** Value fields that disagree between two facts of the same namespace. */
function divergingValueFields(a: ValidatedFact, b: ValidatedFact): string[] {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  const out: string[] = [];
  for (const k of keys) {
    if (NON_VALUE_FIELDS.has(k)) continue;
    if (!valueEq(ra[k], rb[k])) out.push(k);
  }
  return out.sort();
}

export function detectConflict(
  incoming: ValidatedFact,
  existingSameNs: ValidatedFact[],
): DetectConflictResult {
  const incomingKey = entityKeyOf(incoming);

  for (const existing of existingSameNs) {
    // Namespace mismatch is not a conflict (caller should pre-filter, but be
    // defensive — two different namespaces never conflict).
    if (existing.namespace !== incoming.namespace) continue;
    // Different entity → not the same subject → no conflict.
    if (entityKeyOf(existing) !== incomingKey) continue;

    const diverging = divergingValueFields(existing, incoming);
    if (diverging.length === 0) continue; // identical value → no conflict

    return {
      conflict: true,
      with: existing,
      raiseToInbox: {
        kind: 'memory.fact_conflict',
        namespace: incoming.namespace,
        entity_key: incomingKey,
        existing,
        incoming,
        diverging_fields: diverging,
        detected_at: new Date().toISOString(),
      },
    };
  }

  return { conflict: false };
}
