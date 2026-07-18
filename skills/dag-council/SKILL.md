---
name: dag-council
tier: core
runtime: on-demand
trigger: mention
description: "Auto-authored expert council as a DAG: give it a goal + ground truth, the conductor authors N distinct personas, they produce candidates concurrently, a multi-lens judge selects and grafts a winner. Grounded tier for domain-correctness forks. Trigger: multiple options / which approach / best of n / council / 多个方案 / 哪种方案好 / 拿不准选哪个 / domain fork / grounded / anti-happy-path decision / dag-council. Skip: single clear solution (just do it) / you want to hand-write the lens spec yourself (/dag-fanout) / needs web evidence first (/dag-research feeds this)."
metadata:
  source: oh-my-dag
  version: "2.0.0"
  methodology: "conductor-authored personas + diversity>volume + multi-judge + graft runners-up + grounded (market-first + domain-role persona + anti-happy-path axis)"
---
# /dag-council — auto-authored expert council

For wide solution spaces: the conductor reads your goal + ground truth and **authors
the personas itself** (real, distinct expert angles — not one prompt resampled N times).
Candidates generate concurrently, a judge panel scores through multiple lenses, and the
champion is synthesized with the runners-up's orthogonal highlights grafted in.

## Usage

```bash
bun run dag-council <goal-and-groundtruth.json>
# JSON: { goal, groundTruth, conductorModel?, lensCount?, lensModel?, reasonModel? }
```

Stdout: first line = artifact path, then `LENS CHAMPIONS / SYNTHESIS CANDIDATES / FINAL`
marker sections (stable format, safe to split downstream).

## Grounded tier (domain-correctness forks)

When the decision is in a domain where being wrong is expensive and reality is messy
(accounting/legal/ops: dirty data, partial failure, lifecycle-end) **and** it's hard to
reverse, upgrade the run:

1. **Market-first**: research what real-world practice actually does first (e.g. via
   `/dag-research`) and put that hard-evidence baseline into `groundTruth` — personas
   argue from facts, not vibes.
2. **Domain-role personas**: put the real roles into `goal` framing — the daily
   operator / compliance & audit / automation first-principles / lifecycle-end.
3. **Anti-happy-path judging axis**: state in `groundTruth` that every option must be
   judged against dirty data, concurrency, partial failure, cross-boundary, lifecycle-end
   and scale-balloon — otherwise personas quietly answer for the happy path.
4. **Judge + graft**: unanimous consensus is a strong signal; the champion often shrinks
   the debate rather than picking a side. Domain red lines stay with the owner — council
   output is input, not the final call.
