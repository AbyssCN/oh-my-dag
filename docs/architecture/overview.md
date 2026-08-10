# Architecture — how a task becomes a finished graph

[← README](../README.md) · [primitives](primitives.md) · [model layer](model-layer.md) · [MCP tools](mcp-tools.md)

**[→ 引擎流转图(Mermaid 真理源 + rationale + changelog)](diagrams/01-engine-flow.md)**

The shape of the whole system in one sentence: **one LLM call plans, pure functions
transform, dependency order executes, objective gates judge.**

Hand it a plan and `run` executes it. Hand it a *goal* and `solve` wraps that same machine
in a bounded outer sequence: classify what "done" means, write a contract, execute, judge,
re-expand — until a frozen criterion goes green or a stop axis fires.

## 1. Entry — three layers, three different promises

`src/mcp/tool-renames.ts` is the single source for the layer names; each layer contains the
one below it.

| Layer | Promise | Deprecated alias |
|---|---|---|
| `map_*` | slow loop — a decision map, a human present at the frontier | `path_*` |
| `solve` | goal convergence — the engine decides the approach and runs repair rounds | `dag_goal` |
| `run` | the approach is already decided — execute this graph | `dag_run` |

The old names are still registered as aliases with identical behaviour (`applyToolRenames`);
they disappear when the table entry is deleted. Renaming happens at the assembly layer, so
~300 in-tree call sites keep the old literals — and the two gates that count the registered
surface (the docs gate and the README badge) import the same table, so they cannot drift
from what is actually registered.

`conductor_chat` (`src/mcp/tools/chat.ts`, 2026-08-09) is a fourth surface of a different
kind: a **conversational seat**, where Claude drives omd's own conductor over MCP and the
conductor decides for itself whether to answer directly or draw a graph. Two properties are
load-bearing:

- **Headless approval mode = read-only hands.** There is no TTY over MCP and nobody to press
  `y`, so auto-approving writes would just remove the gate. The hands are `read` / `ls` /
  `grep` only (`HEADLESS_HANDS`); every write goes through the graph, where a leaf's own
  tools are its gate.
- **Graphs are fire-and-forget.** A turn dispatches and reports the `runId`; it does not poll
  to completion. The caller tracks progress across turns, so a dropped connection does not
  kill the graph.

## 2. The goal loop — `solve`

`src/harness/goal/run-goal.ts`. A goal comes in and the engine walks a **fixed stage
sequence** — `classify → survey → research → spec → execute` — with no human step between
them. The sequence itself is **strictly acyclic**; the loop lives one level down, inside the
execute node.

### Classification produces two independent axes

One call, two answers (`src/harness/goal/classify-acceptance.ts`):

- **cost tier** — how much machinery this goal deserves;
- **acceptance kind** — `executable` (a command plus the exit code that counts as success)
  or `exploratory` (no machine criterion; a learning goal plus an affordable loss).

The axes are independent on purpose, and forcing the tier deliberately does **not** override
the acceptance axis — the classification still runs. "This goal is cheap" and "this goal has
no machine criterion" are different statements, and one knob for both would let the first
silently answer the second.

### The acceptance criterion is frozen outside the loop

The whole anti-cheating story rests on one property: **the executor cannot move the goalposts.**
So the criterion is computed at classify time and then pinned in two places the loop cannot
reach — the task text handed to the conductor, and an out-of-graph `accept` node built by
`runGoal` itself (`executor: 'command'`, `expect_exit` from the spec). The conductor never
authors it and the inner judge cannot edit it.

That handles a moving goalpost. It does **not** handle a goalpost that was hollow to begin
with, which is what `src/harness/goal/acceptance-gate.ts` adds — two probes, both **fail-open**
(they harden, they are not preconditions):

| Probe | Question | Verdict when it fires |
|---|---|---|
| vacuity | run the command *before any work happens* — does it already pass? | passing here means it is unrelated to this task |
| discrimination | make the classifier produce a **known-wrong** artifact, run the command against it in a temp world | still passing means right and wrong answers both satisfy it |

A criterion that cannot fail is not a criterion. The probe verdict is a five-way vocabulary
(`passed-both` / `vacuity-only` / `demoted` / `skipped` / `exploratory`) and it is persisted
per run, so "was this goal actually judged by anything" is a readable number rather than a
belief.

### The loop is inside the node, and it re-expands rather than re-runs

Both LLM-driven stages compile to a **single `executor: 'conductor'` node** — `goal-contract`
(bounded by `specRounds`) and `goal-execute` (bounded by `maxRounds`). A conductor node draws
a subgraph at runtime and schedules it locally, and its rounds are the loop.

The round semantics matter: each round hands the previous failure reason back to the conductor
and it **draws a new subgraph**. Re-running the same graph can only redo the same work;
redrawing can add a step the previous round did not have at all — which is why the loop needs
no back-edge in the graph itself.

A run-level fixpoint used to sit above this. It was **withdrawn** (D-F, 2026-07-30): two
verify layers meant double cost and an argument about which one owned convergence. What
survived the withdrawal is `judge_final` — with no outer layer left to ask "did the overall
goal happen", the last round has to ask it, or `solve` would be reduced to reading "it
finished" as "it worked", which is the most comfortable entrance for a false completion.

Per round, two gates report separately (`RoundVerdict` in `src/harness/continuity/types.ts`):

1. **the frozen criterion**, run directly by the engine — deliberately *not* as a child node,
   because the judge renders children and would simply copy the answer;
2. **the inner judge**, asked afterwards.

Green criterion ends the loop; the judge's vote on that round is **recorded, not obeyed**.
Both three-state vocabularies stay unflattened — `criterion: 'none'` (nothing was configured)
is not "the criterion failed", and `judge: 'unreachable'` is not "the judge said no". Flatten
either and the combination worth observing — criterion green while the judge says no, i.e.
a judge that is too strict — is buried under noise.

### Four stop axes, none of them "ask the model if we are done"

`max_rounds` (schema-capped at 4) · token / wall-clock budget (`loopBudget`) · deterministic
idle detection (a round that re-expands to exactly the previous subgraph exits `BLOCKED`) ·
convergence. An unreachable judge exits immediately as `infra-error` rather than burning the
remaining rounds on a deterministic fault.

The outcomes are a vocabulary, not a boolean (`src/harness/run-outcome.ts`), because the
*next action* differs: `blocked` needs external input, `budgetStopped` usually just needs more
budget and a resume, `infra-error` means fix the engine, `not-converged` means the rounds ran
out. `RunGoalResult.criteria` additionally exposes the judge and oracle bits separately —
without that pair, "the criterion passed but the judge refused" has no cell to live in.

When a run ends badly, the recorded `error` is a **diagnostic block and nothing else**
(`src/harness/goal/summarize-goal-failure.ts`): termination reason with that outcome's next
action, converged, rounds, both criteria (absent is written as "never judged", never as
false), then only the non-success stages. It used to be the full goal summary, which opens
with the goal text — in the measured case, roughly 1500 characters of task description
before the actual reason. The `succeed` and `cancel` paths still use the full summary; they
want the whole picture, not a diagnosis.

### Detached — surviving the session that started it

An MCP server is stdio: it dies with its client, so an in-flight goal used to die with the
conversation and "unattended" was physically impossible on that path. `solve detached=true`
spawns `scripts/goal-worker.ts` as a detached, `unref`'d child that loads the same tool
assembly and calls the same handler — **zero new execution path**. Logs go to
`.omd/goal-logs/<runId>.log` and any later session can poll `dag_status`.

The parent deliberately does **not** register the run: the worker is the owner, and pid-based
liveness has to point at the owner. A parent-owned record would be judged "interrupted" by the
next session that hydrates it. The cost is a millisecond-wide window where the run is not yet
findable, and a spawn failure must fail loudly on the spot rather than return a `runId` that
will never appear.

### Three gates against unattended re-dispatch

An unattended heartbeat re-dispatched one goal ticket ~55 times over 3.5 days, because
per-call round and budget caps cannot see across calls. The fix is three gates, none of them
prose (2026-08-10, `edc28d1`):

| Gate | Where | What it counts |
|---|---|---|
| A | `src/harness/pathfinder/dispatch.ts` + `afk-hook.ts` | real spawns per ticket (`.goal-attempts`; idempotent hits do not count); over the cap → escalate to a human |
| B | `afk-hook.ts` | exploratory goals — no machine criterion — escalate on the **first** non-convergence, because an opinion loop can say "not yet" forever |
| C | `run-goal.ts` | resume with the same `runId` and a byte-identical goal reuses the classification and the contract stage (`goal-state.json`, keyed by a sha256 of the full goal text) |

Gate C's key is exact by construction: change one character of the goal and the state is void.
Without continuity there is no `runId` to anchor to and the gate simply does not arm — the
behaviour is then identical to before.

## 3. Plan phase

`task` → conductor → `ConductorPlan` → four passes → execution.

The conductor sees a **frozen system prefix** (byte-stable, so the provider's prompt
cache hits) plus the task below a boundary marker. It emits one JSON object. That JSON
is parsed and Zod-validated before anything runs — an unknown template name or a `map`
node without a `map` spec rejects the whole plan rather than failing at node 30.

`ConductorPlan` (`src/harness/conductor-plan.ts`) is a **seam**: execution never cares where
the graph came from. Plans arrive three ways — a runtime model (`/omd-contract` →
`/omd-execute`), a zero-LLM compiler (pathfinder slices via `map_deliver` —
`src/harness/pathfinder/slice-compiler.ts` — plus `dag_deepen` and `dag_slim`), or plans built
programmatically against the engine API, which is how `solve` produces its own two-stage
graphs.

### The pass pipeline

Each pass is a pure function: zero IO, zero logging, no mutation of its input, no
randomness. Same graph in, same graph out. They live in `src/harness/plan-passes/` and are
composed in `src/mcp/assemble.ts`.

| Pass | What it does | Fails how |
|---|---|---|
| `prune` | keep-set = declared outputs ∪ file/git side-effect nodes ∪ command gates, plus their ancestors; everything else is dead and gets cut | identity when no outputs declared |
| `dedup` | nodes with the same semantic key (every schema field except deps) merge; a Merkle fingerprint also enables cross-round reuse on re-plan | identity when nothing matches |
| `evidence` | a node whose template card declares `evidence: ui-pixels` **must** have a `[render command → attach_media review]` descendant chain; missing → patched in; unpatchable → the plan is rejected | throws, fail-closed |
| `stamp` | pins `node.model` on every node that doesn't already have one | identity when the pools are empty |

Ordering is load-bearing: any pass that **adds nodes** must run before `stamp`,
otherwise the new nodes never get a model.

## 4. Execution phase

### Ready-set scheduling

There are no level barriers. A node runs the moment **its own** dependencies settle —
it never waits for an unrelated slow sibling. `requires` decides what "settled" means:
`all` (any failed dep skips this node), `any` (survives sibling failure), or an integer
K (a judge that needs at least K candidates).

### Runtime expansion — two shapes, deliberately not one

`map` fans out **N copies of the same thing** (a template plus a work-list discovered at
runtime); `conductor` expands **one thing into several different steps**, each with its own
goal, executor and dependencies — a shape no template can express.

Both mint **content-addressed child ids** (`src/harness/plan/map-expand.ts`,
`src/harness/plan/conductor-expand.ts`): `childId = <parentId>::<semantic fingerprint>`.
Names are the model's to choose and it renames freely between rounds, so ids keyed on names
would either miss checkpoints that should hit, or — far worse — hand round 2's `impl-api` the
artifacts of round 1's unrelated `impl-api`. The id hashes the **spec only**, never upstream
output: "what I eat changed" is a freshness question answered by `inputHashes` at the
checkpoint layer, not an identity question.

### Fault boundaries

A failed node becomes a `[failed]` input downstream; siblings keep running. Two
honesty rules keep "done" meaningful:

- **File honesty** — a node that produces files is forced onto the tool-using path, and
  its artifacts are existence-checked. Text claiming success with nothing on disk is a
  failure. The engine also *promotes* a mis-labelled file-producer to `agent` rather
  than letting an `inproc` leaf silently produce nothing.
- **Media honesty** — an `attach_media` node whose predecessors yielded no existing
  image **fails** instead of quietly reviewing text. Every reference that was parsed but
  not attached is logged.

### Fan-in

Downstream nodes receive **summaries**, not transcripts. Keeping each node's input small
is what makes a wide graph cheap.

A fan-in node can also be marked `detector: true` (`src/harness/plan/detector.ts`), in which
case its output is read as a protocol — `REJECT: <id>` puts a sibling into the loop's poison
set, `BLOCKED: <reason>` exits the loop to wait for external input. An ordinary node only sees
its own `depends_on`; a fan-in node already sees a whole batch of siblings, and all that was
missing was a way for its judgement to **land in the loop** instead of sitting there as prose
nobody reads. `executor: 'command'` is preferred — a deterministic oracle naming what broke is
cheaper and more trustworthy than another LLM call.

### Checkpoint & single-node resume

Every finished node's output is written atomically (tmp + rename) under
`.omd/continuity/<runId>/`, keyed by a hash of its inputs.

On resume — `dag_resume`, or `dag_run_plan resume=<runId>` — the engine reloads the plan
and replays checkpoints: any node whose inputs still hash the same is **green and
skipped**; work restarts at the first node that never settled. A 40-node graph that died
at node 31 comes back and runs 31–40, not 1–40.

Loop state cannot live in a node checkpoint, because a checkpoint is only written when a node
is **done** and a loop that has not converged has no done node — a crash mid-loop would
evaporate the poison set, which is exactly the failure being defended against. It lives in a
per-node journal instead, `_loop-<nodeId>.json`, written after each round's judgement
(`NodeLoopJournal`). The run-level `_fixpoint.json` still exists for the manual iterate path;
D-F demoted the concept from run level to node level rather than deleting it, since deleting
it would reintroduce "a rejected artifact resurrected by a crash" in a new costume.

Checkpointing is **fail-open**: if a checkpoint cannot be written the run warns and
continues. You never lose progress *and* never wedge on bookkeeping.

## 5. Feedback phase

Three distinct things, often confused:

| | What it is | Model |
|---|---|---|
| **Oracle gate** | a `command` node running `tsc` / tests — objective, zero LLM, cannot hallucinate | none |
| **Verifier** | an in-graph skeptic that attacks the result requirement-by-requirement, defaulting to fail on doubt; deliberately from a **different model family** than the author | `verifier` seat |
| **Escalation** | on failure, a re-plan that emits a **node patch**, not a new graph — unpatched nodes stay byte-identical, so semantic reuse holds by construction | `escalation` seat |

Heal is the loop between them: a red gate becomes a repair task rather than an aborted
run. Escalation is bounded by `maxEscalations`.

## The plan surface — what a node can say

| Field | Controls |
|---|---|
| `executor` | `leaf` / `agent` / `command` / `map` / `research` / `conductor` |
| `goal` · `depends_on` | the node's contract · real data edges only |
| `template` · `persona` | a frozen role card by name · the task-specific angle |
| `model` · `tier` · `thinking` | per-node model pin · strength floor · reasoning effort |
| `cluster` | workstream label — display grouping + the boundary where the model may switch |
| `requires` | `all` / `any` / K |
| `attach_media` | this leaf looks at images from its direct predecessors' output |
| `map` | `lister` discovers the work-list at runtime → one child per item, resumable ids, bounded |
| `max_nodes` · `max_rounds` · `judge_final` | `conductor` nodes: subgraph size cap (≤64) · inner-loop round cap (≤4) · judge the final round too |
| `detector` | this fan-in node's output is read as `REJECT:` / `BLOCKED:` (inside a conductor subgraph only) |
| `kind: primitive` + `primitive` + `params` | one of 12 control-flow shapes ([details](primitives.md)) |
| `command` · `expect_exit` | the CLI to run · which exit code counts as success (default 0 — set `1` for a TDD *red* step) |
| `output_type` · `output_path` · `output_schema` | drives the file-producer guard · the shape structured output must take |
| `postcondition` | how this node's result is checked: `structural` / `code` / `llm-judge` / `human` |
| `mcp` | external MCP tools to mount at run time (`server` or `server:tool`; an unregistered server is rejected at plan time) |
| `max_retry` | node-level retries, each fed the previous failure (0..3; the only recovery knob) |

Run-level knobs: `maxFanout` · `warmThenFanout` (one warm call so the frozen prefix is
cached before the storm) · `verifier` + `conductorEscalationModel` + `maxEscalations` ·
`continuity` · `loopBudget` · `freezeCriterion` · `cancelSignal` · per-provider concurrency
caps · `sessionId` · SQLite run recording · `planToMermaid()`.

## Where the code lives

| Concern | Path |
|---|---|
| engine · plan types · defaults · planner | `src/harness/dag/{engine,types,defaults,planner}.ts` |
| plan schema (the seam) | `src/harness/conductor-plan.ts` |
| pure passes | `src/harness/plan-passes/` |
| runtime expansion · detector · judge | `src/harness/plan/{map-expand,conductor-expand,detector,conductor-judge}.ts` |
| checkpoints & journals | `src/harness/continuity/{checkpoint-manager,types}.ts` |
| goal loop · classification · acceptance probes | `src/harness/goal/{run-goal,classify-acceptance,acceptance-gate}.ts` |
| detached worker | `scripts/goal-worker.ts` |
| MCP surface · layer renames · entry tools | `src/mcp/{assemble,tool-renames}.ts`, `src/mcp/tools/{goal,chat,dag-tools}.ts` |
| run recording | `src/harness/dag-record.ts` |

The `executor-dag*` family was renamed into `src/harness/dag/` on 2026-08-07 (`4a0909a`). The
`executor-` prefix existed to distinguish it from a "macro PG DAG" layer that was planned once
and never built — a prefix drawing a line against something that does not exist only makes
readers think they missed a component.

## The two halves of the design principle

Everything above is one half of a pair. Stating only the first half — which is what this
codebase did for a long time — produces a predictable failure: over-mechanising the model
away.

> **Reliability comes from outside the model. Creativity comes from inside it.**
>
> **Gates judge** — did it happen, is it there, does it pass? Deterministic, zero-model,
> fail-closed. A model "having a look" is not a gate, because when it silently does not
> run, nothing turns red.
>
> **Models generate** — what to do, how to do it, what is still missing. Inside the gates,
> do not replace this with rules. Replacing generation with a mechanical rule marks the
> model's intelligence down to the expressive power of the rule.

Three corollaries that decide real designs:

1. **A deterministic detector is a floor, not a ceiling.** It guarantees the obvious miss
   does not get missed. It must never become the only thing allowed to notice something.
   A set-difference over fetched URLs is a good floor for "what did we fail to read"; it is
   a terrible substitute for "what should we look into next".
2. **Termination belongs to the engine; content belongs to the model.** Round caps,
   "stop after K dry rounds", quorum — the engine counts. What to ask, which angle to take,
   what looks wrong — the model decides. Asking a model "are we done yet?" reintroduces
   exactly the silent failure the gates exist to remove.
3. **Gates sit at the joins, not on every step.** Treat a SOTA model like a competent
   person: you check the work at the points where being wrong is expensive, and you do not
   look over their shoulder while they think.

Both failure modes are real and opposite. A model asked to *judge* whether something passed can
stop running entirely without anything turning red — which is why gates are deterministic. A model
allowed to *only* follow mechanical detectors can never look beyond what those detectors already
see — which is why generation is not gated.

## Cost shape

Overhead is **per-graph, not per-node**: a 5-node graph costs the node work + 2 LLM
calls (planning + verifier), +1 with the verifier off, and **+0** for compiled plans.

`solve` adds its own overhead on top of the graphs it runs: one classification call, a
conductor re-expansion per round in each of the two stages, and one judge call per round —
including the last one, which is what `judge_final` buys and it is not free. Both stages
record separately under the same `runId`, so the cost of one goal is the sum of its two graph
records, rather than a number that has to be reconstructed afterwards.
