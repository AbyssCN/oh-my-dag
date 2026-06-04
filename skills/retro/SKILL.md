---
name: retro
tier: capability
runtime: manual
trigger: mention
description: "Engineering retrospective from git history: analyzes commit patterns, type mix (feat/fix/refactor), focus score, test discipline, and productivity trends. Use for Sprint/weekly reviews. Users may say: \"复盘\", \"retro\", \"回顾\", \"Sprint总结\", \"这周做了什么\", \"工作分析\". Do NOT use for session wrap-up (use /handoff) or code review (use /review)."
metadata:
  source: claude-skills
  version: "1.0.0"
  methodology: "gstack retro + git analytics"
---

# /retro — 工程复盘

> 从 git 历史自动生成工程复盘。不靠记忆，靠数据。

## Input

```
/retro              → 默认: 最近 7 天 git 工程复盘
/retro 24h          → 最近 24 小时
/retro 14d          → 最近 14 天
/retro 30d          → 最近 30 天
/retro compare      → 本周 vs 上周对比
/retro --learning   → Learning Loop 仪表盘（6-Layer K1-K6，见 §Learning Mode）
/retro --learning --write      → 生成 docs/session/learning-retro-YYYY-MM.md
/retro --learning --month 2026-04   → 指定月份报告
```

## Workflow

### Step 1: 数据采集（1 条消息，3 并行 Bash）

```bash
# 1. Commits with stats
git log --since="{window_start}" --format="%H|%aN|%ai|%s" --shortstat

# 2. Per-file change frequency (hotspots)
git log --since="{window_start}" --name-only --format="" | sort | uniq -c | sort -rn | head -20

# 3. Commit timestamps for session detection
git log --since="{window_start}" --format="%at|%ai|%s" | sort -n
```

### Step 2: 分析（纯推理）

#### 2a. Commit Type Mix

从 commit message 的 type prefix 分类：

| Type | 含义 | 健康指标 |
|------|------|---------|
| `feat` | 新功能 | 主要产出 |
| `fix` | 修复 | < 30% 为健康 |
| `refactor` | 重构 | 有意识的改善 |
| `chore` | 杂务 | 必要但非核心 |
| `docs` | 文档 | 知识沉淀 |
| `perf` | 性能 | 优化投资 |
| `test` | 测试 | 质量投资 |

**健康信号**: feat > 40% + fix < 30% = 建设模式。fix > 50% = 救火模式。

#### 2b. Focus Score

```
focus = 1 - (unique_directories_touched / total_commits)
```

| Score | 含义 |
|-------|------|
| > 0.7 | 高度集中（好：深度工作） |
| 0.4-0.7 | 适度分散（正常：多任务） |
| < 0.4 | 过度分散（警告：上下文切换过多） |

#### 2c. Session Detection

commit 间隔 > 2 小时 → 新 session。统计：
- Session 数量 / 平均时长
- Peak hours（commit 最密集的时段）
- 最长连续工作段

#### 2d. Hotspots

文件变更频率 top 10。高频变更文件 = 潜在不稳定区域或活跃开发区。

#### 2e. Sprint 进度对照（如 PROGRESS-MAP.md 存在）

读 `docs/session/PROGRESS-MAP.md` → 对比本周期计划 vs 实际完成。

<!-- 2f. Standards Drift Check 已删 (2026-06-01): 依赖 a sibling project `scripts/check-standards-drift.mjs`, valinor 不存在。
     orphan-ref / HOOK-REGISTRY 差异 / 陈旧检查的概念有价值, 待真 port 一个 valinor 版再加回 (GP-9 不留死步骤)。 -->

### Step 3: 输出报告

```
## Engineering Retro — {window} ({start} ~ {end})

### Summary
{1-2 句: 本周期最大成就}
Commits: {N} | Sessions: {M} | Focus: {score}

### Commit Mix
| Type | Count | % | Trend |
|------|-------|---|-------|
feat/fix/refactor/...

### Health Signals
- {建设模式 | 救火模式 | 均衡}
- Fix 占比: {N}% {健康 | 注意 | 警告}
- Test 占比: {N}% {足够 | 不足}

### Hotspots (Top 5 Most Changed Files)
| File | Changes | Type |
|------|---------|------|

### Session Patterns
- Peak hours: {HH:MM - HH:MM}
- Avg session: {N}h {M}min
- Longest session: {X}h

### Sprint Progress
- Planned: {items}
- Completed: {items} ({N}%)
- Blocked: {items}

### Retrospective
- **Keep**: {1-2 things that went well, anchored in data}
- **Improve**: {1-2 things to do differently, with specific suggestion}
- **Try**: {1 experiment for next sprint}
```

### Step 4: Compare 模式（`/retro compare`）

并排对比两个窗口：

```
| Metric | This Week | Last Week | Delta |
|--------|-----------|-----------|-------|
| Commits | ... | ... | +/- |
| feat% | ... | ... | +/- |
| fix% | ... | ... | +/- |
| Focus | ... | ... | +/- |
| Sessions | ... | ... | +/- |
```

<!-- ## Learning Mode (--learning) 已删 (2026-06-01): 依赖 a sibling project `scripts/harness-learning-retro.mjs`
     + `harness-rule-decay.mjs` (valinor 不存在) + a sibling project learning-loop 概念 (/evolve --promote / L3 crystallized
     / gene 库)。valinor 无此 6-Layer Learning Loop 机制 → 整段删 (GP-9)。valar 的学习闭环走 CLEAR (SDD §11.6, 待 adopt)。 -->

## Constraints

- **Read-only** — 不修改任何文件
- 输出直接给用户，不写文件
- 用 `origin/` 分支查 git（本地 main 可能过期）
- 时间戳用用户本地时区
- 窗口内 0 commits → 报告并建议换窗口
- 自包含 skill — 不读 CLAUDE.md 或其他 docs
