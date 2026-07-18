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

In the `oh-my-*` tradition: pi gives you a minimal, extensible agent runtime — this
repo gives you **the whole configured outfit** on top of it. **omd** is the bundled
terminal agent; every part below mounts as a pi extension and works with any
OpenAI-compatible backend.

- **A memory that consolidates itself** — runtime signals distill into facts, facts
  that recur across sessions get promoted, confident facts ground behavior next time.
  A TTL sweep keeps it bounded; every write passes a validation gate.
- **A DAG execution engine** (the flagship — details below) — a conductor turns tasks
  into typed node graphs that run concurrently, get verified by a cross-model skeptic,
  and escalate only on failure.
- **Gates enforced in code, not prompts** — plan mode blocks writes until the plan is
  aligned; an edit→verify gate blocks side-effect commands until typecheck/tests pass;
  dangerous commands hit a fail-closed classifier.
- **An MCP router** — every MCP server collapses behind one on-demand menu; large tool
  outputs offload to a searchable sandbox.
- **A 17-skill bundle** — 12 harness skills (session rituals, memory, verification,
  review) + 5 DAG skills, `.claude/skills` compatible, with a self-improvement flywheel
  that mines recurring wins into new skill proposals.

> The model is the engine. This is the rest of the car.

## The DAG engine

A single agent chat does everything serially in one context window; ad-hoc parallel
calls lose structure. The engine turns a task into a **typed DAG of small nodes**:

```
task ──▶ conductor (one LLM call) ──▶ plan { nodes, deps }
                                          │
                            ready-set concurrent scheduling
              ┌───────────┬───────────┼───────────┬───────────┐
          command       inproc      agent        map       primitive
          (CLI, no    (single-shot (tool-using (runtime   (tournament/router/
           LLM)        LLM call)   sub-agent)   fan-out)   race/escalation/saga)
              └───────────┴───────────┼───────────┴───────────┘
                               cross-model verifier
                                          │
                          pass ◀──────────┴──────────▶ fail → escalate & re-plan
```

- **One node, one fault boundary** — a failed node becomes a `[failed]` input
  downstream; the rest keeps running. Nodes start the moment their own deps settle.
- **`map` nodes** — when the work-list is unknown at plan time, a lister discovers it
  at runtime and a template stamps out one child per item, with stable resumable ids.
- **A typed primitive menu** — the conductor *selects* schema-validated control flow
  (`parallel`, `pipeline`, `tournament`, `router`, `race`, `escalation`, `saga` with
  reverse compensation), each unit-capped and fail-closed.
- **Trust is external** — plans are Zod-validated; a cross-model skeptic judges results
  (defaults to *fail* when uncertain); escalation to a stronger model happens only on
  failure, and only if you configured one.
- **Recorded and resumable** — plans, per-node results and token usage land in SQLite;
  artifact-hashed checkpoints let a rerun skip done nodes; `planToMermaid()` draws any
  run; an ε-greedy bandit learns per node-kind which configured model is worth it.

## Quick start

```bash
git clone https://github.com/AbyssCN/oh-my-dag.git oh-my-dag
cd oh-my-dag
bun install

# any supported / OpenAI-compatible backend — no baked default
export OMD_RUNTIME_PROVIDER=deepseek
export OMD_RUNTIME_MODEL=deepseek-v4-pro
export DEEPSEEK_API_KEY=sk-...

bun run omd             # interactive terminal agent
bun run omd -p "..."    # one-shot, non-interactive
```

Or `bun run init` for an interactive wizard. `bun link` puts `omd` / `oh-my-dag`
on your PATH. Config lives in `.env` — copy [.env.example](.env.example).
Legacy `XIHE_*` env names are still accepted. Requires [Bun](https://bun.sh) ≥ 1.3.

### In the TUI

| Command | What it runs |
|---|---|
| `/cg <question>` | Parallel code-retrieval DAG: sync → concurrent query nodes → synthesis |
| `/audit` | Multi-lens security/quality audit as an agent-node DAG |
| `/sast` | Concurrent semgrep command-nodes → report synthesis |
| `/iterate <task>` | Full DAG in a fixpoint loop until a convergence judge passes |
| `shift+tab` | Plan mode: read-only deliberation, writes are code-blocked |
| `/recall` · `/cost` · `/mcp` | Memory recall · cost ledger · MCP router |

### From the shell (no TUI needed)

| Command | What it runs |
|---|---|
| `bun run dag-research "<question>"` | Search + tiered crawl → multi-lens fanout → judged answer, zero-loss artifact |
| `bun run dag-council <goal.json>` | Conductor auto-authors N personas → concurrent candidates → judge + graft |
| `bun run dag-fanout <spec.json>` | Hand-written lens spec, straight to fan-out (manual gearbox) |
| `bun run dag-review --gate G2` | Adversarial multi-dimension diff review with verify/refute convergence |
| `bun run dag-build "<goal>" --oracle-cmd "…"` | Conductor plans → agent leaves build concurrently → oracle gates → heal fixpoint, resumable |

Each script has `--help`; the matching skill in [skills/](skills/) documents the discipline.

## Status — what's real today

Honesty over marketing. As of v0.2:

| Capability | Status |
|---|---|
| Conductor → typed plan → ready-set concurrent scheduling | ✅ shipped |
| Executor kinds: command / inproc / agent / map / primitive | ✅ shipped |
| Control-flow primitive menu (tournament, router, race, escalation, saga…) | ✅ shipped (schema-validated, unit-capped, fail-closed) |
| Per-node fault boundaries; file-producer guard | ✅ shipped |
| Cross-model verifier + escalate-only-on-failure; multi-lens verify / debiased judge | ✅ shipped (needs a second provider key) |
| Fixpoint iteration (`/iterate`) + discovery loop | ✅ shipped |
| Run recording (SQLite) + node-level checkpoint/resume (artifact-hashed) | ✅ shipped |
| Bandit model routing (per node-kind, persisted) | ✅ shipped (no-op with a single model) |
| Self-consolidating memory (signals → dream → promoted facts) + recall | ✅ shipped |
| Plan mode (read-only gate, decision ledger, best-of-N) | ✅ shipped |
| Edit→verify tool gate | ✅ shipped (`OMD_VERIFY_GATE=0` to disable) |
| MCP router + output sandbox | ✅ shipped |
| 17-skill bundle + skill flywheel (mine → propose) | ✅ shipped |
| DAG → Mermaid rendering (`planToMermaid`) | ✅ shipped (API; TUI `/dag` command planned) |
| Plan templates / replay a recorded plan as a new run | 🚧 roadmap |
| Persistent cross-process workflow store (lease/CAS, node-level refine) | 🚧 roadmap |

## Design rules

- **Reliability lives outside the model.** Validated plans, code-enforced gates,
  verifiers that default to fail, memory writes behind a validation gate.
- **Wide over deep.** Parallelism and fault isolation both come from width.
- **Pay for quality only on failure.** Cheap model works; escalation is opt-in and
  triggered by a failed verify, not by vibes.

## License

MIT — see [LICENSE](LICENSE).

---
---

<div align="center">

# 中文

### 模型之外的完整装备 — 跑在 [pi](https://pi.dev) coding-agent 运行时上。

</div>

## 这是什么

`oh-my-*` 传统：pi 提供极简可扩展的 agent 运行时，这个仓库给它配上**整套装备**。
**omd** 是内置终端 agent；以下每一层都以 pi extension 挂载，任意 OpenAI 兼容后端可用。

- **自我整理的记忆**——运行时信号蒸馏成事实，跨 session 复现的事实升级为 confident，
  confident 事实落地为下次的行为；TTL 清扫保持有界，每次写入过校验闸。
- **DAG 执行引擎**（旗舰）——conductor 把任务变成有类型的节点图并发执行：五类执行器
  （command / inproc / agent / **map** 运行时展开 / **primitive** 原语菜单含 saga 补偿回滚）、
  ready-set 就绪即跑调度、节点级故障边界、跨模型校验失败才升级、checkpoint 断点续跑、
  SQLite 落库 + Mermaid 画图、bandit 模型路由。
- **代码级闸门而非 prompt 劝告**——计划模式阻断写操作直到方案对齐；写后必验闸拦住未验证
  改动后的副作用命令；危险命令过 fail-closed 分类器。
- **MCP 路由**——所有 MCP server 收敛到一个按需菜单，大输出卸载到可搜索沙箱。
- **17 个技能**——12 个 harness 技能（session 仪式/记忆/验证/审查）+ 5 个 DAG 技能，
  兼容 `.claude/skills`，配自进化飞轮（复现的成功模式挖掘成新技能提案）。

> 模型是引擎，这里是整辆车的其余部分。

## 快速开始

见上方英文 Quick start：`bun install` 后设 `OMD_RUNTIME_PROVIDER/MODEL` + 后端 key，
`bun run omd` 启动（旧 `XIHE_*` 环境变量仍兼容）。TUI 内 `/cg` `/audit` `/iterate` 等
命令、shell 侧 `bun run dag-research|dag-council|dag-fanout|dag-review|dag-build`。

## 现状（诚实版）

上方 Status 表为准：DAG 引擎全链路（五类执行器、原语菜单、校验升级、不动点迭代、
断点续跑、bandit 路由）、记忆层、计划模式、写后必验闸、MCP 路由、17 技能包——
**已交付**；计划模板重放、跨进程持久化工作流存储——**在路线图上**。

## 设计准则

可靠性在模型之外；宽优于深；只为失败付费。
