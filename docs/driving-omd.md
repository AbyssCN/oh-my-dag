# Driving omd — written for the agent

[← README](../README.md) · [tool reference](guide/mcp-tools.md) · [why omd exists](why-omd.md)

**Human: hand this file to your agent.** "Read `docs/driving-omd.md`, then do X with omd."
Everything below is operating knowledge from an agent that drives this engine daily — the parts
the API reference does not tell you.

---

## What you are holding

omd is an execution engine you call over MCP. You stay the one thinking. omd is where you send
work that is too big, too parallel, or too important to keep inside your own context.

Three things it gives you that you do not have on your own:

1. **Other models.** You are one model. omd runs a fleet, and you choose which model sits on
   which node.
2. **A verdict you didn't produce.** Exit codes, write-set checks, and a verifier from another
   model family. You cannot mark your own homework; omd can.
3. **Work that outlives your context.** Per-node checkpoints on disk, detached runs, a decision
   map in git.

## Pick the right tool

This is the mistake to avoid, more than any other. Match the tool to **how settled the work
is**, not to how big it is.

| Situation | Tool |
|---|---|
| 2–5 steps, you want to stay in the loop | `omd_primitive` — one control-flow shape, no graph |
| You know the approach, you want it done in parallel | `run` |
| You have a goal, not a plan; you want a verify loop | `solve` |
| You wrote the spec already | `solve` + `sddPath` — no research pass, no planning tax |
| It must survive you closing the session | `solve` + `detached: true` |
| You want the exact graph, node by node | `dag_run_plan` with a hand-written plan |
| The work spans sessions and half of it is undecided | `map_*` |
| You need facts off the web | `dag_research`, or `omd_web` for zero-model retrieval |
| You need a diff reviewed | `dag_review` |
| Something is broken and you don't know why | `dag_debug` |

`run` has no acceptance step. That is not a gap — acceptance binds to a *goal*, and `run` has
only a graph. So reach for `solve` when you want the acceptance loop, a spec, or detachment.
Not for isolation: `branchStrategy` exists on both.

## The dispatch contract: never wait

`run`, `solve`, `dag_research`, `dag_review`, `dag_debug`, `dag_slim`, `dag_deepen` are all
**fire-and-forget**. They register a run and return in under a second:

```
runId: 8437dca5-ee2d-47b3-8e2c-078a3a879842
status: running
```

That return value is a receipt, not a result. Rules:

- **Do not block on it.** Go do other work. Poll `dag_status(runId)` between other tasks.
- **Budget the wait realistically.** A `run` with a handful of nodes: 5–15 minutes. A
  `dag_research` with `rounds: 2`: 15–40 minutes. If you poll every 30 seconds you are wasting
  your own context on identical strings.
- **Poll cheaply.** `dag_status` gives you `nodes: 5 done / 0 failed / 1 running / 2 pending`
  and the layer view `L1 ✔ node_name(agent)`. Read the counts, not the prose.
- **Then fetch narrowly.** `dag_result` for the whole thing, `dag_node_output` for one node's
  artifact. Do not pull a 130k-character report into your context because you wanted one number.
- A dropped connection does not kill the run. Neither does your session ending, if you passed
  `detached: true`.

## Write the task so a gate exists

The single highest-leverage thing you control is the task text. A task with no checkable finish
line gets you prose about success. A task with one gets you a verdict.

Say the finish line as a command:

> "…Prove it: `bun test src/model` must exit 0."

That makes the conductor emit a `command` node with `expect_exit: 0` — zero LLM, cannot be
talked into passing. Also worth doing:

- **Name the files you already know about.** Every path you supply is a search the fleet skips.
- **Declare the artifact** when a node must produce a file. The artifact gate checks the disk,
  not the claim.
- **Make the criterion red today.** A test that already passes turns the run into an expensive
  no-op, and the acceptance probes will demote the goal for exactly that reason.

## Per-node model control — this is the part people miss

Every node can name its own model, and **an explicitly set model is never overwritten**
(`src/harness/plan-passes/stamp-pass.ts:66`). The full precedence is
`node.model` > `template.model` > router/static (`src/harness/agent-templates.ts:21`, TPL-3).

So you are not limited to the pipelines that ship. Hand `dag_run_plan` a plan you wrote:

```jsonc
{
  "nodes": {
    "draft_a":  { "goal": "…", "executor": "leaf",    "model": "deepseek:deepseek-v4-pro" },
    "draft_b":  { "goal": "…", "executor": "leaf",    "model": "minimax-cn:MiniMax-M3" },
    "critique": { "goal": "…", "executor": "leaf",    "model": "openai-codex:gpt-5.6-sol",
                  "depends_on": ["draft_a", "draft_b"] },
    "gate":     { "goal": "run the suite", "executor": "command",
                  "command": "bun test", "expect_exit": 0, "depends_on": ["critique"] }
  },
  "outputs": ["gate"]
}
```

That is a cross-family best-of-N with a deterministic gate on the end, and you chose every seat
in it. `omd_primitive` takes a `model` coordinate the same way for a single shape.

**Why this matters more than it sounds.** A skill in your own harness is a prompt: it can only
ask *you* to behave differently. A pipeline in omd picks different models for different jobs —
cheap ones for volume, a different family for the critique so it does not share the author's
blind spots, zero-LLM commands for the verdict. That is a capability a prompt cannot have.

Check what is reachable before you pin anything: `omd_config_status` prints every seat, its
bound model, and whether that provider's credential is actually present.

## The pipelines that ship

These are not prompt wrappers. Each is a graph with its own shape, its own seat assignment, and
its own gates — you invoke one instead of building it.

| Skill | What the graph does |
|---|---|
| `/omd-grill` | adversarial interrogation of a plan before it is locked; opens a council at wide forks |
| `/omd-contract` | crystallises the argument into a spec on disk — then feed it to `solve` via `sddPath` |
| `/omd-execute` | spec → DAG → cross-check → four-way acceptance |
| `/omd-research-deep` | seeded multi-angle crawl → council decomposition → multi-round gap-filling |
| `/omd-council` | multi-persona deliberation with a judge panel over a hard call |
| `/omd-review` | multi-dimension diff review with cross-model falsification of every finding |
| `/omd-debug` | reproduce → scope lock → parallel hypotheses → verify |
| `/omd-slim` | deletion-only over-engineering audit |
| `/omd-path` · `/omd-tickets` · `/omd-rule` · `/omd-deliver` | the decision-map loop |

The grill → contract → `solve --sddPath` path is the one worth learning first. Argue the design
out with the human, write it down, then hand the written thing to the engine — because a spec
compiles to a flat graph with no research pass and no re-planning, and the acceptance command
becomes the only stop rule.

## Gates you will hit, and what they mean

- **`BLOCKED 沙箱越界`** — a write outside the allowed root, or a command off the whitelist.
  **Do not retry.** Retrying never changes a whitelist. Use a legal command, or escalate to the
  human to change the boundary.
- **Oracle red** (`expect_exit` mismatch) — the work is not done. No amount of explanation
  changes this. Fix the work.
- **Write-set mismatch / artifact missing** — a node claimed a file it did not write. Treat the
  node's own summary as unreliable from that point.
- **Verifier fail** — a different model family read the result against the original requirement
  and rejected it. This triggers escalation and a re-plan automatically; the rejected nodes and
  their downstream re-run, the rest is reused.
- **Fan-in truncation** — when too much upstream text flows into one node, the engine caps it,
  keeps quotations and cuts narrative. If a node genuinely needs everything, do not fan twenty
  large outputs into it; reduce in stages.
- **Run-board warning** — other runs are sharing this working tree. It only reports. Two runs
  writing the same files is your problem: pass `branchStrategy: 'branch'`.

## Rules

- **Isolate anything unattended or web-facing.** `branchStrategy: 'branch'` gives the run its
  own worktree and a jail. The engine never merges it back — read the diff, then merge.
- **Never pull a full report into context.** Research writes to disk and returns an index. Keep
  it that way; fetch the one section you need.
- **`map_deliver` and `map_rule` are the human's.** You may research, plan, fan out and argue on
  your own. You may not decide to start writing files.
- **A resumable failure is not a restart.** `dag_resume` reloads the plan from the checkpoint and
  skips every node whose inputs are unchanged. Re-dispatching from scratch re-bills work that
  was already green.
- **Report the readout, not the vibe.** Exit codes, node counts, the verifier's verdict. If a
  gate went red, say which one.
