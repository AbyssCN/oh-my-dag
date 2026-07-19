# guardrails — the enforcement ladder

A guardrail is any mechanism that stops a mistake from shipping. They are not equal: they differ in
cost, in how hard they are to bypass, and in how much friction they add to every run. This file names
the ladder and the one rule for climbing it.

---

## The 4-tier ladder (strongest → weakest)

| Tier | Mechanism | Bypassable? | Cost per run |
|------|-----------|-------------|--------------|
| **1. Oracle** | An objective, executable check the Fleet self-heals toward (typecheck, tests, benchmark, pass-rate). | No — green is green. | Runs every time; cheapest to trust. |
| **2. Blocking gate (hook)** | A harness hook that hard-stops the action (e.g. dangerous-command interception, a pre-commit refusal). | Only by Owner override. | Fires on the matching action only. |
| **3. Checklist item** | A required step in a gate/skill the reviewer must tick (e.g. "Spec axis at G3"). | Yes — a human can skip it. | Attention per review. |
| **4. Prose rule** | A sentence in a doc or the identity ("don't do X"). | Trivially — it relies on being read and remembered. | Free, but weakest. |

Higher tiers are **harder to bypass and cheaper to trust** because the machine enforces them; lower
tiers rely on a human reading and remembering. Prefer to push a guardrail *up* the ladder — a prose
rule that becomes an oracle stops being skippable.

---

## Meta-rule: YAGNI the guardrails themselves

**Do not build a guardrail before a rule has actually been skipped in a real run.**

Every guardrail has a cost — an oracle slows every run, a hook can false-positive, a checklist item
spends reviewer attention, a prose rule dilutes the docs it lives in. Speculatively hardening rules
that no one has ever violated is the same over-engineering the method warns against everywhere else.

So the promotion trigger is **evidence, not anticipation**:

1. A rule gets **skipped in a real run** and something breaks (or nearly does).
2. *Then* promote it up the ladder — prose → checklist → hook → oracle — to whatever tier makes the
   skip impossible next time (GP-6: engineer each mistake into a permanent immunity).
3. If a guardrail keeps firing but never catches anything real, demote or delete it.

The ladder is a place to *promote proven rules to*, not a checklist to pre-fill. Start every rule as
prose; let real failures earn each rung.
