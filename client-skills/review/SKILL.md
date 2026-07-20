---
name: review
description: 对一批改动做对抗式 DAG 审查:经 omd dag_review 派多维度审查车队,gate 阶梯控制深度,产结构化 findings 报告。Trigger:/review、审查这批改动、代码审查、review diff、release 闸。
---

# /review — 对抗式改动审查

对应 omd 车队的 `dag-review`。经 omd MCP 的 `dag_review`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_review")对一批改动派多维度对抗审查 DAG。

## 用法

参数都可省,按审查深度选:

- `gate`: `G0` 浅扫(快/便宜) · `G1` 轻量 · `G2` 默认,branch diff 全维度 · `G3` release 闸(spec 轴强制对照 SDD)。不给 = G2。
- `scope`: 收窄审查范围(如限定路径/模块);不给 = 当前 branch diff 全量。

## 流程(异步三段式)

1. `dag_review(gate?, scope?)` → 拿 `runId`;
2. `dag_status(runId)` 轮询(审查要跑几分钟,耐心等,别重复发起);
3. `dag_result(runId)` 取产物 → 里面是**报告落盘路径**,自己 `Read` 该文件再转述。

## 转述纪律

findings 按严重度排序先讲 top 项;finding ≠ ground truth,可疑项自己动手读代码证实攻击/失败路径后再定性——车队产出是候选,你负责终裁。确定性规则扫描(semgrep)走 /sast,两者互补。
