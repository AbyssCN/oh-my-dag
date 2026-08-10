# Architecture — how a task becomes a finished graph

[← docs index](../README.md) · [dag engine](dag-engine.md) · [goal loop](goal-loop.md) ·
[model layer](model-layer.md) · [primitives](primitives.md) ·
[open ecosystem](open-ecosystem.md) · [MCP tools](../guide/mcp-tools.md)

**[→ 引擎流转图(Mermaid 真理源 + rationale + changelog)](../diagrams/01-engine-flow.md)**

The shape of the whole system in one sentence: **one LLM call plans, pure functions
transform, dependency order executes, objective gates judge.**

Hand it a plan and `run` executes it. Hand it a *goal* and `solve` wraps that same machine
in a bounded outer sequence: classify what "done" means, write a contract, execute, judge,
re-expand — until a frozen criterion goes green or a stop axis fires.

## Entry — four ways in, four different promises

`src/mcp/tool-renames.ts` is the single source for the layer names; each of the first three
contains the one below it.

| Entry | Promise | Deprecated alias |
|---|---|---|
| `map_*` | slow loop — a decision map, a human present at the frontier | `path_*` |
| `solve` | goal convergence — the engine decides the approach and runs repair rounds | `dag_goal` |
| `run` | the approach is already decided — execute this graph | `dag_run` |
| chat seat | conversation with the conductor itself; it decides whether to answer or draw a graph | — |

The old names are still registered as aliases with identical behaviour (`applyToolRenames`);
they disappear when the table entry is deleted. Renaming happens at the assembly layer, so
~300 in-tree call sites keep the old literals — and the two gates that count the registered
surface (the docs gate and the README badge) import the same table, so they cannot drift
from what is actually registered.

The chat seat has two front ends over one conductor. `conductor_chat`
(`src/mcp/tools/chat.ts`, 2026-08-09) is the MCP one, where Claude drives omd's own
conductor. Two properties are load-bearing:

- **Headless approval mode = read-only hands.** There is no TTY over MCP and nobody to press
  `y`, so auto-approving writes would just remove the gate. The hands are `read` / `ls` /
  `grep` only (`HEADLESS_HANDS`); every write goes through the graph, where a leaf's own
  tools are its gate.
- **Graphs are fire-and-forget.** A turn dispatches and reports the `runId`; it does not poll
  to completion. The caller tracks progress across turns, so a dropped connection does not
  kill the graph.

`omd tui` is the local one — the same conductor behind a terminal client that also makes
seats, providers, runs and sessions editable in place. **⚠ in development / 开发中 ——
界面与命令面仍在快速变化**;用法与键位见 [tui](../guide/tui.md)。

## The rest of this section

| Page | What it answers |
|---|---|
| [dag engine](dag-engine.md) | what a node can be, the four pure passes, ready-set scheduling, fault boundaries, checkpoint & resume, the plan surface, where the code lives |
| [goal loop](goal-loop.md) | `solve`: classification, the frozen acceptance criterion, the re-expanding inner loop, the four stop axes, detached runs |
| [model layer](model-layer.md) | how a model lands on a node: seats, pools, channels, stamp rules, reasoning effort |
| [primitives](primitives.md) | the control-flow shapes the engine owns, and when a plain node is the better answer |
| [open ecosystem](open-ecosystem.md) | external MCP servers and skills on the agent leaf, and the policy gate around them |
| [omd HUD](omd-hud.md) | the live statusLine surface for DAG and pathfinder runs |

## The two halves of the design principle

Everything in this section is one half of a pair. Stating only the first half — which is what
this codebase did for a long time — produces a predictable failure: over-mechanising the model
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
