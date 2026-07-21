---
name: omd-path
description: 打开/新建/列出 omd pathfinder 决策地图(经 omd MCP server)。大而模糊的多 session 工作先开图:把待决问题变成票,渐进散雾。Trigger:/omd-path、pathfinder、开图、决策地图、这活儿太大先规划。
---

# /omd-path — pathfinder 决策地图

你在驱动 omd 的 pathfinder 模式(TUI-less,经 omd MCP server 的 `path_*` 工具;工具名可能带前缀如 `mcp__omd__path_map`,未加载时先 ToolSearch "path_map")。地图真相存在目标 repo 的 `docs/plan/pathfinder/<slug>.md`(人可读可编辑),MCP server 的 cwd 决定作用的 repo。

## 用法

- `/omd-path` 无参 → 调 `path_map`(无 destination)列出所有开放地图。
- `/omd-path <目的地或 slug>` → 调 `path_map` 带 destination:已存在则 resume 并显示前沿,否则新建空图。
- 用户说"把 research 甩后台/预取" → 调 `path_prefetch`(research 票进 detached AFK 后台,不阻塞对话;结果在下次 `path_tickets` 拉取时自动折回)。

## 开图后的职责(重要)

1. **新图是空的**——你的第一件事是和用户把目的地拆成待决问题,用 `path_add` 逐张开票:
   - `research`:需要检索调研的开放问题(会被 AFK 自动跑,烧钱;宁缺毋滥);
   - `grill`:需要和 owner 审议对齐的决策;
   - `prototype`:需要沙盒验证的假设;
   - `task`:已明确到可施工的项(带 `executorKind`,默认 inproc;改文件的用 agent)。
   `blockedBy` 表达依赖:前置票全裁决后此票才进前沿。
2. 展示前沿后,主动建议下一步:哪张票该先裁(/omd-rule)、research 是否值得 prefetch。
3. **绝不**替 owner 裁决(/omd-rule)或触发交付(/omd-deliver)——那是 owner 的显式动作;你可以给推荐裁决词让 owner 确认。
