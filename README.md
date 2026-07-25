<div align="center">

# oh-my-dag

### A DAG execution engine, persistent decision maps, and self-consolidating memory for your coding agent — over MCP.

*Your agent stays the brain. omd brings the cheap concurrent hands.*

[![MCP server: 30 tools](https://img.shields.io/badge/MCP%20server-30%20tools-c9a227?style=flat-square&labelColor=140f0a)](docs/mcp-tools.md)
[![Clients: Claude Code · Codex · any MCP](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20MCP-6f9488?style=flat-square&labelColor=140f0a)](client-skills/)
[![Models: bring your own](https://img.shields.io/badge/models-bring%20your%20own-b3382a?style=flat-square&labelColor=140f0a)](docs/model-layer.md)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)

**English** · [中文](README.zh-CN.md) · **[Get started →](docs/MCP-ONBOARDING.md)**

</div>

<img src="docs/assets/engine-architecture.svg" alt="omd engine architecture: plan phase, execution phase, feedback phase, and the model layer" width="100%">

## What it is

Your coding agent is a strong, expensive brain. Using it to *type out* every file and
run every test is the wrong job for the smartest thing in the room.

**omd turns one task into a graph of small jobs**, runs them concurrently on cheap
models you bring, checks the result with an objective gate and a skeptic from a
different model family, and spends a frontier model only where judgement actually
happens. It mounts into any client as `omd mcp` — a stdio MCP server, 30 tools.

Three capabilities on one engine:

- **DAG execution** — a task becomes typed nodes: `agent` leaves that really write
  files, `command` leaves that run `tsc`/tests with zero LLM, `map` nodes that fan out
  at runtime, `primitive` nodes for control flow. Nodes run the moment their deps
  settle; every node is checkpointed, so an interrupted run resumes instead of restarting.
- **Pathfinder** — planning for work too big for one session: a decision map in git,
  advanced by typed tickets, with background research that outlives your client and a
  delivery gate only you fire.
- **Self-consolidating memory** — a per-project fact store with hybrid semantic +
  lexical recall and a temporal knowledge graph, folding raw session events into
  layered facts.

## Quick start

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link      # puts `omd` on your PATH (Bun ≥ 1.3)
omd init                     # wizard: keys, model presets, reachability probe → .env
```

```bash
cd <your-project> && claude mcp add omd -- omd mcp
```

The slash-command pack (`/omd-path`, `/omd-review`, … 20 skills) installs itself into
`~/.claude/skills/` on first server start — idempotent, never overwrites a skill you
edited. Opt out with `OMD_INSTALL_SKILLS=0`.

**→ [Full walkthrough](docs/MCP-ONBOARDING.md)** · [command reference](client-skills/README.md)

<details>
<summary>Alternative front-end: the bundled terminal agent</summary>

`bun run omd` (interactive) or `bun run omd -p "..."` (one-shot); configure with
`OMD_RUNTIME_PROVIDER` + `OMD_RUNTIME_MODEL` + your backend key in `.env`
(copy [.env.example](.env.example)). The MCP server is the primary door; this is a convenience.

</details>

## The engine in one screen

A task is planned **once** by an LLM, then transformed by **pure functions**, then
executed by dependency order. Everything after the conductor is deterministic.

**Node kinds** — what a node can be:

| Kind | Model? | Tools? | Use for |
|---|---|---|---|
| `leaf` | one shot | no | generation, research, judgement, drafting |
| `agent` | yes | read/edit/write/bash, in a bwrap jail | **the only kind that writes files** |
| `command` | **none** | a CLI from an allowlist | gates (`tsc`/tests), scanners, indexed lookups |
| `map` | mixed | — | runtime fan-out: a lister discovers the work-list, one child per item |
| `primitive` | mixed | — | 12 control-flow shapes the engine owns |

**Plan passes** — pure functions between the plan and execution:
`prune` (drop dead nodes) → `dedup` (semantic-key merge) → `evidence` (UI pixel-chain
gate) → `stamp` (pin a model on every node).

**Control-flow primitives** — you pick the shape and its params; the loop / branch /
stop / scoring logic belongs to the runtime, never to the model:
`parallel` · `pipeline` · `loop-until` · `verify` · `judge` · `discovery` · `iterate` ·
`tournament` · `router` · `race` · `escalation` · `saga`.

**→ Details:** [architecture](docs/architecture.md) · [primitives](docs/primitives.md) ·
[model layer](docs/model-layer.md) · [MCP tools](docs/mcp-tools.md) · [memory](docs/memory.md)

## Why it's worth wiring in

| | |
|---|---|
| **Cheap concurrency** | Width, not a bigger model. A dozen small-model leaves run in parallel for the price of one frontier call. |
| **Frontier judges, fleet executes** | You pay for quality at the decision points and the verify step — not on every node. |
| **Never loses state** | Every node's output is hashed to a checkpoint. A 429, a crash, a closed laptop — the graph resumes at the first unfinished node. |
| **Memory across sessions** | Decisions and gotchas survive the context window; recall is one call away. |
| **Any client, any model** | MCP in, OpenAI-compatible backends out. No vendor lock. |

## Design rules

- **Contracts over prose.** Every seam is a typed schema; a plan that fails validation
  never runs.
- **The model is not the reliability layer.** Gates, verifiers and deterministic passes
  live outside the model — a stronger model makes them cheaper, not redundant.
- **Fail closed at the edges, fail open in the bookkeeping.** Unknown template name
  rejects the plan; a checkpoint that cannot be written only warns.
- **No silent success.** A file-producing node with no file on disk is a failure, not a
  claim taken on trust.

## License

MIT — see [LICENSE](LICENSE).
