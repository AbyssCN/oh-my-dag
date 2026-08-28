# 通用能力目录 —— 造新东西之前先查这里

[← overview](overview.md) · [seams](seams.md) · [primitives](primitives.md) · [docs-map](../docs-map.md)

> **这份表回答一个问题,而且只回答这一个**:
> **「我要造个 X,仓里有没有现成的能干这活?」**
>
> 现有的架构文档都不回答它 —— `overview.md` 讲流转、`seams.md` 是自动生成的引擎配置接缝、
> `primitives.md` 讲控制流原语。**没有一份是按「我要做什么」索引的**,于是查不到,
> 于是重造。本表按**意图**索引,不按目录位置索引:查表的人**不知道东西在哪**,
> 那正是它需要查表的原因。

---

## 0. 为什么有这份表 —— 三条同一天里发生的真事

**2026-08-28 这一天,同一个人(我)在同一个仓里犯了三次「重造已有件」:**

1. **重新发明了渐进式披露。** 我为「脊柱语料太大」设计了 A/B,造出「索引 + 真清单」这一臂,
   跑了五轮实验才由 owner 问出来 —— `omd_web`(`src/mcp/tools/web.ts:79-91`)**早就是这个形状**:
   原文写盘,回执只给命中索引 + 一行「全文语料(零丢失,按需 Read): <path>」。
   我花了几小时和几百万 token,重造了一个仓里已经跑着的设计。
2. **双 lens 蒸馏用了一半。** `omd_distill` 有 `expert` / `challenger` 两个镜头,
   注释写着「对偶才有增益」。我只用了 expert 那半,challenger **一次都没想起来**。
3. **判据自证已经有了,我还在手写反例。** `goal/acceptance-gate.ts` 的判据自证
   (把错样本摆进 `mkdtemp` 的临时世界跑一遍)就是「怎么证明这条判据不是虚的」的通用答案。

**三次的共同形状**:能力**在仓里**、**能用**、**我不知道它在**。
这不是记性问题 —— 470 个非测试 `.ts` 文件,没有按意图索引的入口就是查不到。

---

## 1. 硬流程(不是建议)

**造任何新件之前,按顺序走完这三步:**

1. **扫本表的「按意图查」那一节。** 命中 → 直接复用,不许"我这个场景特殊所以再写一个"。
2. **没命中 → 扫 `docs-map.md` 与 `seams.md`。** 前者是文档↔源的声明表,后者是引擎配置接缝。
3. **还是没有 → 才造。造完当次 PR 回填本表**,包括「它能不能被别处用」这一列。

**造完不回填 = 下一个人重造 = 今天这件事再发生一次。** 回填是造件的一部分,不是文档任务。

---

## 2. 两把镜头(与 `/omd-deepen`、`/omd-slim` 同源)

### 深模块 > 浅模块

**深模块 = 接口窄、内部厚**;浅模块 = 接口和实现一样宽,调用方还得知道内部怎么回事。

判据(可机械问):**这个件的导出面有几个符号?调用方要不要懂它内部才会用?**
- `repoProbe(queries, {cwd})` → 一个函数、两个参数,内部管 ugrep 转义/封顶/去重/排序 —— **深**。
- 一个导出 12 个 helper、调用方要自己按顺序拼的模块 —— **浅**,该把接口收窄。

深模块**天然可移植**,因为接口窄的东西没有几根线连出去。

### 通用模块 > 专用模块

**同一个能力被第二个场景需要时,不许复制一份改改** —— 把它**参数化**成通用件。

判据:**差异能不能变成一个参数?**
- 能 → 参数化(例:蒸馏的「引用单位」对 web 源是 URL、对仓内源是 `path:line`,
  这是一个 `citationUnit` 参数,不是两个蒸馏器);
- 不能 → 才是两件事。

⚠ **反向也要守**:没有第二个场景就别提前通用化 —— 那是镀金,`/omd-slim` 专治这个。
**通用化的触发条件是「第二个真实场景出现」,不是「我觉得以后可能」。**

---

## 3. 按意图查(主索引)

### 我要给模型喂一大堆材料

| 我要做什么 | 先看 | 通用性 |
|---|---|---|
| 材料太大,想只给骨架 + 按需拉全文 | `src/mcp/tools/web.ts:79`(索引进 context,原文写盘,回执给路径) | 通用 |
| 从**本仓**确定性取事实(不让模型自由 grep) | `src/harness/research/repo-probe.ts:155` `repoProbe` | 通用 |
| 把长文压成精简视图,多视角 | `src/harness/web/distill-source.ts`(expert)+ `distill-challenger.ts`(challenger) | 通用(吃任意文本,不依赖 web provider) |
| 让多发调用共享前缀吃缓存 | `src/harness/research/fanout.ts:358-360` 的前缀分层(stable 在前,run-specific 在后) | 半通用 |
| 一个查询召回不够 | `src/harness/web/query-expand.ts`(一次廉价改写,增益非链路) | 通用 |
| 判来源可不可信 | `src/harness/web/source-tier.ts`(**零 LLM** 三档,域名后缀判,原则 = 降权不灭口)⚠ **缺保底**,见 §4 | 通用 |

⚠ **喂材料的三条实测判据**(前两条读数在 `docs/research/2026-08-28-脊柱语料瘦身-AB读数.md`;
第三条另有一份**独立外部佐证**,见本节末):
1. **蒸馏按「下游要什么」分档,不按「源有多大」分档。** 下游要理解机制 → 蒸有益;
   下游要照着干(点名坐标 + 说清内容)→ 实测有害。
   今天 `retrieve.ts:189` 的门控是源大小,**分档轴是错的**。
2. **半个真值比没有真值更危险。** 给一份**有名字没内容**的材料,模型不会说"我不知道",
   它会围着真名字编。**宁可整条不给,也别给一个空壳。**
3. **喂错了东西,靠 prompt 提醒救不回来 —— 必须在取材那一层解决。**
   我们的读数:喂 repoProbe 真清单把编造从 8 压到 2–3(**低于全文臂**);
   而"输出侧加闸"(把 `checkCoords` 挂 research 出口)只能事后标注,救不了已经进 prompt 的坏料。
   **「防」的杠杆大于「检」。**

> **独立外部佐证(2026-08-28,owner 给的一手材料)**:企业级 RAG 实战的一个案例
> ——「2024 相比 2023 增长多少」被答成 -8.25%,正确答案是 +27.7%,**差 35 个百分点**。
> 根因不是模型算错,是检索把 7 份研报(部分美元列报)排在唯一那份年报前面,
> LLM 把跨币种跨来源的两个数混算。
> 他们先试 **prompt 规则**(「首次结果仅含研报时追加一次年报检索」「同比必须同源同币种」)
> —— correctness 0.2 → **0.5,不及格**;把「来源权威性」做进**检索层**(打标 + 排序加权 + 保底)
> —— **1.0**。原话:「LLM 的注意力有限,11 条规则中靠后的规则遵循率天然偏低。
> **检索层的问题必须在检索层解决。**」
>
> 另一句直接适用于本仓的 DAG:**「多 Agent 不是检索层的替代品,而是检索层的放大器。」**
> 检索好 → 并行让正确数据更快到达;检索差 → **错误沿 Worker 链迅速传导,每个环节都在
> 一本正经地加工错误数据**。fan-out 越宽,坏语料传得越快。
>
> 两个完全独立的场景(企业财报 RAG / 代码仓 research)得到同一条判据 —— 这比我们自己
> 跑五轮 A/B 更强,因为它不是同一套仪器量出来的。
> 来源:`https://zhuanlan.zhihu.com/p/2073177442752243640`

### 我要抓网页

| 我要做什么 | 先看 | 通用性 |
|---|---|---|
| 多 provider 抓同一个 URL,又不想烧付费额度 | `src/harness/web/fetch-racing.ts`(免费档并联 race 赢即 abort,全败才串行 tail) | 通用 |
| 防 SSRF | `src/harness/web/url-guard.ts`(fail-closed) | 通用 |
| HTML → 干净正文 | `src/harness/web/clean.ts`(trafilatura,benchmark 第一) | 通用 |
| provider 额度轮换 | `src/harness/web/quota-store.ts`(轻量 SQLite) | 通用 |

### 我要判「模型说的是不是真的」

| 我要做什么 | 先看 | 通用性 |
|---|---|---|
| 判它点名的**坐标**存不存在 | `src/harness/goal/coord-check.ts` `checkCoords(text,{root})`(**按行**判,不按句) | 通用 |
| 判产物里的 `file:line + 字面量` 声称 | `src/harness/writeset/claim-anchor.ts` | 半通用 |
| 判**一条判据本身是不是虚的** | `src/harness/goal/acceptance-gate.ts`(错样本摆进 `mkdtemp` 临时世界跑一遍) | 通用 |
| 存量红不该判成新增红 | `src/harness/goal/accept-baseline.ts` + `run-goal.ts` 的 `makeBaselineWaiver` | 半通用 |
| 审查 finding 反幻觉 | `src/harness/review/anchor-check.ts` | 半通用 |

### 我要让某个执行体只能写它该写的

| 我要做什么 | 先看 |
|---|---|
| 声明写集 + 越界当场拒 | `src/harness/writeset/write-allow.ts`(判在**写的那一刻**) |
| 写完立刻验 | `src/harness/writeset/write-parse-gate.ts` |
| 跑坏了回得去 | `src/harness/writeset/rollback-anchor.ts` · `poison-rollback.ts` |
| 从 shell 命令推断它写了什么 | `src/harness/writeset/shell-writes.ts` |

### 我要隔离执行

| 我要做什么 | 先看 |
|---|---|
| 每次跑落在独立工作树 | `src/harness/run-worktree.ts`(`.omd/runs/<runId>` + `omd/run/<runId>` 分支) |
| 进程级沙箱 | `src/harness/hooks/sandboxed-leaf.ts` · `bwrap.ts` · `jail-preflight.ts` · `jail-diagnosis.ts` |
| 命令白名单 / 危险命令 | `src/harness/command-leaf.ts` · `hooks/command-policy.ts` · `hooks/dangerous-cmd.ts` |
| 杀干净(含孙进程) | `src/harness/proc/live-children.ts`(进程组树杀 + 台账 + 启动期孤儿回收) |

### 我要判「这次跑要不要重做」

| 我要做什么 | 先看 |
|---|---|
| 节点语义指纹 / 哪些能复用 | `src/harness/plan-passes/semantic-key.ts`(`merkleFingerprints` / `computeReuse`)—— **单一真源** |
| 图内语义去重 / 死节点消除 | `plan-passes/dedup-pass.ts` · `prune-pass.ts` |
| 重规划在空转 | `src/harness/dag/replan-spin.ts`(判据吃 `computeReuse` 预览,不自己近似) |

### 我要处理「执行体卡住了」

| 我要做什么 | 先看 |
|---|---|
| 检测空转 | `src/harness/hooks/drift-detector.ts` + agent-leaf 的 grind 尺 |
| 空转后有界路由(不是直接杀) | `src/harness/spin-route.ts`(档1 证据包)· `dag/spin-rung2.ts`(档2 换脑/换上下文) |
| 判据红了让它自修 | `src/harness/self-repair-round.ts`(四槽模板 + 判据 diff 三态 + M 策略表) |

### 我要跨会话记住东西

| 我要做什么 | 先看 |
|---|---|
| 会话交接存档 / 读回 | `src/harness/session/writer.ts` · `resume.ts` · `bucket.ts`(档距口径) |
| 把散的记录固化成记忆 | `src/harness/dream/*`(9 个阶段,**其中 6 个零 LLM**) |
| 拒绝低质量记忆入库 | `src/harness/dream/validate.ts` · `session/noun-gate.ts`(零 LLM 名词闸) |

### 我要加一道闸

| 我要做什么 | 先看 |
|---|---|
| 新闸必须登记 | `src/harness/gates/gate-registry.ts`(**碰 `run-goal.ts`/`engine.ts` 就被泛化闸要求同步登记**) |
| 禁词 | `scripts/jargon-scan.ts` |
| 孤儿文件(新建的 `.ts` 必须被生产入口 import) | `src/harness/reachability.test.ts` |
| 沉默 catch 只许降不许涨 | `scripts/catch-evidence-scan.ts` |
| 引擎接缝目录自动生成 | `scripts/gen-seam-catalog.ts`(`--check` 判漂移) |

---

## 4. 有能力但没接线(最值钱的一栏)

**这一栏记的是「东西造好了、能用、但某条路上没接」。** 它比「缺什么能力」更重要 ——
缺能力至少人人知道,而**有能力没接线是隐性的**,只会以"重造"的形式暴露出来。

| 能力 | 已接 | 没接 | 证据 |
|---|---|---|---|
| **渐进式披露**(索引 + 按需拉) | `omd_web` MCP 工具那条路 | **research 管线(`researchFanout`)** —— 它把语料**全量灌进每一发 prompt** | `retrieve.ts:5` 注释:web-fanout 把 `.markdown` 当 groundTruth 喂 researchFanout |
| **按需 Read 原文** | 设计上有(回执给路径) | **实测被 Read 过 0 次**;`.omd/web/` 盘上只有 1 份语料(Aug 9) | 全部 Claude 会话记录里 `Read` 命中该路径 = 0 |
| **challenger lens** | `omd_distill` 工具面 | research 管线里**一次没用过** | `web.ts:120` 默认 `both`,但 fanout 不走这个工具 |
| **蒸馏的引用单位** | web 源(URL 在头部) | **仓内源**(`path:line`)—— `DISTILL_SYSTEM` 规则 2 列的是「定义/数字/断言/结论」,没有路径这一格 | `distill-source.ts:62-72` |
| **坐标机械校验** | 派工文本(点火闸) | **research 产物出口** —— 编造的路径今天没有任何一道闸看见 | 实测:全文臂三跑各编造 2–4 个不存在的路径 |
| **总量蒸馏门控** | per-source(`distillThreshold` 默认 30000) | **总量**:10 个源各 29k = 290k,一个都不触发 | `retrieve.ts:189` |
| **累加语料再蒸馏** | — | second-pass 每轮 `corpus +=`,**不再蒸、无上限** | `fanout.ts:470` |
| **保底(coverage floor)** | **一处都没有** | 分层只影响排序与抓取槽位;**没有任何一处保证「结果里至少有一份 A 档/权威源」** | `retrieve.ts:31` 的 `crawlFloor` 是**数量**下限(抓够 5 条,含 B 补位),全是 B 档时它照样满足 |

---

## 5. 维护规则

- **新增能力**:当次 PR 回填「按意图查」对应小节 + 通用性一列。**回填是造件的一部分。**
- **发现"有能力没接线"**:立刻进 §4,**不要等到有空修**。记下来的口子才可能被修。
- **发现自己重造了**:进 §0 当案例。**案例比规则管用** —— §0 那三条是这份表存在的全部理由。
- **本表注册在 `docs/docs-map.md`**,受 docs-drift 闸约束:里面点名的坐标必须真实存在,
  改了实现没改这里 = 闸红。
