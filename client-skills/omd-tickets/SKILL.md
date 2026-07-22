---
name: omd-tickets
description: 查看 omd pathfinder 当前地图前沿票,并拉取已落地的 AFK research 结果(pull 回流 + 预算内自续)。Trigger:/omd-tickets、前沿、看票、研究结果回来了吗。
---

# /omd-tickets — 前沿与回流

调 omd MCP server 的 `path_tickets` 工具(可能带前缀 `mcp__omd__`;未加载先 ToolSearch "path_tickets")。多张开放地图时带 `slug` 参数。

这个工具做三件事,输出直接转述给用户:

1. **回流**:把已落地的 AFK research 结果折进地图(母票自动裁决,`## children` 段孵出子票);
2. **自续**:新孵的 research 子票在预算内(`OMD_PATH_RESEARCH_BUDGET`,默认 12,跨 session 计数)自动续派后台;预算耗尽会提示——转告用户可调预算或用 `path_prefetch` 显式追加;
3. **前沿**:列出当前可动的票 + 状态计数;若区域散尽(全部 task 票已裁且编译通过)会提示可 `/omd-deliver`。

AFK research 是 detached 子进程,对话期间它在后台跑;用户问"研究跑完了吗"就调一次这个工具拉结果。前沿里的 grill/task 票需要 owner 裁决——列出来并给出你的推荐裁决,等 owner 用 /omd-rule 定夺。

## gh 后端的折入语义(与 md 等价,来源不同)

后端是 GitHub Issues 时,回流从 md 落盘文件换成 issue 状态,语义不变:

- **research-done 评论回流**:AFK 研究在 GitHub Actions 上跑完,结果作为 bot 评论落到 research 票上并打 `research-done` label;`path_tickets` 折入时读这条评论(md 则读 `.omd/pathfinder/results/` 落盘文件)。
- **children 挂母票 sub-issue**:结果里 `## children` 段孵出的子票经原生 sub-issue 挂在母票下(血缘 = sub-issue,前沿依赖 = blocked-by);子票默认 blockedBy 母票。
- **警告不 ack、下轮重试**:评论缺失 / 解析失败 → 票标注警告(输出里 `⚠ … 未折入`)、**不摘 `research-done` label**(即不 ack),下次 `path_tickets` 重试;绝不静默跳过、也不造假占位裁决。成功折入才摘 label(幂等锚点)。
