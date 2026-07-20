---
name: execute
description: 把 SDD/规划产物交给 omd DAG 引擎执行(经 MCP dag_run 三段式),完成后按验收协议四选一。Trigger:/execute、开始执行、按 SDD 干、执行计划。
---

# /execute — SDD → DAG → 验收闭环

对应 pi TUI 的 `/execute`。经 omd MCP server 的 `dag_run` / `dag_status` / `dag_result` 三段式工具(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_run")。

## 流程

1. **取契约**:找 `docs/plan/` 下最新的 SDD(`YYYY-MM-DD-<slug>.md`,由 /sdd 落盘);用户直接给了任务文本也行,但大活强烈建议先 /sdd。
2. **执行**:`dag_run` 传 task = SDD 全文(或任务文本)。conductor 会把它分解成带类型节点的 DAG(agent 叶子真改文件、command 叶子跑验证),并发扇出执行。拿到 `runId` 后用 `dag_status` 轮询、`dag_result` 取产物——执行可能几分钟,耐心轮询,不要重复发起。
3. **验收(必须主动做,不等 owner 催)**:对照 SDD 契约逐条判 pass/fail(GWT 验收点 + 不变量),然后按成本四选一:
   - **接受**:全过 → 向 owner 报告"做了什么 + 为什么";
   - **重画**:契约级失败(方向/分解错)→ 带失败要点重新 `dag_run`(task 末尾附 `REDRAW FEEDBACK: <要点>`);
   - **迭代**:部分收敛 → 用 /iterate 定点收敛;
   - **直接修**:小缺口 → 自己动手改 + 验证,比再派 DAG 便宜。
4. 验收后让 owner review 实际 diff。

## 重画路径

owner 判契约级失败时:`dag_run` 的 task = 原契约 + `===== REDRAW FEEDBACK =====\n<失败要点>`,conductor 会针对性重分解。
