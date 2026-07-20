---
name: slim
description: 过度工程专审:经 omd dag_slim 派车队扫描这批改动里的镀金/抽象过度/死复杂度,产瘦身建议报告。Trigger:/slim、找过度工程、过度设计、瘦身、YAGNI 检查。
---

# /slim — 过度工程专审

对应 omd 车队的 `dag-slim`。经 omd MCP 的 `dag_slim`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_slim")对改动做过度工程专项扫描:镀金功能、用不上的抽象层、 speculative generality、死参数死分支。

## 用法

- `scope`: 可选,收窄扫描范围(路径/模块);不给 = 当前 branch diff 全量。

## 流程(异步三段式)

1. `dag_slim(scope?)` → 拿 `runId`;
2. `dag_status(runId)` 轮询,别重复发起;
3. `dag_result(runId)` 取**报告落盘路径** → 自己 `Read` 再转述。

## 转述纪律

每条瘦身建议给出"删了它谁受损"的反证检查——确认无真实调用方/无近期演进信号才建议删。报告是候选清单,动手删之前自己核实引用面,别凭车队一句话砍代码。
