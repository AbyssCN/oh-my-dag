---
name: council
description: 多视角专家议会:宽解空间的设计/决策问题,经 omd dag_research(council 模式)并行多 persona 出方案 + 多 lens 评审择优。Trigger:/council、开会审议、多方案对比、给我几个选项、拿不准选哪个。
---

# /council — 多视角议会

对应 pi TUI 的 `/council`。面对**宽解空间**的问题(多个合理方案、拿不准),不要一次性给平均答案——调 omd MCP 的 `dag_research` 工具(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_research"),开 council 模式。

## 用法

- `dag_research` 参数:`question` = 问题 + 你整理的上下文(现状、约束、已知选项);`council: true`(conductor 自动分解 lens);深题加 `super: true`(全 framing × 全评判维度)。
- 返回 `{runId, reportPath, summary}`——summary 进对话,**全文报告在 reportPath**(.omd/research/ 下),关键决策要 Read 报告看各 lens 冠军和评审细节,别只看 summary。
- 转述时:先给冠军方案 + 为什么赢,再列亚军的可嫁接亮点,最后给你自己的判断(你有议会没有的对话上下文)。

## 何时不用

单一明确解(直接做)、需要 web 证据(先普通 dag_research 检索再 council)、纯执行无需择优。定型的结论走 /note 或 path_rule 落盘。
