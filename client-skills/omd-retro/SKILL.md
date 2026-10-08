---
name: omd-retro
description: 一批 omd-lite(mcode / pi)run 合并后的复盘:先跑确定性汇总 omd-lite retro(零模型),再把 ≥ 2 次的重复模式按七类定位、分流到「闸 / 审查标准 / 任务书模板 / 不处理」四个去处,产出提案表交 owner 批;顺带 omd-lite gc 预览清 worktree。Trigger:/omd-retro、批后复盘、这批 run 复盘一下、坑变闸、retro。
---

# /omd-retro — 批后复盘:把重复的坑分流成闸或审查标准

契约:`docs/plan/2026-10-08-mcode-loop-retro-and-spec-axis.md`(oh-my-dag)§3。分类法来自 mattpocock/skills 的 `retro`。
**时机**:一批 omdl run 合并进 main 之后跑一次。**不自动改闸、不自动改模板**(D7)—— 产出是提案,owner 批了才落地。

## 步骤

1. **汇总(零模型)**:`omd-lite retro --since <批次开始日 YYYY-MM-DD>`(可再跟 label 只看某几个 run)。
   读末尾的「聚合」:首败闸 / 执行器失败 · 越界文件 · 执行器失败 · not-run / 中断原因 · 多轮占比。聚合只列 **≥ 2 个 run** 的模式(D6);单次的只记不提。
   - `执行器挂了(<码>)` 是执行器 / 供应商 / 调度的问题(限流、并发锁 `agent_name_conflict…:lock`、`CONTENT_REVIEW_BLOCKED`、spawn 失败),
     去处通常是调度规则或驱动,**不是**任务书;`执行体没交付(没有改动)` 才要回头读任务书与执行体的收尾报告。
   - 越界文件 ≥ 2 次 = 「允许改动」漏列候选(典型:登记处 —— i18n messages、规则注册表、index 导出)。
2. **清 worktree(预览)**:`omd-lite gc`(只打印路径 · 原因 · 大小)。把可清清单与总大小写进产出;**owner 批了再** `omd-lite gc --apply`。
   不对正在跑的批次跑 `--apply`;gc 自己也会跳过正在跑的 run、有未提交改动的、有被忽略产物的 worktree。
3. **补两路人工信号**(机器数不到的):
   - 本批 Aalto 返工:`git log main --since <批次开始日> --grep '<run 名>'` 里 merge 之后带 run 名的修正提交,读改了什么;
   - 本批 review(`/omd-review`,omdl run 一律带 `sdd: <任务书>`)里被 accept 的项。
4. **定位**:每个重复模式先按七类归因 —— Navigation(找不到该改的地方)· Automated checks(闸缺 / 闸错)· Coding standards ·
   AGENTS.md 瘦身(上下文太长被忽略)· Tool economy(工具用法浪费轮次)· No-ops(空转、没交付)· Information access(读不到该读的)。
5. **分流**(D5:**机械可判 → 确定性闸,没有例外;要判断 → 审查标准给 reviewer,不加给执行方**):
   - **闸**:plana `scripts/dev/gate-*.sh` 加一道,或 omd-lite 越界闸加预检。写出**具体命令**和它在本批哪几个 run 上会红。
   - **审查标准**:追加到 reviewer 的 `--extra` 焦点清单(plana `docs/process/` 下一份文件,首次 retro 时建)。
   - **任务书模板 / executor-brief**:只放导航指针和「Out of scope」,**不放规范条文**(执行方上下文压力最大,条文塞给它不生效)。
   - **不处理**:写明为什么(一次性、已修、成本高于收益)。
6. **产出**:在 plana `docs/process/omd-workhorse.md` 追加 `## <日期> · retro` 一节:聚合表原样 + gc 预览一行 + 提案表
   (模式 · 证据 run · 七类 · 去处 · 具体改法),交 owner 批。批之前不改闸、不改模板、不跑 `gc --apply`。

## 纪律

- 聚合里的数是**计数不是结论**:先读至少一个证据 run 的 `gate-round-<n>.log` / `mcode-round-<n>.log` 再下判断(一个在任何干预下都不动的数,通常量的是尺子)。
- 已经修过的坑(例如 harness 自己造的越界)写进「不处理 · 已修」,注明修它的提交,别再提一遍。
- 单次出现的模式不进提案表;如果你认为它危险到值得破例,标 `?` 交 owner,不要自己决定。
