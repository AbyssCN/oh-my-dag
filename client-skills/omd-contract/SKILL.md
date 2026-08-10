---
name: omd-contract
description: 把审议结论结晶成正式契约文档落盘 docs/plan/,当 /omd-execute 的执行契约。承接 /omd-grill 的决策记录表,写给没有对话上下文的执行器看。含 crystallize/crystals 职能。Trigger:/omd-contract、定契约、写成执行契约、写成 SDD、SDD、结晶、方案定了记下来、列结晶。
---

# /omd-contract — 审议结晶成执行契约

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
## 分解 (Breakdown)     依赖图 + 并行波形(见下方「分解段写法」)
## 非目标 (Non-goals)   明确不做什么(防 scope 蔓延)
## 未决 (Open)          还没裁的问题;有 pathfinder 图的附票 id,待实测的标「待实测」
```

**契约段是关键**:GWT 验收点写得越可证伪,`/omd-execute` 的四选一验收越不含糊。一个「模糊验收点」= 一个执行器和你各自解读的裂缝。

## 分解段写法 —— 默认并行,串行必须给理由

> 2026-08-10 并发实测的教训:SDD 写成「切片 1→2→3→4→5」的顺序清单,conductor 忠实翻译成
> 一条链,波内并行度归零,墙钟 ≈ 切片数 × 单片时长。**顺序偏好冒充依赖边,是墙钟的头号税。**

- **只写真实依赖边,禁写顺序偏好。** 每条依赖必须带理由:「B 依赖 A 因 <B 消费 A 的产物 X>」。
  写不出被消费产物的依赖边,删掉——那是偏好不是依赖。
- **切片表带写集列**:| 切片 | 写集 | 依赖(仅真实,带理由) | verify |。写集两两不相交
  是可并行的机器判据(与写集声明/orphan 对账同一真源)。
- **收尾必写并行波形一行**,conductor 直接照铺:如 `并行波形:{1,3,5} → {2} → {4}`。
  全串行的波形(每波单片)要在 SDD 里给出整体理由,默认视为写错。
- 优先序(哪片先做更有价值)若确有,写进 Open 段或波形注释,**不进依赖边**。

## 纪律

- 只写**已定型**的决策;未决进 Open 段(或直接 `map_add` 开票),不把猜测写成结论。
- 决策记录表里没证据的行,先补证据或降级进 Open,不裸奔进 Contracts。
- 写完提示 owner:确认后 `/omd-execute` 交 DAG 执行。
- 用户要看已有结晶(原 `/crystals`)→ `ls docs/plan/*.md` 按时间列给他。

## 与既有 skill 的边界

- `/omd-contract` 把**已收敛**的结论结晶成正式契约;审议过程本身在 `/omd-grill`(问透之前不结晶)。
- 一句话的轻量决策/引用 → `/omd-note` 记台账,不必起 SDD。
- 契约写完的执行 → `/omd-execute`,本 skill 不碰实现。
