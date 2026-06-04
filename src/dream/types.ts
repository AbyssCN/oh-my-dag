/**
 * src/dream/types.ts — shared Dream-service types (PLAN D55).
 *
 * The 7-layer cleanup matrix (dream-architecture §3.1) keyed L0-L6. The router
 * dispatches on DreamLayer; the engine / audit aggregate over it.
 */

/** The seven memory layers Dream can target (dream-architecture §3.1). */
export type DreamLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

export const DREAM_LAYERS: readonly DreamLayer[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

/** Layers with a real substrate this sprint (L0/L2/L5/L6 are wired). */
export const REAL_LAYERS: readonly DreamLayer[] = ['L0', 'L2', 'L5', 'L6'];

/**
 * Layers explicitly DEFERRED — no substrate yet (scope decision #3):
 *   - L1: OV1 sibling-summary chunks (no chunk-tier write path this sprint)
 *   - L4: code-graph annotation (no codegraph spike yet)
 * The router must RECOGNISE these layers and take the deferred branch (log +
 * audit), never fabricate a write success.
 */
export const DEFERRED_LAYERS: readonly DreamLayer[] = ['L1', 'L4'];

/** Why a layer is deferred — surfaced in logs + audit + adapter return. */
export const DEFERRED_REASON: Record<string, string> = {
  L1: 'no substrate: OV1 sibling-summary chunk write path not built (dream-architecture §3.2)',
  L4: 'no substrate: code graph spike not done (dream-architecture §3.2)',
};

/**
 * Per-candidate router outcome. Every candidate resolves to exactly one of:
 *   - written : a real adapter persisted it
 *   - deferred: a recognised-but-no-substrate layer (L1/L4) — NOT a write
 *   - rejected: refused (L3 hard reject, L2 validateFactWrite refusal, unknown layer)
 *   - proposed: raised to inbox for human verification (L5) — not yet authoritative
 */
export type CandidateOutcome = 'written' | 'deferred' | 'rejected' | 'proposed';

/** What the router decided about one candidate, with provenance for audit. */
export interface RouteResult {
  layer: DreamLayer | 'unknown';
  outcome: CandidateOutcome;
  /** Human-readable detail: rejection reason, deferred reason, target id, … */
  detail: string;
  source_event_ids: number[];
}

/** A layer adapter's run() result. deferred:true means recognised-no-substrate. */
export type AdapterResult =
  | { deferred: true; reason: string }
  | { deferred: false; outcome: CandidateOutcome; detail: string };
