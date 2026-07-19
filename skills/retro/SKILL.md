---
name: retro
tier: capability
runtime: manual
trigger: mention
description: "Engineering retrospective from git history: analyzes commit patterns, type mix (feat/fix/refactor), focus score, test discipline, and productivity trends. Use for Sprint/weekly reviews. Users may say: \"retro\", \"retrospective\", \"sprint summary\", \"what did I do this week\", \"work analysis\", \"复盘\", \"回顾\", \"Sprint总结\", \"这周做了什么\", \"工作分析\". Do NOT use for session wrap-up (use /handoff) or code review (use /review)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "git analytics retrospective"
disable-model-invocation: true
---

# /retro — Engineering Retrospective

> Auto-generate an engineering retrospective from git history. Not from memory — from data.

## Input

```
/retro              → default: engineering retro over the last 7 days of git
/retro 24h          → last 24 hours
/retro 14d          → last 14 days
/retro 30d          → last 30 days
/retro compare      → this week vs last week comparison
```

## Workflow

### Step 1: Data collection (1 message, 3 parallel Bash)

```bash
# 1. Commits with stats
git log --since="{window_start}" --format="%H|%aN|%ai|%s" --shortstat

# 2. Per-file change frequency (hotspots)
git log --since="{window_start}" --name-only --format="" | sort | uniq -c | sort -rn | head -20

# 3. Commit timestamps for session detection
git log --since="{window_start}" --format="%at|%ai|%s" | sort -n
```

### Step 2: Analysis (pure reasoning)

#### 2a. Commit Type Mix

Classify by the type prefix of each commit message:

| Type | Meaning | Health indicator |
|------|------|---------|
| `feat` | new feature | primary output |
| `fix` | fix | < 30% is healthy |
| `refactor` | refactor | deliberate improvement |
| `chore` | chore | necessary but non-core |
| `docs` | docs | knowledge capture |
| `perf` | performance | optimization investment |
| `test` | tests | quality investment |

**Health signal**: feat > 40% + fix < 30% = building mode. fix > 50% = firefighting mode.

#### 2b. Focus Score

```
focus = 1 - (unique_directories_touched / total_commits)
```

| Score | Meaning |
|-------|------|
| > 0.7 | highly concentrated (good: deep work) |
| 0.4-0.7 | moderately spread (normal: multitasking) |
| < 0.4 | over-spread (warning: too much context switching) |

#### 2c. Session Detection

Commit gap > 2 hours → new session. Stats:
- Session count / average duration
- Peak hours (the densest commit window)
- Longest continuous work stretch

#### 2d. Hotspots

File change frequency top 10. High-frequency files = potential instability zones or active development zones.

#### 2e. Sprint Progress Check (if a progress map exists)

If your project keeps a sprint/progress map, read it → compare this cycle's plan vs actual completion.

### Step 3: Output report

```
## Engineering Retro — {window} ({start} ~ {end})

### Summary
{1-2 sentences: the biggest achievement of this cycle}
Commits: {N} | Sessions: {M} | Focus: {score}

### Commit Mix
| Type | Count | % | Trend |
|------|-------|---|-------|
feat/fix/refactor/...

### Health Signals
- {building mode | firefighting mode | balanced}
- Fix share: {N}% {healthy | watch | warning}
- Test share: {N}% {sufficient | insufficient}

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

### Step 4: Compare mode (`/retro compare`)

Compare two windows side by side:

```
| Metric | This Week | Last Week | Delta |
|--------|-----------|-----------|-------|
| Commits | ... | ... | +/- |
| feat% | ... | ... | +/- |
| fix% | ... | ... | +/- |
| Focus | ... | ... | +/- |
| Sessions | ... | ... | +/- |
```

## Constraints

- **Read-only** — does not modify any file
- Output goes directly to the user, no file written
- Use `origin/` branches for git queries (local main may be stale)
- Use the user's local timezone for timestamps
- 0 commits in the window → report and suggest a different window
- Self-contained skill — does not read other docs
