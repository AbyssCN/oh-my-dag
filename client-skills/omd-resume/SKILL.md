---
name: omd-resume
description: 列出断掉/失败的 DAG run(带 goal)让 owner 挑一个续跑——从磁盘 checkpoint 重载 plan、跳过已绿节点接着跑。Trigger:/omd-resume、续跑、接着跑、断了的图、resume、跑一半挂了、429 断了。Skip:全新任务(/omd-execute 或 dag_run)、查状态不续跑(dag_status)。
---

# /omd-resume — 挑一个断掉的图接着跑

调 omd MCP server 的 `dag_runs` + `dag_resume` 工具(可能带前缀 `mcp__omd__`;未加载先 ToolSearch "dag_runs,dag_resume")。UX 三步:**列 → 问 → 续**。

## 1 · 列出可续跑的 run

调 `dag_runs`(**不带 status 过滤**——要同时抓到两类可续的:内存里 `failed` 的,和进程/server 死后磁盘里 `unknown(restart)` 的「合笔记本」型)。从返回里筛出**可续的**:`status` 是 `failed` 或 `unknown`/`restart` 的。

- 一个都没有 → 转告「没有断掉/失败的图可续」,结束。
- 有 → 每条列:**goal(任务文字)· 什么时候(createdAt)· 短 runId**。goal 是给 owner 认图的关键,必须列。

## 2 · 问 owner 续哪个(别自动挑)

用 **AskUserQuestion** 让 owner 选:

- 多个可续 → 每个一个选项,label = goal 前 ~40 字,description = 时间 + runId + 状态。加一个「都不续」。
- 恰好一个 → 仍确认一次(「续这个吗:<goal>?」),别默认就跑——续跑会真派车队烧钱。

**续跑只接 failed / 未知(重启后)的 run**,在飞或已 done 的 `dag_resume` 会拒——所以列表只放可续的,不给 owner 选到会被拒的。

## 3 · 续跑

owner 选定 → 调 `dag_resume runId=<选中的>`。引擎从 `.omd/continuity/<runId>/_dag.json` 重载 plan,按产物 hash 逐节点判「还算数吗」,**只补跑不算数的**(已绿的跳过)。返回 `runId + status: running` → 转告 owner,并说可 `dag_status` 轮询进度、`dag_result` 取产物。

## 边界与诚实

- **只有 plan-memory 改动之后建的 run 能一键续**。老 run 只存了骨架 → `dag_resume` 会报「skeleton only」,转告 owner:那份得手供 plan 走 `dag_run_plan resume=<runId>`(骨架能跳过已绿节点,但重放不出完整 plan)。
- **`dag_run`(LLM 现规划)建的图续跑未必省事**:重跑 conductor 可能吐出形态不同的图 → 图代数签名变 → 旧 checkpoint 全作废、整图重跑。最干净的续跑对象是 `dag_run_plan` / pathfinder slice 建的图(plan 确定性、可重放)。dag_resume 走的正是「重载存下来的那份 plan」,所以它对这两类最有效。
- **产物守卫**:某已绿节点的产出文件被删/改过 → hash 对不上 → 那个节点也会重跑(不信一个产物已经不在的「done」)。这是正确性,不是 bug。
