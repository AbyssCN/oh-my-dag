# Control-flow primitives

[← README](../README.md) · [architecture](architecture.md) · [model layer](model-layer.md)

A primitive is a node that says **which shape** the work has — `kind: "primitive"`,
a `primitive` name, and `params`. The loop / branch / stop / scoring logic belongs to the
runtime. The planner never hand-draws these sub-graphs, and never gets to invent the
termination condition.

Why this exists: a model asked to hand-wire "try three approaches and keep the best"
will draw the fan-out but forget the stop condition, the tie-break, or what happens when
two attempts fail. Those are exactly the parts that must be deterministic.

Every primitive's `params` is schema-validated at compile time and unit-capped (no
primitive may compile to more than 512 units). The schemas are `.strict()`, so an unknown
key is a rejection, not a shrug — a planner that puts `model` in `params` is told so. A bad
param set fails the node **closed**; it does not silently shrink the work.

| Primitive | `params` | Shape |
|---|---|---|
| `parallel` | `goals[]` (2–64), `persona?` | N independent investigations at once |
| `pipeline` | `items[]` (1–32), `stages[]` (2–8) | each item flows through the same ordered stages |
| `loop-until` | `stepGoal`, `target`, `maxIterations?` | repeat a step until `target` items accumulate |
| `verify` | `claim`, `n?`, `lenses?` | spawn n skeptics to adversarially refute one claim |
| `judge` | `attempts` (2–8), `attemptGoal`, `scoreCriterion?`, `criteria?` | N independent attempts, keep the best-scored |
| `discovery` | `roundGoal`, `maxRounds`, `over?`, `keyBy?`, `dryThreshold?` | repeat a finder until K dry rounds — for find-all with an unknown count |
| `iterate` | `stepGoal`, `convergeCriterion`, `maxRounds?` | refine one output until a judge says it converged |
| `tournament` | `attempts` (3–32), `attemptGoal`, `scoreCriterion`, `bracketSize?` | large candidate pool → bracket elimination |
| `router` | `classifyGoal`, `branches[]` (2–8) | classify first, then run **only** the matching branch |
| `race` | `goals[]` (2–8) | redundant alternatives, take the first to succeed |
| `escalation` | `levels[]` (2–6), `acceptCriterion` | try levels cheap → strong until one is accepted |
| `saga` | `steps[{goal, compensateGoal}]` (2–16) | multi-step; on mid-failure run compensations in reverse |

**The lower bounds are the routing advice, enforced.** `pipeline` demands two stages
because one stage is `parallel`. `tournament` demands three candidates because two is
`judge`. `saga` demands two steps because a single step has nothing to compensate. You do
not get to read that guidance and ignore it — the validator says it back to you verbatim.

The menu the planner is shown is a deliberate subset of what the schemas accept: it omits
`verify.lenses`, `judge.criteria` and `discovery.dryThreshold` to keep the choice about
*shape* rather than tuning. Call `omd_primitive` directly and all of them are available.

`escape-hatch` — a gated last-resort imperative sequence — is a thirteenth primitive that
the runtime knows and the router will **never** select on its own. It needs
`OMD_ESCAPE_HATCH=1` in the environment, and its schema forces a `reason` field explaining
why no structural primitive was enough. The planner is told it exists and told not to reach
for it: naming it and forbidding it beats hiding it, because a planner that has never heard
of an escape hatch invents a worse one out of hand-wired nodes.

## Choosing between a primitive and plain nodes

Use a primitive when the shape is one of the above **and** the stop/scoring rule matters.
Use ordinary `leaf` / `agent` / `command` nodes otherwise — the free graph is always
valid, and a hand-drawn fan-out of three siblings is clearer than a `parallel` primitive
wrapping the same three goals.

Two shapes that are **not** primitives, because they are graph patterns rather than
runtime control flow:

- **One decision, then the fan-out.** When N nodes must agree on one interface, schema,
  or naming, emit ONE node that outputs that decision and have all N depend on it. Give
  it `tier: "strong"` — this is the single best place to spend a strong model, and it is
  what lets the workers below stay cheap.
- **The UI evidence chain.** A node whose template card declares `evidence: 'ui-pixels'`
  must be followed by a render `command` node and an `omd-shots-verify` command node that
  checks the screenshots really exist, are non-empty, and are not blank canvases. This one
  is not advice — the `evidence` pass enforces it structurally, splicing the chain in when
  it is missing and **rejecting the plan** when it cannot ([architecture](architecture.md#the-pass-pipeline)).

  The floor is deterministic on purpose. It used to be "send a multimodal model to take a
  look", and the full-stack eval read out why that fails: across six runs only one actually
  produced a screenshot, and that run missed all four seeded defects — while the headline
  pass rate stayed at 1.000. A broken evidence chain was completely invisible in the
  numbers. Counting pixels cannot be fooled that way: not run is not run, blank is red. An
  `attach_media` review leaf may still follow (`omd-shots-verify` prints the image paths on
  stdout), but it is no longer what holds the chain up. Judging whether a design is *good*
  is taste — that belongs to a human or to a step outside the graph, not to a cheap model
  pretending inside it.
