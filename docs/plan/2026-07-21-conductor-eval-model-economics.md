# OMD conductor 迭代升级:客观 oracle harness + model-mix 经济学 + effort-scaling

> 结晶自 2026-07-21 /omd-grill 收敛。融合两篇外部实现:Anthropic《How we built our multi-agent research system》(orchestrator-worker 分解到 worker 的 8 原则)+ Cursor《智能体蜂群与新的模型经济学》(code-swarm 并行写失效模式 + 强 planner/廉价 worker 的成本经济学)。落到 OMD 现有代码(TS/Bun)。本文件是 /omd-execute 的执行契约,写给无对话上下文的执行器。

## 目标 (Destination)

给 OMD 的 conductor 装上**它现在唯一缺的那个「模型之外的闸」**:一套客观、可复现、按任务规模分档的分解质量 eval。据此(1)用真实成本数据回答「conductor 模型该用哪档」,(2)给 conductor prompt 补上按任务规模缩放的**数字锚**,(3)留下一套常驻回归闸,以后改 conductor 先过闸。

判据(整件事做成什么样):跑一条命令,得到一张 `模型组合 × 任务规模` 的 `{首发 pass 比例 / 终值 pass 比例 / heal 轮数 / 成本}` 表;据表校准 conductor prompt 后,固定-leaf A/B 显示分解效率代理下降;标准任务集成为改 conductor 的 pre-flight 闸。

## 决策 (Decisions)

- **D1 · benchmark 双规模** — medium(~5–8 节点)+ large(~10–15 节点)两个任务,读 conductor 质量随任务规模的 crossover。*为什么*:小到能有干净 tsc+test oracle 的任务(如 73 行纯函数)只出 1–2 节点=零分解 → sweep 塌成噪音、effort-scaling 无信号。两篇文章的分解论点都建立在大任务上。

- **D2 · 任务语言 = TS-native** — 中、大任务都用 TypeScript;大任务的黄金语料借 sqllogictest 的**思路**(多 input→已知 output),不移植 Cursor 的 Rust minisqlite。*为什么*:OMD 全 TS/Bun,`dag-build.ts` 默认 oracle=`tsc --noEmit`+`bun test`,fleet 的 leaf 按 TS 调优;Rust 对 OMD 是 off-distribution,会把「fleet 会不会 Rust」混进「分解好不好」。

- **D3 · 模型网格 + 重复** — 4 格 × R=3 重复 × 2 规模 = 24 run。网格:
  - C1 `anthropic:claude-opus-4-8` / `deepseek:deepseek-v4-flash`(前沿规划+廉价执行,Cursor 论点)
  - C2 `mimo:mimo-v2.5-pro` / `deepseek:deepseek-v4-flash`(现状基线)
  - C3 `deepseek:deepseek-v4-flash` / `deepseek:deepseek-v4-flash`(廉价地板)
  - C5 `kimi-coding:k3` / `mimo:mimo-v2.5-pro`(coding-tuned 独立组合)
  - drop C4(前沿×前沿),无必要。*为什么*:对标 Cursor 4 配置;C1/C2/C3 固定 leaf=`ds-flash` 构成干净 conductor 轴(C1 vs C2 = 「conductor 从 MiMo 换 Opus 值不值」);C5 leaf 也变,不在干净轴上,是单独可部署组合读数。

- **D4 · 任务来源 = 复用 OMD 已测模块** — medium=纯模块小簇(`dag-mermaid` / `slim/debt-scan` / `oracle-plan-filter` 一类,已有测试),large=一整个子系统(`pathfinder`:`frontier`+`types`+`slice-compiler`+…,已有测试);oracle=现成测试套件。*为什么*:零 corpus 编写、最贴 OMD 真实 build 形状、oracle 已是高质量。测试钉 public API,内部分解交 conductor 自决(边界决策=分解本身,对应 Cursor 的 split-brain 指标)。

- **D5 · eval 覆盖分阶段** — code-only 先上(Phase ②ₐ,客观 oracle,无 rubric judge);非code(research/审议/design)+ rubric judge 快跟(Phase ②_b)。*为什么*:conductor 同时管 code 和非code;只在 code 上调可能改好 code 分解、悄悄回归 research/审议 分解而无闸。分阶段既拦风险又不阻塞 ④/①。

- **D6 · 删 dead postcondition prompt 指示** — 从 `conductorSystemPrompt` 移除「emit `postcondition`」的指示;plan schema 字段保留作 forward-compat。*为什么*:`postcondition.method:'llm-judge'` 在 schema+prompt 声明、引擎从不执行(Explore 已查,动手前 grep 复核 `executor-dag*.ts`/`*-leaf.ts` 无人读 `postcondition.method`)= conductor 被教吐死字段,白烧规划 token+添分解噪声;whole-run rubric(②_b)接管完整性校验,per-node judge 是 YAGNI 投机机械。

- **D-metric · run 打分语义** — heal ON 跑,scorer 记 4 量:iter0 首发 pass 比例 / 终值 pass 比例 / heal 轮数 / 总成本(按角色)。首发比例→①(分解质量,未被 self-heal 掩盖);终值×成本→④(经济,复刻 Cursor「同质量不同成本」);heal 轮数=Cursor thrash 代理。*为什么*:self-heal 会把烂分解也修到 green,只看终值 pass 则好坏分解都≈1.0、信号全丢。

- **D-overfit · 过拟合闸** — 任务集切 calibration / held-out 两半,① 只在 calibration 半调,validation 半从不用于调参;① 的数字锚取自 Anthropic 已发布启发式(1 / 2–4 / 10+),数据只校准量级、不从数据硬拟合。*为什么*:防把 conductor prompt 过拟合到少数 benchmark 任务(Anthropic 人工 eval 抓过拟合的同理)。

## 契约 (Contracts)

### 不变量 (INV)
- **INV-1** measure 串行(`concurrency=1`)。并行跑候选会争同一 provider 限流额度,污染成本/延迟读数(xihe-tournament 铁律)。按 provider RPM 设 `cooldownMs`。
- **INV-2** benchmark 任务的隐藏 oracle(测试套件)对 conductor 与 leaf **不可见**;每 run 后人工抽查有无作弊/只优化测试点(Cursor 反作弊纪律)。
- **INV-3** reuse-own 任务钉 public API(由测试 import 面定义),抹掉原文件内部结构 → conductor 自决内部拆几节点/怎么切,不得照抄现有模块边界。
- **INV-4** ④ 是**单轮全网格 sweep**,非收窄 tournament:spec 省略 `expand`,输出整张 leaderboard(每 cell×规模:首发/终值/heal轮/成本),**不取单一 champion**(要曲线不要冠军)。
- **INV-5** ① 的验证是**固定-leaf A/B**(leaf 模型不变,只改 conductor prompt),否则增量无法归因到分解。
- **INV-6** 客观分数来自 `dag-build.ts` 的 `runOracle` 命令闸(tsc+test),**不**用 `verifier.ts` 的 LLM `verification.pass`(那是主观判官)。

### GWT 验收点(/omd-execute 逐条判 pass/fail)
- **GWT-0(Phase 0)** *Given* 一个 reuse-own medium 任务 + 抹结构后的 spec,*When* 经新 scorer 跑一次,*Then* 返回结构化 `{firstShotPass:0..1, finalPass:0..1, healRounds:int, costUsd:number, nodeCount:int}`,且 `finalPass` 与手工跑 `bun test` 的过测比例一致(±0)。
- **GWT-0b** *Given* `oracle-plan-filter` 冒烟任务,*When* 跑 harness,*Then* 端到端不崩、产出上述结构 —— 仅验管路,不验分解。
- **GWT-④** *Given* 4 格网格 spec + medium&large 两任务,*When* `xihe-tournament <spec>` 跑完,*Then* 落一张表含 4 格 × 2 规模 × R=3 的均值+stddev,每格四量齐全;measure 串行(日志可见逐候选顺序)。
- **GWT-①** *Given* conductor prompt 加数字锚后,*When* 在 held-out validation 任务上固定-leaf A/B 跑,*Then* 改后相对改前:`firstShotPass` 不降 **且**(`healRounds` 或 leaf token 或 nodeCount 至少一项显著下降)——即分解更收敛。
- **GWT-D6** *When* grep `executor-dag*.ts`/`*-leaf.ts` 复核 `postcondition.method` 确无 runtime 读取后删除 prompt 指示,*Then* `conductor-plan.ts` 测试全绿,且新跑的 plan 不再含 `postcondition` 字段(或含也不影响,schema 仍接受)。
- **GWT-②ₐ** *Given* code 标准任务集,*When* 跑回归闸,*Then* 输出每任务客观分 + 汇总,可作为「改 conductor 前后」对比基线。
- **GWT-②_b(快跟)** *Given* 非code 任务 + rubric judge,*When* 跑,*Then* rubric judge 返 `{score:0..1, dims:{coverage, no-orphan, contract-adherence, no-fabrication}, pass}`,复用 `plan/llm-judge.ts` 的 0..1 schema 形状。

## 分解 (Breakdown)

> 施工切片,conductor 可参考;依赖序 = 施工序(≠ Nick 口述的 ④→① 顺序,oracle 是 ④ 的前置)。

- **Phase 0 — oracle harness**(前置)
  - `src/eval/` 新目录(OMD 本 repo)。
  - `src/eval/scorer.ts`:包 `dag-build.ts` 执行 → 解析 `bun test` 的 `X/N` 过测比例(runOracle 现回 binary green/red,**新写的核心就是这个 fraction 解析** + 记 iter0/终值/heal轮/成本按角色 `ExecutorDagResult.usage`)。
  - `src/eval/tasks/`:medium(纯模块小簇)+ large(pathfinder 子系统)两个 reuse-own fixture,含「拷进 temp workdir → 删原 impl → 抹内部结构留 public-API 测试 + prose spec」的构造脚本;`oracle-plan-filter` 冒烟 fixture。
  - 复用:`scripts/dag-build.ts`、`src/harness/build/oracle-classify.ts`、`src/harness/plan-ledger.ts`。
- **Phase ④ — model-mix sweep**
  - `src/eval/oracles/conductor-modelmix.spec.ts`:default export `(opts)=>TournamentSpec`;`seed()`=4 格 × 2 规模;`measure(c)`=`Bun.spawn` 起 `dag-build.ts`(带 `--conductor-model`/`--leaf-model`)×R=3 取均值,回 `{score:firstShotPass, detail:{finalPass,healRounds,costUsd,...}}`;`concurrency:1`+`cooldownMs`;省略 `expand`(INV-4)。
  - 跑:`bun run $FUSANG_HOME/scripts/xihe-tournament.ts src/eval/oracles/conductor-modelmix.spec.ts`。
  - 产出表 → 读 C1 vs C2 的 cost-at-quality + medium/large crossover。
- **Phase ① — effort-scaling 数字锚 + 删 D6**
  - 改 `src/harness/conductor-plan.ts` `conductorSystemPrompt` 的 "Granularity economics" 段:加按任务档的节点数/宽/深数字带(初值 Anthropic,量级用 ④ 数据校准)。
  - 同处删 D6 dead-postcondition 指示(grep 复核先)。
  - 固定-leaf A/B 在 held-out 半验证(GWT-①)。
- **Phase ②ₐ — code standing eval**:把 Phase 0 的任务扩成一小组 code 回归任务,作为改 conductor 的 pre-flight 闸。
- **Phase ②_b — rubric judge + 非code(快跟)**:`src/eval/rubric-judge.ts`(套 `plan/llm-judge.ts` 0..1 schema);非code 任务扩到 ~20;加 Cursor 低相关审查(同一 run 给 judge 三种输入范围:仅 plan / 全 run / 仅产物)。

**复用清单**:`scripts/dag-build.ts`(driver+oracle+self-heal+模型旗)· `src/harness/plan-ledger.ts`(战绩台账→leaderboard 聚合)· `src/harness/plan/llm-judge.ts`(0..1 schema 骨架)· `$FUSANG_HOME/scripts/xihe-tournament.ts`(sweep driver)· `ExecutorDagResult.usage`(按角色成本,已现成)。
**新建清单**:fraction scorer(4量)· `conductor-modelmix.spec.ts` · reuse-own fixture(抹结构+隐藏 oracle)· `rubric-judge.ts` · `src/eval/` 树。

## 非目标 (Non-goals)

- 不移植 Cursor minisqlite(Rust)。
- 不做 mid-run 动态 spawn / 自适应重规划:OMD 的静态 DAG 天然免疫 Cursor 花大力气才压住的 split-brain + merge-conflict;要走动态须先预算 VCS+协调机制,本轮明确不碰。
- 不接 per-node `postcondition:'llm-judge'` runtime(D6 删指示,不实装)。
- 不给 ④ 加收窄 `expand`(INV-4,它是 sweep 不是寻优 tournament)。
- ②_b 的非code 任务集不在本轮硬性交付(快跟,不阻塞 ④/①)。

## 未决 (Open)

- **O1** medium 纯模块小簇具体选哪 3 个模块、如何抹内部结构而不破 public-API 测试 —— Phase 0 施工时定,受 INV-3 约束。
- **O2** large=`pathfinder` 子系统的抹结构边界(哪些测试算 public 面、哪些是内部 helper 测试需剔除)—— Phase 0 施工时定。
- **O3** provider RPM → `cooldownMs` 具体值(按 C1/C5 的 anthropic/kimi 端点实测限流)—— Phase ④ 起测时定。
- **O4** ②_b rubric judge 的维度权重与 pass 阈值 —— Phase ②_b 时定。
- **O5** R=3 若 stddev 过大(cell 间差 < 噪声)是否升 R=5 —— ④ 首轮数据出来后按需。

---
*确认后 `/omd-execute` 交 DAG 执行(建议按 Phase 0 → ④ 分批,不整包一次跑)。*
