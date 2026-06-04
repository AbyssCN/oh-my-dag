---
name: council
tier: capability
runtime: on-demand
trigger: mention
description: "Multi-perspective parallel generation + judge-and-select (a panel of experts 'meets' to deliberate a winner): facing a wide solution space for a design/decision, dispatch N different persona+angle in parallel to produce candidates → multi-lens judge → select-and-synthesize (graft the runners-up's highlights), instead of giving one averaged answer in a single shot. Trigger: multiple options / compare options / best of n / bestof / fanout / council / parallel exploration / multiple perspectives / give me a few options / which option is better / option comparison / explore options / not sure which to pick / 多个方案 / 对比方案 / 并行探索 / 多视角 / 给我几个选项 / 哪种方案好 / 方案对比 / 拿不准选哪个. Skip: a single clear solution (just do it) / pure execution needing no selection / code review (/review) / root-cause debugging (/investigate)."
metadata:
  source: xihe
  version: "1.0.0"
  methodology: "diversity>volume + persona conditioning + multi-judge panel + graft runners-up"
---

# /council — Multi-Perspective Parallel Generation + Judge-and-Select

> When the solution space is wide, a one-shot answer = landing on the **mediocre center** of the probability distribution. Fanout uses **diversified personas** to pull generation into different expert regions, **multi-lens judge** to counter single-judge bias, and **select + graft** to take the best of each candidate.
> This is not "resample N times" — that is diminishing-returns volume stacking. The core of fanout is **diversity > volume**.

## When to use

- **Architecture/design choices**: multiple defensible directions with real tradeoffs (performance vs simplicity vs reversibility).
- **Hard-to-reverse decisions**: high cost of being wrong, worth adversarial multi-perspective vetting before committing.
- **Option-comparison requests**: the user explicitly says "give me a few options / which is better / not sure".
- **Deep research**: a single question needing multiple expert perspectives + sub-angle coverage (use the deep tier).

## When not to use (anti-slop)

- A single clear solution → just do it, don't fan out for ceremony.
- Pure execution (implementing an already-decided plan) → execute, no selection.
- Code review → `/review`; root-cause debugging → `/investigate`.

## Two tiers

### Light tier — `/council`
Current deliberation context → **3 default lenses** produce candidates in parallel → multi-perspective judge scores → cherry-pick synthesis. Suited to **a single design choice**.

The 3 default lenses (each = persona + angle + sampling modulation):
| lens | persona | angle | temp/topP |
|---|---|---|---|
| `mvp` | pragmatic delivery-oriented engineering lead | smallest viable cut, fastest verification loop, cut the non-core | 0.4 / 0.85 |
| `risk` | senior SRE + security engineer | reason backward from failure modes/boundaries/irreversible points, plug risks first | 0.5 / 0.9 |
| `first-principles` | first-principles thinker | reframe the essence of the problem, question premises, find the simplest structure | 0.75 / 0.95 |

### Deep tier — `/council deep`
**L lens × V sub-angle variants** → per-lens reduce to a champion → M framing synthesis → **K-judge panel + graft** → final solution. Each leaf is injected with persona + a high-level domain abstraction framework + ground truth. Suited to foundational / hard-to-reverse decisions (driven by the task's mass: L = the real number of expert perspectives, V = that lens's real number of sub-angles).

## Core discipline (copy these 4, hold them even when fanning out manually)

1. **Diversity > volume**: within a lens there are V **different sub-angles**, not the same prompt resampled V times (the latter has diminishing returns).
2. **persona conditioning**: each leaf is injected with one line of ROLE + perspective/first-principles lens, moving the (weaker) model from the generic region into the expert region — moving probability mass to escape mediocrity. Low temp = faithful, high temp = explore the long tail.
3. **multi-judge panel**: for foundational decisions a single judge has systemic bias → K **different judging dimensions** (correctness/simplicity/risk) each score once, adversarial-verify.
4. **graft runners-up (graft)**: not "pick one and discard the rest" — synthesize from the champion, but cherry-pick the runners-up's highlights into it.

## Manual fan out (no built-in code path / at scale)

1. Define N **genuinely different** perspectives (default mvp/risk/first-principles, or task-specific expert roles).
2. Inject persona + angle per perspective, **in parallel** each producing a complete candidate (independent, no peeking at each other).
3. Judge with ≥2 different lenses each (don't use a single standard).
4. Synthesize from the highest score, graft the unique strengths of the rest → one final solution + tradeoff rationale.

> The wrap-up must give: **the champion solution + why it won + what was grafted from the runners-up** (not a bare N-pick-1 conclusion).
