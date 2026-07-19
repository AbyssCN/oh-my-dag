---
name: commit
tier: foundation
runtime: on-demand
trigger: mention
description: "Smart git commit: analyze changes + zone checks (tsc/test/build) + conventional message (Chinese) + git commit. --ship mode: merge base + full tests + PR. Trigger: /commit / save changes / git commit / ship / ship it / create PR / 提交 / 保存变更 / 提交代码 / 帮我提交 / 发布 / 创建PR. Skip: verify only without committing (/verify) / code quality review (/review)."
metadata:
  source: oh-my-dag
  version: "3.0.0"
  methodology: "Bun commit + ship release pipeline"
disable-model-invocation: true
---
# /commit — Smart Commit & Ship

> Smart commit: auto-selects checks by change type, generates a conventional commit message.
> **`--ship` mode**: one-shot pipeline — merge base → full verify → PR creation.
> **Zone→Check mapping**: see `_shared/CHECK-ROUTING.md` (shared with /verify).
> **Verification** (TypeScript/Bun projects): `bunx tsc --noEmit` + `bun test` + `bun build <entry>`. Adapt to your project's actual toolchain.

## Trigger

`/commit` or `/commit <message hint>` or `/commit --ship` or `/commit --amend`

## Workflow

### Step 0: Scope Drift Check (before checks)

1. Read the active-plan field in your current-state file (e.g. `_NEXT.md`)
2. `git diff --stat` to view changed files
3. Changed files outside active-plan scope → warn (non-blocking): `⚠️ Scope drift: {file} not in [{plan}] scope`
4. No active plan or no current-state file → silently skip

### Step 1: Analyze Changes

**1 merged Bash call**:
```bash
echo "=== STATUS ===" && git status -s && echo "=== STAGED ===" && git diff --cached --name-only && echo "=== UNSTAGED ===" && git diff --name-only
```

Categorize ALL changed files into zones:

| Zone | Pattern | Required Checks |
|------|---------|-----------------|
| 📦 `src` | `src/**/*.ts` | `bunx tsc --noEmit` + `bun test <related>` |
| 🗃️ `schema/migration` | schema source + migration files | `bunx tsc --noEmit` + `bun test` (full) + manual migration safety review |
| 🧪 `test` | `test/**/*.test.ts` | `bun test <that file>` |
| 📄 `docs` | docs / config-only | _(none)_ |
| ⚙️ `config` | `package.json`, `tsconfig.json`, build config | `bunx tsc --noEmit` |
| 🔀 `mixed` | src + anything else | Union of all applicable checks |

### Step 2: Run Checks (parallel)

Based on zone detection, **issue all Bash calls in parallel in the same message**:

| Zone contains | Required check | Parallel? |
|-----------|-------------|-------|
| `src` / `config` / `schema` | `bunx tsc --noEmit` | ✓ |
| `src` (changed `.ts`) | `bun test <related test>` | ✓ |
| schema / migration | `bun test` (full, schema ripples widely) | ✓ |
| `docs` / config only | none — skip | — |

**Short-circuit rule** (reduces redundant `bun test`): if the most recent `/verify` within this conversation PASSed within 5 minutes + no new source-file changes since + it covers this zone → **skip Step 2's bun test** (tsc still runs). If any condition fails → run full. Safe default: run full.

**If ANY check fails → 🛑 STOP.** Enter Violation attribution:

#### Step 2.1: Violation attribution (when a check fails)

1. Collect the file paths from the failure output (e.g. `[FAIL] test/queue.test.ts → double-claim returns empty`)
2. Compare against `git diff --name-only` (this set of changes)
3. Classify:
```
🔴 Introduced by this change (must fix before commit): [FAIL] src/queue/dispatch.ts → race
🟡 Pre-existing (not from this session, still blocking): [FAIL] test/foo.test.ts — pre-existing
```
4. **Both classes must be fixed** (no downgrade). Pre-existing → additionally log to your error journal tagged `[pre-existing]`, surfaced at the next session start.

### Step 3: Stage Files

- User-specified files → stage those; otherwise stage all modified/untracked
- **NEVER stage**: `.env*`, `node_modules/`, generated index/cache dirs, trace dirs, worktree dirs
- **WARN + confirm** before staging: harness settings files, build/ORM config

### Step 4: Generate Commit Message

Format: `type(scope): description (Chinese)`

**Type**: new file→`feat` / modify existing→`fix`/`refactor`/`chore` / schema·migration→`feat(db)`·`fix(db)` / docs→`docs` / harness config→`chore(harness)`
**Scope**: derive from the top-level module path (e.g. `src/routes/**`→`routes`, `src/queue/**`→`queue`, schema/migration→`db`, `docs/**`→`docs`, harness config→`harness`); multiple scopes → the most important one

Append co-author:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

### Step 5: Commit

```bash
git commit -F- <<'EOF'
type(scope): message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```
`--amend` (only when the user explicitly passes it): `git commit --amend -F-` as above.

### Step 6: Post-Commit

- `git log -1 --oneline` to confirm

## Examples

```
User: /commit
→ Detects: migration + schema source
→ Runs: bunx tsc --noEmit + bun test (full)
→ Message: "feat(db): inbox 表 + HMAC 幂等 schema"

User: /commit 修复重复派发
→ Detects: src/queue/dispatch.ts + test/queue.test.ts
→ Runs: bunx tsc --noEmit + bun test test/queue.test.ts
→ Message: "fix(queue): ready→running CAS 原子抢占防双派发"

User: /commit
→ Detects: docs/ only
→ Skips checks → Message: "docs(plan): ..." → commits directly
```

## Safety Rules

1. **NEVER commit** `.env`, credentials, secrets, generated index/cache dirs
2. **NEVER amend** unless user says `--amend`
3. **NEVER force push** — only local commit (push requires explicit user request)
4. If checks fail, report + STOP — do not retry automatically

---

## Ship mode (`--ship`)

> Full release pipeline. One-shot from commit to PR.

### Ship Step 0: Pre-flight

1. Current branch is `main` → AskUserQuestion to confirm (solo projects often commit straight to main; branch only when a real PR flow is wanted)
2. `git status` — uncommitted changes present → run Step 0-6 first
3. Readiness Dashboard: `Branch | Base: main | Commits: N | Files: M | tsc ✅/❌ | tests ✅/❌`

### Ship Step 1: Merge Base

```bash
git fetch origin main && git merge origin/main --no-edit
```
Conflicts → report conflicting files → AskUserQuestion (resolve/abort)

### Ship Step 2: Full Verify (parallel)

| # | Command | Timeout |
|---|------|------|
| 1 | `bunx tsc --noEmit` | 60s |
| 2 | `bun test 2>&1 \| tail -20` | 180s |
| 3 | `bun build <entry>` | 60s |

**Failure Ownership Triage**: `git diff main...HEAD --name-only` → introduced by this branch=must fix STOP; already exists in base=tag `[pre-existing]`, log to error journal, non-blocking.

### Ship Step 3: Test Coverage Audit

`bun test --coverage` → extract coverage. Compare against `git diff main...HEAD` changed files: new/changed without a corresponding test → warn (non-blocking, report only).

### Ship Step 4: Plan Completion Audit

Read your current-state file's active-plan commitments vs `git diff main...HEAD` actual delivery: DONE / PARTIAL / NOT DONE / EXTRA. NOT DONE → AskUserQuestion (continue/next time/cancel ship).

### Ship Step 5: Push & PR

```bash
git push -u origin HEAD
gh pr create --title "type(scope): 中文描述" --body "$(cat <<'EOF'
## Summary
{git log main..HEAD summary, Chinese}
## Changes
{grouped by file}
## Verify
tsc ✅ · bun test {P pass} · build ✅
## Plan Completion
{completion}

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
Output the PR URL.

### Ship Output

```
## Ship Report — {date}
| Step | Status | Details |
| Merge Base | ✅ | No conflicts |
| Verify | ✅ | tsc 0, all pass, build clean |
| Coverage | ⚠️ | {N} new files without tests |
| Plan Audit | ✅ | {n}/{m} DONE |
| PR | ✅ | #N created |
→ PR: {url}
```
