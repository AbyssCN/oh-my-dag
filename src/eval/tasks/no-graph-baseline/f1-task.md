# F1 宽扇出·代码 — MCP 工具名机械迁移(两臂同文)

在给定的快照目录里,把 `client-skills/` 下**所有 .md 文件**中的旧 MCP 工具名按下表统一替换为新名。
只替换**独立词**(word boundary);`dag_run_plan` 是另一个工具,**不许**被 `dag_run` 的替换误伤。

| 旧名 | 新名 |
|---|---|
| dag_goal | solve |
| dag_run | run |
| path_map | map_open |
| path_add | map_add |
| path_tickets | map_tickets |
| path_rule | map_rule |
| path_deliver | map_deliver |
| path_prefetch | map_prefetch |
| path_init | map_init |

完成标准:替换后 `client-skills/` 下不再出现任何旧名独立词(`dag_run_plan` 原样保留),新名出现处与语义一致。
校验:`bun run src/eval/tasks/no-graph-baseline/f1-check.ts --dir <快照目录>`(隐藏点位表,分数=命中/总点位)。

<!-- harness-only:以下为夹具注记, 不进臂可见文本 -->
> 防泄题登记:快照 = `428dd3e044857f644ca95839d0b6ecfe28d49c0c`(基线)/ `2de591f4ebbfe55f2bf670952e538aabff631681`(参考答案,**不许给臂看**)。
> 臂在 `git archive` 导出的无 .git 目录上作业 —— 不许翻本仓历史抄答案(INV-R2-1 座位一致性核对同批检查)。
