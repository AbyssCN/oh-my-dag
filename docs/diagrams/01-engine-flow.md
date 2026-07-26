# 01 — DAG 引擎:架构与流转

- **Version**: v1.0.0
- **Status**: Active
- **Last updated**: 2026-07-26
- **Related**: [architecture](../architecture.md) · [model-layer](../model-layer.md) · [primitives](../primitives.md)

> 本图是**真理源**。改引擎 = 改这里的 Mermaid,`git diff` 即变更史。README 里嵌的是同一段代码块,
> 不是导出的图片 —— 栅格图改不动局部、diff 无意义、也没有地方写"为什么这么改"。

## Diagram

```mermaid
flowchart TB
  TASK(["TASK"])

  subgraph PLAN["1 · PLAN — one LLM call, everything after it is a pure function"]
    direction TB
    CD["Conductor<br/>decomposer seat · frozen prefix + task"]
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
    VF["Verifier<br/>verify seat · cross-family · fails on doubt"]
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

配色即语义:**紫 = 烧 LLM** · **青 = 确定性/零 LLM** · **橙 = 执行体** · **灰 = 引擎结构件**。
图内标签用英文:同一段 Mermaid 同时嵌进英文与中文 README,单一真理源不做两份。

## 扇出角色与它们的档位

```mermaid
flowchart LR
  subgraph S1["研究/量产 —— cheap · mid 池"]
    R1["research 簇 · lens<br/>并行兄弟,一人一个角度"]
    R2["reduce<br/>每镜头出冠军,高频"]
  end
  subgraph S2["判断 —— strong 池 (≥2 家族)"]
    J1["synthesis · judge<br/>选冠军,闸住整轮"]
    J2["council · best-of-N · tournament<br/>N 次尝试 → judge requires:K"]
  end
  subgraph S3["证伪 —— verify 座"]
    V1["verifier · review-spec<br/>必须跨家族:同家族=同盲点"]
  end
  R1 --> R2 --> J1 --> V1
  J2 --> V1
  classDef a fill:#FAECE7,stroke:#993C1D,color:#4A1B0C
  classDef b fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef c fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  class R1,R2 a
  class J1,J2 b
  class V1 c
```

## Rationale(为什么是这个形状)

- **规划只有一次,其余全确定性。** 图画错的代价是全图白干,所以规划值得花 SOTA;而画完之后的
  每一步变换(剪枝/去重/证据闸/钉模型)都是纯函数 —— 同图进同图出,可测试、可 diff、不会因为
  模型今天心情不同而变。可靠性来自模型之外。
- **改图形状的 pass 必须排在 stamp 之前。** 任何新增节点的 pass 若排在 stamp 之后,新节点就拿不到
  池分配的模型 —— 补了等于没补。
- **oracle 闸与 verifier 分开画,不合并成"审核"。** 前者是 `tsc`/test,零 LLM,不会幻觉,是精度背板;
  后者是模型判断,是召回。把两者混成一格会让人以为"审过了"是同一件事。
- **verifier 必须跨家族。** 同家族模型共享训练偏好与盲点,自己证伪自己等于走过场。
- **escalation 出补丁而不是新图。** 指望重规划模型「逐字保留其余节点」是不可靠的(跨轮重措辞很常见);
  改成只输出节点补丁、引擎程序化 merge 之后,未补丁节点字节不动,语义指纹复用按构造成立。
- **checkpoint 画成旁挂而不是流程中的一环。** 它对主流程是透明的:写失败只 warn 不阻断
  (fail-open),但 resume 时它是唯一的真相来源 —— 输入哈希不变的节点直接判绿。

## Changelog

| Version | Date | Change | Reason |
|---|---|---|---|
| v1.0.0 | 2026-07-26 | 首版:三段泳道 + UI 证据支线 + oracle/verifier 分列 + heal/escalation 两条回路 + checkpoint 旁挂 + 扇出角色档位图 | 承 bluebell 图体系裁决,把架构图从手摆的 SVG 换成 Mermaid 真理源:手摆坐标改不动局部,且引擎会一直变 |
