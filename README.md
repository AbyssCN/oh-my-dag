<div align="center">

# oh-my-dag

### The orchestration layer under your coding agent.

*Your agent says "I'm done." omd doesn't ask — it runs the work as a typed graph, picks a model per node, and takes the verdict from outside the model.*

<img src="assets/diagrams/omd-layers.svg" alt="Where omd sits: the session layer on top, omd underneath behind an MCP boundary, memory and models below" width="920">

[![MCP server: 50 tools](https://img.shields.io/badge/MCP%20server-50%20tools-c9a227?style=flat-square&labelColor=140f0a)](docs/guide/mcp-tools.md)
[![Clients: Claude Code · Codex · any MCP](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20MCP-6f9488?style=flat-square&labelColor=140f0a)](client-skills/)
[![Models: bring your own](https://img.shields.io/badge/models-bring%20your%20own-b3382a?style=flat-square&labelColor=140f0a)](docs/architecture/model-layer.md)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)

**English** · [中文](README.zh-CN.md) · **[Why omd exists →](docs/why-omd.md)** · **[Give this to your agent →](docs/driving-omd.md)**

</div>

You close the tab. The model said *all changes applied*. `git diff` says the file is untouched.

omd never reads that sentence. It reads an exit code.

You keep Claude Code, Codex, gemini-cli or opencode. omd is what they call over MCP when the work is bigger than one conversation.

## Where omd sits

Every open-source coding harness of 2026 — codex, gemini-cli, qwen-code, opencode, kimi-code, deepseek-harness, oh-my-pi — is a **session-layer** tool. The unit of work is a turn. The loop is ReAct: sample, run tools, feed the result back. They compete on context compaction, sandbox depth, event sourcing. They compete well.

They also share one assumption: **whether the work is correct is something the model reports.**

They can't do otherwise. The forward pass that produced the work is the one assessing it — same context, same beliefs. Without stepping outside the session there is nowhere else for a verdict to come from.

omd steps outside it. The unit of work is a **node**. The verdict comes from **code**.

|  | Session-layer harness | Workflow engine<br>(LangGraph, Temporal) | Eval & gate framework<br>(Inspect, promptfoo) | **omd** |
|---|---|---|---|---|
| **Unit of work** | a turn | a step you wrote | a scored sample | **a node in a typed graph** |
| **Where the graph comes from** | no graph — a ReAct loop | you write it | no graph | **a conductor, an SDD contract, a decision map, or your own hand** |
| **Who decides it's correct** | the model | your assertion | your rubric | **oracle → cross-family verifier → human. In that order** |
| **Which model runs it** | the one you launched | the one you configured | n/a | **one per node, and a model you pin by hand is never overwritten** |
| **When it breaks mid-run** | session ends, re-prompt | retry per your policy | graded and over | **per-node checkpoints; resume re-bills only what changed** |
| **How you invoke it** | you chat with it | you embed it | you call it from CI | **`claude mcp add omd -- omd mcp`** |

**The overlap is real.** LangGraph and Temporal run graphs. Eval frameworks run gates. Neither is a new idea. What is combined here: a typed plan as the interchange format, gates inside the run that produced the artifact rather than afterwards on a trace, a verifier from another model family, per-node resume, and an MCP surface so any harness drives all of it.

**What omd is not:**

- **Not a coding CLI.** Keep the harness you have.
- **Not a chat agent.** Its unit is a node, not a conversation.
- **Not an eval framework.** You don't ship it traces.
- **Not a vendor product.** MIT, TypeScript on Bun, any OpenAI-compatible model.

**→ [The long version](docs/why-omd.md)**

## Install

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link      # puts `omd` on your PATH (Bun ≥ 1.3)
omd init                     # wizard: keys, model presets, reachability probe → .env
```

```bash
cd <your-project> && claude mcp add omd -- omd mcp
```

Not on npm yet, so the clone is the install. The server's working directory *is* the repo it operates on. First start installs 22 skills into `~/.claude/skills/`, idempotently, never overwriting one you edited (`OMD_INSTALL_SKILLS=0` opts out).

Then tell your agent:

> Read `docs/driving-omd.md`, then use omd to …

**[docs/driving-omd.md](docs/driving-omd.md)** is written for the agent, not for you — which tool for which job, why it must never block on a `runId`, how to phrase a task so a gate exists, and the failure modes it will hit. **[Full walkthrough for humans](docs/guide/getting-started.md)**.

## The verdict comes from outside the model

<div align="center">
<img src="assets/diagrams/omd-pipeline-contract.svg" alt="The contract pipeline: grill, contract, a zero-LLM compile, execute, verdict" width="960">
</div>

A model asked to judge its own work can stop running entirely without anything turning red. So rung ① has no model in it. A `command` node runs `tsc`, the suite, or your script; the exit code must equal `expect_exit`. Beside it: write-set reconciliation — did it write what it claims — and artifact gates — is the file on disk. A node that reports a file it never wrote fails.

**The criterion sits an exam before it is trusted.** This is the part worth reading twice. The engine runs the proposed acceptance command twice in a throwaway world: once **before any work exists** — still green means it has nothing to do with this task — and once against a **deliberately wrong artifact** the classifier had to supply alongside it — still green means it can't tell right from wrong. Either way the goal is demoted to exploratory instead of collecting a fake pass. Both probes are fail-open: a probe that can't run marks the criterion unproven rather than blocking the run. `src/harness/goal/acceptance-gate.ts`.

When no oracle can judge semantics, rung ② is a verifier from a **different model family**. Same family, same blind spots. Its job is to attack the result, not stamp it. Fail escalates: stronger conductor, re-plan, only the rejected nodes re-run. `src/harness/verifier.ts`.

⚠ **Oracle-green is not semantically right.** This engine once shipped `tsc` clean and the full suite passing, with a status mapping labelled backwards and the test freezing the mistake in place. A test and its implementation from the same change can be wrong together and endorse each other. Rung ① cannot catch that. Rung ③ is a human.

> **Reliability comes from outside the model. Creativity comes from inside it.**
> Gates judge — deterministic, zero-model, fail-closed. Models generate — what to do, how, what's missing. Inside the gates, don't replace that with rules.

## Where a graph comes from

Four sources. The engine only checks that the plan validates.

| Source | What it costs |
|---|---|
| **A conductor draws it** | one LLM call. `run` and `solve` do this |
| **An SDD contract compiles to it** | **zero LLM.** Flat graph, no research pass, no re-planning |
| **A decision map compiles to it** | **zero LLM.** Ruled tickets plus their edges are already a graph |
| **You write it** | zero LLM, total control |

The **contract lane** is the one worth learning. `/omd-grill` interrogates the design until the open questions are named. `/omd-contract` writes it down as a spec. Then `solve(sddPath: …)` compiles that spec straight to a flat graph — and the acceptance command becomes the only stop rule. The spec is not a prompt: it carries the decomposition, the gates, and the verify column, so the engine has nothing left to guess.

One precondition, and it is real: the spec's verify column must point at something **red today**. A spec whose tests already pass turns the run into an expensive no-op.

The **map lane** is for work that outlives sessions. Ambiguity becomes typed tickets in git, you rule on them, and a ruled region compiles and runs. `map_deliver` is a trigger **you** pull. Automation may research, fetch, plan and argue. It may not decide to start writing.

## Build your own pipeline

Every node can name its own model, and **an explicitly pinned model is never overwritten**. The precedence is `node.model` > `template.model` > auto-assign (`src/harness/plan-passes/stamp-pass.ts:66`).

So hand `dag_run_plan` a graph you wrote:

```jsonc
{
  "nodes": {
    "draft_a":  { "goal": "…", "executor": "leaf", "model": "deepseek:deepseek-v4-pro" },
    "draft_b":  { "goal": "…", "executor": "leaf", "model": "minimax-cn:MiniMax-M3" },
    "critique": { "goal": "…", "executor": "leaf", "model": "openai-codex:gpt-5.6-sol",
                  "depends_on": ["draft_a", "draft_b"] },
    "gate":     { "goal": "run the suite", "executor": "command",
                  "command": "bun test", "expect_exit": 0, "depends_on": ["critique"] }
  },
  "outputs": ["gate"]
}
```

That is a cross-family best-of-N with a deterministic gate on the end, and you chose every seat in it. `omd_primitive` takes a `model` the same way for a single shape.

**This is why a shipped pipeline beats a skill.** A skill is a prompt: it can only ask the model in front of you to behave differently. A pipeline picks cheap models for volume, a different family for the critique so it doesn't inherit the author's blind spots, and a zero-LLM command for the verdict. A prompt cannot do that.

## What ships with it

<div align="center">
<img src="assets/diagrams/omd-pipeline-research.svg" alt="The deep-research pipeline: four stages, four models, and a fetch step with no model in it" width="960">
</div>

22 methodology skills, and each is a graph rather than a prompt. They install into `~/.claude/skills/` on first start. An `agent` leaf **inside** a graph gets the same set through the same tool, so a method you wrote once applies forty levels into a fan-out.

| | |
|---|---|
| `/omd-grill` → `/omd-contract` | argue the design, then write the contract the engine executes |
| `/omd-research-deep` | seeded multi-angle crawl → council decomposition → multi-round gap-filling |
| `/omd-council` | multi-persona deliberation with a judge panel |
| `/omd-review` | multi-dimension diff review, every finding falsified cross-model |
| `/omd-debug` | reproduce → scope lock → parallel hypotheses → verify |
| `/omd-path` · `/omd-rule` · `/omd-deliver` | the decision-map loop |

Control flow belongs to the runtime, never the model. You pick the shape — `parallel`, `pipeline`, `loop-until`, `verify`, `judge`, `discovery`, `iterate`, `tournament`, `router`, `race`, `escalation`, `saga` — and the loop, branch, stop and scoring stay in code. A thirteenth, `escape-hatch`, is off unless you set `OMD_ESCAPE_HATCH=1`.

Work routes to **18 seats**. A seat is a *model-selection axis*, not a role, so unrelated calls can share one. Auto-assign fills them by channel economics: strong where being wrong is expensive and rare, cheap where volume is high and an oracle catches the mistake. `src/model/seats.ts`.

**→ [All 50 tools](docs/guide/mcp-tools.md)** · [the skills in full](docs/guide/skills.md)

## Measured, not asserted

Same question — a mid-2026 MCP ecosystem review — two configurations of our own:

| | **omd `--deep`, cheap seats** | **106-agent frontier workflow** |
|---|---|---|
| Cash cost | **$2.19** | subscription quota · 3.76M tokens |
| Result | 132k-char report · 32 sources | 23 claims, verified 3-of-3 |
| Finished? | ran clean to the end | hit the quota mid-verify |

The cheap run reproduced **13 of the 15** facts the frontier run had verified. Not because small models are secretly frontier-grade. Because fact coverage is decided by retrieval, and retrieval is the part with no model in it. `omd_web` searches and fetches with **zero model in the loop**: full text to disk, only an index back, gaps closed by re-crawling rather than by a model filling them in.

Engine test suite: **6812 passing, 0 failing, 590 files** (`bun test`).

**→ [The full A/B](docs/guide/deep-research.md)** · [sample output](docs/examples/deep-research-mcp-2026.md)

## Docs

| | | |
|---|---|---|
| **For your agent** | [driving omd](docs/driving-omd.md) | which tool for which job, the dispatch contract, the gates it will hit |
| **Why** | [why omd exists](docs/why-omd.md) | the layer argument, and what a session harness structurally cannot do |
| **How to use** | [getting started](docs/guide/getting-started.md) · [workflow](docs/guide/workflow.md) · [MCP tools](docs/guide/mcp-tools.md) · [model config](docs/guide/model-config.md) · [skills](docs/guide/skills.md) · [deep research](docs/guide/deep-research.md) · [TUI](docs/guide/tui.md) | install, connect, and the reference surface |
| **Why this shape** | [architecture](docs/architecture/overview.md) · [DAG engine](docs/architecture/dag-engine.md) · [goal loop](docs/architecture/goal-loop.md) · [model layer](docs/architecture/model-layer.md) · [primitives](docs/architecture/primitives.md) · [open ecosystem](docs/architecture/open-ecosystem.md) | node kinds, the four pure passes, scheduling, isolation, seats |
| **What went wrong before** | [silent failures](docs/silent-failures.md) | every defect family this engine shipped with no red light |

## License

MIT — see [LICENSE](LICENSE).
