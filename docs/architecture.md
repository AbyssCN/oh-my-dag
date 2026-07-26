# Architecture — how a task becomes a finished graph

[← README](../README.md) · [primitives](primitives.md) · [model layer](model-layer.md) · [MCP tools](mcp-tools.md)

**[→ 引擎流转图(Mermaid 真理源 + rationale + changelog)](diagrams/01-engine-flow.md)**

The shape of the whole system in one sentence: **one LLM call plans, pure functions
transform, dependency order executes, objective gates judge.**

## 1. Plan phase

`task` → conductor → `ConductorPlan` → four passes → execution.

The conductor sees a **frozen system prefix** (byte-stable, so the provider's prompt
cache hits) plus the task below a boundary marker. It emits one JSON object. That JSON
is parsed and Zod-validated before anything runs — an unknown template name or a `map`
node without a `map` spec rejects the whole plan rather than failing at node 30.

`ConductorPlan` is a **seam**: execution never cares where the graph came from. Plans
arrive three ways — a runtime model (`/sdd` → `/execute`), a zero-LLM compiler
(pathfinder slices, `dag_deepen`, `dag_slim`), or an explicit planning call through the
engine API.

### The pass pipeline

Each pass is a pure function: zero IO, zero logging, no mutation of its input, no
randomness. Same graph in, same graph out.

| Pass | What it does | Fails how |
|---|---|---|
| `prune` | keep-set = declared outputs ∪ file/git side-effect nodes ∪ command gates, plus their ancestors; everything else is dead and gets cut | identity when no outputs declared |
| `dedup` | nodes with the same semantic key (every schema field except deps) merge; a Merkle fingerprint also enables cross-round reuse on re-plan | identity when nothing matches |
| `evidence` | a node whose template card declares `evidence: ui-pixels` **must** have a `[render command → attach_media review]` descendant chain; missing → patched in; unpatchable → the plan is rejected | throws, fail-closed |
| `stamp` | pins `node.model` on every node that doesn't already have one | identity when the pools are empty |

Ordering is load-bearing: any pass that **adds nodes** must run before `stamp`,
otherwise the new nodes never get a model.

## 2. Execution phase

### Ready-set scheduling

There are no level barriers. A node runs the moment **its own** dependencies settle —
it never waits for an unrelated slow sibling. `requires` decides what "settled" means:
`all` (any failed dep skips this node), `any` (survives sibling failure), or an integer
K (a judge that needs at least K candidates).

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

### Checkpoint & single-node resume

Every finished node's output is written atomically (tmp + rename) under
`.omd/continuity/<runId>/`, keyed by a hash of its inputs.

On resume — `dag_resume`, or `dag_run_plan resume=<runId>` — the engine reloads the plan
and replays checkpoints: any node whose inputs still hash the same is **green and
skipped**; work restarts at the first node that never settled. A 40-node graph that died
at node 31 comes back and runs 31–40, not 1–40.

Checkpointing is **fail-open**: if a checkpoint cannot be written the run warns and
continues. You never lose progress *and* never wedge on bookkeeping.

## 3. Feedback phase

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
| `executor` | `leaf` / `agent` / `command` / `map` |
| `goal` · `depends_on` | the node's contract · real data edges only |
| `template` · `persona` | a frozen role card by name · the task-specific angle |
| `model` · `tier` · `thinking` | per-node model pin · strength floor · reasoning effort |
| `cluster` | workstream label — display grouping + the boundary where the model may switch |
| `requires` | `all` / `any` / K |
| `attach_media` | this leaf looks at images from its direct predecessors' output |
| `map` | `lister` discovers the work-list at runtime → one child per item, resumable ids, bounded |
| `kind: primitive` + `primitive` + `params` | one of 12 control-flow shapes ([details](primitives.md)) |
| `postcondition` | `structural` / `code` / `llm-judge` / `human` |
| `output_type` · `output_path` | drives the file-producer guard |
| `on_failure` · `max_retry` | `retry` / `complete-then-retry` / `escalate` / `pause` |

Run-level knobs: `maxFanout` · `warmThenFanout` (one warm call so the frozen prefix is
cached before the storm) · `verifier` + `conductorEscalationModel` + `maxEscalations` ·
`continuity` · per-provider concurrency caps · `sessionId` · SQLite run recording ·
`planToMermaid()`.

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

The engine's own history is the evidence for both halves. Trusting a model to *judge* that
UI pixels were fine produced a chain that silently never ran while the headline metric
stayed green (see [eval findings](eval-findings.md)) — that is why gates are deterministic.
Constraining a model to *only* follow mechanical detectors would have produced research that
can never look beyond the URLs it already had — which is why generation is not gated.

## Cost shape

Overhead is **per-graph, not per-node**: a 5-node graph costs the node work + 2 LLM
calls (planning + verifier), +1 with the verifier off, and **+0** for compiled plans.
