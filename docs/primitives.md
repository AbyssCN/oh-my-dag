# Control-flow primitives

[← README](../README.md) · [architecture](architecture.md) · [model layer](model-layer.md)

A primitive is a node that says **which shape** the work has — `kind: "primitive"`,
a `primitive` name, and `params`. The loop / branch / stop / scoring logic belongs to the
runtime. The planner never hand-draws these sub-graphs, and never gets to invent the
termination condition.

Why this exists: a model asked to hand-wire "try three approaches and keep the best"
will draw the fan-out but forget the stop condition, the tie-break, or what happens when
two attempts fail. Those are exactly the parts that must be deterministic.

Every primitive's `params` is schema-validated at compile time and unit-capped. A bad
param set fails the node **closed** — it does not silently shrink the work.

| Primitive | `params` | Shape |
|---|---|---|
| `parallel` | `goals[]`, `persona?` | N independent investigations at once |
| `pipeline` | `items[]`, `stages[]` | each item flows through the same ordered stages |
| `loop-until` | `stepGoal`, `target`, `maxIterations?` | repeat a step until `target` items accumulate |
| `verify` | `claim`, `n?` | spawn n skeptics to adversarially refute one claim |
| `judge` | `attempts`, `attemptGoal`, `scoreCriterion` | N independent attempts, keep the best-scored |
| `discovery` | `roundGoal`, `over?`, `keyBy?`, `maxRounds` | repeat a finder until K dry rounds — for find-all with an unknown count |
| `iterate` | `stepGoal`, `convergeCriterion`, `maxRounds?` | refine one output until a judge says it converged |
| `tournament` | `attempts`, `attemptGoal`, `scoreCriterion`, `bracketSize?` | large candidate pool → bracket elimination |
| `router` | `classifyGoal`, `branches[]` | classify first, then run **only** the matching branch |
| `race` | `goals[]` | redundant alternatives, take the first to succeed |
| `escalation` | `levels[]`, `acceptCriterion` | try levels cheap → strong until one is accepted |
| `saga` | `steps[{goal, compensateGoal}]` | multi-step; on mid-failure run compensations in reverse |

`escape-hatch` — a gated last-resort imperative sequence — exists but is **off by
default** and is not advertised to the planner.

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
- **The UI evidence chain.** A node whose deliverable is user-visible UI must be followed
  by a render `command` node that prints image paths and an `attach_media` review leaf
  that judges the real pixels. This one is not advice — the `evidence` pass enforces it
  structurally ([architecture](architecture.md#the-pass-pipeline)).
