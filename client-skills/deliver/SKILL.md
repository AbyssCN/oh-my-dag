---
name: deliver
description: 执行 omd pathfinder 已散尽区域(编译 slice → 跑 DAG 真改文件 → 票翻 delivered)。这是 deliberate/build 的权力闸,仅在 owner 明确下令交付时使用。Trigger:/deliver、交付、开始执行、动手吧。
---

# /deliver — 显式交付闸

调 omd MCP server 的 `path_deliver` 工具(可能带前缀 `mcp__omd__`;未加载先 ToolSearch "path_deliver")。多图时带 `slug`。

## 这是权力闸,不是普通命令

- **只有 owner 明确下令**("交付"、"执行吧"、"/deliver")才调用。区域散尽的报信不构成执行授权。
- 调用前向 owner 确认一句交付范围:哪些票(ruled task)、将执行什么(各票的 ruling 即节点目标)。
- 工具行为:零 LLM 编译 slice(票→DAG 节点,blockedBy→依赖边)→ 跑 executor DAG(agent 叶子带工具**真改文件**)→ **全节点 done 才把票翻 delivered**;有节点失败则不标记、报错、可修复后重试。
- 执行可能要几分钟(真实 DAG 跑模型)——这是预期的,不要中途放弃重调。
- 交付完成后:转述执行摘要,建议用户 review 实际改动(git diff),然后继续裁下一层前沿。
- 报"未配 leaf 模型"时:让用户设 `OMD_ITER_LEAF_MODEL`(或 `OMD_RUNTIME_PROVIDER`/`OMD_RUNTIME_MODEL`)——模型坐标是 harness 旋钮,任何 provider 都行。
