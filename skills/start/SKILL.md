---
name: start
tier: foundation
runtime: always
trigger: mention
description: "Session 初始化仪式: 并行读 _NEXT.md + git status 恢复上次 context, 输出 Briefing 含当前任务 + 建议下一步. 每个新 session 第一条命令防 context 丢失. Trigger: 开始 / start / 恢复进度 / 继续上次的 / 新session / 从哪里继续. Skip: 保存进度 (/handoff) / 提交 (/commit)."
metadata:
  source: claude-skills
  version: "3.1.0"
---
# /start — Session Initialization

> 每个新 session 的第一个命令。恢复上下文，输出简报，建议下一步。
> **设计原则**: 最少 IO（2 调用）、最少 token（部分读取）、≤30 行输出。

## Input

- Optional: feature hint (e.g., `/start G5残留`) — 聚焦到特定模块
- Optional: `--scope <dirs>` — 声明文件范围用于多 session 隔离
- 无 hint 时，从 `_NEXT.md` 的 `active_plan` 判断焦点

## Workflow

### Step 0.5: Memory Layer 前置 flush（崩溃兜底，无条件执行）

如果上次 session 意外崩溃未走 `/handoff`，`.claude/memory/index/pending.jsonl` 可能还有未 embed 的捕获条目。先 drain 掉再进 briefing：

```bash
npx tsx .claude/memory/scripts/flush.ts || true
```

Pending 为空时 no-op（<50ms）。`|| true` 保证不阻断 /start，**但 stderr 保留可见**（非 0 退出时 Claude 看到 provider 错误/drift 信号）。

**非零退出处理**: 若 flush 退出码非 0（例如 model drift、provider auth 失败、pending 损坏），在 Step 3 Briefing 最顶部（`## Session Briefing` 标题下一行）注入：
```
⚠️ Memory flush failed (exit {code}) — 检查 stderr；memory 可能未更新
```
本 session 依旧走完流程，但 briefing 里的 💾 Relevant Memory 段标注 `(stale — flush failed)`。

### Step 1: 并行读取（3 个调用，同一消息发出）

| # | 工具 | 参数 | 提取内容 |
|---|------|------|----------|
| 1 | Read | `docs/session/session-state.json` | **v5 schema (state-arch-v2)**: 仅 last_session + cognitive.class_distribution。当前态字段已迁 _NEXT.md ROUTER_V6 (用 active-task-v2 helper 严解析)。 |
| 2 | Read | `_NEXT.md` **offset=60, limit=100** | strategic context + completed_modules + backlog（JSON 不含的战略信息） |
| 3 | Bash | *(见下方 git 命令)* | git + spec size + sessions 一次性取完 |
| 4 | Read | `docs/knowledge/_INDEX.md` | Domain knowledge 注册表（domain matching 用） |

**Step 1 Bash 命令**（合并检查为 1 次调用）:
```bash
cd "$(git rev-parse --show-toplevel)" && \
echo "=LOG=" && git log --oneline -5 && \
echo "=STATUS=" && git status --short --branch && \
echo "=SPEC=" && wc -l .claude/CLAUDE.md 2>/dev/null; wc -l "$HOME/.claude/projects/c--a sibling project/memory/MEMORY.md" 2>/dev/null && \
echo "=SESSIONS=" && ls -t .claude/sessions/*.md 2>/dev/null | head -3
```

解析规则（从 `=TAG=` 分隔符提取）:
- `=LOG=` → last 5 commits
- `=STATUS=` → branch + uncommitted files
- `=SPEC=` → CLAUDE.md 行数 + MEMORY.md 行数
- `=SESSIONS=` → 最近 3 个 session 摘要文件路径（L1 数据源）

### Step 1.7: L1 Session Memory（条件读取）

**仅当** `=SESSIONS=` 输出了文件路径时执行（最多 1 次额外 Read）：
- 选择最近 1 个 session 文件 → Read 全文
- 提取 YAML frontmatter（status, task, commit_range, next_session_hint）
- 提取 `## Decisions` + `## Dead Ends` + `## Remaining` sections
- Token 预算: L1 数据 ≤ 500 tokens（超长 Decisions 截断到前 5 条）
- **L2 traces**（`.claude/traces/`）不自动加载 — 仅通过 `trace-search.sh` 按需搜索

### Step 2: 上下文恢复（从 Step 1 已读数据提取，无额外 IO）

**2a. Active Task 恢复**（v5: 当前态唯一源 = _NEXT.md ROUTER_V6, 累积态 = session-state.json）:
- **当前态**: 从 `_NEXT.md` ROUTER_V6 yaml fence 提取（用 active-task-v2 helper 或直接 grep）：
  - `active_plan.feature` → null = IDLE，非 null = 活跃计划
  - `active_plan.{plan_file, complexity, blocked_on}` → 当前 posture
  - `next_3_steps[]` → 下 3 步
- **累积态**: 从 `session-state.json` 读 `last_session.{date,session_id,summary}` (v5 schema 仅这一段)
- **status 派生**: `active_plan.feature` 非 null = ACTIVE, 否则 IDLE (不再从 JSON 读 status 字段)

**2a-fallback. Backlog 降级推荐**（IDLE 时自动触发）:
- 条件: `_NEXT.md` `active_plan.feature` 为 null (派生 status === IDLE)
- 动作: Read `docs/session/_BACKLOG.md` → 逐行匹配 `/\*\*\[(P[0-1])\/([SMLX]+)\]\s*(.+?)\*\*/` 提取 P0/P1 条目
- 排序: P0 优先于 P1，同优先级按文档出现顺序
- 取前 3 条 → 填入 Briefing "下 3 步" 段:
  ```
  1. [Backlog P0/M] {title}
  2. [Backlog P1/L] {title}
  3. [Backlog P1/M] {title}
  ```
- 附加提示: `💡 Run /start <feature-hint> to activate a backlog item`
- 如果 `_BACKLOG.md` 不存在或无 P0/P1 条目 → 显示 "Backlog 为空" + 建议 `AskUserQuestion` 询问目标

**2b. Domain Knowledge Matching**（从 Step 1 Read #5 `_INDEX.md` 匹配）:

收集 4 类信号并匹配 _INDEX.md 中的每个 domain：

1. **file_touched**: 从 `=STATUS=` 中变更的文件路径 → 匹配 `match_signals.file_touched` globs
2. **feature**: 从 `active_task.feature`（JSON）或 `active_plan.feature`（YAML）→ 匹配 `match_signals.feature_pattern` regex
3. **plan_file**: 从 `context_pointers.plan_file` 路径字符串 → 匹配 `match_signals.plan_ref_contains` 关键词（v4: 合并 plan_ref → plan_file, 路径已含 PLAN slug 关键词）
4. **explicit**: `/start --domain <name>` → 直接命中

匹配规则：
- `/start --domain X` → 直接加载 X 的 invariants + dead-ends（Read 对应文件）
- 2+ 自动信号命中 → 自动加载 domain invariants + dead-ends
- 1 自动信号命中 → 在 briefing 提及，不自动加载
- 0 命中 → 跳过 domain knowledge 段

加载时执行：Read `docs/knowledge/{domain}/invariants.md` + Read `docs/knowledge/{domain}/dead-ends.md`（最多 2 个额外 Read 调用）。将 invariant 数量 + dead-end 数量 + 最新 experiment champion 记入 briefing。

**2c. L1 Session Memory**（从 Step 1.7 读取数据提取）:
- YAML frontmatter `task` + `next_session_hint` → 上次焦点 + 建议的衔接点
- `## Decisions` → 决策列表（前 5 条，每条 1 行摘要）
- `## Dead Ends` → 死胡同列表（与当前 active_task 相关时高亮提醒）
- `## Remaining` → 对照 _NEXT.md `next_3_steps` 验证一致性 (v5: 不再读 session-state.progress.remaining_steps)
- 无 session 文件 → 跳过 L1 section

**2d. Drift Events 展示**（v5 state-arch-v2: 从 .claude/telemetry/drift-events.jsonl 读）:

从 `.claude/telemetry/drift-events.jsonl` 末尾反向 tail 最近 N 行 (state-arch-v2 commit C: drift_events 已 JSONL append-only, 不再在 session-state.json)。或调 `cognitive-state.mjs:readDriftEvents(lookbackDays)` API。
规则:
- JSONL 不存在或为空 → 不展示
- 非空 → 展示最近 3 条 (按 ts desc), 格式见 Step 3 briefing 模板 `### ⚠️ Prior Drifts`
- **不自动**把 drift_events 作为当前 session 的 framing 前提。仅**展示给 the owner**, 由 the owner 决定是否提 `/ceo` 重审方向或主动避开

注意：drift_events 是**内容性**知识（主题 + 锚点），不是**状态标签**（L<N> 计数）。hook 层已不再跨 session 注入任何 cognitive 状态（见 `session-cognitive-inject.mjs` v3 + core-rules-full §10.5.1）。

### Step 2.5: Memory Layer Retrieval（top-K 语义召回注入 briefing）

**Query 构造** — 由 `retrieve.ts` 代码层**确定性**产出（S1.1：LLM 不再拼 query 字符串）。

**Bash**:
```bash
# 用户 /start <hint>: 位置参数优先
npx tsx .claude/memory/scripts/retrieve.ts "<hint>" --k 3 --format briefing

# 无 hint: --from-state 自动从 state 文件构造（内部优先级见下方）
npx tsx .claude/memory/scripts/retrieve.ts --from-state --k 3 --format briefing
```

`--from-state` 固定优先级（不可调）:
1. `session-state.json` `active_task.feature`
2. 任一 `_NEXT.wt-*.md` active_plan.feature（worktree 模式）
3. `_NEXT.md` active_plan.feature
4. `_NEXT.md` next_3_steps[0] 前 80 字（IDLE 兜底）
5. `session-state.json` progress.remaining_steps[0]

**输出规范**: stdout = markdown block（`### 💾 Relevant Memory` 头）直接嵌入 briefing；stderr 带 `[retrieve] query="..." (source: ...)` 让 Claude 看到来源但不污染渲染。全空 → stdout `_(no active task — skipping retrieval)_`，不报错。

**失败语义**: 非 0 退出不阻断 /start；briefing 顶部注入 `⚠️ Memory retrieve failed (exit N)`。成本 ~5KB × 日均 10 sessions ≈ $0.75/天。

### Step 3: 输出 Session Briefing

**输出控制**: 总行数 ≤ 35 行（+5 for domain knowledge section when loaded）。

```
## Session Briefing — {date}

**上次**: {last_session_summary 前 80 字}
**阶段**: IDLE ({N} modules) | **更新**: {updated_at}

### 📋 Active Plan
{IDLE: "无活跃计划" | 活跃: Feature / PlanFile / BlockedOn}

### 🎯 下 3 步
1. {step}
2. {step}
3. {step}

### 🌿 Git
Branch: {branch} | Uncommitted: {N} | Ahead: {N}
Commits: {commit1} / {commit2} / {commit3}

### 💾 Session Memory (L1)
{仅在 Step 1.7 读取了 session 文件时显示，否则省略整段}
- Last: {session_id} — {task 前 50 字}
- Decisions: {top 2-3 decisions, comma-separated}
- Dead Ends: {count}项{, ⚠️ 与当前任务相关: "{dead_end_title}" — 如有}

### ⚠️ Prior Drifts (2d 档 B)
{仅在 session-state.json.cognitive.drift_events[] 非空时显示，否则省略整段}
{展示最近 3 条，每条格式:}
- {session_id_short} — {topic}
  Rewind-Anchor: {rewind_anchor}
{尾行提示:}
_由 the owner 决定是否关联到当前任务 — hook 不自动注入_

{Step 2.5 retrieve.ts --format briefing 输出原样嵌入（含 "### 💾 Relevant Memory (top-3)" 头）；跳过时省略整段}

### 🧠 Domain Knowledge ({domain})
{仅在 Step 2b 匹配到 domain 时显示，否则省略整段}
- {N} invariants loaded (last updated: {freshness})
- {N} experiments recorded (champion: {latest_champion_id})
- {N} dead-ends flagged
- Active plan: {crystallized_plan_path or "none"}

### 💡 建议
{最优下一个 skill + 理由一句话}
```

**建议推荐逻辑**（按优先级）:
1. uncommitted + CODE_REVIEW=PASS → `/commit`
2. modified files → `/verify --smart`
3. `_NEXT.md` 含 `blocked_on` → 提示读 `.claude/knowledge/error-journal.json`
4. commits ahead of origin → 提醒 `git push`
5. IDLE + no hint → `AskUserQuestion` 询问今日目标

### Step 4: Feature Hint 搜索（仅当用户提供 hint 时执行）

Glob + Grep 搜索 `docs/plan/` 和 `docs/prd/exec/` 中匹配 hint 的文件。
找到则追加到 briefing:
```
### 🔎 匹配的 Plan/PRD
- {filename}: {first heading}
```

### Step 5: 健康状态行（无额外 IO，从 Step 1 数据计算）

在 briefing 末尾追加一行，格式:
```
{✅|⚠️} Spec: {CLAUDE_lines+MEMORY_lines}行
```

判定：
- Spec > 300 行 → ⚠️，附加 `— 需瘦身`
- 否则 → ✅ 健康

### Step 6: 消歧提示

```
> 路由: Vibe(单文件) | Lite(2-5文件) | Full(跨层/Plan Mode)
> skill: commit↔verify | verify --smart↔--full | design --spec↔--review
```

## Constraints

- Read-only — 禁止修改文件
- **Step 1 的 2 个调用必须在同一消息并行发出**（无依赖，不可串行）
- **总输出 ≤ 30 行（硬限制）** — 输出前数行数，超过就砍最长段落。DO NOT 添加模板外的段落（禁止"健康指标"/"测试覆盖"/"消歧"等额外 section）。输出只包含: Session Briefing 标题 + 上次/阶段 + Active Plan + 下3步 + Git + 建议 + Spec 健康行 + 消歧一行。每个 `###` 段落内容限 1-3 行，commits 只列 hash + scope 不列完整 message。
- 目标完成 < 5 秒
- `_NEXT.md` 缺失或损坏 → **立即**输出 `⚠️ _NEXT.md 缺失` 警告 + 建议 `/handoff` 重建或手动创建。DO NOT 用 Glob/Grep 尝试其他路径恢复文件。直接输出缩短版 briefing（仅 Git + 建议段落）
- error-journal 不再注入 — 仅当 `_NEXT.md` 含 `blocked_on` 时按需提示读取
- **VF-2.3 Recurrence Check**: 当按需读取 error-journal 时，额外扫描 `status: crystallized` 条目。如果本 session 的工作领域（从 `active_plan.feature` 推断）涉及某条 crystallized 条目的模块，在建议中提示: `⚠ crystallized pattern [{title}] — 确认对应规则仍生效`。不主动读 journal，只在已触发读取时顺带检查
