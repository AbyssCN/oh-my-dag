<div align="center">

# oh-my-dag

### The full harness around the model — on the [pi](https://pi.dev) coding-agent runtime.

[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![Built on pi](https://img.shields.io/badge/built%20on-pi-6f9488?style=flat-square&labelColor=140f0a)](https://pi.dev)

**English** · [中文](#中文)

</div>

---

## What this is

pi gives you a minimal agent runtime; this repo is the full outfit on top. **omd** is
the bundled terminal agent. Everything mounts as pi extensions and works with any
OpenAI-compatible backend, plus everything the pi-ai catalog can auth (OAuth included).

- **A DAG execution engine** — tasks become typed node graphs that run concurrently,
  get verified by a cross-model skeptic, and escalate only on failure.
- **Pathfinder** — planning for work too big for one session: a persistent decision
  map in git, typed tickets, zones that compile straight into executable graphs.
- **An agent-template registry** — frozen specialist role cards picked by name.
- **Self-consolidating memory**, **code-enforced gates** (edit→verify, dangerous-cmd
  classifier), an **MCP router** with output sandbox, and **22 skills**.

> The model is the engine. This is the rest of the car.

## Quick start

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git && cd oh-my-dag
bun install
bun run init            # wizard: presets, role matrix, OAuth logins
bun run omd             # interactive terminal agent
bun run omd -p "..."    # one-shot
```

Or configure by hand: `OMD_RUNTIME_PROVIDER` + `OMD_RUNTIME_MODEL` + your backend's
API key in `.env` (copy [.env.example](.env.example)). `bun link` puts `omd` on your
PATH. Requires [Bun](https://bun.sh) ≥ 1.3.

## How you work with it

Three lanes, by task size:

**1. Plain chat** — most work. The runtime model with the gates always on: edits are
followed by a mandatory verify (typecheck/tests) before side-effect commands run;
dangerous commands hit a fail-closed classifier; memory recalls prior sessions.

**2. Spec → graph (`/sdd` → `/execute`)** — for work worth planning first. Deliberate
in chat with the plan toolkit (`/grill` interrogates the idea, `/note` `/ref`
`/search` collect decisions, `/council` runs a multi-persona debate), then:

```
/sdd            # crystallize the conversation into a spec on disk (docs/plan/)
/execute        # the runtime model decomposes the spec into a DAG and runs it
```

The same model that held the conversation plans the graph — full context, no lossy
handoff. The run ends with an **acceptance brief** (DAG summary, convergence state,
token usage); `/execute --redraw "<notes>"` re-plans from your acceptance failures.
`/iterate <task>` wraps the whole thing in a fixpoint loop until a judge passes it.

**3. Pathfinder (`shift+tab`)** — for big, foggy, multi-session work. Opens a
**persistent decision map** (markdown in git: `docs/plan/pathfinder/<dest>.md`).
The frontier advances as typed tickets:

| Ticket | How it runs |
|---|---|
| `grill` | interactive deliberation with you, decisions land on the map via `/rule` |
| `research` | AFK background fleet; a `map` node discovers sub-tickets at runtime |
| `prototype` | disposable spike in an isolated git worktree |
| `task` | ordinary execution ticket |

`/tickets` lists the frontier, `/rule` adjudicates a decision onto the map, and when
a zone's fog is gone `/deliver` compiles it into executable slices and runs them —
zero planning calls, agent nodes write real files, and the zone is only marked
delivered when every node is done and verified. `bun run omd-path` manages maps from
the shell (no API key needed).

### TUI commands

| Command | What it does |
|---|---|
| `/grill` `/note` `/ref` `/search` `/council` `/crystallize` `/crystals` | plan toolkit: interrogate, collect, debate, crystallize |
| `/sdd` · `/execute [--redraw]` | spec on disk · run it as a DAG with acceptance brief |
| `/iterate <task>` | DAG in a fixpoint loop until a convergence judge passes |
| `shift+tab` · `/path` `/tickets` `/rule` `/deliver` | pathfinder: map, frontier, adjudicate, deliver |
| `/cg <question>` | parallel code-retrieval DAG |
| `/audit` · `/sast` | multi-lens security/quality audit · concurrent semgrep → synthesis |
| `/recall` · `/cost` · `/mcp` | memory recall · cost ledger · MCP router |
| `/setup` · `/config` | wizard · config center |
| `/omd` | index of every routed skill |

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


## Claude Code integration

omd exposes an MCP server over stdio. Use it in Claude Code by adding to your `.claude/settings.json`:

```jsonc
// ~/.claude/settings.json (global) or .claude/settings.json (project)
{
  "mcpServers": {
    "omd": {
      "command": "bun",
      "args": ["run", "omd", "mcp"],
      "cwd": "/path/to/oh-my-dag"
    }
  }
}
```

Or if you ran `bun link`:

```jsonc
{
  "mcpServers": {
    "omd": {
      "command": "omd",
      "args": ["mcp"]
    }
  }
}
```

This gives Claude Code access to omd's tool surface (DAG engine, skill router, memory, verification) as MCP tools.

### Skills for Claude Code

Install all 22 skills into `.claude/skills/`:

```bash
mkdir -p .claude/skills
for skill in skills/*/; do name=$(basename "$skill"); ln -sf "../../skills/$name" ".claude/skills/$name"; done
```

See [docs/examples/claude-code/](docs/examples/claude-code/) for the full setup: skill install guide, CLAUDE.md template, and PreToolUse hooks (verify-after-edit + dangerous-cmd classifier).

## License

MIT — see [LICENSE](LICENSE).

---
---

<div align="center">

# 中文

### 模型之外的完整装备 — 跑在 [pi](https://pi.dev) coding-agent 运行时上。

</div>

## 这是什么

pi 是极简 agent 运行时，这个仓库是它上面的整套装备。**omd** 是内置终端 agent，一切以
pi extension 挂载，任意 OpenAI 兼容后端可用（外加 pi-ai 目录能认证的一切，含 OAuth）。
核心：**DAG 执行引擎**（任务变成类型化节点图并发执行，跨模型 skeptic 校验，失败才升级）、
**Pathfinder**（跨 session 大活的持久决策地图）、**agent 模板卡注册表**、自整理记忆、
代码级闸门、MCP 路由、22 个技能。

> 模型是引擎，这里是整辆车的其余部分。

## 怎么用 — 按活的大小分三条道

**1. 平常聊天**——大多数工作。runtime 模型 + 常开闸门：改完必验（typecheck/test 过了才放行
副作用命令）、危险命令 fail-closed 分类、记忆自动召回。

**2. 规格 → 图（`/sdd` → `/execute`）**——值得先规划的活。聊天里用规划工具打磨
（`/grill` 拷问想法、`/note` `/ref` `/search` 收决策、`/council` 多视角辩论），然后
`/sdd` 把共识结晶成 spec 落盘，`/execute` 由**同一个 runtime 模型**（握有全部对话上下文）
把 spec 分解成 DAG 执行。跑完回 ACCEPTANCE BRIEF（图摘要/收敛态/token 用量）；
`/execute --redraw "<失败要点>"` 按验收失败重画；`/iterate` 套不动点循环直到 judge 通过。

**3. Pathfinder（`shift+tab`）**——大而模糊、一个 session 装不下的活。打开**持久决策地图**
（markdown 进 git：`docs/plan/pathfinder/`）。前沿按类型化票推进：`grill`（交互审议，
`/rule` 把裁决落图）· `research`（AFK 后台车队，map 节点运行时发现子票）· `prototype`
（隔离 worktree 可弃 spike）· `task`。`/tickets` 看前沿，区域散雾后 `/deliver` 编译成
slice 直执——零规划调用，agent 节点真写文件，全部节点 done 且校验过才标记交付。
Shell 侧 `bun run omd-path` 管地图（不需要 API key）。

TUI 命令表、shell 车队表、节点字段表、22 技能表见上方英文段（表格通用）。

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
