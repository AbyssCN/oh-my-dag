# 03 — 能力地图:哪些烧模型,哪些不烧

- **Version**: v1.0.0
- **Status**: Active
- **Last updated**: 2026-07-26
- **Related**: [mcp-tools](../mcp-tools.md) · [architecture](../architecture.md)

> 真理源。工具清单本身在 [mcp-tools.md](../mcp-tools.md);这张图只回答两个问题:
> **有哪几类能力** 和 **哪些是零模型的**。

## Diagram

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

**青 = 零模型**(可计算、不会幻觉、失败必然可见)· **紫 = 每次都调模型** · **橙 = 混合**(图里既有 command 闸也有 leaf)。

零模型的那几个是整套设计的承重墙:`omd_web` 只抓不判、`omd-shots-verify` 只数像素不评美丑、`omd_shapes` 只发知识不做决定。**它们坏了会立刻红,不会静默通过。**

## Rationale

- **按"烧不烧模型"上色,而不是按功能上色。** 功能分组读者自己看名字就能猜;真正影响成本与可靠性的是"这一步会不会幻觉"。
- **`omd_web` 与 `dag_research` 刻意分开画。** 前者零模型只负责把料拿回来,后者才做综合判优 —— 三段链(抓/综合/蒸)独立可调是它们的设计前提,画在一起会让人以为必须一起用。
- **卡(template)也画进来。** 它不是 MCP 工具,但它是"知识"这一类里与 `omd_shapes` 对偶的另一半:shape 管图长什么样,card 管节点里怎么干活。

## Changelog

| Version | Date | Change | Reason |
|---|---|---|---|
| v1.0.0 | 2026-07-26 | 首版 | 需要一张能力全景, 并标出零模型的那几处承重墙 |
