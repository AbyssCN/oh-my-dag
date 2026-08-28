# MCP tools — the engine's raw API

[← docs index](../README.md) · [architecture](../architecture/overview.md) ·
[command reference](../../client-skills/README.md) ·
[capability map (diagram source of truth)](../diagrams/03-capability-map.md)

Everything omd does is reachable two ways, and they are the same thing from two sides.
The MCP tools below are the raw API; the slash commands in
[client-skills](../../client-skills/) are thin workflow wrappers that call these and add the
discipline (when to escalate, how to accept, who holds the trigger).

> **Naming (2026-08-04)** — the three layers now say their own promise: `map_*`
> (slow-loop decision maps, human in the loop) ⊃ `solve` (goal convergence with repair
> rounds, was `dag_goal`) ⊃ `run` (execute a settled plan, was `dag_run`); `path_*` became
> `map_*` (`path_map` → `map_open`). Old names still work as **deprecated aliases** for one
> release — same schema, same handler, `[deprecated → new]` in the description.

**Engine** — delegate work to the cheap fleet:

| Tool | What it does |
|---|---|
| `run` (alias: `dag_run`) | task → conductor decomposes into a typed DAG → concurrent execution (agent leaves really write files, command leaves run tsc/tests) |
| `dag_run_plan` | skip the conductor: execute a pre-built plan JSON directly; `resume=<runId>` skips checkpointed done nodes |
| `dag_resume` | one-step resume: reload a failed run's plan from its on-disk checkpoint and re-run, skipping green nodes |
| `dag_status` · `dag_result` · `dag_node_output` | three-phase async: dispatch, keep chatting, poll, fetch artifacts |
| `dag_runs` | list runs — memory registry merged with on-disk checkpoints; optional status filter |
| `dag_research` | multi-lens parallel research + judged synthesis; full report on disk, summary into context |
| `dag_review` | adversarial multi-dimension diff review fleet, async — gate `G0`–`G3`, `scope` paths |
| `dag_slim` | over-engineering, deletion-only audit fleet, async |
| `dag_deepen` | architecture-deepening scan: git-hotspot discovery → one agent per hotspot → leverage-ranked HTML report |
| `dag_debug` | parallel multi-hypothesis root-cause debug fleet, async — reproduce + codegraph → fan out hypotheses |
| `solve` (alias: `dag_goal`) | autonomous goal loop: research → spec → execute → verify → one repair round |
| `conductor_chat` | chat with the conductor (persistent session): it answers directly or plans DAG runs; read-only hands, all writes go through graphs; reply header carries sessionId + spawned runIds |
| `dag_cancel` | cooperative stop: no new nodes dispatched, in-flight ones finish, ends `cancelled` (resumable) |
| `dag_triage` | **owner inbox** (read-only): decision forks a running graph raised, plus runs that need a human look |
| `dag_rule` | rule on one of those forks; the ruling becomes a verbatim owner directive for the run's next round |
| `dag_intervene` | record a human intervention: append an `intervened` entry to the run-board (cause = `NodeFailureKind`); powers the avoidability readout |

**Pathfinder** — persistent planning for foggy, multi-session work:

| Tool | What it does |
|---|---|
| `map_init` (alias: `path_init`) | initialize the pathfinder backend: no args → probe + recommendation; or set the backend (git-markdown / issues) |
| `map_open` (alias: `path_map`) | list / create / resume decision maps |
| `map_add` (alias: `path_add`) | add typed tickets (research / grill / prototype / task) with dependency edges |
| `map_tickets` (alias: `path_tickets`) | show the frontier; folds in landed background results first |
| `map_rule` (alias: `path_rule`) | adjudicate a decision onto the map (owner's call) |
| `map_confirm` | confirm a machine-suggested ticket: accept (optionally retitle) into the frontier, or reject — logged for the acceptance-rate readout |
| `map_deliver` (alias: `path_deliver`) | **the power gate**: compile the clear region to a slice, run the DAG, mark delivered only on full success |
| `map_prefetch` (alias: `path_prefetch`) | dispatch frontier research to detached background processes that outlive the client |

**Memory** — persistence across sessions:

| Tool | What it does |
|---|---|
| `memory_recall` | hybrid semantic + lexical search over the fact store; ranked hits with confidence, source, and code-anchor staleness. Long facts are head-truncated at 1500 chars and the whole response is capped at 8000 — what got dropped is stated, never silently cut |
| `memory_fact` | fetch one fact in full by id, with a per-anchor staleness breakdown. This is the exit for a truncated `memory_recall` hit — without it, truncation would make content permanently unreachable |
| `memory_remember` | store a fact, gated by namespace safeguards (rejects secrets / banned / out-of-namespace). `omd.pattern` / `omd.limit` may carry `evidence: [{path, sha}]` — repo-relative paths plus a sha256-prefix fingerprint, checked on every recall with zero LLM calls |

**Config** — model roster, keys, presets, all over MCP:

| Tool | What it does |
|---|---|
| `omd_config_status` · `omd_plans` | show the model roster / role assignments / which keys are set · list saved plans |
| `omd_register_provider` | register an OpenAI-compatible provider (baseUrl + key-env + models) into the shared model registry |
| `omd_set_key` · `omd_set_model` · `omd_set_role` | set a provider key · a model's attributes · a role→model assignment |
| `omd_apply_preset` · `omd_toggle_hud` | apply a wizard preset (base-opencode-go / cn-standard / cn-ultimate) · toggle the statusline HUD |
| `omd_models_auto` | auto-assign per-node models by channel economics → `.omd/config.json`; env still overrides |
| `omd_shapes` | the graph-shape catalogue — each with trigger conditions, when NOT to use it, and why. Call once before decomposing |
| `omd_primitive` | run one control-flow primitive directly, no graph needed. For 2–5 step combos; large fan-out goes to `run` |
| `omd_web` | search + fetch, zero LLM. Full text to disk, returns only the index + fetched URLs. For a synthesised answer use `dag_research` |
| `omd_distill` | distil insight from text you already have (no fetching). `expert` = faithful extraction, `challenger` = high-temp long-tail |

### Claude slash commands (the [client-skills](../../client-skills/) pack)

All 22 install themselves into `~/.claude/skills/` on first server start (Codex: merge the
SKILL.md bodies into `AGENTS.md`). Each wraps the MCP tool(s) in the middle column and adds the
discipline — when to escalate, how to accept, who holds the trigger. **They are graphs, not
prompts**: each carries its own shape, seat assignment and gates.

| Command | Wraps | What it adds |
|---|---|---|
| `/omd-path` | `map_open` · `map_add` · `map_prefetch` | open or resume a decision map, break a goal into tickets |
| `/omd-tickets` | `map_tickets` | show the frontier, folding in landed background research |
| `/omd-rule` | `map_rule` | adjudicate a decision onto the map — the owner's explicit call |
| `/omd-deliver` | `map_deliver` | the delivery gate: compile the ruled region and run it |
| `/omd-grill` | deliberation → `map_rule` | interrogate a plan before it's locked; open a council at wide forks |
| `/omd-contract` | writes a spec to `docs/plan/` | crystallise the argument into the contract the engine executes |
| `/omd-execute` | `run` → `dag_status` / `dag_result` | run a spec as a DAG, then accept the result against it |
| `/omd-iterate` | `run` (fixpoint loop) | re-run to convergence, carrying the failure reason forward |
| `/omd-resume` | `dag_runs` · `dag_resume` | list broken runs, pick one, resume it from its checkpoint |
| `/omd-note` | `map_add` · `map_rule` | a decision ledger for the conversation |
| `/omd-recall` | `memory_recall` | pull prior facts when reasoning stalls |
| `/omd-council` | `dag_research` (council) | judged multi-persona debate over a hard call |
| `/omd-research-deep` | `dag_research` (`super` + `rounds`) | seeded multi-angle crawl → council → multi-round gap-filling |
| `/omd-review` | `dag_review` | adversarial diff review, gate `G0`–`G3`, every finding falsified |
| `/omd-audit` | `run` (security lenses) | trust-boundary audit as a DAG |
| `/omd-sast` | semgrep (local) | deterministic static scan, zero LLM |
| `/omd-slim` | `dag_slim` | deletion-only over-engineering audit |
| `/omd-deepen` | `dag_deepen` | architecture-hotspot scan → leverage-ranked report |
| `/omd-debug` | `dag_debug` | reproduce → scope lock → parallel hypotheses → verify |
| `/omd-docs-drift` | `run` | the semantic half of doc drift: does the doc still hold? |
| `/omd-ui-reviewer` | (local) | judge rendered UI screenshots — hierarchy, spacing, states |
| `/omd-video` | (local) | video → structured per-segment notes (frames + audio) |

