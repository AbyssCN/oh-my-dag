---
name: omd-deepen
description: git 热点架构加深扫描:经 omd dag_deepen 确定性挑高摩擦模块,并发找浅模块(删除测试/深接口草图),跨热点归并重复逻辑,按 leverage 排序产 HTML 报告。Trigger:/omd-deepen、架构加深扫描、热点扫描、找浅模块、找重构机会、deepening。
---

# /omd-deepen — 架构加深扫描

经 omd MCP 的 `dag_deepen`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_deepen")。不是让一个 agent 满仓乱逛,而是:**确定性热点 pass**(按近期 commit 的 git 触碰频率算,零 LLM)先挑出摩擦真正所在的模块 → **一热点一 leaf 并发扫**,各自用删除测试猎浅模块 → **合成 leaf** 归并跨热点的重复逻辑并按 leverage 排序。产物是一张 HTML 报告(每个候选一卡:文件/摩擦度/删除测试判定/before-after 接口草图/强度)。

## 用法(参数都可省)

- `commits`:回看多少条 git 历史算热点(默认 200)。热点太旧、近 N commit 无代码触碰会报错 → 加大重试。
- `hotspots`:扫描的热点目录个数(默认 6)。想更广加大,想快减小。
- 想只扫某方向 → 给一个 scope 路径,跳过全仓排序。

## 流程(异步三段式)

1. `dag_deepen(commits?, hotspots?)` → 拿 `runId`;
2. `dag_status(runId)` 轮询,别重复发起;
3. `dag_result(runId)` 取 **HTML 报告落盘路径** → 交给 owner;要转述要点自己 `Read`。

## 浅模块判据(报告在找什么)

- **接口比实现贵**:调用方要记的规矩、要传的参数、要处理的返回态,比这模块干的活还多 → 浅,该加厚(把复杂度吞进去,让接口变窄)。
- **壳层**:只做转发/改名/透传的中间层,删了调用方直连也不塌 → 删除测试不通过 = 删。
- **删除测试**:假设这模块不存在,调用方要多写多少?几乎不多写 → 它没在挣它的位置。
- **跨热点重复**:同一段逻辑在 N 处手抄 → 一个共享工具候选(这是单点扫描看不见的全局赢面,靠合成 leaf 捞)。
- **按 leverage 排序**:机会大小 × 热点温度。冷模块的浅不用管——**没在付的摩擦不重构(架构的 YAGNI)**,widen 用 `commits` 不满仓巡。

## 转述纪律

候选是**输入不是结论**:dag_deepen 从不改文件、不开 PR。按 leverage 讲给 owner,不替他拍板改哪个;真要动某模块,先 `/omd-grill` 或 `/omd-sdd` 把方案钉死再走 `/omd-execute`。

## 与既有 skill 的边界

- `/omd-deepen` = git 热点**架构加深**(浅模块去壳加厚 / 收敛复杂度),只出候选不动手。
- 不用于:审 diff 找 bug → `/omd-review`;删镀金/过度工程 → `/omd-slim`;把候选钉成方案 → `/omd-grill` + `/omd-sdd`。
