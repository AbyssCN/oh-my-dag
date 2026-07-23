---
name: omd-execute
description: 把已定的 SDD/规划交给 omd DAG 引擎执行(经 MCP dag_run 三段式),完成后按交叉验证 checklist 逐条判、四选一验收。Trigger:/omd-execute、开始执行、按 SDD 干、执行计划。
---

# /omd-execute — SDD → DAG → 验收闭环

经 omd MCP 的 `dag_run` / `dag_status` / `dag_result` 三段式工具(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_run")。把契约交引擎执行,再**主动**按 checklist 验收——不是跑完就算完。

## 流程

1. **取契约**:找 `docs/plan/` 下最新 SDD(`YYYY-MM-DD-<slug>.md`,由 `/omd-sdd` 落盘);用户直接给了任务文本也行,但大活先 `/omd-sdd`。
2. **执行**:`dag_run` 传 task = SDD 全文(或任务文本)。conductor 分解成带类型节点的 DAG(agent 叶子改文件、command 叶子跑验证),并发扇出。拿 `runId` 后 `dag_status` 轮询、`dag_result` 取产物——可能几分钟,耐心轮询,别重复发起。
3. **验收(必须主动做,不等 owner 催)**:先跑下面的**交叉验证 checklist**,再按成本四选一。

## 交叉验证 checklist(每次至少跑一遍——「验收」的可执行化)

验收不是「看 DAG 报了 ✅ 就信」。逐条对:

1. **契约 vs 真身**:SDD 标「后端已有」的端点/函数,抽查代码里**真存在**——防契约照抄了参照物但没接线。
2. **演示/测试数据 vs 既有闸**:造数前先问「会被哪个校验误伤」——唯一约束、状态机触发器、append-only、权限/双人闸。
3. **写入形 vs 读取形互相印证**:两边用同一个错误形状会一起躲过 oracle → 新读面加一条断言**存储形字段**的回归测试。
4. **改契约三处同步**:schema + 接口/端点清单 + 验收测试,漏一处 typecheck 不一定抓得到。
5. **幂等重放**:重跑 seed/迁移,计数必须归零或跳过;「新建 N」在重放里重现 = 幂等标签撒谎,查库对行数。
6. **「复用既有」必须验对象**:验收表写「✅ 复用 X」时,去 X 的真身**逐元素核对**确实包含这些行。**销号 ✅ ≠ 元素真生效**——按验收项逐条指认,不是整屏扫一眼。
7. **垂直可验证性**:每个 DAG 叶应是端到端可独立验证的**用户功能片**,不是技术层横切(「只建表」这种叶子跑完也没法单独验)。SDD 若按技术层组织 → conductor 继承横切 DAG、末端才炸 → **重画**,让 task 文本按用户功能垂直切(承 /omd-path 垂直切分闸)。

## 四选一验收

| 结果 | 动作 |
|---|---|
| **接受** | checklist 全过 + SDD 的 GWT 验收点/不变量逐条 pass → 向 owner 报「做了什么 + 为什么」 |
| **重画** | 契约级失败(方向/分解错)→ 带失败要点重 `dag_run`,task 末尾附 `===== REDRAW FEEDBACK =====\n<要点>`,conductor 针对性重分解 |
| **迭代** | 部分收敛、差在收尾 → 交 `/omd-iterate` 定点收敛 |
| **直接修** | 小缺口 → 自己动手改 + 验证,比再派 DAG 便宜 |

验收后让 owner review 实际 diff。

## 与既有 skill 的边界

- `/omd-execute` = 把**已定**的 SDD/plan 交 DAG 执行 + 四选一验收。
- 不用于:pathfinder 已散尽区域的增量交付(权力闸)→ `/omd-deliver`;plan 前把方案审议透 → `/omd-grill`;fixpoint 反复迭代 → `/omd-iterate`(它是本 skill 的循环包装);结论落成 SDD → `/omd-sdd`。
