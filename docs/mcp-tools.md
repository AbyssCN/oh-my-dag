# MCP tools — the engine's raw API

[← README](../README.md) · [architecture](architecture.md) · [command reference](../client-skills/README.md)

Everything omd does is reachable two ways, and they are the same thing from two sides.
The MCP tools below are the raw API; the slash commands in
[client-skills](../client-skills/) are thin workflow wrappers that call these and add the
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
| `dag_cancel` | cooperative stop: no new nodes dispatched, in-flight ones finish, ends `cancelled` (resumable) |
| `dag_triage` | **owner inbox** (read-only): decision forks a running graph raised, plus runs that need a human look |
| `dag_rule` | rule on one of those forks; the ruling becomes a verbatim owner directive for the run's next round |

**Pathfinder** — persistent planning for foggy, multi-session work:

| Tool | What it does |
|---|---|
| `map_init` (alias: `path_init`) | initialize the pathfinder backend: no args → probe + recommendation; or set the backend (git-markdown / issues) |
| `map_open` (alias: `path_map`) | list / create / resume decision maps |
| `map_add` (alias: `path_add`) | add typed tickets (research / grill / prototype / task) with dependency edges |
| `map_tickets` (alias: `path_tickets`) | show the frontier; folds in landed background results first |
| `map_rule` (alias: `path_rule`) | adjudicate a decision onto the map (owner's call) |
| `map_deliver` (alias: `path_deliver`) | **the power gate**: compile the clear region to a slice, run the DAG, mark delivered only on full success |
| `map_prefetch` (alias: `path_prefetch`) | dispatch frontier research to detached background processes that outlive the client |

**Memory** — persistence across sessions:

| Tool | What it does |
|---|---|
| `memory_recall` | hybrid semantic + lexical search over the fact store; ranked hits with confidence and source |
| `memory_remember` | store a fact, gated by namespace safeguards (rejects secrets / banned / out-of-namespace) |

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

### Claude slash commands (the [client-skills](../client-skills/) pack)

Copy into `~/.claude/skills/` (Codex: merge into `AGENTS.md`). Each wraps the MCP
tool(s) in the right column and adds the workflow discipline.

| Command | Wraps | What it adds |
|---|---|---|
| `/path` | `map_open` · `map_add` | open or resume a decision map, break a goal into tickets |
| `/tickets` | `map_tickets` · `map_prefetch` | show the frontier, pull landed research, dispatch background work |
| `/rule` | `map_rule` | adjudicate a decision onto the map — owner's explicit call |
| `/deliver` | `map_deliver` | the delivery gate: compile the clear zone and run it |
| `/sdd` | writes spec to `docs/plan/` | crystallize the conversation into a spec on disk before building |
| `/execute` | `run` → `dag_status`/`dag_result` | run a spec as a DAG, then actively accept the result against it |
| `/iterate` | `run` (fixpoint loop) | re-run to convergence — your agent is the judge |
| `/resume` | `dag_runs` · `dag_resume` | list failed/interrupted runs, pick one, resume it from disk |
| `/grill` | deliberation → `map_rule` | interrogate an idea before it's locked; land the ruling |
| `/note` | `map_add` · `map_rule` | a decision ledger for the conversation |
| `/council` | `dag_research` (--council) | judged multi-persona debate over a hard call |
| `/audit` | `run` (security lenses) | multi-lens security audit as a DAG |
| `/sast` | semgrep (local) | deterministic static scan, no LLM |
| `/review` | `dag_review` | adversarial diff-review fleet, gate G0–G3 |
| `/slim` | `dag_slim` | deletion-only over-engineering audit |
| `/deepen` | `dag_deepen` | architecture-hotspot scan → leverage-ranked report |
| `/debug` | `dag_debug` | root-cause debug fleet: reproduce → multi-hypothesis → verify |
| `/recall` | `memory_recall` | proactively pull prior facts when reasoning stalls |
| `/video` | (local) | video → structured per-segment notes (frames + audio) |

