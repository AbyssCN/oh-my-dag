# SDD — omd MCP Server（引擎与 UI 解耦：Claude Code 当大脑，omd 当自包含执行机器）

> 状态：**P1 + P2 已交付**（2026-07-20，dogfood: k3 车队执行 + 审核方验收整备）。
> 交付偏差记录：工具面 14 个（原契约 16）——dag_review/slim/deepen 与 dream_consolidate 未做成
> MCP 工具（走客户端 bash 调 shell 车队已够用，避免 D-7 注册面膨胀；要独立工具另立增量）；
> 超契约新增：dag_node_output 三级下钻、派发简报、dag_status 活体进度、dag_run_plan resume
> 断点续跑、path_add/path_prefetch。P3（sampling / ACP）未动。
> 前情：pi TUI 对比 Claude Code/Codex 有代差（打磨/权限流/多端入口），且 pi 快速演进带 churn 税
> （0.77→0.80 认证考古一天）。omd 的价值大头（DAG 引擎/车队/记忆/pathfinder）不依赖 pi 的 UI。

## 问题陈述

omd 当前唯一的人机入口是 pi TUI。用户日常主驾驶想用世界级 agent UI（Claude Code/Codex），
但不想放弃 omd 的独有能力：DAG 并发执行引擎、research/review/slim/deepen 车队、跨 session
SQLite 记忆、pathfinder 决策地图、以及配好的国产模型矩阵（kimi-coding:k3 订阅 + deepseek/mimo/qwen）。
需要一条解耦路径：**UI 换人，引擎不动，额度分开烧**。

## 目标

一个**纯 stdio MCP server**（零 UI、自包含）：
- Claude Code（或任何 MCP 客户端）经工具驱动 omd 全部独有能力；
- 模型调用发生在 omd 自己的进程里 —— 自有 callModel 栈 + `~/.omd/env` 全局配置 +
  kimi OAuth 自动刷新（kimi-oauth.ts）；与客户端的 Anthropic 认证互不相干；
- 贵模型（Opus）只出对话与规划，量大的叶子工作烧便宜订阅 —— 最优成本结构；
- pi 保留为无头执行 runtime（agent-leaf 工具循环），TUI 继续可用，两入口共享同一份配置/记忆/地图。

非目标：不做 HTTP/SSE 远端服务（本机单用户）；不做 MCP sampling 依赖（可选糖后置）；
不搬 pi 会话的被动记忆钩子（R1-R3 是 pi-session 专属）。

## 决策记录（D-numbers）

| # | 决策 | 理由 / 被否替代 |
|---|---|---|
| D-1 | 传输 = **stdio 纯 MCP**，入口 `omd mcp` 子命令（tui.ts args 分流，同 `omd init` 范式） | 本机单用户，stdio 最简；HTTP/SSE 被否（新增网络面无收益） |
| D-2 | **模型自包含**：server 进程用自有 callModel 栈（env 注册表 + pi 目录后备 + kimi-oauth 刷新），不向客户端要补全 | 额度分开烧是本方案核心卖点；sampling 作 P3 可选糖（客户端模型入 leaf 池），非依赖 |
| D-3 | 长任务**三段式**：`dag_run*` 立即回 runId → `dag_status` 轮询 → `dag_result` 取产物；短工具（recall/path_rule）同步返回 | MCP 客户端超时不可控；引擎 continuity/checkpoint 现成，崩溃后 resume 同 runId |
| D-4 | **plan 接缝直通**：`dag_run_plan` 入参 = ConductorPlan JSON（Zod schema 转 MCP inputSchema），Claude 当规划大脑 → 零 conductor 调用；`dag_run(task)` 保留 conductor 路径 | ConductorPlan 本来就是"执行机器对来源零感知"的接缝（D-7 pathfinder 同源）；Opus 规划质量 ≥ 弱 conductor |
| D-5 | **记忆共库**：同一 `memory.db`/dream 管线，写入仍过 validateFactWrite 校验闸；捕获从被动钩子改**显式** `memory_remember`（配 CLAUDE.md 指引何时存） | 跨 UI 一份长期记忆是红利；被动钩子搬不动（pi 会话事件流专属），显式捕获是 Claude Code 用户的既有习惯 |
| D-6 | **pathfinder 以工具+文件呈现**：path_map/tickets/rule/compile/dispatch；grill 票由 Claude 对话本身承担（问→答→`path_rule` 落图）；地图 markdown-in-git 真相源不变；shift+tab 模式壳不搬 | pathfinder D-3（markdown 真相源）意外成为跨宿主关键 —— Claude Code 不经工具也能 Read/Edit 地图；苏格拉底拷问本来就是对话活 |
| D-7 | **工具面窄进**：v1 只暴露 omd 独有能力（约 16 个工具），不暴露 bash/文件/搜索等客户端已有能力 | 工具越多 Claude 选择越乱（Smart Zone 同理）；重叠工具是纯噪音 |
| D-8 | **宽出纪律**：工具返回压缩产物（brief/摘要/计数 + 产物落盘路径），不向客户端上下文灌全量输出 | 对齐引擎 fan-in 纪律；Claude 需要细节时自己 Read 产物文件 |
| D-9 | **进程模型**：server 常驻（客户端管 spawn/kill），DAG 在 server 进程内 async 跑（引擎本就 in-process fan-out）；不 spawn 子进程集群 | 引擎设计即 in-process；崩溃恢复靠 continuity resume（D-3 的 runId 语义） |
| D-10 | **安全面不扩**：工具作用域 = 启动时 cwd（repo）；command 叶继续过 fail-closed 闸 + 白名单；MCP 不新增权限 | server 只是引擎的另一个调用面，闸门在引擎层不在入口层 |
| D-11 | 注册管理：server 端 `tools/list` 描述一行制（≤120 字符/工具），说明书住 SKILL/CLAUDE.md 不住 description | 客户端每轮都付 description 税（agent-template 注册表同理） |

## 范围澄清：三件套（MCP 只承载"能力"，"行为"走 Claude Code 原生机制）

MCP 无权管客户端模型的行为（拦工具/注入系统提示）。omd 各层按性质分流三扇门：

| 门 | 承载 | omd 来源 |
|---|---|---|
| ① MCP server | **能力**：DAG 引擎+车队 / 记忆库 / pathfinder（引擎内部的 persona/模板卡/lens/caveman 随进程自动保留） | 本 SDD 主体 |
| ② `.claude/skills` | **思维模式**：22 技能直装（技能包自始 `.claude/skills` 兼容，零改造） | skills/ 原样 |
| ③ CLAUDE.md + hooks | **身份 + 行为闸门**：omd 纪律写 CLAUDE.md；写后必验/危险命令走 PreToolUse hook（退出码 2 硬阻断，与 pi 扩展闸同强度） | 行为层重述 |

不搬（pi 会话专属）：被动记忆钩子、tier-advisory 工具流观察、TUI 壳。两入口并存，共享配置/记忆/地图。

## 架构

```
Claude Code (Opus = 对话/规划大脑, UI/权限流)          omd TUI (保留, 可并存)
        │ MCP stdio                                        │
        ▼                                                  ▼
┌─ omd MCP server (bun, 零 UI) ────────────┐      ┌─ pi runtime ─┐
│ src/mcp/server.ts   组装: Server+Stdio    │      │  (原样)      │
│ src/mcp/tools/*.ts  纯函数处理器 (注入接缝)│      └──────┬───────┘
│        │                                  │             │
│        ▼ 共享接缝 (均为现有公共面)          │◀────────────┘
│  runExecutorDag / runExecutorDagWithPlan  │   ← DAG 引擎 (不动)
│  researchFanout / dag-review / slim / deepen │ ← 车队 (不动)
│  memory store + recall + dream            │   ← 记忆 (不动, 共库)
│  pathfinder map-store / frontier / slice-compiler │ ← 地图 (不动, 共文件)
│  callModel (env 注册表 + pi 目录后备 + kimi-oauth) │ ← 模型层 (不动)
└───────────────────────────────────────────┘
```

## 工具面（v1 契约）

| 工具 | 入参要点 | 返回 | 模式 | 期 |
|---|---|---|---|---|
| `dag_run` | task, maxFanout?, verifier? | runId | 异步 | P1 |
| `dag_run_plan` | plan (ConductorPlan JSON), 同上 | runId | 异步 | P1 |
| `dag_status` | runId | 节点态汇总 (done/failed/running 计数 + 当前层) | 同步 | P1 |
| `dag_result` | runId | acceptance brief + 产物路径表 + usage | 同步 | P1 |
| `dag_research` | question, council?, super?, k? | runId (产物 = 报告落盘路径) | 异步 | P1 |
| `memory_recall` | query, k? | 事实列表 (带置信/出处) | 同步 | P1 |
| `memory_remember` | fact, type? | ok/rejected (过校验闸, 拒因回显) | 同步 | P1 |
| `dag_review` | gate?, scope? | runId | 异步 | P2 |
| `dag_slim` / `dag_deepen` | scope? | runId | 异步 | P2 |
| `dream_consolidate` | — | 整理统计 | 同步(慢) | P2 |
| `path_map` | dest? | 地图列表/单图前沿摘要 | 同步 | P2 |
| `path_tickets` | dest | open 票列表 (类型/依赖) | 同步 | P2 |
| `path_rule` | dest, ticketId, decision | 落图确认 + 新前沿 | 同步 | P2 |
| `path_compile` | dest, zone | ConductorPlan (交 dag_run_plan) | 同步 | P2 |
| `path_dispatch` | dest, ticketId | runId (AFK research 车队) | 异步 | P2 |

P3（可选糖，不承诺）：MCP sampling 把客户端模型挂进 leaf 池；ACP 入口。

## 测试接缝 (Seams)

- `src/mcp/server.ts` 纯组装（Server + StdioServerTransport + 工具注册），零逻辑。
- `src/mcp/tools/*.ts` 处理器为纯函数：注入 `{ engine, memory, pathfinder, cwd, clock }`，
  测试传 fake（与 executor-dag 测试的 GenerateFn 注入同范式）。
- SDK 的 `InMemoryTransport` 对接 Client/Server 双端 → 无进程端到端测试（tools/list、
  schema 拒坏参、三段式生命周期）。
- run 注册表（runId → 状态/结果）独立小模块，可无盘单测；持久面复用 continuity。

## 先红纪律

每工具先写失败测试再实现：schema 拒坏参（缺 task / plan 非法 → MCP error 非 crash）、
`dag_status` 对未知 runId 的明确错、`memory_remember` 被校验闸拒的回显、
`dag_run_plan` 对无效 ConductorPlan 的 parsePlan 级拒绝。

## Oracle-cmd

```
bun run typecheck && bun test
```

## Allowed files / Forbidden files

- Allowed：`src/mcp/**`（新）、`src/harness/tui.ts`（仅 args 分流 `omd mcp`）、`package.json`
  （scripts）、`test/core/mcp-*.test.ts`、`docs/**`、`README.md`（入口文档）。
- Forbidden：`src/harness/executor-dag*`、`src/harness/pathfinder/**`、`src/harness/memory/**`、
  `src/model/**`、`src/runtime/**` —— **只消费公共面，不改引擎**。改到即越界，回 SDD 重议。

## Review Gate

G2 双轴（`dag-review --gate G2`）+ 手工端到端：Claude Code 真配 mcpServers →
`dag_run_plan` 三段式跑通一张 3 节点图（叶子落 kimi-coding:k3）+ `memory_recall` 命中。

## 分期

- **P1**：server 骨架 + dag_run/dag_run_plan/dag_status/dag_result + dag_research +
  memory_recall/remember + **三件套的 ②③**（skills 安装指引 + CLAUDE.md 模板 + 两个 hook
  样例 — 几乎零成本, 先装先受益）+ Claude Code 配置文档（mcpServers 一段）。
- **P2**：三车队 + dream + pathfinder 五件套。
- **P3**（可选）：sampling 客户端模型池、ACP。
