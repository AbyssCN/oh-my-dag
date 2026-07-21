<div align="center">

# oh-my-dag

### A DAG execution engine, persistent decision maps, and self-consolidating memory for your coding agent — served over MCP.

*Your agent stays the smart brain. omd brings the cheap concurrent hands*
*and the memory that doesn't forget.*

[![MCP server: 19 tools](https://img.shields.io/badge/MCP%20server-19%20tools-c9a227?style=flat-square&labelColor=140f0a)](docs/MCP-ONBOARDING.md)
[![Clients: Claude Code · Codex · any MCP](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20MCP-6f9488?style=flat-square&labelColor=140f0a)](client-skills/)
[![Models: bring your own](https://img.shields.io/badge/models-bring%20your%20own-b3382a?style=flat-square&labelColor=140f0a)](.env.example)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)

**[Get started →](docs/MCP-ONBOARDING.md)** · **English** · [中文](#中文)

</div>

---

## What this is

Your coding agent — Claude Code, Codex, any MCP client — is a strong, expensive
brain. Using it to *type out* every file, run every test, and hold every plan in
its head is the wrong job for the smartest thing in the room.

**oh-my-dag (omd) is the rest of the car.** It turns one task into a graph of small
jobs, runs them concurrently on cheap models you bring, verifies the result with a
skeptic from a different model family, and only spends a frontier model when a check
actually fails. Your agent decides *what* to do and *judges* the outcome; the fleet
does the typing. It plugs into any client as **`omd mcp`** — a stdio MCP server
exposing 19 tools — so nothing about your existing setup changes.

Three things it gives your agent, all built on one DAG engine:

- **A DAG execution engine.** A task becomes a typed node graph: `agent` leaves that
  really write files, `command` leaves that run `tsc`/tests, `map` nodes that fan out
  at runtime, `primitive` nodes for control flow. Nodes run the moment their
  dependencies settle, each is its own fault boundary, and every graph is checkpointed
  so an interrupted run resumes instead of restarting.
- **Pathfinder.** Planning for work too big for one session — a persistent decision
  map committed to git, advanced by typed tickets, with background research that keeps
  running after you close the client and an explicit delivery gate you alone fire.
- **Self-consolidating memory.** A per-project fact store with hybrid semantic +
  lexical recall and a temporal knowledge graph, that folds raw session events into
  layered facts so the next session starts knowing what the last one learned.

> The model is the engine. This is the rest of the car.

### Why it's worth wiring in

| | |
|---|---|
| **Cheap concurrency** | Width, not a bigger model, does the work. A dozen small-model leaves run in parallel for the price of one frontier call. |
| **Frontier judges, fleet executes** | You pay for quality only where it matters — the verify step and, on failure, one escalation — not on every node. |
| **Never loses state** | Every node's output is hashed to a checkpoint. A 429, a crash, a closed laptop — the graph resumes from the first unfinished node. |
| **Memory across sessions** | Decisions, findings, and gotchas survive the context window; recall is one call away. |
| **Any client, any model** | MCP in, OpenAI-compatible backends out. No vendor lock, no framework rewrite. |

## Quick start (MCP — recommended)

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link      # puts `omd` on your PATH (Bun ≥ 1.3)
omd init                     # wizard: keys, model presets, reachability probe → .env
```

Wire it into Claude Code from the repo you want to work on (the server's cwd is the
repo it operates on):

```bash
cd <your-project> && claude mcp add omd -- omd mcp
# or drop a .mcp.json (this repo ships a template) for a zero-command project mount
```

The slash-command pack (`/omd-path`, `/omd-deepen`, `/omd-review`, … 16 skills that teach
your agent the workflows) **installs itself** into `~/.claude/skills/` the first time the
`omd mcp` server starts — no manual copy. It is idempotent, updates on package upgrade, and
**never overwrites a skill you have edited**. New skills appear on your next Claude session.
Opt out with `OMD_INSTALL_SKILLS=0`.

**→ Full walkthrough: [docs/MCP-ONBOARDING.md](docs/MCP-ONBOARDING.md)** ·
command reference: [client-skills/README.md](client-skills/README.md)

<details>
<summary><b>Alternative front-end: the bundled terminal agent</b></summary>

An interactive terminal agent ships in the box for when you want omd without an
external client. `bun run omd` (interactive) or `bun run omd -p "..."` (one-shot);
configure with `OMD_RUNTIME_PROVIDER` + `OMD_RUNTIME_MODEL` + your backend key in
`.env` (copy [.env.example](.env.example)). The MCP server above is the primary door;
this is a convenience.

</details>

## How you work with it

Three lanes, by task size. Everything below is driven from your client — plain chat,
or the slash commands from the [client-skills](client-skills/) pack.

**1 · Plain chat** — most work. Your agent's own hands, with omd's memory
(`memory_recall` / `memory_remember`) carrying facts across sessions so you don't
re-explain the project every morning.

**2 · Spec → graph (`/sdd` → `/execute`)** — for work worth planning first.
Deliberate in chat — `/grill` interrogates the idea, `/note` collects decisions,
`/council` runs a judged multi-persona debate — then:

```
/sdd            # crystallize the conversation into a spec on disk (docs/plan/)
/execute        # dag_run: a conductor decomposes the spec into a typed DAG; the fleet runs it
```

The run is three-phase async (`dag_status` / `dag_result`) — dispatch and keep
talking. Your agent then **actively accepts** the result against the spec and picks
one of four moves: accept · redraw with failure notes · `/iterate` to a fixpoint ·
fix directly.

**3 · Pathfinder (`/path`)** — for big, foggy, multi-session work. A **persistent
decision map** (markdown in git: `docs/plan/pathfinder/<dest>.md`). The frontier
advances as typed tickets:

| Ticket | How it runs |
|---|---|
| `grill` | interactive deliberation with you; decisions land on the map via `/rule` |
| `research` | detached background fleet — keeps running after you close the client; results self-expand child tickets, on a budget |
| `prototype` | disposable spike in an isolated git worktree |
| `task` | build ticket; its ruling becomes the executable node goal |

`/tickets` pulls landed research and shows the frontier, `/rule` adjudicates, and
once a zone's fog clears **`/deliver`** — the explicit power gate — compiles it into a
slice and runs it: zero planning calls, agent nodes write real files, marked
delivered only when every node is done.

## The two surfaces

Everything omd does is reachable two ways, and they are the *same* thing seen from two
sides. The **MCP tools** are the engine's raw API. The **slash commands** are thin
workflow wrappers your agent invokes — each one calls the MCP tool named beside it and
adds the discipline (when to escalate, how to accept, who holds the trigger).

### MCP tools — the engine (19 tools, three groups)

**Engine** — delegate work to the cheap fleet:

| Tool | What it does |
|---|---|
| `dag_run` | task → conductor decomposes into a typed DAG → concurrent execution (agent leaves really write files, command leaves run tsc/tests) |
| `dag_run_plan` | skip the conductor: execute a pre-built plan JSON directly; `resume=<runId>` skips checkpointed done nodes |
| `dag_status` · `dag_result` · `dag_node_output` | three-phase async: dispatch, keep chatting, poll, fetch artifacts |
| `dag_runs` | list runs — memory registry merged with on-disk checkpoints; optional status filter |
| `dag_research` | multi-lens parallel research + judged synthesis; full report on disk, summary into context |
| `dag_review` | adversarial multi-dimension diff review fleet, async — gate `G0`–`G3`, `scope` paths |
| `dag_slim` | over-engineering, deletion-only audit fleet, async |
| `dag_deepen` | architecture-deepening scan: git-hotspot discovery → one agent per hotspot → leverage-ranked HTML report |

**Pathfinder** — persistent planning for foggy, multi-session work:

| Tool | What it does |
|---|---|
| `path_map` | list / create / resume decision maps |
| `path_add` | add typed tickets (research / grill / prototype / task) with dependency edges |
| `path_tickets` | show the frontier; folds in landed background results first |
| `path_rule` | adjudicate a decision onto the map (owner's call) |
| `path_deliver` | **the power gate**: compile the clear region to a slice, run the DAG, mark delivered only on full success |
| `path_prefetch` | dispatch frontier research to detached background processes that outlive the client |

**Memory** — persistence across sessions:

| Tool | What it does |
|---|---|
| `memory_recall` | hybrid semantic + lexical search over the fact store; ranked hits with confidence and source |
| `memory_remember` | store a fact, gated by namespace safeguards (rejects secrets / banned / out-of-namespace) |
| `dream_consolidate` | one synchronous consolidation round folding the recent event window into L0–L6 layers |

### Claude slash commands (the [client-skills](client-skills/) pack)

Copy into `~/.claude/skills/` (Codex: merge into `AGENTS.md`). Each wraps the MCP
tool(s) in the right column and adds the workflow discipline.

| Command | Wraps | What it adds |
|---|---|---|
| `/path` | `path_map` · `path_add` | open or resume a decision map, break a goal into tickets |
| `/tickets` | `path_tickets` · `path_prefetch` | show the frontier, pull landed research, dispatch background work |
| `/rule` | `path_rule` | adjudicate a decision onto the map — owner's explicit call |
| `/deliver` | `path_deliver` | the delivery gate: compile the clear zone and run it |
| `/sdd` | writes spec to `docs/plan/` | crystallize the conversation into a spec on disk before building |
| `/execute` | `dag_run` → `dag_status`/`dag_result` | run a spec as a DAG, then actively accept the result against it |
| `/iterate` | `dag_run` (fixpoint loop) | re-run to convergence — your agent is the judge |
| `/grill` | deliberation → `path_rule` | interrogate an idea before it's locked; land the ruling |
| `/note` | `path_add` · `path_rule` | a decision ledger for the conversation |
| `/council` | `dag_research` (--council) | judged multi-persona debate over a hard call |
| `/audit` | `dag_run` (security lenses) | multi-lens security audit as a DAG |
| `/sast` | semgrep (local) | deterministic static scan, no LLM |
| `/review` | `dag_review` | adversarial diff-review fleet, gate G0–G3 |
| `/slim` | `dag_slim` | deletion-only over-engineering audit |
| `/deepen` | `dag_deepen` | architecture-hotspot scan → leverage-ranked report |
| `/dream` | `dream_consolidate` | fold recent events into layered memory |

## The DAG engine

Why a graph and not a script: a script is a straight line, and a straight line waits
for its slowest step. A graph runs everything whose inputs are ready, isolates
failures to single nodes, and lets you throw *width* — many cheap models at once — at
work a single model would grind through serially.

```
task ──▶ plan producer ──▶ ConductorPlan { nodes, deps }   ← the Zod-validated seam
                                          │
                            ready-set concurrent scheduling
              ┌───────────┬───────────┼───────────┬───────────┐
          command       leaf        agent        map       primitive
          (CLI, no    (single-shot (tool-using (runtime   (control-flow
           LLM)        LLM call)   sub-agent)   fan-out)    menu, schema-locked)
              └───────────┴───────────┼───────────┴───────────┘
                               cross-model verifier (skeptic)
                                          │
                          pass ◀──────────┴──────────▶ fail → escalate & re-plan
```

`ConductorPlan` is a seam — execution never cares where the graph came from. Plans
arrive three ways: the **runtime model** (`/sdd` → `/execute`), a **compiler with zero
LLM calls** (pathfinder slices, `dag_deepen`, `dag_slim`), or an **explicit planning
call** through the engine API (any model; also the escalation path).

**Why you'd use it:**

- **Multi-model, economical fan-out.** Every node names its own model. Cheap models do
  the bulk work concurrently; `warmThenFanout` fires one call first so the shared
  frozen prompt prefix is cached before the storm, and per-provider concurrency caps
  keep you inside rate limits. Overhead is **per-graph, not per-node**: a 5-node graph
  costs the node work + 2 LLM calls (planning + verifier), +1 with the verifier off,
  and **+0** for compiled plans.
- **Ready-set scheduling.** A node starts the moment its own dependencies settle;
  it never waits for the slowest sibling.
- **One node, one fault boundary.** A failed node becomes a `[failed]` input
  downstream; its siblings keep running. No single failure takes the graph down.
- **File honesty.** File-producing nodes are forced onto the tool-using path and their
  artifacts are existence-checked — "done" without files on disk is a failure, not a
  claim taken on trust.
- **Verify, then maybe escalate.** A skeptic from a *different model family* attacks
  the result requirement-by-requirement, defaulting to fail on doubt. Only a failed
  verify triggers a re-plan on a stronger model — and only if you configured one.

### Resume: a run that breaks doesn't start over

Long fan-outs meet rate limits, network blips, and closed laptops. omd treats an
interrupted run as **paused**, not lost.

- Every node's output is written atomically (tmp + rename) to a checkpoint under
  `.omd/continuity/<runId>/`, keyed by a hash of its inputs.
- On resume — `dag_run_plan resume=<runId>`, or find the run with `dag_runs` — the
  engine replays the checkpoint: any node whose inputs still hash the same is **green
  and skipped**; execution picks up at the first node that never settled.
- Checkpointing is **fail-open** — if writing a checkpoint ever fails, the run warns
  and continues rather than aborting. You never lose progress *and* you never wedge on
  the bookkeeping.

So a 40-node graph that dies at node 31 on a 429 comes back and runs nodes 31–40, not
1–40. `continuity` (artifact-hashed checkpoints) plus SQLite run recording mean any
client can pick up a run another one started.

### The plan surface (what a node can say)

| Field | Controls |
|---|---|
| `executor` | `leaf` / `agent` / `command` / `map` |
| `goal` · `depends_on` | the node's contract · real data edges only |
| `template` · `persona` | a frozen role card by name · the task-specific angle |
| `model` | per-node pin — beats card model, bandit router, static config |
| `map` | `lister` discovers the work-list at runtime → one child per item, resumable ids, bounded |
| `kind: primitive` | `parallel` `pipeline` `loop-until` `verify` `judge` `discovery` `iterate` `tournament` `router` `race` `escalation` `saga` — schema-validated, unit-capped, fail-closed |
| `postcondition` | `structural` / `code` / `llm-judge` / `human` |
| `output_type` · `output_path` | drives the file-producer guard |
| `on_failure` · `max_retry` | `retry` / `complete-then-retry` / `escalate` / `pause` |

Run-level knobs: `maxFanout` · `warmThenFanout` · `verifier` +
`conductorEscalationModel` + `maxEscalations` · `continuity` · `router` (ε-greedy
bandit per node-kind) · `sessionId` · SQLite run recording + `planToMermaid()`.

## The memory system

Most agents forget everything the moment the context window scrolls. omd gives each
project a **Tier-1 self-memory** — one SQLite file that survives sessions, clients, and
machines.

- **Facts + hybrid retrieval.** Recall fuses two legs — a vector leg (cosine over
  embeddings) and a lexical leg (FTS5 real BM25) — with Reciprocal Rank Fusion (k=60),
  so a query hits both by-meaning and by-exact-term. A Tier-1 store is under ~10k
  facts, so retrieval is exact brute force: correct and fast, no ANN index to tune.
- **A temporal knowledge graph.** Facts are linked by time-bounded edges
  (`omd_edges`) with app-enforced no-overlap, so "what was true when" is a first-class
  query, not a guess from timestamps.
- **A write pipeline that rejects by default.** Every write passes namespace
  safeguards: out-of-namespace, banned, and (on the automatic learning path) secret-
  bearing facts are refused. A **confidence self-evolve lock** supersedes an
  existing same-identity fact only when the new one clears the bar — memory sharpens
  instead of accreting contradictions. Explicit `memory_remember` trusts you and skips
  the secret scan (your sovereignty over your own store).
- **Dream consolidation.** `dream_consolidate` runs one pump round that folds the
  recent raw-event window into layered facts (**L0–L6**), returning per-layer stats.
  Raw noise becomes durable, ranked knowledge — the next session recalls the distilled
  version, not the transcript.

Three tools expose it: `memory_recall` (search), `memory_remember` (gated write),
`dream_consolidate` (fold events → layers). All truth lives on disk in `.omd/`.

### Session handoff — `/start` and `/handoff`

The memory tools store *facts*. Two agent-side skills store the *narrative* — where
you were and what comes next — so a fresh session doesn't start cold:

- **`/handoff`** (session wrap-up) — updates the project's next-state file
  (`_NEXT.md`), writes a session log, and captures memory. Skip it and the next
  session loses the thread. It references paths (commit sha, plan, diff) instead of
  inlining them, and redacts secrets.
- **`/start`** (session open) — reads that next-state file plus `git status` in
  parallel and hands your agent a briefing: the current task and the suggested next
  step. The first command of a new session.

These are the **narrative layer** — distinct from the two machine layers. Run-resume
checkpoints (`.omd/continuity/`) restore an interrupted *DAG run*; the fact store
restores *knowledge*; `/start` + `/handoff` restore the *story*.

Both are **manual today** — you invoke them. They can be automated with session hooks:
omd already ships a `Stop` hook that nudges memory distillation, and a
`SessionStart` / `SessionEnd` pair can turn the briefing and the wrap-up into an
automatic checkpoint on every session boundary. See
[docs/examples/claude-code/hooks/](docs/examples/claude-code/hooks/).

## The model layer

One resolution chain: local provider registry (custom gateways, env providers) →
**pi-ai catalog fallback** — protocol and auth (`~/.pi/agent/auth.json`, OAuth
refresh) delegated wholesale → loud config error. Models are *coordinates*
(`provider:model`), not bindings; any OpenAI-compatible backend plugs in.

- **Five roles** (`OMD_PLAN_MODEL` · `OMD_CONDUCTOR_MODEL` · `OMD_LEAF_MODEL` ·
  `OMD_VERIFIER_MODEL` · `OMD_DREAM_MODEL`), each resolved in-memory →
  `.omd/config.json` → env → factory default. On the chat path, planning is done by
  your runtime model; the conductor slot serves scripts, the engine API, and escalation.
- **Three wizard presets**: `base-opencode-go` (one gateway key, multi-family) ·
  `cn-standard` (deepseek pro/flash + mimo) · `cn-ultimate` (kimi k3 steering,
  deepseek judging, qwen work, glm review).
- **Escalation resolves through the full chain**, so OAuth-only providers (e.g.
  `kimi-coding:k3`) qualify as escalation targets. A tier-advisory extension *suggests*
  escalations you actually hold keys for — it never forces them.

## Agent template cards

Frequent node shapes are frozen role cards, not re-authored per plan. Five ship
built-in: `code-reviewer` (dual-axis Standards/Spec) · `skeptic-verifier`
(adversarial, lens-parameterized) · `researcher` (FACT/INFERENCE/OPEN discipline) ·
`synthesizer` (fan-in merge + omission ledger) · `implementer` (minimal-diff,
artifact-honest). The planner pays one description line per card; the card body is
injected only into the executing leaf, before the node id, so same-card siblings share
a cached prefix. Project cards live in `.omd/agents/*.md` and override built-ins by
name. Division of labor: **the card carries depth (method, checklist, output
discipline); `persona` carries the angle** — they stack.

## Design rules

- **Reliability lives outside the model** — validated plans, code-enforced gates,
  verifiers that default to fail.
- **Wide over deep** — parallelism and fault isolation come from width; a linear graph
  is a legitimate answer for coupled work.
- **Pay for quality only on failure** — cheap models work; escalation triggers on a
  failed verify, not on vibes.
- **Registry over regeneration** — anything a model would re-derive per run (role
  cards, lens structures, control flow) is frozen once and referenced by name.

## MCP integration (Claude Code / Codex / any client)

`omd mcp` is a stdio MCP server — the 19 tools above in three groups. The server is
**stateless**: maps live in `docs/plan/pathfinder/` (git), runtime state in `.omd/`,
so any client can resume another's work.

```bash
cd <your-project> && claude mcp add omd -- omd mcp
# or drop a .mcp.json into the project (this repo ships a template)
```

The server's **cwd is the repo it operates on**. Full setup — install, model config,
slash pack, a five-minute walkthrough, cost/safety invariants:
**[docs/MCP-ONBOARDING.md](docs/MCP-ONBOARDING.md)**. See
[docs/examples/claude-code/](docs/examples/claude-code/) for a CLAUDE.md template and
PreToolUse hooks (verify-after-edit + dangerous-cmd classifier).

## License

MIT — see [LICENSE](LICENSE).

---
---

<div align="center">

# 中文

### DAG 执行引擎 + 持久决策地图 + 自整理记忆 —— 经 MCP 服务你的 coding agent。

*你的 agent 保持聪明的大脑,omd 提供便宜的并发手脚和不丢的记忆。*

**[上手 →](docs/MCP-ONBOARDING.md)** · [English](#oh-my-dag) · **中文**

</div>

---

## 这是什么

你的 coding agent —— Claude Code、Codex、任意 MCP 客户端 —— 是一颗强而昂贵的大脑。让它
去*逐字敲*每个文件、跑每条测试、把整个计划都记在脑子里,是把房间里最聪明的东西用错了地方。

**oh-my-dag(omd)是整辆车的其余部分。** 它把一个任务拆成一张小活的图,用你自带的廉价
模型并发执行,再由一个来自不同模型家族的 skeptic 校验结果,只有校验真的失败时才动用
frontier 模型。你的 agent 决定*做什么*、并*判断*产物;车队负责敲键盘。它以 **`omd mcp`**
接入任意客户端 —— 一个 stdio MCP server,暴露 19 个工具 —— 你现有的配置一行都不用改。

一套 DAG 引擎之上,给你的 agent 三样东西:

- **DAG 执行引擎。** 一个任务变成类型化节点图:`agent` 叶子真写文件,`command` 叶子跑
  `tsc`/测试,`map` 节点运行时扇出,`primitive` 节点管控制流。节点的依赖一就绪就开跑,
  每个节点是自己的故障边界,每张图都有 checkpoint —— 断掉的 run 是续跑,不是重来。
- **Pathfinder。** 给一个 session 装不下的大活做规划 —— 一张进 git 的持久决策地图,按
  类型化票推进,后台研究关掉客户端还在跑,还有一个只有你能扳的显式交付闸。
- **自整理记忆。** 每个项目一份事实库,语义 + 词法混合召回,带时序知识图;它把 session
  的原始事件折叠成分层事实,让下一个 session 一开局就知道上一个学到了什么。

> 模型是引擎,这里是整辆车的其余部分。

### 为什么值得接进来

| | |
|---|---|
| **廉价并发** | 干活靠宽度,不靠换更大的模型。一打小模型叶子并行跑,价钱约等于一次 frontier 调用。 |
| **frontier 判断、车队执行** | 只在关键处付贵价 —— 校验步,以及失败时那一次升级 —— 不是每个节点都付。 |
| **状态永不丢** | 每个节点的产物都哈希成 checkpoint。429、崩溃、合上笔记本 —— 图从第一个没跑完的节点续上。 |
| **记忆跨 session** | 决策、发现、坑点都活过上下文窗口;召回只差一次调用。 |
| **任意客户端、任意模型** | MCP 进,OpenAI 兼容后端出。不锁厂商,不用重写框架。 |

## 快速上手(MCP —— 推荐)

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install && bun link      # 把 `omd` 放进 PATH(需 Bun ≥ 1.3)
omd init                     # 向导:密钥、模型预设、可达性探测 → .env
```

在你要工作的仓库里接进 Claude Code(server 的 cwd = 它作用的仓库):

```bash
cd <your-project> && claude mcp add omd -- omd mcp
# 或放一个 .mcp.json(本仓库带模板),项目级挂载零命令
```

再装教会 agent 工作流的斜杠技能包:

```bash
cp -r client-skills/{path,tickets,rule,deliver,execute,iterate,grill,sdd,note,council,audit,sast,review,slim,deepen,dream} ~/.claude/skills/
```

**→ 完整走查:[docs/MCP-ONBOARDING.md](docs/MCP-ONBOARDING.md)** ·
命令参考:[client-skills/README.md](client-skills/README.md)

<details>
<summary><b>备用前端:随包的终端 agent</b></summary>

包里带一个交互式终端 agent,方便你不接外部客户端也能用 omd。`bun run omd`(交互)或
`bun run omd -p "..."`(一次性);用 `.env` 里的 `OMD_RUNTIME_PROVIDER` +
`OMD_RUNTIME_MODEL` + 后端密钥配置(拷 [.env.example](.env.example))。上面的 MCP server
是主入口,这个是便利补充。

</details>

## 怎么用 —— 按活的大小分三条道

一切都从你的客户端驱动 —— 平常聊天,或 [client-skills](client-skills/) 包里的斜杠命令。

**1 · 平常聊天** —— 大多数工作。你的 agent 自己的手脚,加上 omd 的跨 session 记忆
(`memory_recall` / `memory_remember`),不用每天早上重新解释一遍项目。

**2 · 规格 → 图(`/sdd` → `/execute`)** —— 值得先规划的活。聊天里打磨 —— `/grill`
拷问想法、`/note` 收决策、`/council` 跑一场评判式多角色辩论 —— 然后:

```
/sdd            # 把对话结晶成 spec,写进磁盘(docs/plan/)
/execute        # dag_run:conductor 把 spec 分解成类型化 DAG,车队执行
```

跑起来是三段式异步(`dag_status` / `dag_result`)—— 派完活继续聊。你的 agent 随后
**主动对照 spec 验收**,四选一:接受 · 带失败要点重画 · `/iterate` 收敛到不动点 · 直接修。

**3 · Pathfinder(`/path`)** —— 大而模糊、一个 session 装不下的活。打开一张**持久决策
地图**(markdown 进 git:`docs/plan/pathfinder/<dest>.md`)。前沿按类型化票推进:

| 票 | 怎么跑 |
|---|---|
| `grill` | 和你交互审议;裁决经 `/rule` 落到地图上 |
| `research` | detached 后台车队 —— 关掉客户端还在跑,结果自动孵化子票,受预算约束 |
| `prototype` | 隔离 git worktree 里的可弃 spike |
| `task` | 建造票;它的裁决词就是可执行的节点目标 |

`/tickets` 拉回落地的研究并显示前沿,`/rule` 裁决,一旦某区散雾 —— **`/deliver`**(显式
权力闸)—— 把它编译成 slice 直接执行:零规划调用,agent 节点真写文件,全部节点 done 才
标记交付。

## 两个 surface

omd 能做的一切都有两条到达路径,而且它们是同一件事的两个侧面。**MCP 工具**是引擎的裸
API;**斜杠命令**是你的 agent 调用的薄工作流包装 —— 每条都调右列那个 MCP 工具,再补上
纪律(何时升级、怎么验收、谁扳扳机)。

### MCP 工具 —— 引擎(19 工具,三组)

**引擎组** —— 把活甩给廉价车队:

| 工具 | 做什么 |
|---|---|
| `dag_run` | 任务 → conductor 分解成类型化 DAG → 并发执行(agent 叶子真写文件,command 叶子跑 tsc/测试) |
| `dag_run_plan` | 跳过 conductor:直接执行预建 plan JSON;`resume=<runId>` 跳过已 checkpoint 的 done 节点 |
| `dag_status` · `dag_result` · `dag_node_output` | 三段式异步:派活、继续聊、轮询、取产物 |
| `dag_runs` | 列出运行 —— 内存台账并上磁盘 checkpoint;可按状态过滤 |
| `dag_research` | 多视角并行研究 + 评判合成;完整报告写盘,摘要进上下文 |
| `dag_review` | 对抗式多维度 diff 审查车队,异步 —— gate `G0`–`G3`,`scope` 限定路径 |
| `dag_slim` | 过度工程、只删不加的审计车队,异步 |
| `dag_deepen` | 架构深化扫描:git 热点发现 → 每热点一个 agent → 按杠杆排序的 HTML 报告 |

**Pathfinder 组** —— 给模糊的跨 session 大活做持久规划:

| 工具 | 做什么 |
|---|---|
| `path_map` | 列出 / 新建 / 恢复决策地图 |
| `path_add` | 加类型化票(research / grill / prototype / task)带依赖边 |
| `path_tickets` | 显示前沿;优先折入落地的后台结果 |
| `path_rule` | 把一条裁决落到地图上(owner 拍板) |
| `path_deliver` | **权力闸**:把已散雾区域编译成 slice、跑 DAG,全部成功才标交付 |
| `path_prefetch` | 把前沿研究派给 detached 后台进程,关掉客户端也活着 |

**记忆组** —— 跨 session 持久:

| 工具 | 做什么 |
|---|---|
| `memory_recall` | 对事实库做语义 + 词法混合搜索;返回带置信度与来源的排序命中 |
| `memory_remember` | 存一条事实,经 namespace 安全闸(拒密钥 / 禁词 / 越 namespace) |
| `dream_consolidate` | 一轮同步巩固,把近期事件窗口折叠进 L0–L6 分层 |

### Claude 斜杠命令([client-skills](client-skills/) 包)

拷进 `~/.claude/skills/`(Codex 并入 `AGENTS.md`)。每条包装右列的 MCP 工具,补上工作流纪律。

| 命令 | 包装 | 补了什么 |
|---|---|---|
| `/path` | `path_map` · `path_add` | 打开或恢复决策地图,把目标拆成票 |
| `/tickets` | `path_tickets` · `path_prefetch` | 看前沿、拉落地研究、派后台活 |
| `/rule` | `path_rule` | 把裁决落到地图 —— owner 显式拍板 |
| `/deliver` | `path_deliver` | 交付闸:编译已散雾区域并执行 |
| `/sdd` | 写 spec 进 `docs/plan/` | 建造前把对话结晶成写盘的 spec |
| `/execute` | `dag_run` → `dag_status`/`dag_result` | 把 spec 当 DAG 跑,再主动对照验收 |
| `/iterate` | `dag_run`(不动点循环) | 反复跑到收敛 —— 你的 agent 当判官 |
| `/grill` | 审议 → `path_rule` | 锁定前拷问想法;落裁决 |
| `/note` | `path_add` · `path_rule` | 对话的决策台账 |
| `/council` | `dag_research`(--council) | 对难拍的决策做评判式多角色辩论 |
| `/audit` | `dag_run`(安全视角) | 多视角安全审计 DAG |
| `/sast` | semgrep(本地) | 确定性静态扫描,不用 LLM |
| `/review` | `dag_review` | 对抗式 diff 审查车队,gate G0–G3 |
| `/slim` | `dag_slim` | 只删不加的过度工程审计 |
| `/deepen` | `dag_deepen` | 架构热点扫描 → 按杠杆排序的报告 |
| `/dream` | `dream_consolidate` | 把近期事件折叠进分层记忆 |

## DAG 引擎

为什么用图不用脚本:脚本是一条直线,而直线要等它最慢的一步。图会把输入就绪的活全跑起来、
把失败隔离到单个节点,还让你拿*宽度* —— 一次上很多廉价模型 —— 去打一个单模型只能串行硬
磨的活。

```
task ──▶ plan producer ──▶ ConductorPlan { nodes, deps }   ← Zod 校验的接缝
                                          │
                            ready-set 并发调度
              ┌───────────┬───────────┼───────────┬───────────┐
          command       leaf        agent        map       primitive
          (CLI, 无     (单发       (用工具的   (运行时    (控制流菜单,
           LLM)         LLM 调用)   子 agent)   扇出)      schema 锁定)
              └───────────┴───────────┼───────────┴───────────┘
                               跨模型 verifier(skeptic)
                                          │
                          pass ◀──────────┴──────────▶ fail → 升级 & 重规划
```

`ConductorPlan` 是接缝 —— 执行机器从不关心图从哪来。plan 有三条产出路径:**runtime 模型**
(`/sdd` → `/execute`)、**零 LLM 调用的编译器**(pathfinder slice、`dag_deepen`、
`dag_slim`)、经引擎 API 的**显式规划调用**(任选模型;升级也走这条)。

**你为什么会用它:**

- **多模型、经济扇出。** 每个节点自报模型。廉价模型并发扛主体活;`warmThenFanout` 先发一
  次调用,让共享的冻结 prompt 前缀在风暴前进缓存,per-provider 并发上限帮你守住限速。开销
  **按图摊销,不按节点**:5 节点图 = 节点工作 + 2 次 LLM 调用(规划 + 校验),关校验 +1,
  编译产出 **+0**。
- **ready-set 调度。** 一个节点的依赖一settle 就开跑,绝不等最慢的 sibling。
- **一节点一故障边界。** 失败节点在下游变成 `[failed]` 输入,它的 sibling 继续跑。单点失败
  不会拖垮整张图。
- **文件诚实。** 产文件的节点被强制走用工具的路径,产物做存在性校验 —— 磁盘上没文件的
  "done" 是失败,不是靠信任接受的声明。
- **先校验、必要才升级。** 一个来自*不同模型家族*的 skeptic 逐条需求攻击结果,存疑即判失败。
  只有校验失败才在更强模型上重规划 —— 且仅当你配了更强模型。

### 续跑:断掉的 run 不从头来

长扇出会撞限速、网络抖动、合上的笔记本。omd 把中断的 run 当成**暂停**,不是丢失。

- 每个节点的产物按输入哈希为键,原子写(tmp + rename)成 checkpoint,落在
  `.omd/continuity/<runId>/`。
- 续跑时 —— `dag_run_plan resume=<runId>`,或用 `dag_runs` 找到那次 run —— 引擎回放
  checkpoint:输入哈希仍一致的节点**判绿、跳过**;执行从第一个没 settle 的节点接上。
- checkpoint 是 **fail-open** 的 —— 万一写 checkpoint 失败,run 只告警不中止。你既不丢进度,
  也不会卡在记账上。

所以一张 40 节点的图在第 31 个节点撞 429 挂掉,回来跑的是 31–40,不是 1–40。`continuity`
(产物哈希 checkpoint)加 SQLite 运行记录,意味着任意客户端都能接手另一个开的 run。

### plan 面(一个节点能说什么)

| 字段 | 管什么 |
|---|---|
| `executor` | `leaf` / `agent` / `command` / `map` |
| `goal` · `depends_on` | 节点的契约 · 只连真实数据边 |
| `template` · `persona` | 按名引用的冻结角色卡 · 任务专属角度 |
| `model` | 逐节点钉死 —— 压过卡片模型、bandit 路由、静态配置 |
| `map` | `lister` 运行时发现工作清单 → 每项一个子节点,可续 id,有界 |
| `kind: primitive` | `parallel` `pipeline` `loop-until` `verify` `judge` `discovery` `iterate` `tournament` `router` `race` `escalation` `saga` —— schema 校验、单元封顶、fail-closed |
| `postcondition` | `structural` / `code` / `llm-judge` / `human` |
| `output_type` · `output_path` | 驱动产文件守卫 |
| `on_failure` · `max_retry` | `retry` / `complete-then-retry` / `escalate` / `pause` |

Run 级旋钮:`maxFanout` · `warmThenFanout` · `verifier` + `conductorEscalationModel` +
`maxEscalations` · `continuity` · `router`(逐 node-kind 的 ε-greedy bandit)· `sessionId`
· SQLite 运行记录 + `planToMermaid()`。

## 记忆系统

多数 agent 一等上下文窗口滚过就全忘了。omd 给每个项目一份 **Tier-1 自我记忆** —— 一个
SQLite 文件,活过 session、客户端和机器。

- **事实 + 混合召回。** 召回融合两条腿 —— 向量腿(embedding 上的余弦)和词法腿(FTS5 真
  BM25)—— 用 Reciprocal Rank Fusion(k=60)融合,一个查询同时按语义和按精确词命中。Tier-1
  库不到约 1 万条事实,所以召回是精确暴力算:又对又快,没有 ANN 索引要调。
- **时序知识图。** 事实由带时间边界的边(`omd_edges`)相连,应用层强制不重叠,于是"某时
  刻什么为真"是一等查询,不是从时间戳猜。
- **默认拒绝的写管线。** 每次写都过 namespace 安全闸:越 namespace、禁词、以及(在自动学习
  路径上)带密钥的事实一律拒。一把**置信度自我进化锁**只在新事实过线时才顶替同身份的旧
  事实 —— 记忆是变锋利,不是堆积矛盾。显式的 `memory_remember` 信任你、跳过密钥扫描(你对
  自己库的主权)。
- **梦境巩固。** `dream_consolidate` 跑一轮 pump,把近期原始事件窗口折叠成分层事实
  (**L0–L6**),返回每层统计。原始噪声变成持久、排过序的知识 —— 下个 session 召回的是蒸馏
  版,不是原始记录。

三个工具暴露它:`memory_recall`(搜索)、`memory_remember`(带闸写入)、`dream_consolidate`
(事件 → 分层)。所有真相都在磁盘上的 `.omd/`。

### session 交接 —— `/start` 和 `/handoff`

记忆工具存的是*事实*。两个 agent 侧技能存的是*叙事* —— 你到哪了、下一步做什么 —— 让新
session 不用冷启动:

- **`/handoff`**(session 收尾)—— 更新项目的 next-state 文件(`_NEXT.md`)、写 session
  log、捕获记忆。跳过它,下个 session 就丢了线头。它**引用路径**(commit sha、计划、diff)
  而不内联,并对密钥脱敏。
- **`/start`**(session 开局)—— 并行读那份 next-state 文件加 `git status`,给你的 agent
  一段 briefing:当前任务 + 建议下一步。新 session 的第一条命令。

这是**叙事层** —— 和两个机器层分开。run 续跑 checkpoint(`.omd/continuity/`)恢复一次断掉
的 *DAG run*;事实库恢复*知识*;`/start` + `/handoff` 恢复*故事*。

两者**目前是手动**的 —— 你来敲。它们可以用 session hooks 自动化:omd 已经带一个 `Stop`
hook 软提示记忆整理,一对 `SessionStart` / `SessionEnd` 就能把 briefing 和收尾变成每个
session 边界上的自动 checkpoint。见 [docs/examples/claude-code/hooks/](docs/examples/claude-code/hooks/)。

## 模型层

单一解析链:本地 provider 注册表(自定义网关、env provider)→ **pi-ai 目录后备** —— 协议
与认证(`~/.pi/agent/auth.json`,含 OAuth 刷新)整体交给 pi → 报错。模型是*坐标*
(`provider:model`),不是绑定;任意 OpenAI 兼容后端可插。

- **五角色**(`OMD_PLAN_MODEL` · `OMD_CONDUCTOR_MODEL` · `OMD_LEAF_MODEL` ·
  `OMD_VERIFIER_MODEL` · `OMD_DREAM_MODEL`),各按 内存 → `.omd/config.json` → env →
  出厂默认 解析。对话主路的规划由你的 runtime 模型做;conductor 槽服务脚本、引擎 API 和升级。
- **三档向导预设**:`base-opencode-go`(一把网关 key,多家族)· `cn-standard`(deepseek
  pro/flash + mimo)· `cn-ultimate`(kimi k3 领航、deepseek 判、qwen 干活、glm 审)。
- **升级走完整解析链**,所以 OAuth-only 的 provider(如 `kimi-coding:k3`)也够格当升级目标。
  一个 tier-advisory 扩展*建议*你手里真有 key 的升级 —— 从不强制。

## agent 模板卡

高频的节点形状是冻结的角色卡,不是每张 plan 重写。内置 5 张:`code-reviewer`(标准/规格
双轴)· `skeptic-verifier`(对抗式,lens 参数化)· `researcher`(FACT/INFERENCE/OPEN
纪律)· `synthesizer`(扇入合并 + 遗漏台账)· `implementer`(最小 diff、产物诚实)。规划
prompt 每张卡只付一行 description;卡片 body 只注入执行叶、且前置于节点 id,于是同卡 sibling
共享缓存前缀。项目卡放 `.omd/agents/*.md`,同名覆盖内置。分工:**卡片管深度(方法、清单、
输出纪律),`persona` 管角度** —— 两者叠加。

## 设计准则

- **可靠性在模型之外** —— 校验过的 plan、代码级闸门、默认判失败的 verifier。
- **宽优于深** —— 并行与故障隔离来自宽度;线性图对紧耦合的活是合法答案。
- **只为失败付费** —— 廉价模型够用;升级由失败的校验触发,不靠感觉。
- **注册表优于重生成** —— 模型会每次重推的东西(角色卡、lens 结构、控制流)冻结一次、按名引用。

## MCP 接入(Claude Code / Codex / 任意客户端)

`omd mcp` 是 stdio MCP server —— 上面 19 个工具、三组。server 是**无状态**的:地图在
`docs/plan/pathfinder/`(git),运行时状态在 `.omd/`,所以任意客户端都能接手另一个的活。

```bash
cd <your-project> && claude mcp add omd -- omd mcp
# 或往项目里放一个 .mcp.json(本仓库带模板)
```

server 的 **cwd = 它作用的仓库**。完整安装、模型配置、斜杠包、五分钟走查、成本/安全不变量:
**[docs/MCP-ONBOARDING.md](docs/MCP-ONBOARDING.md)**。CLAUDE.md 模板与 PreToolUse hook
(edit 后校验 + 危险命令分类器)见 [docs/examples/claude-code/](docs/examples/claude-code/)。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
