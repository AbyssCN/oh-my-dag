---
name: omd-path
description: 打开/新建/列出 omd pathfinder 决策地图(经 omd MCP server)。大而模糊的多 session 工作先开图:把待决问题变成票,渐进散雾。Trigger:/omd-path、pathfinder、开图、决策地图、这活儿太大先规划。
---

# /omd-path — pathfinder 决策地图

你在驱动 omd 的 pathfinder 模式(TUI-less,经 omd MCP server 的 `path_*` 工具;工具名可能带前缀如 `mcp__omd__path_map`,未加载时先 ToolSearch "path_map")。MCP server 的 cwd 决定作用的 repo。

## 后端(md / gh)

pathfinder 有两个可选后端,同一套 `path_*` 工具面语义等价:

- **md 后端(默认)**:地图真相存 `docs/plan/pathfinder/<slug>.md`(人可读可编辑)。
- **gh 后端**:票据生命周期迁 GitHub Issues(map = `🧭 [map]` issue,票 = `[<type>]` sub-issue,ruling = resolution 评论 + close),AFK research 上 GitHub Actions。

后端选择由 `.omd/pathfinder/config.json` 落定(`{"backend":"gh"|"md"}`),由 `path_init` 写入;缺省或无 GitHub remote → md。

## path_init — 两步引导流(开图前先接线后端)

新 repo 首次用 pathfinder 先跑 `path_init`,它是两步流:

1. **报告模式**:`path_init`(不传 `backend`)→ 返回环境探测报告(git repo / GitHub remote / `gh auth` scope / repo 公私 / Actions / 机器级 key)+ 推荐答案。先把报告转述给 owner。
2. **执行模式**:owner 确认后 `path_init` 带 `backend`(`gh`|`md`)+ `destination`(+ gh 时 `cloudAfk`:public 仓开云端 AFK = 决策历史公开可读,须 owner 明示)→ 建 labels / map issue / caller workflow / secrets / workflow_dispatch 干跑金丝雀 / 落 config。
   - 缺什么报什么 + 修复命令(如 `gh auth refresh -s workflow`),照报错补齐再重跑。

已建好后端的 repo 直接用 `path_map`,不必再 init。

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
