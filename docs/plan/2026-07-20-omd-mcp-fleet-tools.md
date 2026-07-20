# SDD — omd MCP 纯化增量：车队四工具 + run 发现 + conductor 续跑 + 记忆蒸馏钩子

> 状态：契约（owner 令 2026-07-20："纯靠 MCP 调用所有功能" + "做 2、3 和 5" + "调用 omd mcp 做这些"）。
> 执行：k3 车队经 omd MCP `dag_run_plan`（Fable 出图），resume 断点续跑兜 429。
> 前情：MCP P1+P2 已交付（SDD 2026-07-19 落章）；本增量补"纯 MCP 客户端"形态的缺口。

## 问题陈述

客户端不再依赖 bash 调 shell 车队 → dag_review/slim/deepen 与 dream 整理在纯 MCP 形态下不可达；
server 重启后 run 不可发现（registry 纯内存）；conductor 路径 (`dag_run`) 无断点续跑；
记忆写入靠显式调用，会话结束"忘了存"是人为漏洞。

## 决策记录（D-numbers）

| # | 决策 | 理由 / 被否替代 |
|---|---|---|
| D-1 | **车队四工具 MCP 化**：`dag_review(gate?,scope?)` `dag_slim(scope?)` `dag_deepen(commits?,hotspots?)` 异步三段式（复用 runRegistry/runId）；`dream_consolidate()` 同步(慢)。实现 = **受监督子进程包装** `scripts/dag-*.ts`（Bun.spawn 本仓脚本, 非任意 shell — D-10 安全面不扩），stdout/报告落盘回路径（D-8 宽出） | 脚本是车队的维护入口；重编排 = 平行真相源，drift 必至。dream 无脚本 → 直连 src/dream 接缝 |
| D-2 | **slash 发现层**：client-skills 加 `/review` `/slim` `/deepen` `/dream` 四薄壳技能（教客户端模型何时调对应 MCP 工具, 一屏内） | 注册面在 server（下载配置即用），技能只做触发教学 — 双层各司其职 |
| D-3 | **`dag_run` 加 resume 参数**：语义直通引擎 generation 闸 — 重规划图形状变 → checkpoint 自动作废（等价全跑, 不假续）；图稳定 → 真续。文档言明"确定性续跑首选 dag_run_plan" | 不新增机制；generation 闸是现成的对账真相 |
| D-4 | **`dag_runs` 发现工具**：内存 registry ∪ continuity 目录扫描（`.omd/continuity/*/_dag.json`）合并去重 → runId/状态/goal/时间 列表（截断 20, 宽出）。server 重启后客户端可发现"上次断掉的 runId" | resume 的可用性缺了发现就是半成品 |
| D-5 | **记忆蒸馏 Stop hook 样例**：`docs/examples/claude-code/hooks/memory-distill.sh` — Claude Code Stop hook 提示模型把本会话可复用结论经 `memory_remember` 入库（软提示, 不 block 硬拦）+ CLAUDE.md 模板补该节 | 把"忘了存"从人为因素变成默认行为；被动钩子 (pi 专属) 的客户端等价物 |
| D-6 | **P3 sampling 关闭（否决留档）**：① Claude Code 不支持 sampling（anthropics/claude-code#1785 开放请求）② MCP 2026-07-28 RC 已弃用 sampling ③ 订阅凭证挂第三方 runtime 违反 Anthropic ToS（订阅认证仅限官方客户端; kimi device-flow 先例不适用）。**合规替代**: `ANTHROPIC_API_KEY` 按量 API 入 fleet — pi 目录原生支持, 零代码 | 三重否决, 任一都足够; 不留悬案 |

## 工具面增量（14 → 19）

| 工具 | 入参 | 返回 | 模式 |
|---|---|---|---|
| `dag_review` | gate?, scope? | runId → 报告路径 | 异步 |
| `dag_slim` | scope? | runId → 报告路径 | 异步 |
| `dag_deepen` | commits?, hotspots? | runId → HTML 报告路径 | 异步 |
| `dream_consolidate` | — | 整理统计 (层计数) | 同步(慢) |
| `dag_runs` | status? | run 列表 (≤20, 含重启前) | 同步 |

## 执行编排（dogfood）

Fable 出图 → k3 车队经 omd MCP 执行，两张小图（防限流窗），429 → **resume 同 runId 续跑**（上一增量的能力自证）：
- **图A（代码）**：fleet.ts 四工具 + dag_runs + dag_run resume 参数 + 各先红测试 + oracle 双闸
- **图B（文档）**：四 slash 薄壳 + memory-distill hook + CLAUDE.md 补节 + README 工具数同步

## Allowed / Forbidden

- Allowed：`src/mcp/**`、`test/core/mcp-*.test.ts`、`client-skills/**`、`docs/**`、`README.md`。
- Forbidden：`src/harness/**`（含 executor-dag*/review/slim/arch 内核）、`src/dream/**` 只消费导出、
  `src/model/**`、`src/runtime/**`、`scripts/**`（被包装不被改）。

## Oracle-cmd

```
bun run typecheck && bun test
```
