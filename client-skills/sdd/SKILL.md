---
name: sdd
description: 把审议结论结晶成 SDD 文档落盘 docs/plan/(/execute 的执行契约)。含 crystallize/crystals 的职能。Trigger:/sdd、落盘方案、写成 SDD、结晶、方案定了记下来。
---

# /sdd — 审议结晶成执行契约

对应 pi TUI 的 `/sdd`(并入 `/crystallize`、`/crystals` 的职能)。审议(/grill、pathfinder 裁决)收敛后,把结论写成结构化 SDD 落盘——它就是 /execute 的执行契约,写给"没有对话上下文的执行器"看。

## 落盘

路径:`docs/plan/YYYY-MM-DD-<slug>.md`(日期用今天,slug 从主题取 kebab-case)。

结构(每段都要能被无上下文的执行器独立消费):

```markdown
# <标题>
## 目标 (Destination)      一句话讲清做成什么样
## 决策 (Decisions)        D-1..D-N: 每条已定型的裁决 + 一句为什么 (来自审议/pathfinder decisionsLog)
## 契约 (Contracts)        不变量 + GWT 验收点 (Given/When/Then, /execute 验收逐条判 pass/fail 的依据)
## 分解 (Breakdown)        建议的施工切片与依赖 (conductor 可参考, 不必照抄)
## 非目标 (Non-goals)      明确不做什么 (防 scope 蔓延)
## 未决 (Open)             还没裁的问题 (有 pathfinder 图的, 附票 id)
```

## 纪律

- 只写**已定型**的决策;未决的进 Open 段(或直接 path_add 开票),不要把猜测写成结论。
- 写完提示 owner:确认后 `/execute` 交给 DAG 执行。
- 用户要看已有结晶(原 /crystals)→ `ls docs/plan/*.md` 按时间列给他。
