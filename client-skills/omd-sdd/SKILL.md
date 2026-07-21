---
name: omd-sdd
description: 把审议结论结晶成正式 SDD 文档落盘 docs/plan/,当 /omd-execute 的执行契约。承接 /omd-grill 的决策记录表,写给没有对话上下文的执行器看。含 crystallize/crystals 职能。Trigger:/omd-sdd、写成 SDD、结晶、方案定了记下来、列结晶。
---

# /omd-sdd — 审议结晶成执行契约

对应 pi TUI 的 `/sdd`(并入 `/crystallize`、`/crystals` 职能)。审议(`/omd-grill`、pathfinder 裁决)收敛后,把结论写成结构化 SDD 落盘——它是 `/omd-execute` 的执行契约,写给**没有对话上下文的执行器**看,不是给人读的散文。

## 承接 /omd-grill 的决策记录表

`/omd-grill` 收尾产的是一张**决策记录表**(不是散文):

| # | 决策 | 定论 | 落点(/omd-note · pathfinder 票 · SDD 章节) | 证据 |
|---|------|------|--------------------------------------------|------|

本 skill 把这张表**结晶成 SDD**:表里落点标「SDD 章节」的行 → 进下面的「决策」与「契约」段;标 `/omd-note` 的轻量决策留在台账不必入 SDD;标 pathfinder 票的附票 id 进「未决」段。表里「待 owner / 待实测」的未解项 → 原样进「未决」段,绝不当成结论写死。

## 落盘

路径:`docs/plan/YYYY-MM-DD-<slug>.md`(日期用今天,slug 从主题取 kebab-case)。

每段都要能被无上下文的执行器独立消费:

```markdown
# <标题>
## 目标 (Destination)   一句话讲清做成什么样
## 决策 (Decisions)     D-1..D-N:每条已定型裁决 + 一句为什么 + 证据(承决策记录表)
## 契约 (Contracts)     不变量 + GWT 验收点(Given/When/Then)——/omd-execute 逐条判 pass/fail 的依据
## 分解 (Breakdown)     建议施工切片与依赖(conductor 可参考,不必照抄)
## 非目标 (Non-goals)   明确不做什么(防 scope 蔓延)
## 未决 (Open)          还没裁的问题;有 pathfinder 图的附票 id,待实测的标「待实测」
```

**契约段是关键**:GWT 验收点写得越可证伪,`/omd-execute` 的四选一验收越不含糊。一个「模糊验收点」= 一个执行器和你各自解读的裂缝。

## 纪律

- 只写**已定型**的决策;未决进 Open 段(或直接 `path_add` 开票),不把猜测写成结论。
- 决策记录表里没证据的行,先补证据或降级进 Open,不裸奔进 Contracts。
- 写完提示 owner:确认后 `/omd-execute` 交 DAG 执行。
- 用户要看已有结晶(原 `/crystals`)→ `ls docs/plan/*.md` 按时间列给他。

## 与既有 skill 的边界

- `/omd-sdd` 把**已收敛**的结论结晶成正式契约;审议过程本身在 `/omd-grill`(问透之前不结晶)。
- 一句话的轻量决策/引用 → `/omd-note` 记台账,不必起 SDD。
- 契约写完的执行 → `/omd-execute`,本 skill 不碰实现。
