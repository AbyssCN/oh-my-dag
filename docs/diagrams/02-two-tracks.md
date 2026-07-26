# 02 — 两条主线:组合模式与图模式

- **Version**: v1.0.0
- **Status**: Active
- **Last updated**: 2026-07-26
- **Related**: [architecture](../architecture.md) · [01 engine flow](01-engine-flow.md) · [model-layer](../model-layer.md)

> 真理源。README(中英两份)嵌的是同一段代码块。

## Diagram

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

**怎么选**:2–5 步、每步你都想看一眼 → 组合模式。≥10 个节点要并发跑、要能断点续跑 → 图模式。
两边共用同一套闸与同一套模型经济学 —— 换轨道不换可靠性。

## Rationale

- **图不是入口,是一种执行模式。** 计划期那四个纯函数 pass(剪枝/去重/证据闸/钉模型)的价值随图的规模增长,而成本固定 —— 3 步的组合里它们一分钱不值,40 节点扇出里它们是命根子。所以入口该由**规模**决定,而规模判断正是调用方那个 SOTA agent 最擅长的。
- **两条线共用底座是重点,不是巧合。** 组合模式如果绕开闸,就退化成"用 MCP 包装的裸模型调用";图模式如果不能被单步调用,大量小活会被迫套一张图。共用底座让两条线互为退路。
- **谁当 harness**:探索性任务的规划不该钉进图里,而该在 harness 里涌现。omd 的答案是**调用方那个 SOTA agent 就是 harness** —— 不另建一个规划框架。

## Changelog

| Version | Date | Change | Reason |
|---|---|---|---|
| v1.0.0 | 2026-07-26 | 首版 | 定位从"图是唯一入口"改为双主线 |
