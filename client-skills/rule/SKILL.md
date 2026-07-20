---
name: rule
description: 裁决 omd pathfinder 前沿票(记录 owner 决策到地图真相文件)。仅在 owner 明确给出裁决时使用。Trigger:/rule、裁决、就这么定、按方案X来。
---

# /rule — 裁决一张票

调 omd MCP server 的 `path_rule` 工具(可能带前缀 `mcp__omd__`;未加载先 ToolSearch "path_rule"),参数 `ticketId` + `ruling`(多图时带 `slug`)。

## 纪律

- **裁决权属于 owner**。只有当用户明确表达了决定("就用 SQLite"、"按方案 B 来"、"/rule t3 xxx")才调用;你的角色是把 owner 的口头决定提炼成一句清晰的 ruling 文本(task 票的 ruling 会成为将来 slice 节点的执行目标 goal,要写得让弱 executor 也能独立完成)。
- 用户表达模糊时,先复述你理解的裁决内容让其确认,再落盘。
- 裁决后工具会重算前沿并回报:新解锁了哪些票、区域是否散尽。**区域散尽只是报信**——执行永远等 owner 显式说 /deliver,你不要自作主张接着交付。
- 想撤销/改判:地图是 `docs/plan/pathfinder/<slug>.md` 人可编辑的 markdown,直接改 status/ruling 字段即可(未知状态词不会丢票,会进 unrecognized 分组)。
