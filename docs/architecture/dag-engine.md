# The DAG engine — plan, execute, feed back

[← architecture overview](overview.md) · [goal loop](goal-loop.md) ·
[model layer](model-layer.md) · [primitives](primitives.md) ·
[engine flow diagram](../diagrams/01-engine-flow.md)

A task is planned **once** by an LLM, then transformed by **pure functions**, then executed
by dependency order, then judged by gates. Everything after the conductor is deterministic.
This page is that pipeline; the outer sequence that turns a *goal* into such a graph is in
[the goal loop](goal-loop.md).

## Node kinds — what a node can be

| Kind | Model? | Tools? | Use for |
|---|---|---|---|
| `leaf` (`inproc` in code) | one shot | no | generation, judgement, drafting |
| `agent` | yes | read/edit/write/bash — jailed **only** on `branchStrategy: 'branch'` (see below) | **the only kind that writes files** |
| `command` | **none** | a CLI from an allowlist | gates (`tsc`/tests), scanners, indexed lookups |
| `map` | mixed | — | runtime fan-out: a lister discovers the work-list, one child per item |
| `primitive` | mixed | — | control-flow shapes the engine owns (12 composable + gated `escape-hatch`) |
| `research` | yes | live web retrieval | grounded research — **fails loudly** without a web runner instead of citing from model memory |
| `conductor` | yes | — | expands a subgraph at run time; hosts the goal loop's re-plan rounds |

Control-flow primitives are the shapes the engine owns — you pick the shape and its params,
while the loop / branch / stop / scoring logic belongs to the runtime, never to the model:
`parallel` · `pipeline` · `loop-until` · `verify` · `judge` · `discovery` · `iterate` ·
`tournament` · `router` · `race` · `escalation` · `saga`. A gated thirteenth,
`escape-hatch`, exists but stays off unless `OMD_ESCAPE_HATCH=1`. Details and the "use a
plain node instead" cases: [primitives](primitives.md).

## Plan phase

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

## Execution phase

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

### Where a run's writes land, and what contains them

`solve` takes `branchStrategy`:

| | `head` (default) | `branch` |
|---|---|---|
| Writes go to | your current working tree | an isolated git worktree on `omd/run/<runId>`; the engine never merges back — you do |
| Agent leaf **write** face | anchored at the run's cwd, but an **absolute path still escapes** (measured, not theorised) | bwrap jail — the leaf process only sees that worktree, so there is nothing outside to address |
| Agent leaf **read** face | **your whole filesystem** — no jail | `HOME=/tmp`, `/home` not mounted → `~/.ssh` does not exist inside the jail |
| Command leaf | allowlist + dangerous-pattern table (both modes) | same |

**This is a deliberate ruling, not an oversight** (2026-07-31): `head` is the "I'm here, I'm
watching" mode, and reading outside the repo is the reason it exists. If a node were ever hijacked
— say by injected text inside a fetched web page — the execution face is held by the command
allowlist (live-verified: rejected twice), but the **read** face in `head` is open by design.
Run `branchStrategy: 'branch'` for anything unattended, anything that fetches the open web, or
anything you would not want reading `~/.ssh`. If bwrap is missing on the box, the engine says so
loudly and degrades to path-level isolation only.

## Feedback phase

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

## Cost shape of a graph

Overhead is **per-graph, not per-node**: a 5-node graph costs the node work + 2 LLM
calls (planning + verifier), +1 with the verifier off, and **+0** for compiled plans.
What `solve` adds on top of that is in [the goal loop](goal-loop.md#cost-shape-of-a-goal).
