---
name: tickets
description: 查看 omd pathfinder 当前地图前沿票,并拉取已落地的 AFK research 结果(pull 回流 + 预算内自续)。Trigger:/tickets、前沿、看票、研究结果回来了吗。
---

# /tickets — 前沿与回流

调 omd MCP server 的 `path_tickets` 工具(可能带前缀 `mcp__omd__`;未加载先 ToolSearch "path_tickets")。多张开放地图时带 `slug` 参数。

这个工具做三件事,输出直接转述给用户:

1. **回流**:把已落地的 AFK research 结果折进地图(母票自动裁决,`## children` 段孵出子票);
2. **自续**:新孵的 research 子票在预算内(`OMD_PATH_RESEARCH_BUDGET`,默认 12,跨 session 计数)自动续派后台;预算耗尽会提示——转告用户可调预算或用 `path_prefetch` 显式追加;
3. **前沿**:列出当前可动的票 + 状态计数;若区域散尽(全部 task 票已裁且编译通过)会提示可 `/deliver`。

AFK research 是 detached 子进程,对话期间它在后台跑;用户问"研究跑完了吗"就调一次这个工具拉结果。前沿里的 grill/task 票需要 owner 裁决——列出来并给出你的推荐裁决,等 owner 用 /rule 定夺。
