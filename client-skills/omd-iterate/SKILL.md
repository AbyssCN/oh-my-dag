---
name: omd-iterate
description: 外层 fixpoint 迭代执行:跑 omd DAG → 评结果 → 带失败原因重画,直到收敛或到轮数上限。Trigger:/omd-iterate、迭代收敛、没收敛再来一轮、定点修。
---

# /omd-iterate — fixpoint 迭代(跑→评→重画)

对应 pi TUI 的 `/omd-iterate`。在 MCP 世界里 fixpoint 的"评"由你(runtime 模型)担任——这正是原设计意图:judge 要有全上下文。

## 流程

1. `dag_run`(omd MCP;未加载先 ToolSearch "dag_run")执行任务,`dag_status`/`dag_result` 拿本轮产物。
2. **你当收敛 judge**:对照任务目标逐项评估本轮结果——达标即收敛,报告并停;未达标则写出**具体失败原因**(哪个节点产物不合格、缺什么)。
3. 未收敛 → 重画:新一轮 `dag_run`,task = 原任务 + `[上一轮未收敛] <失败原因>\n请针对性重新分解修复`。
4. 默认最多 3 轮;到上限仍未收敛 → 停下向 owner 报告卡点和建议(升级模型/改任务/人工介入),不要无限烧。

## 与 /omd-execute 的分工

/omd-execute 是"SDD → 一次执行 → 验收四选一"的交接协议;/omd-iterate 是验收选了"迭代"之后的定点收敛循环,或没有 SDD 的中型任务直接迭代。
