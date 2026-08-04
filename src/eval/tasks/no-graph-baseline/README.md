# no-graph-baseline — r2 对照实验语料 (设计 docs/plan/2026-08-04-r2-no-graph-baseline-design.md)

四格任务集 (F1/F2 宽扇出 · G1/G2 散雾), 两臂同文。**语料规范表 = 各自的 *-registry.test.ts** (闸)。

| 格 | 任务 | 校验 | 状态 |
|---|---|---|---|
| F1 | client-skills 工具名机械迁移 (真历史 2de591f 逆向, 12 文件 26 点位) | `f1-check.ts --dir` (selftest: 基线 0/26 答案 26/26 ✓) | ✅ |
| F2 | ≥6 来源事实综合 (本仓 docs/reference 材料) | 核实清单 (预制) | 待建 |
| G1 | 散雾探索 (3 改进+论证) | 发现物出口数 + 盲评 | 待建 |
| G2 | 散雾多日 (中途需求变化) | 失效识别/预埋点 | 待建 |

防泄题: 臂在 `git archive <快照>` 导出的无 .git 目录作业; 快照 hash 钉在 registry test。
