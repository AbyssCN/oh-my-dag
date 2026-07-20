# Pathfinder: omd MCP server — 引擎与 UI 解耦: Claude Code 当大脑 (对话/规划), omd 当自包含执行机器 (DAG/车队/记忆/pathfinder, 自有额度)

<!-- slug: omd-mcp-server -->

## Decisions so far

- [d01-stdio] D-1 stdio 纯 MCP, 入口 `omd mcp` 子命令 (tui.ts args 分流, 同 `omd init` 范式); HTTP/SSE 被否 (本机单用户, 新增网络面无收益)
- [d02-model-selfcontained] D-2 server 进程用自有 callModel 栈 (env 注册表 + pi 目录后备 + kimi-oauth 刷新), 不向客户端要补全; sampling 仅 P3 可选糖
- [d03-three-phase-runs] D-3 dag_run* 立即回 runId → dag_status 轮询 → dag_result 取产物; 短工具同步返回; 崩溃后 continuity resume 同 runId
- [d04-plan-seam] D-4 dag_run_plan 入参 = ConductorPlan JSON (Zod 转 inputSchema), Claude 当规划大脑零 conductor 调用; dag_run(task) 保留 conductor 路径
- [d05-shared-memory] D-5 同一 memory.db/dream 管线, 写入过 validateFactWrite 校验闸; 被动钩子改显式 memory_remember (配 CLAUDE.md 指引)
- [d06-pathfinder-as-tools] D-6 path_map/tickets/rule/compile/dispatch 五工具 + markdown-in-git 真相源不变; grill 由 Claude 对话承担; shift+tab 模式壳不搬
- [d07-narrow-tool-surface] D-7 v1 只暴露 omd 独有能力 (~16 工具), 不暴露 bash/文件/搜索等客户端已有能力
- [d08-wide-out] D-8 工具返回压缩产物 (brief/摘要/计数 + 产物落盘路径), 不向客户端上下文灌全量输出
- [d09-process-model] D-9 server 常驻 (客户端管 spawn/kill), DAG 在 server 进程内 async 跑; 不 spawn 子进程集群; 崩溃靠 continuity resume
- [d10-security-noexpand] D-10 工具作用域 = 启动时 cwd; command 叶继续过 fail-closed 闸 + 白名单; MCP 不新增权限
- [d11-short-descriptions] D-11 description ≤120 字符/工具; 说明书住 SKILL/CLAUDE.md 不住 description (客户端每轮付 description 税)
- [research-seams] 齐备 (2026-07-19 实证): runExecutorDagWithPlan@executor-dag.ts:583 (D-7 预构造入口已在, 跳 conductor); OmdMemory/createOmdMemory@src/harness/memory (混合检索内建) + validateFactWrite@src/memory/safeguards/validator.ts (VAL-INV-9 两基座共用同一 guard); pathfinder map-store/frontier/slice-compiler/dispatch 全导出; CheckpointManager@continuity/checkpoint-manager.ts:35。→ MCP server 只消费公共面成立, Allowed/Forbidden 文件边界可守。
- [research-sdk] 零新增依赖: @modelcontextprotocol/sdk ^1.29.0 已在 dependencies (omd 客户端栈 src/harness/mcp/sdk-client.ts 在用同版); server/stdio.js (StdioServerTransport) + inMemory.js (InMemoryTransport, Client/Server 双端无进程测试) + zod-compat (Zod→inputSchema) 齐备。→ SDD 测试接缝 (InMemoryTransport 端到端) 可落地。
- [research-model-layer] D-2 成立: callModel@src/model/index.ts:316 (env 注册表 + pi 目录后备); kimi-coding OAuth 自包含 — device flow + 自动刷新 (fbe1e55), pi 0.80 走 registerProvider 正门 (280f817)。server 进程独立烧自有额度 (kimi-coding:k3 订阅 + deepseek/mimo/qwen), 与客户端 Anthropic 认证互不相干。
- [task-server-skeleton] 交付 src/mcp/server.ts 纯组装 (Server + StdioServerTransport + 工具注册, 零逻辑) + src/harness/tui.ts args 分流 `omd mcp` (同 `omd init` 范式) + package.json script。先红: server 启动注册面测试 (test/core/mcp-*.test.ts)。边界: 只消费公共面, 禁改 executor-dag* / pathfinder/** / memory/** / model/** / runtime/**。已存在 run2 产物 src/mcp/server.ts + test/core/mcp-server.test.ts — 审阅沿用或补齐, 不推倒。
- [task-run-registry] 交付 src/mcp/run-registry.ts: run 注册表独立小模块 (runId → 状态/结果), 可无盘单测; 持久面复用 continuity (崩溃后 resume 同 runId, D-3/D-9)。先红 (test/core/mcp-run-registry.test.ts): 未知 runId 返明确错 (MCP error 非 crash)。
- [task-tools-dag] 交付 src/mcp/tools/ 下 dag_run/dag_run_plan/dag_status/dag_result 四工具 — 纯函数处理器, 注入 {engine, runRegistry, cwd, clock} (测试传 fake, 同 executor-dag GenerateFn 注入范式); 引擎接缝 runExecutorDag/runExecutorDagWithPlan。先红: schema 拒坏参 (缺 task/plan 非法 → MCP error 非 crash)、dag_run_plan 对无效 ConductorPlan 的 parsePlan 级拒绝、未知 runId 明确错。宽出 (D-8): 返回 runId/节点计数/产物路径, 不灌全量输出。tools/list 描述 ≤120 字符 (D-11)。
- [task-tools-memory] 交付 memory_recall + memory_remember 两工具 (src/mcp/tools/memory.ts): recall (query,k? → 事实列表带置信/出处; OmdMemory/createOmdMemory 接缝); remember (fact → ok/rejected; 过 validateFactWrite 校验闸 @src/memory/safeguards/validator.ts, 拒因回显)。纯函数处理器注入 {memory, cwd}。先红: 校验闸拒 secret/越界 namespace 的回显。描述 ≤120 字符。
- [task-tool-research] 交付 dag_research 异步工具 (src/mcp/tools/research.ts): question, council?, super?, k? → runId; researchFanout 接缝; 报告落盘, 返回落盘路径 + 摘要 (宽出 D-8)。先红: 缺 question → MCP error。描述 ≤120 字符。
- [task-e2e-inmemory] 交付 InMemoryTransport 端到端测试 (test/core/mcp-e2e.test.ts): Client/Server 双端无进程对接 — tools/list (全工具注册 + 描述 ≤120 字符 D-11)、schema 拒坏参、dag_run_plan 三段式生命周期 (注入 fake engine: runId → status 轮询 → result 取产物)。
- [task-triad-docs] 交付三件套②③ + 入口文档: .claude/skills 安装指引 (22 技能直装, 指 skills/ 原样)、CLAUDE.md 模板 (omd 纪律: 写后必验/危险命令闸)、两个 PreToolUse hook 样例 (写后必验 + dangerous-cmd, 退出码 2 硬阻断)、README.md 增 Claude Code mcpServers 配置段 (`omd mcp`)。只动 docs/ 与 README, 示例落 docs/examples/claude-code/。
- [grill-signoff] owner 签字: "按照sdd执行" (2026-07-19)。P1 范围如 SDD: server 骨架 + dag_run*/status/result + dag_research + memory 两件 + 三件套②③ + 配置文档。
- [rca-filestouched-gate] run1(k3,240s)/run2(k3,600s) 全 7 叶 failed 的根因: executor-dag.ts:406 产物闸要求 filesTouched 非空, 但 AgentLeafRunner 的 filesTouched 生产者在全仓无任何实现 (grep 实证, 只有 leaf-runners.ts:21 类型声明) → producesFiles 节点 (goal 正则命中) 100% 假阴性, 与模型无关 (run2 叶已真写 src/mcp/server.ts 仍判 failed)。修复 = 在 agent-leaf scoped session 包 write/edit 工具记账 — 属 SDD Allowed 白名单外, 需另起 SDD 修引擎; 另: k3 叶 240s 预算不足 (600s 下正常产物), 且 k3 叶 loop 内有 drift spinning 前科。
- [task-server-skeleton] 人工交付 (run2 产物审阅沿用, commit 54f0c53): src/mcp/server.ts + tui.ts `omd mcp` 分流 + package.json script + test/core/mcp-server.test.ts。run3 剔出 region, 防叶子覆写。

## Tickets

### status: open

_(none)_

### status: blocked

_(none)_

### status: ruled

### task-run-registry
- type: task
- title: run 注册表模块: runId → 状态/结果, 可无盘单测, 持久面复用 continuity
- status: delivered
- delivered: run3 交付 (c3a71d4) + 明细层 (1917a03) + 活体进度 applyNodeEvent (0da74bc)
- blockedBy: research-seams, grill-signoff
- ruling: 交付 src/mcp/run-registry.ts: run 注册表独立小模块 (runId → 状态/结果), 可无盘单测; 持久面复用 continuity (崩溃后 resume 同 runId, D-3/D-9)。先红 (test/core/mcp-run-registry.test.ts): 未知 runId 返明确错 (MCP error 非 crash)。
- executorKind: agent

### task-tools-dag
- type: task
- title: dag_run/dag_run_plan/dag_status/dag_result 四工具 + 先红 (schema 拒坏参 / 未知 runId 明确错 / parsePlan 级拒绝)
- status: delivered
- delivered: 四工具 (c3a71d4) + dag_node_output 三级下钻 (1917a03) + 派发简报/活体status (340ec62) + resume 断点续跑 (6eeaf40)
- blockedBy: task-server-skeleton, task-run-registry
- ruling: 交付 src/mcp/tools/ 下 dag_run/dag_run_plan/dag_status/dag_result 四工具 — 纯函数处理器, 注入 {engine, runRegistry, cwd, clock} (测试传 fake, 同 executor-dag GenerateFn 注入范式); 引擎接缝 runExecutorDag/runExecutorDagWithPlan。先红: schema 拒坏参 (缺 task/plan 非法 → MCP error 非 crash)、dag_run_plan 对无效 ConductorPlan 的 parsePlan 级拒绝、未知 runId 明确错。宽出 (D-8): 返回 runId/节点计数/产物路径, 不灌全量输出。tools/list 描述 ≤120 字符 (D-11)。
- executorKind: agent

### task-tools-memory
- type: task
- title: memory_recall/memory_remember 两工具 + 先红 (校验闸拒因回显)
- status: delivered
- delivered: 实现 (c3a71d4) + 真闸先红测试补齐 (round4 装配批)
- blockedBy: task-server-skeleton, research-seams
- ruling: 交付 memory_recall + memory_remember 两工具 (src/mcp/tools/memory.ts): recall (query,k? → 事实列表带置信/出处; OmdMemory/createOmdMemory 接缝); remember (fact → ok/rejected; 过 validateFactWrite 校验闸 @src/memory/safeguards/validator.ts, 拒因回显)。纯函数处理器注入 {memory, cwd}。先红: 校验闸拒 secret/越界 namespace 的回显。描述 ≤120 字符。
- executorKind: agent

### task-tool-research
- type: task
- title: dag_research 异步工具 (researchFanout 接缝, runId 三段式, 报告落盘)
- status: delivered
- delivered: 实现 (c3a71d4) + 缺 question 先红测试补齐 (round4 装配批)
- blockedBy: task-server-skeleton, research-seams
- ruling: 交付 dag_research 异步工具 (src/mcp/tools/research.ts): question, council?, super?, k? → runId; researchFanout 接缝; 报告落盘, 返回落盘路径 + 摘要 (宽出 D-8)。先红: 缺 question → MCP error。描述 ≤120 字符。
- executorKind: agent

### task-e2e-inmemory
- type: task
- title: InMemoryTransport 端到端: tools/list / schema 拒坏参 / 三段式生命周期
- status: delivered
- delivered: test/core/mcp-e2e.test.ts (round4 装配批) — 14 工具枚举/坏参三层拒/三段式生命周期; 真 stdio e2e 另证 E2E_PASS
- blockedBy: task-tools-dag, task-tools-memory, task-tool-research
- ruling: 交付 InMemoryTransport 端到端测试 (test/core/mcp-e2e.test.ts): Client/Server 双端无进程对接 — tools/list (全工具注册 + 描述 ≤120 字符 D-11)、schema 拒坏参、dag_run_plan 三段式生命周期 (注入 fake engine: runId → status 轮询 → result 取产物)。
- executorKind: agent

### task-triad-docs
- type: task
- title: 三件套②③ + 入口文档: skills 安装指引 / CLAUDE.md 模板 / 两个 PreToolUse hook 样例 / Claude Code mcpServers 配置 (README)
- status: delivered
- delivered: docs/examples/claude-code (c3a71d4) + client-skills 12 技能包 + MCP-ONBOARDING (ad9a9f3)
- blockedBy: grill-signoff
- ruling: 交付三件套②③ + 入口文档: .claude/skills 安装指引 (22 技能直装, 指 skills/ 原样)、CLAUDE.md 模板 (omd 纪律: 写后必验/危险命令闸)、两个 PreToolUse hook 样例 (写后必验 + dangerous-cmd, 退出码 2 硬阻断)、README.md 增 Claude Code mcpServers 配置段 (`omd mcp`)。只动 docs/ 与 README, 示例落 docs/examples/claude-code/。
- executorKind: agent

### research-seams
- type: research
- title: 引擎/记忆/pathfinder/continuity 公共出口是否齐备 (MCP 只消费公共面, 零引擎改动是否成立)
- status: ruled
- blockedBy: 
- ruling: 齐备 (2026-07-19 实证): runExecutorDagWithPlan@executor-dag.ts:583 (D-7 预构造入口已在, 跳 conductor); OmdMemory/createOmdMemory@src/harness/memory (混合检索内建) + validateFactWrite@src/memory/safeguards/validator.ts (VAL-INV-9 两基座共用同一 guard); pathfinder map-store/frontier/slice-compiler/dispatch 全导出; CheckpointManager@continuity/checkpoint-manager.ts:35。→ MCP server 只消费公共面成立, Allowed/Forbidden 文件边界可守。

### research-sdk
- type: research
- title: MCP SDK 面: Server/StdioServerTransport/InMemoryTransport/Zod→inputSchema 是否齐备, 是否需新增依赖
- status: ruled
- blockedBy: 
- ruling: 零新增依赖: @modelcontextprotocol/sdk ^1.29.0 已在 dependencies (omd 客户端栈 src/harness/mcp/sdk-client.ts 在用同版); server/stdio.js (StdioServerTransport) + inMemory.js (InMemoryTransport, Client/Server 双端无进程测试) + zod-compat (Zod→inputSchema) 齐备。→ SDD 测试接缝 (InMemoryTransport 端到端) 可落地。

### research-model-layer
- type: research
- title: callModel 栈 + kimi-oauth 自包含性: server 进程能否独立烧自有额度 (D-2 是否成立)
- status: ruled
- blockedBy: 
- ruling: D-2 成立: callModel@src/model/index.ts:316 (env 注册表 + pi 目录后备); kimi-coding OAuth 自包含 — device flow + 自动刷新 (fbe1e55), pi 0.80 走 registerProvider 正门 (280f817)。server 进程独立烧自有额度 (kimi-coding:k3 订阅 + deepseek/mimo/qwen), 与客户端 Anthropic 认证互不相干。

### d01-stdio
- type: grill
- title: 传输选型
- status: ruled
- blockedBy: 
- ruling: stdio 纯 MCP, 入口 `omd mcp` 子命令 (tui.ts args 分流, 同 `omd init` 范式); HTTP/SSE 被否 (本机单用户, 新增网络面无收益)
- dNumber: D-1

### d02-model-selfcontained
- type: grill
- title: 模型自包含
- status: ruled
- blockedBy: 
- ruling: server 进程用自有 callModel 栈 (env 注册表 + pi 目录后备 + kimi-oauth 刷新), 不向客户端要补全; sampling 仅 P3 可选糖
- dNumber: D-2

### d03-three-phase-runs
- type: grill
- title: 长任务三段式
- status: ruled
- blockedBy: 
- ruling: dag_run* 立即回 runId → dag_status 轮询 → dag_result 取产物; 短工具同步返回; 崩溃后 continuity resume 同 runId
- dNumber: D-3

### d04-plan-seam
- type: grill
- title: plan 接缝直通
- status: ruled
- blockedBy: 
- ruling: dag_run_plan 入参 = ConductorPlan JSON (Zod 转 inputSchema), Claude 当规划大脑零 conductor 调用; dag_run(task) 保留 conductor 路径
- dNumber: D-4

### d05-shared-memory
- type: grill
- title: 记忆共库
- status: ruled
- blockedBy: 
- ruling: 同一 memory.db/dream 管线, 写入过 validateFactWrite 校验闸; 被动钩子改显式 memory_remember (配 CLAUDE.md 指引)
- dNumber: D-5

### d06-pathfinder-as-tools
- type: grill
- title: pathfinder 呈现方式
- status: ruled
- blockedBy: 
- ruling: path_map/tickets/rule/compile/dispatch 五工具 + markdown-in-git 真相源不变; grill 由 Claude 对话承担; shift+tab 模式壳不搬
- dNumber: D-6

### d07-narrow-tool-surface
- type: grill
- title: 窄工具面
- status: ruled
- blockedBy: 
- ruling: v1 只暴露 omd 独有能力 (~16 工具), 不暴露 bash/文件/搜索等客户端已有能力
- dNumber: D-7

### d08-wide-out
- type: grill
- title: 宽出纪律
- status: ruled
- blockedBy: 
- ruling: 工具返回压缩产物 (brief/摘要/计数 + 产物落盘路径), 不向客户端上下文灌全量输出
- dNumber: D-8

### d09-process-model
- type: grill
- title: 进程模型
- status: ruled
- blockedBy: 
- ruling: server 常驻 (客户端管 spawn/kill), DAG 在 server 进程内 async 跑; 不 spawn 子进程集群; 崩溃靠 continuity resume
- dNumber: D-9

### d10-security-noexpand
- type: grill
- title: 安全面不扩
- status: ruled
- blockedBy: 
- ruling: 工具作用域 = 启动时 cwd; command 叶继续过 fail-closed 闸 + 白名单; MCP 不新增权限
- dNumber: D-10

### d11-short-descriptions
- type: grill
- title: tools/list 一行制
- status: ruled
- blockedBy: 
- ruling: description ≤120 字符/工具; 说明书住 SKILL/CLAUDE.md 不住 description (客户端每轮付 description 税)
- dNumber: D-11

### grill-signoff
- type: grill
- title: SDD 契约签字 + P1 范围确认 (server 骨架 + dag_run*/status/result + dag_research + memory 两件 + 三件套②③ + 配置文档)
- status: ruled
- blockedBy: research-seams, research-sdk, research-model-layer
- ruling: owner 签字: "按照sdd执行" (2026-07-19)。P1 范围如 SDD: server 骨架 + dag_run*/status/result + dag_research + memory 两件 + 三件套②③ + 配置文档。

### rca-filestouched-gate
- type: research
- title: fleet agent 叶产物闸 filesTouched 生产者缺失 (P0, 闸不可满足)
- status: ruled
- blockedBy: 
- ruling: run1(k3,240s)/run2(k3,600s) 全 7 叶 failed 的根因: executor-dag.ts:406 产物闸要求 filesTouched 非空, 但 AgentLeafRunner 的 filesTouched 生产者在全仓无任何实现 (grep 实证, 只有 leaf-runners.ts:21 类型声明) → producesFiles 节点 (goal 正则命中) 100% 假阴性, 与模型无关 (run2 叶已真写 src/mcp/server.ts 仍判 failed)。修复 = 在 agent-leaf scoped session 包 write/edit 工具记账 — 属 SDD Allowed 白名单外, 需另起 SDD 修引擎; 另: k3 叶 240s 预算不足 (600s 下正常产物), 且 k3 叶 loop 内有 drift spinning 前科。

### status: delivered

### task-server-skeleton
- type: task
- title: server 骨架: src/mcp/server.ts 纯组装 (Server+StdioServerTransport+工具注册) + tui.ts args 分流 `omd mcp` + package.json script
- status: delivered
- blockedBy: research-sdk, grill-signoff
- ruling: 交付 src/mcp/server.ts 纯组装 (Server + StdioServerTransport + 工具注册, 零逻辑) + src/harness/tui.ts args 分流 `omd mcp` (同 `omd init` 范式) + package.json script。先红: server 启动注册面测试 (test/core/mcp-*.test.ts)。边界: 只消费公共面, 禁改 executor-dag* / pathfinder/** / memory/** / model/** / runtime/**。已存在 run2 产物 src/mcp/server.ts + test/core/mcp-server.test.ts — 审阅沿用或补齐, 不推倒。
- executorKind: agent

### status: escalated

_(none)_
