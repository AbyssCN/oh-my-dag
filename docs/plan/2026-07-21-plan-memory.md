# 提案:plan-memory —— DAG 图记忆 + 复刻 + 迭代优化(v2,grill 后修订)

> 2026-07-21 · 缘起:Nick 质疑 bandit 天花板,提出正确替代轴:**任务复现时重放已验证 DAG 图并持续迭代**。
> v2 修订:对 v1 做蓝军 grill(照 bandit 尸检标准:"每条路径真的会跑吗"),4 处设计改动 + 分期门控。
> bandit 保留为零成本被动实验,不再投入;本 slice 是自学习主投资线。

## 0 · v1→v2 的 grill 修订(证据编号对应汇报)

| # | v1 缺陷 | 证据 | v2 修复 |
|---|---|---|---|
| A2 | **family 自举悖论**:每次 conductor 重分解产新 plan 行 → 单 plan 的 runs 永远≈1,`runs≥2` 闸永不开(bandit 式空转) | 设计推演 | **record 时做 family 聚类**:新 plan 先对既有 family 做文本匹配,命中并入(family 计数器),未中开新族。schema 加 `family_id` |
| A3 | **verdict 闸空转**:`verifier` 在引擎是可选项,MCP assemble **根本没配** → "verdict pass 才入账"= 账本永空 | executor-dag-types.ts:122 `verifier?:`;assemble.ts 无 verifier 装配 | ok 判定降级:`verifier pass ∨ (无 verifier ∧ 全叶 done)`,记 `verified` 布尔区分强弱信号 |
| A4 | **结构兼容扫描不可靠**:节点 goal 是自然语言,从中抽文件路径判存在 = 脆 | goal 形状 | 改扫 **checkpoint 的 filesTouched/outputPaths**(结构化已录)+ 模板存在性(parsePlan knownTemplates 现成校验) |
| A5 | v1 写"conductor 局部修复该节点"——**引擎不这么做** | executor-dag.ts:730 升级=整图重规划 | 但 **:773 已内置预构造 plan 的约束修复**:"重规划时只修不发明——保留各节点既定目标与依赖边"。v2 版本机制 = **捕获约束修复轮的产出为 v(n+1)**,机制现成,只差落账 |
| A1 | **流量前提未证**:dag_runs 历史 = 2 次冒烟。复现分布是否存在未知——不能重蹈 bandit(先建决策层,流量永远没来) | dag_runs 实测 | **分期门控**(§5):Phase A 只建数据层(纯记录,零行为改变),Phase B 召回闸压在实测复现证据后面 |

## 1 · 目标

复现任务族第二次起:免 conductor(重放已验证图)· 图随结局进化(约束修复→版本链)· 绝不错误重放(保守闸+静默回退)。
非目标:跨 repo 共享 · LLM 槽位改写 / **AWM 式子图归纳**(跨任务抽象共享子程序 —— 他们的量级 1000+ 任务撑得起
抽象错误率,我们的撑不起;v3 方向)· bandit 撤除。

**先验接地(2026-07-21 web 查证)**:AWM(arXiv 2409.07429)只从成功轨迹归纳 + 在线积累 → 我们的 ok 闸 + Phase A
record;Voyager(arXiv 2305.16291)成功+自验证才入库 + **技能注入 prompt 非强制执行** → 我们的 verified 布尔 +
`replay:'hint'` 档;Temporal 只借"真相在历史文件 + 签名一致性检验"哲学(其重放语义对应 omd 已有的 resume,非本 slice)。
注意:三者证明的是**复现分布存在时 memoization 大胜**(AWM 1000+ 任务/Voyager 固定世界)—— 我们的证据门验的正是该前提。

## 2 · baseline(2026-07-21 实测)

已有:`dag_run_plan` 重放入口 · resume 跳绿 · 每节点结局 checkpoint(status/usage/filesTouched/artifactHashes)·
generation 形态签名 · 升级轮的**约束修复语义**(:773,预构造 plan 专属,天然为重放而生)· bun:sqlite+FTS5 惯例(model-router.db/output-store 先例)。
缺口:①`_dag.json` 只存骨架,完整 plan(节点 goal/executor/template)丢弃 ②任务→图召回层 ③修复产物不落版本账。

## 3 · 架构(三层,truth 在文件,db 是投影)

```
Phase A (数据层, 零行为改变):
  dag_run 跑完 → _dag.json 增存全量 plan + verdict + taskText   (缺口①)
              → plan-ledger.db: family 聚类 record (A2) + ok 判定 (A3)
              → omd_plans 工具: 列 family/版本/runs/ok率/成本 (可观测 = Phase B 的证据仪表)

Phase B (决策层, 证据门控后):
  dag_run(task) → 召回闸: family 匹配 (FTS5 BM25) ∧ ok率≥0.8 ∧ runs≥2 ∧ 结构兼容(A4)
      ├─ 命中 → executePlan(plan vN) [免 conductor], 结果注明 replayed
      └─ 未中/低置信 → conductor (今天路径, 静默)
  verifier fail → 升级轮约束修复 (:773 现成) → 产出捕获为 plan v(n+1) (A5)
  连续 2 版失败 → family retired (防坏图自我强化)
```

- `plan-ledger.db`(bun:sqlite,WAL,`.omd/`,gitignored):
  `families(id, canonical_task, created_at, retired)` + `plans(id, family_id, version, parent_id, plan_json, generation, verified, runs, ok_runs, avg_cost_usd)` + FTS5 影子表(canonical_task)。
  **db 可重建**(扫 continuity 目录),`_dag.json` 是真相源。
- 控制面:`dag_run` 增参 `replay:'auto'|'hint'|'off'|'force:<planId>'`(默认 auto,Phase B 才生效)。
  `hint` 档(Voyager 软注入模式的移植,2026-07-21 查证后增):召回图**注入 conductor prompt 作参考分解**
  ("已验证分解如下,可复用或修改"),不绕过 conductor —— 付分解钱换方差下降,覆盖"相似但非同参"灰区
  (auto 硬重放的保守边界之外最大的价值区)。

## 4 · 设计岔口(定案)

召回在引擎内(Claude 侧经 dag_run_plan 天然免费存在,不互斥)· 独立 ledger.db 不混 memory store(结构化查询+防污染 recall)·
BM25 先行向量 v3 · 仅失败出新版(成功不动图)· 文件真相源 db 投影。

## 5 · 分期 + 证据门(A1 的答案,bandit 教训的直接应用)

**Phase A(现在建,S+M 量)**:#1 全量 plan 落 `_dag.json`(schemaVersion 2 向后兼容)→ #2 plan-ledger(family 聚类 record + ok 判定)→ #3 `omd_plans` 可观测工具 → #4 测试(family 聚类不变量/ok 判定/重建)。
纯数据收集,不改任何执行行为——资产从今天开始积累,失败模式不存在。

**证据门**:跑 2-4 周,`omd_plans` 显示任一 family `runs≥3 ∧ ok率≥0.8` → 复现分布证实,开 Phase B。
无 family 达标 → **不建召回闸**,Phase A 沉淀的账本仍服务审计/成本分析,损失 ≈0。

**Phase B(门后建,M 量)**:#5 召回闸接 dag_run → #6 修复轮产物落版本链 → #7 retired 闸 → #8 召回保守性测试。

## 6 · 风险 / 反 happy-path

错误重放(最大):三重闸+静默回退+`replay:'off'` 逃生门,且整个闸压在证据门后。
repo 漂移:filesTouched 扫描拦截,漏网→verifier/升级轮兜底(恰是 v2 诞生点)。
坏图自我强化:retired 闸。膨胀:仅 ok run 入索引,continuity TTL 跟随。
并发:WAL+UPSERT。secrets:taskText 与 continuity goal 同暴露面(.omd gitignored),不新增面。
无 verifier 的弱信号 ok:`verified` 布尔留痕,Phase B 召回可按需只认强信号。

## 7 · 推荐

**立即:Phase A 四件**(数据层,零风险,资产即刻积累)。Phase B 让数据决定——这正是 bandit 案例教的:
**先证明分布存在,再建吃分布的机器。**
