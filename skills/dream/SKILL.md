---
name: dream
tier: foundation
runtime: on-demand
trigger: mention
description: "Manually trigger Dream consolidation: distill an agent's raw events into durable memory facts, with safeguards. Runs all layers, budget cap ~10k tokens. Trigger: /dream / consolidate memory / dream run / 做梦 / 整理记忆 / 跑一次 dream / 记忆整理. Skip: routine verification (/verify) / commit (/commit) / history recall (/recall)."
metadata:
  source: xihe
  version: "1.0.0"
---
# /dream — Manual Dream consolidation

> Distill an agent's raw events since the last checkpoint into durable memory facts.
> **Auto-trigger**: agents consolidate automatically once they accumulate enough new events, or after a few hours have passed since the last run. `/dream` is the **manual** full trigger.

## Trigger words

`/dream` · consolidate memory · dream run · 做梦 · 整理记忆 · 跑一次 dream · 记忆整理

## What it runs (budget cap ~10k tokens)

A manual dream is a full consolidation pass over all of an agent's accumulated events (versus the background heartbeat, which only does a lightweight pass):

1. **Collect** the agent's raw events since the last consolidation checkpoint.
2. **Consolidate** — the model distills the events into candidate memory facts.
3. **Restraint gate** — each candidate must pass a multi-stage filter (is it worth keeping? is it derived knowledge rather than a source of truth? is it on the ban-list?) before it can be written.
4. **Write** the surviving facts into the memory layer; rejected candidates are logged separately for audit, never written to memory.
5. **Audit** — record that the run completed, with a self-check on the extraction ratio.

## Hard constraints (no bypass)

1. **Every fact goes through validation** — there is no bypass branch. Rejected facts are logged separately, never written into memory.
2. **Sources of truth are never touched** — the dream pass only writes *derived* memory (preferences, patterns, lessons, commitments, deadlines). It never modifies the system's authoritative records (e.g. business data, financial figures, document bodies).
3. **No faked writes** — if a consolidation target has no backing store, the pass takes a deferred branch and records it in the audit; it never reports a fake success.
4. **Memory Restraint** — drop sources of truth; drop sensitive / banned categories (e.g. personal data, surveillance, special categories); keep only derived items.
5. **Health ratio check** — if too high a fraction of events get turned into facts (over-recording), the audit flags a warning to tighten the prompt.

## Notes

- A manual `/dream` consolidates a single agent's events on demand. Run it before a long break, or after a burst of activity you want captured, so the next session starts with the lessons already distilled.
- Consolidation is **propose-and-filter**, not blind capture: most raw events are intentionally dropped. A small fact count is the expected, healthy outcome.
