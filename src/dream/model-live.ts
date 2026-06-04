/**
 * src/dream/model-live.ts — the live DreamModel (D60, wires the seam to callModel).
 *
 * Behind the DreamModel seam (model.ts): events → callModel (structured output) →
 * CandidateFact[]. The deterministic restraintGate + validateFactWrite downstream
 * are the hard boundary; this adapter is the "brain" they guard.
 *
 * INV-1  FAIL-LOUD: a callModel throw (retries exhausted) PROPAGATES — never caught,
 *        never returns [] to mask a failure. The engine advances the watermark over
 *        the whole event window regardless of candidate count, so a swallowed error
 *        would skip those events forever. (Mirrors unwiredDreamModel: reject, never
 *        fabricate.)
 * INV-2  EMPTY WINDOW → [] without calling the model (nothing to consolidate).
 * INV-3  (inherited from callModel) structured reply is JSON-parsed + Zod-validated
 *        with bounded retry; only a validated object is ever mapped.
 * INV-A  the envelope schema accepts ALL 7 layers incl L3 — the model's output must
 *        PARSE; L3 rejection is the router's job, not a schema failure (else a
 *        legitimately L3-tagged candidate triggers infinite corrective retry).
 * INV-B  `fact` stays a loose record — L2's namespace / confidence / source-anchor is
 *        validated DOWNSTREAM by validateFactWrite, not here. The schema validates the
 *        ENVELOPE only.
 * INV-C  callModel does NOT inject the schema into the first prompt (it only sends
 *        corrective turns on failure) — so the system message MUST describe the output
 *        shape, else the first attempt always fails validation and burns the budget.
 */
import { z } from 'zod';
import { callModel as defaultCallModel, type ModelRequest, type ModelUsage } from '../model';
import { resolveRoleModel } from '../model/role-models';
import { DREAM_LAYERS, type DreamLayer } from './types';
import type { CandidateFact, ConsolidationInput, DreamEvent, DreamModel } from './model';

/** Envelope schema (INV-A all 7 layers, INV-B loose fact). callModel validates the
 *  model's reply against this; only a match is ever mapped to CandidateFact[]. */
const CandidateSchema = z.object({
  layer: z.enum(DREAM_LAYERS as unknown as [DreamLayer, ...DreamLayer[]]),
  fact: z.record(z.string(), z.unknown()),
  source_event_ids: z.array(z.number()),
});
const ConsolidationEnvelope = z.object({ candidates: z.array(CandidateSchema) });

/** Appended to the restraint prompt (INV-C). Describes the exact JSON to emit; the
 *  responseSchema only VALIDATES it, it never instructs the model. */
const OUTPUT_SHAPE_INSTRUCTION = `# Output format (STRICT)
Reply with ONLY a JSON object of this exact shape — no prose, no code fences:
{ "candidates": [ { "layer": "L2", "fact": { ... }, "source_event_ids": [<event id>, ...] } ] }
- "layer": which memory layer the insight targets (one of L0 L1 L2 L3 L4 L5 L6).
- "fact": the insight payload. For an L2 durable fact it MUST carry a "namespace"
  (user.* or wright.*), a "source_event_id", and a "confidence" — a fact missing these
  is rejected downstream.
- "source_event_ids": the ids of the events that back this candidate.
If nothing is worth keeping, reply { "candidates": [] }.`;

/** One raw event → one compact line for the model. */
function serializeEvents(events: DreamEvent[]): string {
  return events
    .map((e) => `event ${e.event_id} [${e.type}]: ${JSON.stringify(e.payload)}`)
    .join('\n');
}

export interface LiveDreamModelOptions {
  /** Injected for tests (or to swap transports). Default: the real callModel. */
  callModel?: typeof defaultCallModel;
  /** 'provider:modelId' coordinate. Default: resolveRoleModel('dream') AT CALL TIME,
   *  so a TUI override via setRoleModel('dream', …) takes effect without a rebuild. */
  model?: string;
  /** Reasoning effort. Default 'high' — consolidation is extraction reasoning. */
  thinkingLevel?: NonNullable<ModelRequest['thinkingLevel']>;
  /** callModel retry budget (omit → callModel's own default of 2). */
  maxRetries?: number;
  /** Sampling temperature (omit → provider default). */
  temperature?: number;
  /** Token-accounting side-channel (D60-a). Called once per model call with the reply's
   *  usage, so the runner can fold tokens into the Dream audit WITHOUT widening the
   *  DreamModel seam (consolidate still returns only CandidateFact[]). */
  onUsage?: (usage: ModelUsage) => void;
}

export class LiveDreamModel implements DreamModel {
  private readonly call: typeof defaultCallModel;
  private readonly model: string | undefined;
  private readonly thinkingLevel: NonNullable<ModelRequest['thinkingLevel']>;
  private readonly maxRetries: number | undefined;
  private readonly temperature: number | undefined;
  private readonly onUsage: ((usage: ModelUsage) => void) | undefined;

  constructor(opts: LiveDreamModelOptions = {}) {
    this.call = opts.callModel ?? defaultCallModel;
    this.model = opts.model;
    this.thinkingLevel = opts.thinkingLevel ?? 'high';
    this.maxRetries = opts.maxRetries;
    this.temperature = opts.temperature;
    this.onUsage = opts.onUsage;
  }

  async consolidate(input: ConsolidationInput): Promise<CandidateFact[]> {
    // INV-2: an empty window has nothing to consolidate — never burn a model call.
    if (input.events.length === 0) return [];

    const req: ModelRequest = {
      messages: [
        { role: 'system', content: `${input.prompt}\n\n${OUTPUT_SHAPE_INSTRUCTION}` },
        { role: 'user', content: serializeEvents(input.events) },
      ],
      model: this.model ?? resolveRoleModel('dream'),
      thinkingLevel: this.thinkingLevel,
      responseSchema: ConsolidationEnvelope,
    };
    if (this.maxRetries !== undefined) req.maxRetries = this.maxRetries;
    if (this.temperature !== undefined) req.temperature = this.temperature;

    // INV-1: a throw here (callModel exhausted its budget) propagates untouched.
    const res = await this.call(req);

    // D60-a: surface token usage out-of-band (the seam stays CandidateFact[]-only).
    this.onUsage?.(res.usage);

    // callModel only returns on a schema match, so res.parsed already passed the
    // envelope. Re-parse to narrow `unknown` → typed (and to fail loud should the
    // contract ever drift).
    const { candidates } = ConsolidationEnvelope.parse(res.parsed);
    return candidates.map((c) => ({
      layer: c.layer,
      fact: c.fact,
      source_event_ids: c.source_event_ids,
    }));
  }
}
