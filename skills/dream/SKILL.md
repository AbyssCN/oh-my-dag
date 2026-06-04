---
name: dream
tier: foundation
runtime: on-demand
trigger: mention
description: "Manually trigger Dream consolidation: distill an agent's raw events into L0-L6 memory (via the Memory Restraint 3-gate + validateFactWrite). Runs all layers, budget cap ~10k tokens. Trigger: /dream / consolidate memory / dream run / 做梦 / 整理记忆 / 跑一次 dream / 记忆整理. Skip: routine verification (/verify) / commit (/commit) / history recall (/recall)."
metadata:
  source: claude-xihe
  version: "1.0.0-xihe"
  methodology: "D55 Dream service · dream-architecture-2026-05-29.md §7.1 (D1-D8)"
---
# /dream — Manual Dream consolidation

> Distill an agent's raw events since the last watermark into memory facts.
> **Design source**: `docs/knowledge/research/dream-architecture-2026-05-29.md` §3 (7-layer matrix) + §3.5 (Memory Restraint 3-gate).
> **Auto-trigger**: every tick the Conductor checks `xihe_dream_watermarks` — agents with `events_since_last_dream > 50` OR `last_dream_at < now()-4h` dream automatically. `/dream` is the **manual** full trigger.

## Trigger words

`/dream` · consolidate memory · dream run · 做梦 · 整理记忆 · 跑一次 dream · 记忆整理

## What it runs (all layers, budget cap ~10k tokens)

A manual dream runs **all 7 layers** (vs the heartbeat, which only runs L2):

```
events (id > last_dream_event_id)
  → DreamModel.consolidate()        # model matrix D60 wiring; currently unwired → throws (no silent fake success)
  → restraintGate (3 gates)         # UTILITY / ROUTING SoT / RESTRAINT ban-list (§3.5.1)
  → router (by-layer dispatch)      # §3.3
      L0 → client-context prewarm (UPDATE xihe_clients prediction)
      L1 → DEFERRED (no substrate — log + audit, no write)
      L2 → MemOS facts (each one through validateFactWrite — D54 SAFEGUARD-2 v2)
      L3 → HARD REJECT (business PG SoT — Dream never touches it)
      L4 → DEFERRED (no code graph)
      L5 → inbox propose (needs_human_verify, never writes business_relations directly)
      L6 → ~/vault/<agent>/dreams/<date>.md (per-agent)
  → audit (xihe_events type='dream_run_completed' + <5% ratio self-check)
```

## Hard constraints (no bypass)

1. **L2 must go through validateFactWrite** — there is no bypass branch. Rejected facts land in `xihe_memos_rejects`, never L2.
2. **L3 business PG is never touched** — any L3-intent candidate is hard-rejected + logged, never INSERT/UPDATE/DELETE.
3. **L1/L4 deferred** — no substrate, takes the deferred branch (audit records `deferred_layers`); **never fakes a successful write**.
4. **Memory Restraint** — drop SoT (invoices/journal entries/financial figures/document bodies); drop banned namespaces (GDPR/surveillance/special categories); keep only derived items (preferences/patterns/lessons/commitments/deadlines).
5. **<5% health ratio** — `facts_extracted / events_processed > 20%` → audit flags `warn: over-recording, tighten prompt`.

## Current status

- **⚠ Two paths (corrected by 2026-06-03 measurement)**: the routing diagram above is the **ideal design of the canonical path** (engine→restraint→router→purify→audit) — all built, but `wireDreamRunner`/`setDreamRunner` have **zero production callers** → DORMANT, reachable only from tests. **What wright actually runs live is the light path**: `tui.ts → new LiveDreamModel() → createDreamPump → dream-pump.consolidate → wright.memory.writeFact(validateFactWrite)`, **bypassing engine/restraint/router/purify**. Both paths implement the same `DreamModel` interface (model.ts:66), but the live path does not go through the canonical machinery.
- **Model seam (D55/D60)**: `src/dream/model.ts` `DreamModel` interface. `LiveDreamModel` (model-live.ts) is the live implementation (via dream-pump); `unwiredDreamModel` is only an un-injected fallback (throws rather than silently faking success).
- **Sources**: live `src/dream/model-live.ts` + `src/wright/learning/dream-pump.ts` · canonical (DORMANT) engine `src/dream/engine.ts` · purify `src/dream/purify.ts` (629 lines, built) · restraint `src/dream/restraint.ts` · router `src/dream/router.ts` · adapters `src/dream/adapters/*` · audit `src/dream/audit.ts`.
