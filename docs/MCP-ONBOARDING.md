# omd over MCP — Onboarding

> Your coding agent (Claude Code / Codex / any MCP client) stays the smart brain;
> omd provides the cheap concurrent hands and the memory that doesn't forget.
> [中文速览](#中文速览) at the bottom.

`omd mcp` is a stdio MCP server exposing oh-my-dag's three subsystems as tools:

- **DAG execution engine** — decompose a task into a typed node graph, fan out to
  *your choice of cheap models* concurrently, verify cross-model, escalate only on
  failure. The frontier model judges; the fleet executes.
- **Pathfinder** — persistent decision maps for work too big for one session:
  typed tickets in git-tracked markdown, AFK background research that keeps running
  after you close the client, an explicit delivery gate.
- **Self-memory** — hybrid FTS+vector fact store that survives across sessions.

Everything is **stateless in the server**: maps live in `docs/plan/pathfinder/`
(git), runtime state in `.omd/` — crash the server, switch clients, resume freely.

---

## 1 · Install (2 minutes)

Prereqs: [Bun](https://bun.sh) ≥ 1.3, one API key for any OpenAI-compatible
provider (nothing is vendor-locked).

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git
cd oh-my-dag && bun install
bun link          # puts `omd` on your PATH
```

## 2 · Configure (models are coordinates, not bindings)

omd bakes **no model**. Every role (conductor / leaf / agent / verifier…) is a
`provider:model` coordinate — DeepSeek, Kimi k3, GLM, GPT, MiMo, or any
OpenAI-compatible gateway, mix freely.

**Wizard (recommended):**

```bash
omd init          # keys, model presets, reachability probe → writes .env
```

**Manual** — copy [.env.example](../.env.example), minimum set:

```bash
OMD_RUNTIME_PROVIDER=deepseek          # runtime coordinate (conductor defaults to it, D-8)
OMD_RUNTIME_MODEL=deepseek-v4-pro
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
# optional role matrix:
# OMD_ITER_CONDUCTOR_MODEL / OMD_ITER_LEAF_MODEL / OMD_ITER_AGENT_MODEL = provider:model
```

## 3 · Wire into your client

**Claude Code, project-level (zero commands)** — drop a `.mcp.json` into the target
repo (this repo ships one you can copy):

```jsonc
{
  "mcpServers": {
    "omd": { "command": "omd", "args": ["mcp"] }
  }
}
```

**Claude Code, manual:**

```bash
cd <your-project> && claude mcp add omd -- omd mcp
```

**Key rule: the server's cwd is the repo it operates on.** Decision maps land in
`<repo>/docs/plan/pathfinder/`, runtime state in `<repo>/.omd/`.

**Skills (strongly recommended)** — install the slash-command workflow pack so your
agent knows the disciplines (who rules, who delivers, how to iterate):

```bash
cp -r client-skills/{path,tickets,rule,deliver,execute,iterate,grill,sdd,note,council,audit,sast} ~/.claude/skills/
```

Codex has no skills mechanism — merge the SKILL.md bodies you need into the target
repo's `AGENTS.md`. See [client-skills/README.md](../client-skills/README.md) for
the full command-migration table and workflows.

## 4 · What you get (14 tools, three groups)

**Engine group** — delegate work to the cheap fleet:

| Tool | What it does |
|---|---|
| `dag_run` | task → conductor decomposes into a typed DAG → concurrent execution (agent leaves **really write files**, command leaves run tsc/tests) |
| `dag_run_plan` | skip the conductor: execute a pre-built plan JSON directly |
| `dag_status` / `dag_result` / `dag_node_output` | three-phase async: dispatch, keep chatting, poll, fetch artifacts |
| `dag_research` | multi-lens parallel research + judged synthesis; full report on disk, only a summary enters context |

**Pathfinder group** — persistent planning for foggy multi-session work:

| Tool | What it does |
|---|---|
| `path_map` | list / create / resume decision maps |
| `path_add` | add typed tickets (research / grill / prototype / task) with dependency edges |
| `path_tickets` | show the frontier; folds in landed AFK results first (pull reflow + budgeted self-expansion) |
| `path_rule` | adjudicate a decision onto the map (owner's call) |
| `path_deliver` | **the power gate**: compile the clear region to a slice, run the DAG, mark delivered only on full success |
| `path_prefetch` | dispatch frontier research to detached background processes — they keep running after you close the client |

**Memory group**: `memory_recall` / `memory_remember` — persistent fact store with
namespace safeguards.

## 5 · Five-minute walkthrough

```
you:    /path add OCR to the invoice module
agent:  (path_map) empty map — let's break it down:
        r1[research] which OCR service?   g1[grill] fallback policy on failed recognition?
        t1[task] integrate API (blockedBy: r1)   t2[task] persist + reconcile (blockedBy: t1,g1)
you:    prefetch
agent:  (path_prefetch) r1 researching in background. Meanwhile — g1?
        … deliberation …
you:    /rule g1 failures go to a manual queue, never auto-post
agent:  ✓ ruled. (path_tickets) r1's result landed: recommends service X … confirm and I'll draft t1's ruling
you:    /rule t1 use X, key via env
agent:  region clear, slice compiles — awaiting /deliver
you:    /deliver
agent:  (path_deliver) 3 nodes done, tickets delivered. Here's the diff — please review.
```

## 6 · Cost & safety invariants

- **Humans hold the trigger**: research runs itself, tickets self-expand, but
  `path_rule` and `path_deliver` fire only on the owner's explicit word.
- **Bounded spend**: AFK self-expansion obeys `OMD_PATH_RESEARCH_BUDGET`
  (default 12, counted across sessions on disk); DAG fan-out is capped;
  escalation to stronger models triggers only on a failed verify.
- **Nothing to lose**: all truth is on disk — maps in git, results and budgets in
  `.omd/`. Any client can pick up where another left off.

---

## 中文速览

**装**:`git clone … && bun install && bun link`(需 Bun ≥1.3)。
**配**:`omd init` 向导写 `.env`;模型是 `provider:model` 坐标,任何 OpenAI 兼容后端可用,不锁厂商。
**接**:目标 repo 放 `.mcp.json`(本仓库带模板)或 `claude mcp add omd -- omd mcp`;**server 的 cwd = 它作用的仓库**。技能包:`cp -r client-skills/... ~/.claude/skills/`,获得 `/path` `/rule` `/deliver` `/execute` 等斜杠工作流。
**得到什么**:14 个工具三组——DAG 引擎组(任务分解成类型化节点图、廉价模型车队并发真改文件、三段式异步)、pathfinder 组(持久决策地图、AFK 后台研究关了客户端还在跑、显式交付闸)、记忆组(跨 session 事实库)。
**边界**:裁决与执行永远等 owner 显式指令;自续研究受预算约束(`OMD_PATH_RESEARCH_BUDGET`,默认 12);状态全在磁盘,换客户端零损失。
