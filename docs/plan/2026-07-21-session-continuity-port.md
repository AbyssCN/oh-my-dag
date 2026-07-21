# 提案:把 memory-hub 的自动 session 交接移植进 omd

> 状态:**待 Nick 决策**(实装 / 改范围 / 不做)。这是设计 + 工作量评估,不是已定的 SDD。
> 日期:2026-07-21 · 来源机制:`/home/nick/repos/memory-hub`(bluebell 只接线)

## 1 · 目标

让 omd 的 session 交接从**手动**(`/start` `/handoff` 要人敲)变成**可选的自动**:
Claude Code 的 session 边界(开始/结束/压缩/每轮)触发 hook,自动蒸馏一份 checkpoint 并在
下个 session 开局自动注入 briefing。等价于"每次收工自动 `/handoff`、每次开工自动 `/start`"。

**非目标**:替换 omd 现有的 `.omd/continuity/<runId>/`(那是 DAG run 续跑,另一回事,见 §5 命名冲突);
不引入 Postgres 依赖;不强制 —— 默认 opt-in。

## 2 · omd 今天有什么(baseline)

| 组件 | 现状 |
|---|---|
| `/start` `/handoff` skills | **手动**(`disable-model-invocation: true`),写项目的 `_NEXT.md` + session log + 捕获记忆 |
| `.omd/continuity/<runId>/` | **DAG run** 续跑 checkpoint(节点产物哈希),`CheckpointManager`,和 session 交接无关 |
| Tier-1 记忆 | `bun:sqlite`,`.omd/`,namespace 安全闸,`memory_recall/remember` + dream L0–L6 |
| hooks 例子 | 只有 PreToolUse(dangerous-cmd / verify-after-edit)+ 一个 Stop `memory-distill.sh`(**软提示**,不写 checkpoint) |
| 模型层 | 五角色(含 `OMD_DREAM_MODEL`),`provider:model` 坐标,统一解析链 |

关键:omd 的 handoff 写的目标文件**也叫 `_NEXT.md`** —— 和 memory-hub 同源血统,但停在手动。

## 3 · memory-hub 有什么(要移植的机制)

- **4 个 hook**(全 fail-open):`SessionStart`(自动 brief,注入上个 session 的 checkpoint 经
  `hookSpecificOutput.additionalContext`,>14 天跳过,≤10k 字符)· `Stop`(每轮增量记
  `ledger.jsonl`:真 token 数 / 碰过文件 / commit,跨 200k 档或 commit 触发 writer)·
  `PreCompact`(压缩前同步写)· `SessionEnd`(自动 handoff,`writer --final`,把 §1/§2
  splice 进 `_NEXT.md` 的标记之间)。
- **checkpoint = 9 段蒸馏 markdown**(意图 / 下一步 / 会话指令 / 任务 / 当前工作 / 文件锚点 /
  发现的知识 / 错误与修复 / 决策),便宜模型蒸馏 + **零 LLM 反幻觉校验**(文件路径必须真存在、
  commit hash 必须能 resolve、noun-gate 容差 3),失败降级机械版。
- **双轨存**:markdown 文件(真源,resume 读它)+ Postgres `agent_memory`(`checkpoint_events` 追加
  事件 + `facts` namespace=`continuity` 的最新快照,可语义召回)。
- **MCP 读工具**:`memory_checkpoints`(时间线)+ 资源 `memory://checkpoints`。写侧走 hook→writer,
  不经 MCP 工具。

## 4 · 差距 = 要移植的东西

writer(蒸馏+校验+splice)· 4 个 hook 脚本 · Stop 的 transcript ledger(token 记账)·
SessionStart 的 briefing 注入 · checkpoint sink(改存 omd SQLite,不用 PG)· 一个读 checkpoint 的入口。

## 5 · 设计岔口(每条附推荐)—— 这份文档的核心

**D1 · 存储substrate(最重要)**
memory-hub 用 Postgres 做可查询轨;omd 的 Tier-1 记忆是 `bun:sqlite`。
→ **推荐**:markdown 文件当真源(同 memory-hub),把最新快照 + checkpoint 事件**镜像进 omd 现有
SQLite 记忆库**(新 namespace `continuity`,`identity_key = sessionId` 让同 session 多写演进一行),
**不引入 PG**。omd 已有 facts 表 + FTS + edges,直接复用。

**D2 · 命名冲突(最容易埋雷)**
omd **已经**有 `.omd/continuity/<runId>/` 给 DAG run 续跑;memory-hub 的 session checkpoint 也住
`continuity/`。两个"continuity"概念会在目录/env/文档里撞车,读者必混。
→ **推荐**:session checkpoint 落 `~/.omd/projects/<slug>/session/<sessionId>/`(或 `.omd/session/`),
`.omd/continuity/` **保留给 DAG run**。文档里明确区分"run 续跑"vs"session 交接"。

**D3 · 蒸馏模型**
→ **推荐**:新增 `OMD_CONTINUITY_MODEL`,默认走 leaf/dream 的便宜模型,经标准解析链。

**D4 · 反幻觉校验器**
→ **推荐**:原样移植(零 LLM,价值高成本低),commit-hash 校验复用 omd 的 git 访问。

**D5 · hook 打包姿态**
memory-hub 在 `settings.json` 里强制接线;omd 的立场是 hooks = opt-in 例子。
→ **推荐**:4 个 hook 脚本 + writer 放 `docs/examples/claude-code/hooks/` + 一段接线片段,**opt-in
不强制**,和 omd 现有姿态一致。证明有效后再考虑提默认。

**D6 · 和手动 /start /handoff 的关系**
→ **推荐**:把 writer 抽成**共享模块**(一个 `command` 可执行脚本),hook 自动调它、skill 显式调它,
**9 段格式 + splice 逻辑单一真源**。手动 skill 留作 override/fallback(hook 关时仍可用)。

**D7 · transcript ledger / token 记账(最 fiddly)**
Stop hook 读 CC 的 transcript JSONL 抽真 usage token、碰过文件、commit —— 强耦合 CC transcript 格式,
维护成本最高。
→ **推荐**:移植但**隔离进独立 parser 模块**,fail-open,token 数当 best-effort(拿不到就估算兜底)。

**D8 · 触发策略 & 项目scope**
→ **推荐**:采用"跨 token 档或 commit"触发,阈值走 env(`OMD_SESSION_BUCKET` 等);memory-hub 的
`MEMORY_TENANT` 映射到 omd 的 project-scope(`OMD_DATA_HOME` / slug)。

## 6 · 工作分解 + 估算

| 项 | 内容 | 估 |
|---|---|---|
| W1 共享 writer 模块 | 蒸馏 + 校验 + `_NEXT.md` splice,接 omd 模型层 + git | **M(~1 天)** |
| W2 4 个 hook 脚本 | 路径/scope 适配、`additionalContext` 注入、fail-open、writer.lock | **S–M(0.5–1 天)** |
| W3 Stop ledger | transcript token 记账 + 文件/commit 抽取(最 fiddly) | **M(0.5–1 天)** |
| W4 SQLite sink | namespace=`continuity` 写进现有记忆库 + 一个读 checkpoint 入口 | **S(0.5 天)** |
| W5 命名分离 + 配置 | 和 DAG-run continuity 分家 + env 接线 | **S(0.25 天)** |
| W6 测试 + 文档 | writer 确定性 / 校验器 / fail-open / resume brief + 接线文档 | **M(0.5–1 天)** |

**合计 ~3–5 个专注日。** 可分解 ≥4 → 适合 `dag-build` 车队跑(oracle = `bun test` + tsc 闸)。
W1/W3 是正确性敏感核心(建议 Aalto 亲手或强 verify),W2/W4/W5 机械可派。

## 7 · 风险 / 反 happy-path

- **CC transcript 格式漂移**打断 ledger(最高)。缓解:隔离 parser、fail-open、token best-effort。
- **两个 continuity 概念撞车** → 用户混淆。缓解:session 目录改名、文档明确分层(D2)。
- **每 session 蒸馏成本**(每个边界一次便宜模型调用)。缓解:token 档阈值 + 便宜模型 + 无实质变更则跳过。
- **校验器误杀**真实内容 → 频繁 DEGRADED。缓解:noun-gate 容差 + 失败重提示一次(照 memory-hub)。
- **hook 超时预算**(SessionEnd `--final` ≤50s 蒸馏)。缓解:非 final 走 detached,仅 final/precompact 同步。
- **双写竞态**(Stop 触发时 writer 在跑)→ 移植 `writer.lock`。

## 8 · 推荐

**值得移植**,但:opt-in(先例子后默认)· 文件真源 + SQLite 镜像(不碰 PG)· writer 抽共享模块被
hook 和手动 skill 复用 · session 目录与 DAG-run continuity 明确分家。先 ship 例子 + 接线文档,
证明有效再提默认。

先等你拍:**实装 / 改范围 / 暂不做**。实装的话我建议先落 W1+W4(核心写+存)跑通单 session,
再上 W2/W3 的 hook 自动化。
