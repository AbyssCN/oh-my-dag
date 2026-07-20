---
name: note
description: 把定型的决策/参考资料记进持久台账(docs/plan/NOTES.md),供 /sdd 收割。含 ref 的职能。Trigger:/note、记下来、这个决定记一下、留个引用。
---

# /note — 决策台账

对应 pi TUI 的 `/note`(并入 `/ref` 的职能)。审议中定型的决策要**当场持久化**——上下文会被压缩,没落盘的决策等于没做过。

## 落盘

追加到目标 repo 的 `docs/plan/NOTES.md`(没有就建):

```markdown
- [2026-07-20] 决策: 用 SQLite 不用 Postgres — 单机部署, 运维成本优先
- [2026-07-20] 参考: https://… — <一句为什么有用>
```

## 升级路径

- 决策属于某张 pathfinder 地图的票 → 优先 `path_rule` 落到地图(那是更强的真相源);没有对应票但成体系 → 建议 `path_add` 开票再裁。
- NOTES.md 是轻量暂存;审议收敛时 /sdd 会把它们收割进正式 SDD 的 Decisions 段。
