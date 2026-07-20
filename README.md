<div align="center">

# oh-my-dag

### A DAG execution engine + persistent decision maps for your coding agent — served over MCP.

*Your agent stays the smart brain. omd brings the cheap concurrent hands*
*and the memory that doesn't forget.*

[![MCP server: 14 tools](https://img.shields.io/badge/MCP%20server-14%20tools-c9a227?style=flat-square&labelColor=140f0a)](docs/MCP-ONBOARDING.md)
[![Clients: Claude Code · Codex · any MCP](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20MCP-6f9488?style=flat-square&labelColor=140f0a)](client-skills/)
[![Models: bring your own](https://img.shields.io/badge/models-bring%20your%20own-b3382a?style=flat-square&labelColor=140f0a)](.env.example)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)

**[Get started →](docs/MCP-ONBOARDING.md)** · [client-skills](client-skills/) · **English** · [中文](#中文)

</div>

---

## What this is

Your coding agent (Claude Code, Codex, any MCP client) stays the smart brain; omd
provides the cheap concurrent hands and the memory that doesn't forget. **`omd mcp`**
is the primary front door — a stdio MCP server (14 tools). A terminal agent on the
[pi](https://pi.dev) runtime ships bundled as an alternative front-end. Any
OpenAI-compatible backend plugs in; nothing is vendor-locked.

- **A DAG execution engine** — tasks become typed node graphs that run concurrently
  on *your choice of cheap models* (agent leaves really write files), get verified by
  a cross-model skeptic, and escalate only on failure. The frontier model judges;
  the fleet executes.
- **Pathfinder** — planning for work too big for one session: a persistent decision
  map in git, typed tickets, AFK background research that keeps running after you
  close the client, and an explicit delivery gate.
- **An agent-template registry** — frozen specialist role cards picked by name.
- **Self-consolidating memory**, **code-enforced gates** (edit→verify, dangerous-cmd
  classifier), and **22 engine-side skills**.

> The model is the engine. This is the rest of the car.

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
# or drop a .mcp.json (this repo ships a template) for zero-command project-level mount
```

Then install the slash-command workflow pack (teaches your agent the disciplines):

```bash
cp -r client-skills/{path,tickets,rule,deliver,execute,iterate,grill,sdd,note,council,audit,sast} ~/.claude/skills/
```

**→ Full walkthrough: [docs/MCP-ONBOARDING.md](docs/MCP-ONBOARDING.md)** ·
command migration table & workflows: [client-skills/README.md](client-skills/README.md)

<details>
<summary><b>Alternative: the bundled terminal agent (pi TUI)</b></summary>

```bash
bun run omd             # interactive terminal agent
bun run omd -p "..."    # one-shot
```

Or configure by hand: `OMD_RUNTIME_PROVIDER` + `OMD_RUNTIME_MODEL` + your backend's
API key in `.env` (copy [.env.example](.env.example)).

</details>

## How you work with it

Three lanes, by task size. The slash commands below are the
[client-skills](client-skills/) pack — your agent's native abilities plus omd's
MCP tools underneath.

**1. Plain chat** — most work. Your agent's own hands, with omd's memory
(`memory_recall` / `memory_remember`) carrying facts across sessions.

**2. Spec → graph (`/sdd` → `/execute`)** — for work worth planning first.
Deliberate in chat (`/grill` interrogates the idea, `/note` collects decisions,
`/council` runs a judged multi-persona debate via `dag_research`), then:

```
/sdd            # crystallize the conversation into a spec on disk (docs/plan/)
/execute        # dag_run: a conductor decomposes the spec into a typed DAG and the fleet runs it
```

The run is three-phase async (`dag_status` / `dag_result`) — dispatch and keep
talking. Your agent then **actively accepts** the result against the spec and picks
one of four moves: accept / redraw with failure notes / `/iterate` to a fixpoint /
fix directly.

**3. Pathfinder (`/path`)** — for big, foggy, multi-session work. A **persistent
decision map** (markdown in git: `docs/plan/pathfinder/<dest>.md`). The frontier
advances as typed tickets:

| Ticket | How it runs |
|---|---|
| `grill` | interactive deliberation with you, decisions land on the map via `/rule` |
| `research` | detached AFK background fleet — keeps running after you close the client; results self-expand child tickets (budgeted) |
| `prototype` | disposable spike in an isolated git worktree |
| `task` | build ticket; its ruling becomes the executable node goal |

`/tickets` pulls landed research and shows the frontier, `/rule` adjudicates, and
when a zone's fog is gone **`/deliver`** — the explicit power gate — compiles it
into a slice and runs it: zero planning calls, agent nodes write real files, marked
delivered only when every node is done. `bun run omd-path` manages maps from the
shell (no API key needed).

### Client slash commands (the [client-skills](client-skills/) pack)

| Command | What it does |
|---|---|
| `/path` `/tickets` `/rule` `/deliver` | pathfinder: map + tickets, frontier + reflow, adjudicate, delivery gate |
| `/sdd` · `/execute` | spec on disk · run it as a DAG with active acceptance |
| `/iterate <task>` | DAG in a fixpoint loop — your agent is the convergence judge |
| `/grill` `/note` `/council` | interrogate · decision ledger · judged debate |
| `/audit` · `/sast` | multi-lens security audit DAG · deterministic semgrep scan |

(The bundled pi TUI keeps its original command set — see the migration table in
[client-skills/README.md](client-skills/README.md).)

### Shell fleet (no TUI)

| Command | What it runs |
|---|---|
| `bun run dag-research "<q>"` | deep research: multi-query search + source-tiered crawl → multi-lens fan-out → judged synthesis. `--council` auto-authors lenses, `--super` widens everything |
| `bun run dag-review --gate G2` | adversarial multi-dimension diff review (correctness/security/boundary/contract) with verify/refute convergence |
| `bun run dag-slim` | over-engineering audit, deletion-only: global pass + per-file concurrent pass |
| `bun run dag-deepen` | architecture-deepening scan: git-hotspot discovery → one agent per hotspot → leverage-ranked HTML report |
| `bun run dag-build "<goal>" --oracle-cmd "…"` | conductor plans → agent leaves build concurrently → oracle gates → heal fixpoint, resumable |
| `bun run dag-council <goal.json>` | auto-authored expert council → concurrent candidates → judge + graft |
| `bun run dag-fanout <spec.json>` | hand-written lens spec, straight to fan-out |
| `bun run omd-path` · `bun run omd-debt` | pathfinder map CLI · ledger of deliberate `ponytail:` shortcuts |

Every script has `--help`; the matching skill in [skills/](skills/) documents the discipline.

## The DAG engine

```
task ──▶ plan producer ──▶ ConductorPlan { nodes, deps }   ← the Zod-validated seam
                                          │
                            ready-set concurrent scheduling
              ┌───────────┬───────────┼───────────┬───────────┐
          command       leaf        agent        map       primitive
          (CLI, no    (single-shot (tool-using (runtime   (13-item control-flow
           LLM)        LLM call)   sub-agent)   fan-out)   menu, schema-locked)
              └───────────┴───────────┼───────────┴───────────┘
                               cross-model verifier (skeptic)
                                          │
                          pass ◀──────────┴──────────▶ fail → escalate & re-plan
```

`ConductorPlan` is a seam: execution never cares where the graph came from. Plans
arrive three ways — the **runtime model** (`/sdd` → `/execute`), a **compiler with
zero LLM calls** (pathfinder slices, `dag-deepen`, `dag-slim`), or an **explicit
planning call** through the engine API (any model; also the escalation path).

Execution mechanics:

- **Ready-set scheduling** — a node starts the moment its own deps settle; never
  waits for the slowest sibling. Per-provider concurrency caps; `warmThenFanout`
  fires one call first so the shared frozen prompt prefix is cached before the storm.
- **One node, one fault boundary** — a failed node becomes a `[failed]` input
  downstream; siblings keep running.
- **File honesty** — file-producing nodes are forced onto the tool-using path and
  their artifacts are existence-checked; "done" without files on disk is a failure.
- **Verify, then maybe escalate** — a skeptic from a *different model family* attacks
  the result requirement-by-requirement, defaulting to fail on doubt. Only a failed
  verify triggers a re-plan on a stronger model, and only if you configured one.

**Cost math**: overhead is per-graph, not per-node. A 5-node graph = node work
+2 LLM calls (planning + verifier); +1 with the verifier off; **+0** for compiled
plans. A linear graph is a workflow — the DAG is a superset, not a rival mode.

### The plan surface (what a node can say)

| Field | Controls |
|---|---|
| `executor` | `leaf` / `agent` / `command` / `map` |
| `goal` · `depends_on` | the node's contract · real data edges only |
| `template` | pick a role card from the agent-template registry |
| `persona` | one-line expert framing, the task-specific angle |
| `model` | per-node pin — beats card model, bandit router, static config |
| `map` | `lister` discovers the work-list at runtime → one child per item, stable resumable ids, bounded |
| `kind: primitive` | `parallel` `pipeline` `loop-until` `verify` `judge` `discovery` `iterate` `tournament` `router` `race` `escalation` `saga` — schema-validated, unit-capped, fail-closed |
| `postcondition` | `structural` / `code` / `llm-judge` / `human` |
| `output_type` / `output_path` | drives the file-producer guard |
| `creative` | output is the deliverable → exempt from narration compression |
| `on_failure` / `max_retry` | `retry` / `complete-then-retry` / `escalate` / `pause` |

Run-level knobs: `maxFanout` · `warmThenFanout` · `cavemanLevel` (output
compression) · `verifier` + `conductorEscalationModel` + `maxEscalations` ·
`continuity` (artifact-hashed checkpoints, reruns skip green nodes) · `router`
(ε-greedy bandit per node-kind) · `sessionId` (one trace id) · SQLite run recording
+ `planToMermaid()`.

## Agent template cards

Frequent node shapes are frozen role cards, not re-authored per plan. Five ship
built-in: `code-reviewer` (dual-axis Standards/Spec) · `skeptic-verifier`
(adversarial, lens-parameterized) · `researcher` (FACT/INFERENCE/OPEN discipline) ·
`synthesizer` (fan-in merge + omission ledger) · `implementer` (minimal-diff,
artifact-honest).

The planner pays one description line per card; the card body is injected only into
the executing leaf, placed before the node id so same-card siblings share a cached
prefix. Project cards live in `.omd/agents/*.md` (frontmatter `name` /
`description` / optional `model`), override built-ins by name, and unknown card
names invalidate a plan at parse time. Division of labor: **the card carries depth
(method, checklist, output discipline); `persona` carries the angle** — they stack.

## The model layer

One resolution chain: local provider registry (custom gateways, env providers) →
**pi-ai catalog fallback** — protocol and auth (`~/.pi/agent/auth.json`, OAuth
refresh) delegated to pi wholesale → loud config error. The wizard lists
auth.json-ready OAuth providers and runs device-flow logins inline.

- **Five roles** (`OMD_PLAN_MODEL` `OMD_CONDUCTOR_MODEL` `OMD_LEAF_MODEL`
  `OMD_VERIFIER_MODEL` `OMD_DREAM_MODEL`), each resolved in-memory →
  `.omd/config.json` → env → factory default. On the chat path planning is done by
  your runtime model (`OMD_ITER_CONDUCTOR_MODEL` overrides); the conductor slot
  serves scripts, the engine API, and escalation.
- **Three wizard presets**: `base-opencode-go` (one gateway key, multi-family) ·
  `cn-standard` (deepseek pro/flash + mimo) · `cn-ultimate` (kimi k3 steering,
  deepseek judging, qwen work, glm review).
- **Two-tier multimodal pools**; a **tier-advisory** extension suggests (never
  forces) escalations you actually have keys for. The escalation slot resolves
  through the full chain, so OAuth-only providers (e.g. `kimi-coding:k3`) qualify.

## Skills — all 22

Layered for token discipline (*Smart Zone*): only **4 resident** skills stay in the
prompt where the model can self-invoke them; the other **18 route** through `/omd`
or an explicit `/<name>`.

| Skill | One line |
|---|---|
| **verify** ● | unified verification gate: tsc/test/build by changed files, 5 modes |
| **recall** ● | active memory recall from the chunk store |
| **investigate** ● | 8-phase root-cause debugging discipline |
| **codebase-design** ● | deep-module vocabulary: depth, seam, leverage, locality |
| start · handoff | session bootstrap briefing · session close-out ritual |
| commit | analyzed conventional commits behind the verify zone check |
| retro | engineering retrospective from git history |
| review | on-demand audit: security / coverage / debt / gates / PR |
| dream | manual memory consolidation (raw events → L0-L6 facts, gated) |
| caveman | ultra-compressed output mode (~75% fewer tokens) |
| ponytail | the laziest solution that works; YAGNI enforced, shortcuts ledgered |
| council | multi-persona debate → judged champion with grafted ideas |
| skill-creator | create, improve, and measure skills |
| omd | the index: one table of every routed skill |
| dag-research | deep web research as a DAG (see shell fleet) |
| dag-review · dag-slim · dag-deepen | diff review · deletion audit · architecture scan |
| dag-build | decomposable coding task with oracle gate + heal loop |
| dag-council · dag-fanout | auto-authored council · hand-written lens fan-out |

● = resident. A **skill flywheel** mines recurring wins from run history into new
skill proposals.

## Design rules

- **Reliability lives outside the model** — validated plans, code-enforced gates,
  verifiers that default to fail.
- **Wide over deep** — parallelism and fault isolation come from width; a linear
  graph is a legitimate answer for coupled work.
- **Pay for quality only on failure** — cheap models work; escalation triggers on a
  failed verify, not on vibes.
- **Registry over regeneration** — anything a model would re-derive per run (role
  cards, lens structures, control flow) is frozen once and referenced by name.


## MCP integration (Claude Code / Codex / any client)

`omd mcp` is a stdio MCP server — 14 tools in three groups: the DAG engine
(`dag_run` / `dag_run_plan` / `dag_status` / `dag_result` / `dag_node_output` /
`dag_research`), pathfinder (`path_map` / `path_add` / `path_tickets` /
`path_rule` / `path_deliver` / `path_prefetch`), and memory (`memory_recall` /
`memory_remember`). The server is stateless: maps live in `docs/plan/pathfinder/`
(git), runtime state in `.omd/` — any client can resume another's work.

```bash
cd <your-project> && claude mcp add omd -- omd mcp
# or drop a .mcp.json into the project (this repo ships a template)
```

The server's **cwd is the repo it operates on**. Full setup — install, model
config, skills, a five-minute walkthrough, cost/safety invariants:
**[docs/MCP-ONBOARDING.md](docs/MCP-ONBOARDING.md)**.

Two skill packs, different audiences:

- **[client-skills/](client-skills/)** — slash workflows for *your agent* (the MCP
  client): `/path` `/rule` `/deliver` `/execute` … with the owner-holds-the-trigger
  disciplines. Copy into `~/.claude/skills/` (Codex: merge into `AGENTS.md`).
- **[skills/](skills/)** — the 22 engine-side disciplines consumed by omd's own
  leaves and the bundled TUI; optionally symlink into `.claude/skills/` too.

See [docs/examples/claude-code/](docs/examples/claude-code/) for CLAUDE.md template
and PreToolUse hooks (verify-after-edit + dangerous-cmd classifier).

## License

MIT — see [LICENSE](LICENSE).

---
---

<div align="center">

# 中文

### DAG 执行引擎 + 持久决策地图 — 经 MCP 服务你的 coding agent。

*你的 agent 保持聪明的大脑,omd 提供便宜的并发手脚和不丢的记忆。*

**[上手 →](docs/MCP-ONBOARDING.md)** · [斜杠技能包](client-skills/)

</div>

## 这是什么

你的 coding agent（Claude Code / Codex / 任意 MCP 客户端）保持"聪明的大脑"，omd 提供
"便宜的并发手脚和不丢的记忆"。**`omd mcp`** 是主入口（stdio MCP server，14 工具）；
pi 运行时上的终端 agent 作为备用前端随包附带。任意 OpenAI 兼容后端可用，不锁厂商。
核心：**DAG 执行引擎**（任务变成类型化节点图，由你自选的廉价模型车队并发执行——agent
叶子真改文件，跨模型 skeptic 校验，失败才升级；frontier 模型做判断，车队做执行)、
**Pathfinder**（跨 session 大活的持久决策地图，AFK 后台研究关掉客户端还在跑，显式交付闸）、
**agent 模板卡注册表**、自整理记忆、代码级闸门、22 个引擎侧技能。

> 模型是引擎，这里是整辆车的其余部分。

**上手**:[docs/MCP-ONBOARDING.md](docs/MCP-ONBOARDING.md)(装→配→接→用,五分钟示例)·
斜杠技能包与命令迁移表:[client-skills/README.md](client-skills/README.md)。

## 怎么用 — 按活的大小分三条道

以下斜杠来自 [client-skills](client-skills/) 技能包(装进 `~/.claude/skills/`),
底下是 omd 的 MCP 工具。

**1. 平常聊天**——大多数工作。你的 agent 自己的手脚,加上 omd 的跨 session 记忆
(`memory_recall` / `memory_remember`)。

**2. 规格 → 图（`/sdd` → `/execute`）**——值得先规划的活。聊天里打磨(`/grill` 拷问
想法、`/note` 收决策、`/council` 经 `dag_research` 多视角辩论),`/sdd` 把共识结晶成
spec 落盘,`/execute` 走 `dag_run`:conductor 分解成类型化 DAG、车队并发执行,三段式
异步(`dag_status`/`dag_result`)——派完活继续聊。跑完你的 agent **主动对照 spec 验收**,
四选一:接受 / 带失败要点重画 / `/iterate` 不动点收敛 / 直接修。

**3. Pathfinder（`/path`）**——大而模糊、一个 session 装不下的活。打开**持久决策地图**
（markdown 进 git：`docs/plan/pathfinder/`）。前沿按类型化票推进：`grill`（交互审议，
`/rule` 把裁决落图）· `research`（detached AFK 后台——关掉客户端还在跑,结果自动孵化
子票,受预算约束）· `prototype`（隔离 worktree 可弃 spike）· `task`（裁决词即执行目标）。
`/tickets` 拉研究回流看前沿，区域散雾后 **`/deliver`**（显式权力闸）编译成 slice 直执
——零规划调用，agent 节点真写文件，全部节点 done 才标记交付。
Shell 侧 `bun run omd-path` 管地图（不需要 API key）。

shell 车队表、节点字段表、22 技能表见上方英文段（表格通用）。

## 引擎要点

`ConductorPlan` 是接缝：执行机器不关心图从哪来。三条产出路径——runtime 模型
（`/sdd`→`/execute`）、零 LLM 编译器（pathfinder slice、dag-deepen、dag-slim）、
引擎 API 显式规划调用（任选模型，escalation 也走这条）。执行：ready-set 就绪即跑、
一节点一故障边界、写文件节点强制工具路径 + 产物存在性校验、跨家族 skeptic 存疑即 fail、
失败才升级。**成本按图摊销**：5 节点图 = 节点工作 +2 次调用（规划+校验）；关校验 +1；
编译产出 +0。线性图就是 workflow——DAG 是超集不是对立模式。

## 模板卡 / 模型层

内置 5 卡（code-reviewer · skeptic-verifier · researcher · synthesizer · implementer）：
规划 prompt 每卡只付一行 description，卡片 body 只注入执行叶且前置——同卡 sibling 共享
缓存前缀。项目卡放 `.omd/agents/*.md` 同名覆盖；未知卡名解析期拒。**模板管深度，persona
管角度**。模型层单一解析链：本地注册表 → pi-ai 目录后备（认证/协议全交 pi，OAuth 含刷新）
→ 报错。五角色 4 层优先级；对话主路规划 = runtime 模型；三档预设
（base-opencode-go / cn-standard / cn-ultimate）；双层多模态池 + tier-advisory；
escalation 槽走完整解析链（`kimi-coding:k3` 这类 OAuth-only 也可入位）。

## 设计准则

可靠性在模型之外 · 宽优于深（线性图对紧耦合任务同样合法）· 只为失败付费 ·
注册表优于重生成（模型会每次重推的东西冻结一次、按名引用）。
