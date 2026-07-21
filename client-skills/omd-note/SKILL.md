---
name: omd-note
description: 把定型的决策/参考资料轻量记进持久台账 docs/plan/NOTES.md,供 /omd-sdd 收割。记 why 不复制内容、遮敏感信息、追加不覆盖。含 ref 职能。Trigger:/omd-note、记下来、这个决定记一下、留个引用。
---

# /omd-note — 决策台账

对应 pi TUI 的 `/note`(并入 `/ref` 职能)。审议中定型的决策要**当场持久化**——上下文会被压缩,没记下的决策等于没做过。追加到目标 repo 的 `docs/plan/NOTES.md`(没有就建)。

```markdown
- [2026-07-21] 决策: 用 SQLite 不用 Postgres — 单机部署, 运维成本优先
- [2026-07-21] 参考: docs/plan/2026-07-19-omd-mcp-server.md §D-9 — server 退出双保险的由来
```

## 三条原则(直接降 token)

1. **引用不复制** — 记决策就记 **why**,引已有产物(commit sha / plan path / 前沿票 slug / 报告路径)只写它的 **path**,绝不把内容内联复制进台账。代码里 git diff 已有 **what**,台账只补 **why**。
2. **遮敏感信息** — 台账里遮掉 secret / API key / token / PII,命中写 `<redacted:kind>`。台账进 git,泄漏一次撤不回。
3. **追加不覆盖** — 新条目追到台账,旧条目原样留(时间线可回溯)。台账太长时最旧的批量移到 `docs/plan/_JOURNAL.md`,不在 NOTES.md 里删历史。

## 升级路径

- 决策属于某张 pathfinder 地图的票 → 优先 `/omd-rule` 落到地图(那是更强的真相源);没对应票但成体系 → `/omd-path` 开票再裁。
- NOTES.md 是**轻量暂存**;审议收敛时 `/omd-sdd` 把这些条目收割进正式 SDD 的 Decisions 段。

## 与既有 skill 的边界

- `/omd-note` = 轻量记台账(一句话决策 + 引用)。**不用于**:
  - 结晶成正式 SDD 契约文档 → `/omd-sdd`;
  - pathfinder 前沿票的裁决落真相文件 → `/omd-rule`(那是带判定纪律的正式裁决,不是随手记)。
