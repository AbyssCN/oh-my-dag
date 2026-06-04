/**
 * src/dream/model.ts — the DreamModel seam (PLAN D55 · scope decision #1).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SEAM, NOT A LIVE PROVIDER                                                 │
 * │ The Dream consolidation LLM is behind this interface. Wiring a real       │
 * │ provider (Codex Sonnet / Haiku / Opus 4.8) is DEFERRED to D60 (the model  │
 * │ matrix). This sprint ships the seam + a deterministic FakeDreamModel for  │
 * │ tests + an unwiredDreamModel that THROWS — a production mis-call must be   │
 * │ loud, never a silent false success.                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Design source: dream-architecture-2026-05-29.md §3.3 (flow) + §3.5 (restraint).
 *
 * Flow: raw events → DreamModel.consolidate() → CandidateFact[] → restraintGate
 * (deterministic, §3.5.1) → router (by-layer dispatch, §3.3). The model decides
 * WHAT to extract and WHICH layer it belongs to; the restraint gate and router
 * are pure, testable, model-free guards that the model's output must clear.
 */
import { UNIVERSAL_CONSOLIDATION_PROMPT } from './prompt';
import type { DreamLayer } from './types';

/**
 * One raw event handed to the model for consolidation. A thin projection of
 * xihe_events (id / type / payload) — the model never sees the whole table,
 * only the window the engine selected (id > last_dream_event_id).
 */
export interface DreamEvent {
  /** xihe_events.id — bigint as number (mirrors the schema). The model never
   *  uses this as a cursor; it is provenance for the candidate's source anchor. */
  event_id: number;
  type: string;
  payload: Record<string, unknown>;
}

/** Everything the model needs for one consolidation pass over one agent. */
export interface ConsolidationInput {
  /** The agent whose events are being consolidated (Wright / Ratia / …). */
  agent_id: string;
  /** The event window: events WHERE id > last_dream_event_id, ascending. */
  events: DreamEvent[];
  /** Verbatim restraint prompt the live model must obey (§3.5.2). Carried on
   *  the input so the seam is self-describing — a live adapter prepends it. */
  prompt: string;
}

/**
 * A consolidated candidate the model proposes. It carries:
 *   - `layer`: the L0-L6 destination intent (router dispatches on it)
 *   - `fact`: the payload. For L2 this MUST be a validateFactWrite-shaped object
 *     (namespace + source anchor + confidence); for other layers it is the
 *     layer-specific payload (L5 edge proposal, L6 note, L0 prediction, …).
 *   - `source_event_ids`: provenance — which raw events backed this candidate.
 *
 * The model is trusted to TAG the layer; it is NOT trusted to bypass the gates
 * — every L2 candidate still passes validateFactWrite, and an L3-tagged
 * candidate is hard-rejected by the router regardless of payload.
 */
export interface CandidateFact {
  layer: DreamLayer;
  fact: Record<string, unknown>;
  source_event_ids: number[];
}

/** The consolidation seam. One method: events → candidates. */
export interface DreamModel {
  consolidate(input: ConsolidationInput): Promise<CandidateFact[]>;
}

// ---------------------------------------------------------------------------
// FakeDreamModel — deterministic, for tests. Returns a fixed candidate set
// (optionally a function of the input) with zero network / zero LLM.
// ---------------------------------------------------------------------------

export class FakeDreamModel implements DreamModel {
  constructor(
    private readonly candidates:
      | CandidateFact[]
      | ((input: ConsolidationInput) => CandidateFact[]),
  ) {}

  consolidate(input: ConsolidationInput): Promise<CandidateFact[]> {
    const out =
      typeof this.candidates === 'function' ? this.candidates(input) : this.candidates;
    // Defensive copy so a caller cannot mutate the fixture between runs.
    return Promise.resolve(out.map((c) => ({ ...c })));
  }
}

// ---------------------------------------------------------------------------
// unwiredDreamModel — the default. THROWS loudly. A daemon that calls Dream
// without injecting a real model in production must fail, not fabricate.
// ---------------------------------------------------------------------------

export const unwiredDreamModel: DreamModel = {
  consolidate(): Promise<CandidateFact[]> {
    return Promise.reject(
      new Error('DreamModel not wired — pending D60 model matrix'),
    );
  },
};

/** Re-export so callers can build a ConsolidationInput with the universal base
 *  prompt (compose domain overlays via composeConsolidationPrompt). */
export { UNIVERSAL_CONSOLIDATION_PROMPT };
