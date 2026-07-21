# Pathfinder: session-continuity-port: port memory-hub auto session handoff into omd

<!-- slug: session-continuity-port-port-memory-hub- -->

## Decisions so far

- [g1] 先做 MVP:先落 W1(共享 writer 模块)+ W4(SQLite sink),跑通单个 session 的「蒸馏写出 + 存储 + 开局读回」;验证有
- [g2] markdown 文件为真源(resume 读它),最新快照 + checkpoint 事件镜像进 omd 现有 SQLite 记忆库(namespace=co
- [g3] session checkpoint 落 ~/.omd/projects/<slug>/session/<sessionId>/;.omd/continuity
- [g5] 接受默认:新增 OMD_CONTINUITY_MODEL(默认走 leaf/dream 便宜模型,经标准解析链)· 零-LLM 反幻觉校验器原样移植(文件存在/
- [p1] 已实测两份真实 xihe transcript(191/485 行)。核心风险(格式漂移打断 token 记账)未兑现:✅ 每条 assistant 行都带 u
- [t2] 实装 src/harness/session/sink.ts 的真实 SQLite 镜像(替换两个 no-op 函数体;导出类型与函数签名逐字保持不变——W1 
- [t5] session 交接的配置接线 + 命名分离收尾(纯机械;禁改 src/harness/session/{writer,read-back,noun-gate}

## Tickets

### status: open

### g4
- type: grill
- title: D7 ledger 策略:隔离 parser + fail-open + token best-effort 全量移植,还是先砍掉 token 记账用更简单触发(按 p1 结果定)
- status: open
- blockedBy: p1

### t3
- type: task
- title: W3 Stop ledger:CC transcript token 记账 + 碰过文件/commit 抽取,隔离进独立 parser 模块 + fail-open + token best-effort 兜底(最 fiddly)
- status: open
- blockedBy: g4, p1
- executorKind: agent

### t4
- type: task
- title: W2 4 个 hook 脚本:SessionStart(additionalContext briefing 注入,>14天跳过/≤10k)· Stop(增量 ledger)· PreCompact(同步写)· SessionEnd(--final handoff splice),全 fail-open + writer.lock
- status: open
- blockedBy: t1, t3
- executorKind: agent

### t6
- type: task
- title: W6 测试 + 文档:writer 确定性 / 校验器 / fail-open / resume brief 单 session round-trip 测试 + docs/examples/claude-code/hooks/ 接线文档
- status: open
- blockedBy: t1, t2, t3, t4
- executorKind: agent

### status: blocked

_(none)_

### status: ruled

### p1
- type: prototype
- title: 接地验证:拿真实 CC transcript 跑 memory-hub 的 ledger parser,确认当前 CC JSONL 格式下 usage token / 碰过文件 / commit 仍可抽取(D7 最高风险的接地)
- status: ruled
- blockedBy: 
- ruling: 已实测两份真实 xihe transcript(191/485 行)。核心风险(格式漂移打断 token 记账)未兑现:✅ 每条 assistant 行都带 usage.input_tokens 等 4 个键,ctxTokens 解析正常(190k/226k);✅ 碰过文件、Bash 命令抽取完好;✅ 新增 line.type(ai-title/queue-operation/attachment/last-prompt/mode/permission-mode/bridge-session/file-history-snapshot/custom-title 等)被 allowlist 设计正确忽略、零破坏。两处best-effort软点(不致命):①commit 触发按 workflow 失灵——xihe/omd 的 commit 走 /commit skill 或 subagent,主 transcript 没有裸 git commit Bash 调用(实测两 session 均为 attachment/tool_result 回显 + 一个 subagent 内),主 Stop hook 看不到;token 档触发是可靠主触发,commit 只是加成。②lastUserAsk 被 <task-notification>/skill 前导 污染,过滤器只挡 <system-reminder>。结论:核心机制存活,ledger 全量移植可行;建议加两处小硬化(扩 user-ask skip 前缀;commit 触发改看 HEAD 移动或降为可选)。均落在 W2/W3(hook 层),不影响 MVP(W1+W4)。

### g5
- type: grill
- title: D3–D6/D8 默认项打包确认:OMD_CONTINUITY_MODEL(便宜模型)· 反幻觉校验器原样移植 · hook opt-in 例子不强制 · writer 抽共享模块被 hook+手动 skill 复用 · token 档或 commit 触发(env 阈值)
- status: ruled
- blockedBy: 
- ruling: 接受默认:新增 OMD_CONTINUITY_MODEL(默认走 leaf/dream 便宜模型,经标准解析链)· 零-LLM 反幻觉校验器原样移植(文件存在/commit 可 resolve/noun-gate 容差3,失败降级机械版)· 4 个 hook + writer 放 docs/examples/claude-code/hooks/ 作 opt-in 例子不强制接线 · writer 抽单一共享模块被 hook 与手动 /start /handoff skill 复用 · 触发按 token 档或 commit,阈值走 env(OMD_SESSION_BUCKET)。

### g3
- type: grill
- title: D2 命名分离:session checkpoint 落 ~/.omd/projects/<slug>/session/<sessionId>/,.omd/continuity/ 保留给 DAG-run 续跑,文档明确分层
- status: ruled
- blockedBy: 
- ruling: session checkpoint 落 ~/.omd/projects/<slug>/session/<sessionId>/;.omd/continuity/ 保留给 DAG-run 续跑,两者互不侵占。文档明确区分「run 续跑」与「session 交接」两个 continuity 概念。

### g2
- type: grill
- title: D1 存储 substrate:markdown 文件真源 + 镜像进 omd 现有 SQLite 记忆库(namespace=continuity,identity_key=sessionId),不引 Postgres
- status: ruled
- blockedBy: 
- ruling: markdown 文件为真源(resume 读它),最新快照 + checkpoint 事件镜像进 omd 现有 SQLite 记忆库(namespace=continuity,identity_key=sessionId 让同 session 多写演进一行),复用现有 facts/FTS/edges,不引入 Postgres。

### g1
- type: grill
- title: 范围与首刀:全量 W1–W6 一次交付 vs 先 MVP(W1 writer + W4 SQLite sink)跑通单 session 再上 hook 自动化
- status: ruled
- blockedBy: 
- ruling: 先做 MVP:先落 W1(共享 writer 模块)+ W4(SQLite sink),跑通单个 session 的「蒸馏写出 + 存储 + 开局读回」;验证有效后再上 W2/W3 的 hook 自动触发。W1 正确性敏感,Aalto 亲手或强 verify;W4 可派。

### status: delivered

### t1
- type: task
- title: W1 共享 writer 模块:9 段蒸馏 + 零-LLM 反幻觉校验(文件存在/commit 可 resolve/noun-gate 容差3)+ _NEXT.md splice,接 omd 模型层 + git(正确性敏感核心)
- status: delivered
- blockedBy: g2, g3, g5
- ruling: Aalto 亲手实装(不下放,g1 正确性敏感)—— src/harness/session/{writer,noun-gate,read-back,sink 契约}.ts + scripts/session-writer.ts + role-models.ts continuity 角色。commit f6e45fb。验证:tsc 0 err · 全 613 测试绿 · 真实 transcript 单 session 回路跑通(write→read-back)· 反幻觉闸实测正确拦截 flash 编造路径并 fail-open 降级 · 落盘 ~/.omd/projects/<slug>/session/ 与 DAG-run continuity 分家。
- executorKind: agent

### t5
- type: task
- title: W5 命名分离 + env 配置接线:session 目录与 DAG-run continuity 分家,OMD_SESSION_BUCKET / OMD_CONTINUITY_MODEL / MEMORY_TENANT→project-scope 映射
- status: delivered
- blockedBy: g3
- ruling: session 交接的配置接线 + 命名分离收尾(纯机械;禁改 src/harness/session/{writer,read-back,noun-gate}.ts 与 sink.ts 契约的逻辑)。① scripts/session-writer.ts:装配 OmdMemory 传 runWriter({memory}) 打开 SQLite 镜像——照 src/mcp/assemble.ts 的 createDefaultMemory(process.env) 装配姿势构造(memory.db 路径要 OMD_DATA_HOME/dataPath 感知,别硬写进当前 repo;构造失败则 fail-open 不传,markdown 仍落);加 --no-sink 关闭开关。② 统一 /start 与 /handoff 的 session log 路径:skills/start/SKILL.md 写 .omd/sessions/ 而 skills/handoff/SKILL.md 写 .claude/sessions/——两文件统一到 .omd/sessions/(与 omd 数据面一致),只改路径字样不动其它流程。③ 文档:在 docs/ 合适处加一节说明 (a) OMD_CONTINUITY_MODEL=session 蒸馏模型(默认便宜档)(b) OMD_SESSION_BUCKET=触发档阈值(phase-2 用)(c) session 交接落 ~/.omd/projects/<slug>/session/,与 DAG-run 的 .omd/continuity/ 是两个不同 continuity,明确分层。oracle=tsc(改了 .ts 就跑)。禁碰 src/harness/continuity/。 【交付核对:② handoff 路径统一(.claude/sessions/→.omd/sessions/)+ ③ env/分层文档 已交付;① memory 装配随 W4 defer 已回退,session-writer 保持 markdown-only。】
- executorKind: agent

### t2
- type: task
- title: W4 SQLite sink:checkpoint 事件追加 + 最新快照镜像进现有记忆库(namespace=continuity)+ 一个读 checkpoint 时间线的入口
- status: delivered
- blockedBy: g2
- ruling: ⚠️ 实为 DEFERRED —— 交付核对发现真存储撞 safeguard 红线(omd 记忆只收小型结构化 fact:user.*/omd.*,拒 continuity blob)。owner 决策甲=MVP markdown-only:DAG 交付的 writeFact impl 已回退,sink.ts 留 fail-open no-op 契约座,sink 测试删除。W4 非本 MVP 交付物;后续若要跨 session 语义召回,按「存 §1/§2 短摘要 fact + 新增 omd.session namespace」实现。原 slice 目标存档:实装 src/harness/session/sink.ts 的真实 SQLite 镜像(替换两个 no-op 函数体;导出类型与函数签名逐字保持不变——W1 的 writer.ts 依赖它们)。① sinkCheckpoint(input,deps):deps.memory 存在时调 OmdMemory.writeFact(src/harness/memory/store.ts:187)写最新快照——namespace='continuity',id=input.sessionId(→同 session 多写演化更新一行,靠 writeFact 内建 tombstoneByIdentity),text=[input.intent,input.next].filter(Boolean).join('\\n').slice(0,2000)(空则 input.md.slice(0,2000)),payload={mode,ctxTokens,degraded,checkpointPath,md},actorType='model',actorId='claude',confidence 用现有允许值。返回{ok:未 rejected,factStatus:w.status,error}。全程 fail-open:writeFact 抛/rejected→{ok:false,error 摘要},绝不抛。无 deps.memory→保持现有 {ok:false,error:'no OmdMemory injected...'}。② listCheckpoints(opts,deps):deps.memory.retrieve 查 namespace='continuity' 的快照,映射 CheckpointRow[](payload 取 mode/ctxTokens/degraded/checkpointPath,ts 用 fact created_at,intent 用 text 首行);opts.sessionId 过滤、opts.recent 限量(默认20);read-only,fail-open 返 []。加 test/core/session-sink.test.ts:注入内存假 OmdMemory(writeFact 记参数 + retrieve 回放),断言 (a) namespace='continuity' 且 id=sessionId (b) 同 sessionId 二次写演化(identity 一致)(c) payload 含 md/checkpointPath (d) 无 memory→{ok:false} 不抛 (e) listCheckpoints 过滤 + 空库返 []。oracle=tsc + bun test。禁改契约类型/签名;禁碰 writer.ts/read-back.ts/noun-gate.ts;禁碰 src/harness/continuity/(DAG-run 续跑)。
- executorKind: agent

### status: escalated

_(none)_
