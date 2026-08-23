# Getting started

[← docs index](../README.md) · [why omd exists](../why-omd.md) ·
[driving omd (for your agent)](../driving-omd.md) · [MCP tools](mcp-tools.md)

Fifteen minutes, start to a finished graph. You need [Bun](https://bun.sh) ≥ 1.3 and one API
key for any OpenAI-compatible provider. Nothing here is vendor-locked.

> **What you are installing.** `omd mcp` is a stdio MCP server. Your coding agent — Claude
> Code, Codex, or any MCP client — stays the thing you talk to; omd becomes the engine it
> hands work to. See [why omd exists](../why-omd.md) if you want the argument before the
> install.

---

## 1 · Install

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install
bun link              # puts `omd` on your PATH
```

Not on npm yet, so the clone is the install.

## 2 · Configure your models

omd bakes in **no model**. Every seat is a `provider:model` coordinate — DeepSeek, Kimi, GLM,
GPT, Qwen, MiMo, MiniMax, or any OpenAI-compatible gateway, mixed freely.

**The wizard is the easy path:**

```bash
omd init
```

It asks for keys, offers three guided presets that fill the whole seat matrix, probes each
provider for reachability, and writes `.env`.

**By hand** — copy [.env.example](../../.env.example); the minimum is a runtime coordinate plus
that provider's credentials:

```bash
OMD_RUNTIME_PROVIDER=deepseek
OMD_RUNTIME_MODEL=deepseek-v4-pro
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Check it took:

```bash
omd mcp &            # or just let your client start it
# then, from your agent:  omd_config_status
```

`omd_config_status` prints every seat, the model bound to it, and whether the credential for
that provider is actually present — the readout is a probe, not a guess. Details and the full
seat matrix: [model config](model-config.md).

## 3 · Wire it into your client

**Claude Code:**

```bash
cd <your-project> && claude mcp add omd -- omd mcp
```

Or drop a `.mcp.json` into the target repo (this repo ships one you can copy):

```jsonc
{
  "mcpServers": {
    "omd": { "command": "omd", "args": ["mcp"] }
  }
}
```

**Codex / any other MCP client:** point it at the same command, `omd mcp`, over stdio.

> **The one rule that catches everyone: the server's working directory is the repo it operates
> on.** Decision maps land in `<repo>/docs/plan/pathfinder/`, runtime state in `<repo>/.omd/`.
> Start it from the project you want it to work on, not from the omd checkout.

**Skills install themselves.** On first start the server copies 22 methodology skills into
`~/.claude/skills/`, idempotently, under an `omd-` prefix so they cannot collide with yours —
and it **never overwrites one you have edited** (it compares a content hash). You get
`/omd-path`, `/omd-review`, `/omd-debug` and the rest in your next session. Opt out with
`OMD_INSTALL_SKILLS=0`. Codex has no skills mechanism — merge the SKILL.md bodies you want
into that repo's `AGENTS.md`. See [skills](skills.md).

## 4 · The three entry layers

Each one contains the next, and each states a different promise. Pick by how settled the work
is, not by how big it is.

| Layer | Use it when | Promise |
|---|---|---|
| `run` | the approach is already decided | execute this graph |
| `solve` | you have a goal, not a plan | converge on the goal, including repair rounds |
| `map_*` | the work spans many sessions and half of it is still unclear | a decision map in git, with a human at the frontier |

There is also `conductor_chat` — a persistent conductor session over MCP, useful when you want
to ask the engine's own planner something rather than hand it a job.

The older names `dag_run`, `dag_goal` and `path_*` still work as deprecated aliases with
identical behaviour. New code should use the new ones.

## 5 · Your first graph

From inside your agent, hand omd something small and checkable:

```
run(task: "Add a `--json` flag to scripts/omd-seats.ts that prints the seat table as JSON.
           Then run `bun run scripts/omd-seats.ts --json | head -3` and it must exit 0.")
```

You get back a `runId` immediately — dispatch is fire-and-forget, so a dropped connection does
not kill the graph:

```
runId: 8437dca5-ee2d-47b3-8e2c-078a3a879842
status: running
```

Poll it:

```
dag_status(runId: "8437dca5-…")
```

```
status: running
nodes: 5 done / 0 failed / 0 skipped / 1 running / 2 pending (共 8)
running: judge_panel(agent, 22s)
```

When it reaches `done`, `dag_result` gives you the full result and `dag_node_output` gives you
one node's artifact. If it fails, `dag_resume` reloads the plan from the on-disk checkpoint and
re-runs only the nodes that are not green.

**→ In practice you will not type any of this yourself — you tell your agent to. Hand it
[driving omd](../driving-omd.md) first.**

## 6 · The invariants worth knowing on day one

- **The owner holds the trigger.** Research runs itself and tickets expand themselves, but
  `map_rule` and `map_deliver` fire only on your explicit word. Automation never starts writing
  files on its own.
- **Everything true is on disk.** Maps in git, runtime state and checkpoints in `.omd/`. Crash
  the server, switch clients, resume freely — there is nothing to lose in memory.
- **Spend is bounded.** Fan-out is capped, background research obeys a budget counted across
  sessions on disk, and escalation to a stronger model triggers only after a failed verify.
- **Isolate anything unattended.** For background runs and anything that fetches the open web,
  pass `branchStrategy: 'branch'` — an isolated git worktree plus a jail. The engine never
  merges that branch back; you do.

## Where to go next

| | |
|---|---|
| Let your agent drive it | [driving omd](../driving-omd.md) — written for the agent, not for you |
| Understand why this layer exists | [why omd exists](../why-omd.md) |
| Every tool and its arguments | [MCP tools](mcp-tools.md) |
| Which door for which job | [workflow](workflow.md) |
| Seats, presets, per-seat pins | [model config](model-config.md) |
| How the engine is built | [architecture overview](../architecture/overview.md) |
