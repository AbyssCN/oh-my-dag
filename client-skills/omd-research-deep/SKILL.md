---
name: omd-research-deep
description: 终极档深度调研:种子作者化多角度抓取 + council 分解 + 多轮缺口补挖,一条工具调用出整领域 grounded 报告。Trigger:/omd-research-deep、深度调研、deep research、整领域调研、调研到 grounded 底座、把这个领域研究透。Skip:轻量单点查证(tavily 直查)/ 单问题综合(dag_research 默认档)/ 代码理解(dag-map)。
---

# /omd-research-deep — 终极档深度调研

调 omd MCP `dag_research`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_research"),
开 **`super: true`** + **`rounds: 3`**。管线全在引擎内跑完才返回,**引擎计数,不问模型"够了吗"**:

1. **种子作者化**(`super` 开的就是这个)— 模型把问题拆 3-4 个互补角度 query
   (机制 / 实践 / 反面 / 生态),各自独立检索并入语料。
2. **council 分解** — conductor 按全部语料 author 领域专家 lens → L×V fanout →
   per-lens 判优 → 综合 → judge panel → graft。(`council` 默认就是开的,不用传。)
3. **多轮缺口补挖**(`rounds`,上限 4)— 轮间做 [模型缺口分析 + 确定性 probe:
   引用集 − 已抓集 的缺料补抓],**无新增即提前停**;二轮起 challenger lens 只挖缺口不重答原题。

## 用法

```
dag_research(question: "<研究问题>", super: true, rounds: 3)
```

- **异步返回**(spawn detached 子进程):立即回 `runId`,用 `dag_status` 轮询到完成再取报告(真源 `src/mcp/tools/research.ts` 的 detached 分支)。
- `summary` 进对话;**全文在 `reportPath`**(lens 冠军 + 逐轮缺口留痕 + 全部语料附录零丢失)。
  关键决策**必须 `Read` 那个文件**,别只看 summary。
- 转述纪律:结论 + 来源 URL + 哪轮缺口补出了什么;「语料未覆盖」的部分**如实说**。
- 成本形状:种子×检索 + council + ≤N 轮,比默认档 `dag_research` 贵数倍
  ——**真要挖透的领域才用**。

## 前置与降级

- **必须有 search provider**:`TAVILY_API_KEY` / `ANYSEARCH_API_KEY` / `SEARXNG_URL` 任一。
  没有 → 工具**响亮拒绝**(不会静默降级成"看起来像调研的一段话")。这是有意的:
  没有 web 就没有调研。
- **锚点文件 / 显式种子 query 不在 MCP 面上**:`--anchor`(把已有设计笔记原样送进
  groundTruth 之首)和 `--queries`(给死种子、不作者化)只有源码档的
  `bun run scripts/dag-research.ts` 有。要这两个 → 直接跑脚本(需 omd 源码/包目录),
  或把锚点要点写进 `question` 正文。

## 与既有能力的边界

- `dag_research` **默认档**(不开 `super`)= 单问题综合,便宜得多 —— 大多数调研用它就够。
- `omd_web` = 只抓不综合 · `omd_distill` = 吃已有料蒸洞察 · `dag-map` = codegraph 代码理解。
- 轻量单点查证走客户端自带的 web 检索,别为一个事实起这条管线。
- 领域法定源 RAG(会计/法条类)不在此管线。
