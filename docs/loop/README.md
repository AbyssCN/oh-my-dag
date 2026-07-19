# The Loop — a methodology for AI-driven engineering

This directory is the generalized, product-neutral distillation of how work moves through this
harness. It names three roles, two lifecycle paths for getting work done, and one spine where both
paths converge. Everything else (gates, slice contracts, guardrail ladder) hangs off these.

The vocabulary is deliberately abstract — **Owner**, **Runtime**, **Fleet** — so the method
transfers across any codebase, not just the one it grew in.

---

## 1. The three-role constitution

Work is a triangle of authority. No role may usurp another's mandate.

| Role | Who | Owns | Never does |
|------|-----|------|-----------|
| **Owner** | The human | Direction, scope, HITL merge, the escalation-valve endpoint | Micro-manage the technical path |
| **Runtime** | The lead model (you) | Contracts, final ruling, dispatch judgment, diff audit, acceptance | Rubber-stamp Fleet output |
| **Fleet** | The DAG of sub-agents | Decomposable + verifiable implementation; self-heal to a green oracle | **Commit. Ever.** |

- **Owner = direction/scope/HITL-merge/escalation endpoint.** The Owner sets business direction and
  scope, performs the human-in-the-loop merge, and is the single destination of the escalation valve
  `?`. The Owner does not dictate the technical path — that is delegated.
- **Runtime = contracts/final-ruling/dispatch-judgment/diff-audit/acceptance.** The Runtime authors
  contracts (types + validation + state machine + GWT invariants), makes the final ruling on every
  open question it *can* rule on, decides whether and how to dispatch, audits every diff, and does
  acceptance against the spec. Runtime holds the mode-switch authority across the whole lifecycle.
- **Fleet = decomposable + verifiable implementation, self-heal to oracle green, never commits.**
  The Fleet is dispatched only when work is genuinely shardable and verifiable. Fleet leaves iterate
  against an objective oracle until it goes green, and hand results back — they never write to the
  repo's history.

Iron discipline: **code can loop, rules cannot loop.** Fleet may retry against an oracle without a
human in the loop; a *rule* that keeps getting skipped is a bug to be fixed, never a retry.

---

## 2. Two lifecycle paths, one spine

Not all work is the same size. Forcing small work through a heavy planning apparatus is a tax
(YAGNI violation); assuming large fuzzy work can be fully planned on day one is a lie. So there are
two entry paths, chosen by the *shape* of the work, converging on one execution spine.

```
                                          ┌──────────────── SMALL / crisp work ────────────────┐
requirement → judge size ─────────────────┤ chat + /grill + /council  →  /sdd (spec)           │
                                          └────────────────────────────────────────────────────┘
                                                                                    │  decompose
                                          ┌──────────── BIG / fuzzy / cross-session ─┤            │
                                          │ shift+tab → pathfinder decision map      │            │
                                          │  tickets: grill · research · prototype · task        │
                                          │  frontier = ready-set; AFK research auto-dispatched   │
                                          │  region clears →                          │           │
                                          └───────────────────────────────────────────┘           │
                                                                                    ▼           ▼
                                              ══════════ SPINE ══════════   slice → /execute → dual-axis review → acceptance
```

### Path A — small / crisp work

For a change that fits in one head of context and has a clear target or benchmark.

1. **Chat** — think in the open, no ceremony.
2. **`/grill`** *(skill)* — adversarial interrogation before locking a plan/contract: one question at
   a time, recommends an answer each time, reads code instead of asking when it can, compresses prose
   into Contracts + decision-number (D-number) deltas.
3. **`/council`** *(skill)* — when the solution space is wide: fan out N personas/angles in parallel,
   judge across lenses, synthesize the champion. Optional.
4. **`/sdd`** *(command)* — emit a spec: PR/FAQ framing → Contracts → red-first tests → decomposition
   into slices.
5. Then join the spine at **slice → `/execute`**.

### Path B — big / fuzzy / cross-session work

For work too large or too foggy to plan correctly up front, spanning multiple sessions.

1. **`shift+tab`** — enter **pathfinder** mode (this *replaces* plan mode; there is no coexistence).
2. **Decision map** — a persistent decision DAG (a graph, not a tree), stored as **markdown-in-git as
   the source of truth**, with a local index that can be rebuilt from it. The map survives across
   sessions.
3. **Tickets** carry the frontier. Each ticket has a *type* that drives its dispatch automatically —
   the human no longer hand-orders grill vs. research:
   - **grill** — HITL, Runtime interrogates in-session (read-only deliberation).
   - **research** — AFK background fleet, auto-dispatched; on completion it flows back, updates the
     map, notifies, and the frontier is recomputed. A research ticket may **self-expand into child
     tickets** (map-node discovery at runtime).
   - **prototype** — a spike in an isolated git-branch worktree; throwaway code never pollutes the
     main tree, and abandoning it just deletes the worktree.
   - **task** — a ruled leaf, waiting to be compiled.
4. **Frontier = ready-set**: the tickets whose blockers are all ruled. This is the carrier for
   concurrent HITL + AFK work.
5. **A region clears** (every ticket in it ruled) → the region **compiles into a slice with zero
   LLM** (the decision DAG maps directly to a plan — no lossy re-derivation from prose) → Runtime
   finalizes → join the spine at **`/execute`**.
6. If a contract can't be filled at compile time, that's *a ticket with no ruling* — go back to the
   map (escalation valve `?`). **Assemble, never invent.**

### The shared spine

Both paths converge here, and the execution machinery downstream is identical:

- **slice** — the atomic construction unit (see `SLICE-TEMPLATE.md`). It arrives either from a spec's
  decomposition (Path A) or a cleared pathfinder region (Path B).
- **`/execute`** *(command)* — hand the (possibly pre-constructed) plan to the executor DAG: ready-set
  scheduling, leaves, verify, escalation. The conductor model defaults to the **same model as
  Runtime** — there is no separate cheap conductor re-deriving a DAG from prose.
- **dual-axis review** — the review gate for the slice (see `GATES.md`): a Diff axis plus, at higher
  gates, a Spec axis.
- **acceptance** — Runtime judges pass/fail against the contract, unprompted, and picks the cheapest
  correct remedy (accept / redraw / iterate / fix-in-place). Undecidable items go up the `?` valve.

---

## 3. The escalation valve `?`

The single upward escape hatch. When Runtime cannot rule, it marks `?` with its leaning + reasoning
and reports to the Owner. **No defer, no silent scope-cut.** The worst failure is not being wrong
(the oracle catches wrong) — it is silently downgrading something that had a real source into a
"defer".

---

## 4. Files in this directory

- **README.md** — this file: roles, two paths, the spine.
- **GATES.md** — the G0–G3 review-gate ladder and where the deliberate/build boundary is enforced.
- **SLICE-TEMPLATE.md** — the generic slice contract every construction unit must satisfy.
- **guardrails.md** — the 4-tier guardrail ladder and the meta-rule for promoting a rule up it.
