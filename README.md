<div align="center">

# oh-my-dag

### Two ways to put cheap concurrent models behind your agent — call one capability, or hand off a whole graph.

*Your agent stays the brain. omd brings the hands, the gates, and the memory.*

[![MCP server: 33 tools](https://img.shields.io/badge/MCP%20server-33%20tools-c9a227?style=flat-square&labelColor=140f0a)](docs/mcp-tools.md)
[![Clients: Claude Code · Codex · any MCP](https://img.shields.io/badge/clients-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20any%20MCP-6f9488?style=flat-square&labelColor=140f0a)](client-skills/)
[![Models: bring your own](https://img.shields.io/badge/models-bring%20your%20own-b3382a?style=flat-square&labelColor=140f0a)](docs/model-layer.md)
[![Runtime: Bun ≥ 1.3](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-b3382a?style=flat-square&labelColor=140f0a)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-c9a227?style=flat-square&labelColor=140f0a)](LICENSE)

**English** · [中文](README.zh-CN.md) · **[Get started →](docs/MCP-ONBOARDING.md)**

</div>

## The two tracks

Your coding agent is a strong, expensive brain. Using it to *type out* every file, read every
page, and hold every plan in its head is the wrong job for the smartest thing in the room.

omd gives that agent two ways to delegate — and they share one substrate, so switching tracks
never costs you reliability:

```mermaid
flowchart TB
  AGENT["Your agent<br/>Claude Code · Codex · any MCP client · omd's own TUI"]

  subgraph OMD["omd — one engine, two ways in"]
    direction TB

    subgraph T1["Track 1 · COMPOSE — call one capability at a time"]
      C1["omd_primitive<br/>judge · verify · parallel · tournament · 12 shapes"]
      C2["omd_web / omd_distill<br/>fetch pages · distil insight"]
      C3["memory_recall / path_map<br/>facts that outlive the window"]
      C4["omd_shapes<br/>proven decompositions, and when NOT to use them"]
    end

    subgraph T2["Track 2 · GRAPH — hand off a whole fan-out"]
      G1["dag_run<br/>a conductor decomposes for you"]
      G2["dag_run_plan<br/>you wrote the graph, just run it"]
      G3["dag_review / dag_debug / dag_slim / dag_deepen<br/>pre-shaped fleets"]
    end

    BASE["Shared substrate<br/>typed plan · deterministic passes · oracle gates · cross-family verifier<br/>checkpoints · model pools · cost accounting"]
    T1 --> BASE
    T2 --> BASE
  end

  MODELS[("Your models<br/>any OpenAI-compatible backend")]
  AGENT -->|MCP| T1
  AGENT -->|MCP| T2
  BASE --> MODELS

  classDef compose fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
  classDef dagmode fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef base fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef ext fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
  class C1,C2,C3,C4 compose
  class G1,G2,G3 dagmode
  class BASE base
  class AGENT,MODELS ext
```

**Track 1 — compose.** Call one capability and look at the result: run a `judge` over three
attempts, fetch and distil a page, recall what you decided last week. Two to five steps, you
stay in the loop.

**Track 2 — graph.** Hand off a whole fan-out: a task becomes typed nodes, they run the moment
their dependencies settle, every node is checkpointed, and an interrupted run resumes instead of
restarting. Ten nodes or a hundred, you go do something else.

The dividing line is **scale**, and the caller is the best judge of it. The four deterministic
passes that make a graph worth it (prune, dedup, evidence, stamp) buy nothing on a 3-step
composition and are load-bearing on a 40-node one.

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
`~/.claude/skills/` on first server start — idempotent, and it never overwrites a skill you
edited. Opt out with `OMD_INSTALL_SKILLS=0`.

**→ [Full walkthrough](docs/MCP-ONBOARDING.md)** · [command reference](client-skills/README.md)

<details>
<summary>Alternative front-end: the bundled terminal agent</summary>

`bun run omd` (interactive) or `bun run omd -p "..."` (one-shot); configure with
`OMD_RUNTIME_PROVIDER` + `OMD_RUNTIME_MODEL` + your backend key in `.env`
(copy [.env.example](.env.example)). The MCP server is the primary door; this is a convenience.

</details>

## What you can call

```mermaid
flowchart LR
  subgraph EXEC["执行 —— 把活干完"]
    E1["dag_run · dag_run_plan · dag_resume<br/>dag_status · dag_result · dag_runs"]
    E2["omd_primitive<br/>12 个控制流形状"]
  end

  subgraph RESEARCH["研究 —— 把问题查透"]
    R1["omd_web<br/>零模型:搜 + 抓,全文落盘"]
    R2["omd_distill<br/>expert 忠实 / challenger 挖长尾"]
    R3["dag_research<br/>抓 + 多镜头综合判优"]
  end

  subgraph AUDIT["审查 —— 把问题找出来"]
    A1["dag_review<br/>多维度 + 跨家族证伪"]
    A2["dag_debug · dag_slim · dag_deepen"]
    A3["omd-shots-verify<br/>零模型:截图真存在且非白板"]
  end

  subgraph MEMORY["记忆与规划 —— 活过上下文窗口"]
    M1["memory_recall · memory_remember<br/>dream_consolidate"]
    M2["path_map · path_add · path_rule<br/>path_deliver · path_prefetch"]
  end

  subgraph KNOW["知识 —— 别每次从零发明"]
    K1["omd_shapes<br/>图式 + 什么时候别用"]
    K2["agent 模板卡<br/>专家检查单注入 leaf"]
  end

  classDef llm fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef zero fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef mixed fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
  class E1,E2,R3,A1,A2 mixed
  class R1,A3,K1,K2 zero
  class R2,M1,M2 llm
```

**Execution** — `dag_run` (a conductor decomposes for you) · `dag_run_plan` (you wrote the graph)
· `dag_resume` (pick up where a broken run stopped) · `omd_primitive` (one control-flow shape, no
graph required) · `dag_status` / `dag_result` / `dag_node_output` / `dag_runs`.

**Research** — `omd_web` (search + fetch, **zero LLM**; full text to disk, only an index comes
back) · `omd_distill` (two lenses over text you already have: one faithful, one adversarial) ·
`dag_research` (fetch + multi-lens synthesis with a judge panel).

**Audit** — `dag_review` (multi-dimension diff review, each dimension routable to a different
model family) · `dag_debug` · `dag_slim` (deletion-only over-engineering audit) · `dag_deepen`
(architecture hotspots).

**Memory & planning** — `memory_recall` / `memory_remember` / `dream_consolidate` ·
`path_map` / `path_add` / `path_rule` / `path_deliver` / `path_prefetch` (a decision map in git,
advanced by typed tickets, with background research that outlives your client).

**Knowledge** — `omd_shapes` (proven graph shapes, each with the trigger *and* the "not when")
· template cards (a vetted specialist checklist injected into a node at run time).

**Config** — `omd_config_status` / `omd_set_model` / `omd_set_role` / `omd_apply_preset` / …

**→ [Full tool reference](docs/mcp-tools.md)**

## How the graph runs

A task is planned **once** by an LLM, then transformed by **pure functions**, then executed by
dependency order. Everything after the conductor is deterministic.

```mermaid
flowchart TB
  TASK(["TASK"])

  subgraph PLAN["1 · PLAN — one LLM call, everything after it is a pure function"]
    direction TB
    CD["Conductor<br/>gpt-5.6-sol · frozen prefix + task"]
    PJ["Plan JSON<br/>zod-validated · unknown card rejects the plan"]
    P1["prune<br/>cut nodes nothing consumes"]
    P2["dedup<br/>merge by semantic key"]
    P3["evidence<br/>UI pixel-chain gate"]
    P4["stamp<br/>pin a model: pick pool, then 3 rules"]
    CD --> PJ --> P1 --> P2 --> P3 --> P4
  end

  subgraph EXEC["2 · EXECUTE — dependency-driven, no level barrier"]
    direction TB
    RS{{"Ready-set scheduler<br/>a node waits only for its own deps"}}
    L1["inproc leaf<br/>one shot, no tools"]
    L2["agent leaf<br/>tools + bwrap jail<br/>the only kind that writes files"]
    L3["command<br/>zero LLM · allowlisted CLI"]
    L4["map · primitive<br/>runtime fan-out / engine-owned control flow"]
    UI["UI evidence branch<br/>render command prints image paths<br/>then attach_media leaf judges real pixels"]
    RS --> L1 & L2 & L3 & L4
    L2 -.-> UI
    L3 -.-> UI
  end

  subgraph FB["3 · FEEDBACK — objective gate first, model judgement second"]
    direction TB
    FI["Fan-in<br/>summaries, never transcripts"]
    OG["Oracle gate<br/>tsc + test · zero LLM, cannot hallucinate"]
    VF["Verifier<br/>glm-5.2 · cross-family · fails on doubt"]
    HL["Heal<br/>a red gate becomes a repair task"]
    ES["Escalation<br/>emits a node PATCH; untouched nodes stay byte-identical"]
    FI --> OG --> VF
    OG -->|red| HL
    VF -->|rejected| ES
  end

  CP[("Checkpoint<br/>.omd/continuity/runId")]

  TASK --> CD
  P4 --> RS
  L1 & L2 & L3 & L4 --> FI
  UI --> FI
  L1 & L2 & L3 & L4 -.->|every done node lands atomically| CP
  CP -.->|resume: same input hash = green, re-run only the rest| RS
  HL --> RS
  ES --> CD

  classDef llm fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef pure fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef exec fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
  classDef infra fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
  class CD,PJ,VF,ES llm
  class P1,P2,P3,P4,OG,L3 pure
  class L1,L2,HL,UI exec
  class TASK,RS,L4,FI,CP infra
```

*Purple = an LLM call · teal = deterministic, zero LLM · coral = executor · grey = engine structure.*

**Node kinds** — what a node can be:

| Kind | Model? | Tools? | Use for |
|---|---|---|---|
| `leaf` | one shot | no | generation, research, judgement, drafting |
| `agent` | yes | read/edit/write/bash, in a bwrap jail | **the only kind that writes files** |
| `command` | **none** | a CLI from an allowlist | gates (`tsc`/tests), scanners, indexed lookups |
| `map` | mixed | — | runtime fan-out: a lister discovers the work-list, one child per item |
| `primitive` | mixed | — | 12 control-flow shapes the engine owns |

**Plan passes** — pure functions between the plan and execution: `prune` (drop dead nodes) →
`dedup` (semantic-key merge) → `evidence` (UI pixel-chain gate) → `stamp` (pin a model on every node).

**Control-flow primitives** — you pick the shape and its params; the loop / branch / stop /
scoring logic belongs to the runtime, never to the model: `parallel` · `pipeline` · `loop-until` ·
`verify` · `judge` · `discovery` · `iterate` · `tournament` · `router` · `race` · `escalation` · `saga`.

**→ [Architecture in depth](docs/architecture.md)** · [primitives](docs/primitives.md) ·
[diagram source](docs/diagrams/01-engine-flow.md)

## Which model runs which node

```mermaid
flowchart TB
  N["a node needs a model"]

  N --> R1{"node.model set?"}
  R1 -->|yes| USE["use it"]
  R1 -->|no| R2{"template card pins a model?"}
  R2 -->|yes| USE
  R2 -->|no| STAMP["stamp pass picks from a pool"]
  STAMP --> USE
  USE --> EFF["reasoning effort<br/>node.thinking > run config > seat tier > default<br/>transport clamps per provider"]

  subgraph POOLS["pools — capability first, then tier"]
    direction TB
    P0["attach_media? → multimodal pool<br/>(tier:strong → the SOTA multimodal pool)"]
    P1["tier:strong → strong pool — ≥2 families"]
    P2["default → mid pool"]
    P3["tier:cheap → cheap pool"]
  end
  STAMP -.-> POOLS

  subgraph RULES["stamp rules, in priority order"]
    direction TB
    S1["chain affinity — inherit upstream, keep the prompt cache"]
    S2["sibling spread — siblings get different model families"]
    S3["rotation — spread load inside the tier"]
  end
  STAMP -.-> RULES

  classDef pick fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef pool fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef rule fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
  classDef plain fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
  class R1,R2,STAMP pick
  class P0,P1,P2,P3 pool
  class S1,S2,S3 rule
  class N,USE,EFF plain
```

Two things stay deliberately separate: a **template card** says *how* the work is done (method,
checklist, output discipline); a **seat or pool** says *who* does it (which model coordinate).
They compose freely — the same card runs on any model, one model executes many cards. That is the
main structural difference from a subagent, where "who" and "how" are welded into one definition.

**→ [Model layer in depth](docs/model-layer.md)** · [diagram source](docs/diagrams/04-model-layer.md)

## Why it holds together

Two halves of one principle. Systems that state only the first end up mechanising the model away;
systems that state only the second end up trusting it where trust is not checkable.

> **Reliability comes from outside the model.** Gates judge — did it happen, is it there, does it
> pass? Deterministic, zero-model, fail-closed. A model "having a look" is not a gate: when it
> silently does not run, nothing turns red.
>
> **Creativity comes from inside it.** Models generate — what to do, how to do it, what is still
> missing. Inside the gates, do not replace this with rules. Replacing generation with a mechanical
> rule marks a frontier model down to the expressive power of that rule.

Three corollaries that decide real designs:

1. **A deterministic detector is a floor, not a ceiling.** It guarantees the obvious miss does not
   get missed; it must never become the only thing allowed to notice something.
2. **Termination belongs to the engine; content belongs to the model.** Round caps and quorum are
   counted by the engine. Asking a model "are we done yet?" reintroduces the silent failure gates exist to remove.
3. **Gates sit at the joins, not on every step.** Treat a capable model like a capable person: check
   the work where being wrong is expensive; don't look over their shoulder while they think.

## Design rules

- **Contracts over prose.** Every seam is a typed schema; a plan that fails validation never runs.
- **Fail closed at the edges, fail open in the bookkeeping.** An unknown template name rejects the
  plan; a checkpoint that cannot be written only warns.
- **No silent success.** A file-producing node with no file on disk is a failure, not a claim taken
  on trust. Same for a "reviewed" screenshot that never existed.
- **Cross-family or it doesn't count.** A verifier from the author's own model family shares its
  blind spots; so do three research lenses on one family.

## Docs

| | |
|---|---|
| [Architecture](docs/architecture.md) | passes, scheduling, fault boundaries, checkpoint & resume |
| [Primitives](docs/primitives.md) | the 12 control-flow shapes, and when to use plain nodes instead |
| [Model layer](docs/model-layer.md) | seats, pools, stamp rules, reasoning effort, multi-perspective review |
| [MCP tools](docs/mcp-tools.md) | all 33, grouped |
| [Memory](docs/memory.md) | fact store, hybrid recall, dream consolidation |
| [Diagrams](docs/diagrams/) | Mermaid source of truth for every figure above |

## License

MIT — see [LICENSE](LICENSE).
