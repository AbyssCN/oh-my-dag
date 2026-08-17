# tdd-bugfix pack 的 eval 设计(实验四要素,动手前写全)

> **诚实状态:本 eval 设计完整、fixture 与 oracle 可跑,但 A/B 尚未点火 —— 下方读数表空着。**
> 空表不是装饰:pack 作者的义务是把表填上再声称能力;没读数之前,本 pack 的能力主张
> 一律视为未证。点火消耗真 token,由 owner 决定何时跑。

## ① 单一变量

**pack 装 / 不装**(`omd pack add templates/packs/tdd-bugfix` vs 裸引擎)。
同一任务、同一座位配置、同一轮上限。一次只动这一个 —— 不许顺带换模型/换 prompt。

## ② 预先声明的成败信号(跑之前就定死,事后不改)

| 信号 | 怎么量 | pack 成立的方向 |
|---|---|---|
| S1 修复成功率 | 隐藏 oracle(`eval/oracle/regression.oracle.ts` 拷入为 oracle.test.ts 后跑)全绿的比率 | 装 > 不装 |
| S2 verify-red 纪律率 | run 记录里存在 `expect_exit:1` 的 command 节点且其 exitCode=1 的比率(复现先红) | 装 ≫ 不装(裸引擎大概率 0) |
| S3 违规率 | fixer 类节点 `filesTouched` 含 `*.test.*` 的比率(改测试作弊) | 装 < 不装 |
| S4 成本 | run 账本 token(in+out)与墙钟 | 如实记,不设方向(纪律可以更贵,贵多少要知道) |

⚠ S2/S3 依赖 run 记录的节点级字段(exitCode/filesTouched 账本里都有);
**"conductor 派了卡"本身不是任何信号** —— prompt 里的东西无法证明被读,判据只认行为差。

## ③ 对照基线

不装包那一臂**在同一批次、同一天、同一座位配置下现跑现量**。
不许拿别的仓、别的模型、上周的数当基线(detector 60% 天花板的教训:基线不同条件,对比作废)。

## ④ 两侧都要收什么数据

- 不塌(装了没更好):这是"卡/playbook 无增益"的证据 —— 值得知道,省掉 9 行 roster 税。
- 塌了(装了更差):方向性证据,查是哪个信号塌(纪律更贵? 步骤链拖轮次?)。
- 每臂 n ≥ 8(单座位读数,换座位重跑;读数表按臂分列,不许只留合并数)。

## 点火流程(每臂一次)

1. `mkdtemp` 世界,拷入 `eval/tasks/broken-calc/`(**不含** eval/oracle —— 执行体不可见)。
2. 实验臂:在世界里 `omd pack add <本 pack 路径>`;对照臂:跳过。
3. 以 `BUG_REPORT.md` 原文为任务,经 `dag_run`(或 goal 层带 playbook)点火,记 runId。
4. 结束后拷 `eval/oracle/regression.oracle.ts` 入世界为 `oracle.test.ts`,`bun test oracle.test.ts` → S1。
5. 从 `.omd/dag-runs.db` 该 runId 的 nodes 列取 exitCode/filesTouched → S2/S3;usage → S4。
6. 读数入下表,**两臂分列**。

## 读数表(未跑,空着 —— 见顶部诚实状态)

| 信号 | 裸引擎 (n=) | 装 pack (n=) | 结论 |
|---|---|---|---|
| S1 修复成功率 | — | — | 未跑 |
| S2 verify-red 纪律率 | — | — | 未跑 |
| S3 违规率 | — | — | 未跑 |
| S4 token / 墙钟 | — | — | 未跑 |
