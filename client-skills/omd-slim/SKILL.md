---
name: omd-slim
description: 精益审计:先扫 ponytail: 债务台账记已知欠账,再经 omd dag_slim 派车队按 global-first 两遍法找过度工程(镀金/过度抽象/死复杂度),只删不加。Trigger:/omd-slim、找过度工程、瘦身、YAGNI 检查、债务台账。
---

# /omd-slim — 精益审计(先债后瘦)

两步:先把**已知欠账**(你主动留的 `ponytail:` 捷径)收成台账,再让车队找**你没意识到的过度工程**。两者不同——债是你故意留的,过度工程是意外长出来的。

## Pass 0 — debt 台账(先记已知债)

跑 `bun run scripts/omd-debt.ts [--paths "src,scripts"]`:纯 grep 扫全仓 `// ponytail: <天花板>, <升级触发>` 标记,收成 ledger(缺升级触发的标 `-` = rot 风险)。零 LLM。让"以后再说"不烂成"永远不说"。这是**已知债的账**,不判对错,只收拢。

## Pass 1+2 — 过度工程专审(经 dag_slim)

调 omd MCP `dag_slim`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_slim"),`scope` 可选收窄。异步三段式:`dag_slim(scope?)` → `dag_status` 轮询 → `dag_result` 取报告路径自己 `Read`。车队按 **global-first 两遍法**(系统级先跑,-50% 在这):

**Pass 1 — global(系统级)**:跨文件找 —
- `dedup:` 同一逻辑手写在 N 处 → 一个共享 util(最大赢面)
- `collapse:` 一个概念的并行实现 → 合并成一个
- `layer:` 没人需要的整层/包装/间接 → 删掉这层
- `couple:` 局部"最小"选择造成的耦合/重复 → 全局一致的替代

**Pass 2 — local(逐 hunk)**:`delete:` 死代码/用不上的灵活性 · `stdlib:` 标准库/Bun 已有 · `native:` 平台已有(CSS/DB 约束)· `yagni:` 单实现的抽象/无人设的配置 · `shrink:` 同逻辑更少行。
格式:`L<行>: <tag> <what>. <replacement>.`

## 不要 flag(不是膨胀)
文档化的 `ponytail:`/DEFER、契约面、刻意留的扩展缝 = 规划非投机,别 yagni/delete;前端体验代码(动效/状态/层级)= 交付物非灵活性,别删。

## 转述纪律
每条删除建议给"删了它谁受损"的反证——确认无真实调用方 + 无近期演进信号才建议删。报告是候选,动手前自己核实引用面,别凭车队一句话砍代码。

## 与既有 skill 的边界
- omd-slim = **只找过度工程 + 记已知债**,只删不加。**找 bug/正确性** → /omd-review;**扫安全** → /omd-audit;**架构浅模块加厚(是"加"不是"删")** → /omd-deepen。
