---
name: verify
tier: foundation
runtime: on-demand
trigger: mention
description: "Unified verification gate: runs tsc/test/build based on changed files. 5 modes: --smart (default diff-based) / --quick (tsc only) / --full (full suite before push) / --all (everything) / --health (composite quality score + trend). Trigger: /verify / run tests / health check / 验证 / 跑测试 / 检查一下 / 预检 / 提交前检查 / 健康度 / 代码质量. Skip: code review feedback (/review) / commit (/commit)."
metadata:
  source: oh-my-dag
  version: "5.0.0"
  methodology: "Bun verify + composite scoring"
---
# /verify — Unified verification entry

> **Zone→Check mapping**: see `_shared/CHECK-ROUTING.md` (shared with /commit).
> **Verification trio** (TypeScript/Bun projects): `bunx tsc --noEmit` + `bun test` + `bun build <entry>`. Adapt to your project's actual toolchain. If tests require a database, gate them so dev boxes without one skip gracefully rather than failing.

## Modes

```
--quick (fastest)    → bunx tsc --noEmit only (single command, fastest feedback)
--smart (default)    → pick the minimal check subset by git diff and run in parallel
--full  (pre-push)   → tsc + bun test (full) + bun build
--all                → tsc + bun test + bun build (everything)
--health             → composite health score 0-10 + trend tracking + regression detection
```

---

## Smart mode (default)

Analyzes changed files from `git diff --name-only HEAD`, auto-selecting the minimal check subset and running it in parallel.

### Step 1: Analyze changed files

| File Pattern | Required Checks | Notes |
|-------------|----------------|------|
| schema / migration files | `bunx tsc --noEmit` + sync against the schema definition | migration safety reviewed manually: indexes / constraints / reversibility |
| schema source | `bunx tsc --noEmit` + `bun test` (full) | schema changes ripple widely → run the full suite |
| `src/**/*.ts` | `bunx tsc --noEmit` + `bun test <related>` | run the related tests per module |
| `test/**/*.test.ts` | `bun test <that file>` | — |
| docs / config-only | — | no check |

> **Authoritative source**: this table is synced with `_shared/CHECK-ROUTING.md`. On conflict, CHECK-ROUTING.md wins.

Build union of all required checks from matched zones. Do NOT add checks beyond the zone table.

### Step 0: Pre-check

`git diff --name-only HEAD` empty → "No changes detected." Terminate.
Changes only in docs/config (no check zone) → "Changed files: {N} (docs/config only) — no checks required." Terminate.

### Step 2: Parallel execution

Issue all checks in parallel in the same message (tsc / bun test do not conflict). Capture stdout+stderr, exit code, and timing.

### Step 3: Parse results + Fix-First

Per check: PASS/FAIL → extract the top 3 most critical findings (file:line) → grade BLOCK / WARN / INFO.

**Fix-First Heuristic** (only `--smart`):
- **AUTO-FIX** (apply directly): unused import, import order, trailing whitespace, inferable `any`
- **ASK** (AskUserQuestion): naming disputes, architecture choices, logic changes, type assertions
- **REPORT** (report only): test failures, build errors, migration safety

After AUTO-FIX, automatically re-run that check. Mark `[auto-fixed]` in the report.

### Step 4: Unified report

```
## Smart Check Report — {date}
Changed files: {N} | Checks selected: {M}

| Check | Status | Time | Findings | Severity |
|-------|--------|------|----------|----------|

**Overall: ✅ PASS / 🛑 {N} BLOCKS / ⚠️ {M} WARNINGS**
🛑 Blocking: [{check}] {file}:{line} — {description}
```

### Real check reference

| Command | Verifies |
|---------|----------|
| `bunx tsc --noEmit` | TypeScript types (incl. cross-module contracts, inferred ORM types) |
| `bun test` | full bun:test — data access / state machines / safeguards / routes |
| `bun test <file>` | single test file (diff-based subset) |
| `bun build <entry>` | bundle (module resolution / entry integrity) |

> migration safety / access policies / invariants = **manual review** (and an adversarial review pass for high-risk seams) when there is no automated script for them.

---

## Quick mode (--quick)

TypeScript type check only:

`bunx tsc --noEmit`

Single command, fastest feedback. Good for quick checks between edits.

```
## Quick Check — {date}
| Check | Result | Details | Time |
| TypeScript | ✅/❌ | {N errors in M files} | {Ns} |
**Result: ✅ PASS / 🛑 {N} type errors**
```

---

## Full mode (--full)

Pre-push verification.

### Steps 1-2: Verify (tsc + test in parallel)

**Issue 2 parallel Bash calls in the same message**:

| # | Command | Timeout |
|---|------|------|
| 1 | `bunx tsc --noEmit` | 60s |
| 2 | `bun test 2>&1 \| tail -20` | 180s |

Parse: tsc → group errors by file | bun test → pass/fail/skip counts

### Step 3: Build Check

`bun build <entry>` (depends on tsc passing; tsc FAIL → skip build). Classify failures: module resolution / import / other.

### Step 4: Staged Files Audit

`git diff --cached --name-only` + `git diff --name-only`:
- Staged files unrelated to the current feature?
- `.env*` / credentials / secrets?
- Generated files that shouldn't be committed?

### Step 5: Known Failures Check

Read unresolved P0/P1 entries from your error journal. If any, BLOCK.

```
## Preflight Report — {timestamp}
| Step | Check | Result | Details | Time |
| 1 | TypeScript | ✅/❌ | {N errors} | {Ns} |
| 2 | bun test | ✅/❌ | {P pass, F fail, S skip} | {Ns} |
| 3 | Build | ✅/❌/⏭️ | {error summary} | {Ns} |
| 4 | Staged Files | ✅/⚠️ | {suspicious} | — |
| 5 | Known Issues | ✅/🛑 | {blocking} | — |
**Decision: ✅ GO / 🛑 STOP**
```

---

## All mode (--all)

Runs tsc + bun test + bun build in full, skipping smart selection.

---

## Health mode (`--health`)

> Composite quality dashboard. Does not fix code — only diagnoses + scores + tracks trends.

### Step 1: Check suite (parallel)

| # | Category | Command | Weight |
|---|------|------|------|
| 1 | TypeScript | `bunx tsc --noEmit` | 35% |
| 2 | Tests | `bun test` | 45% |
| 3 | Build | `bun build <entry>` | 20% |

### Step 2: Scoring (0-10 per category)

| Score | Criteria |
|------|------|
| 10 | zero errors |
| 7 | 1-3 warnings / 1 minor error |
| 4 | 3-10 errors or failures |
| 0 | 10+ errors or won't run |

**Composite score** = Σ(category score × weight). If a category is unavailable → its weight is proportionally redistributed.

### Step 3: Trend tracking

Save to a health-history log (one JSON line per run):
```json
{"date": "2026-05-29", "composite": 9.4, "types": 10, "tests": 10, "build": 8, "details": {...}}
```

### Step 4: Regression detection

Compare against the last 10: a category drops ≥2 → 🔴; rises ≥2 → 🟢; 3 consecutive drops → ⚠️ trend alert.

```
## Health Dashboard — {date}
| Category | Score | Δ | Status | Details |
| TypeScript | 10/10 | — | 🟢 | 0 errors |
| Tests | 10/10 | — | 🟢 | all pass, 0 fail |
| Build | 10/10 | — | 🟢 | clean |
**Composite: 9.x/10**
```

---

## Constraints

- **Full mode runs tsc + bun test in parallel**: issued in one message (--quick is tsc only)
- Build depends on tsc passing (serialized after)
- tsc / bun test run in parallel without conflict
- Never auto-fix — only diagnose (except Smart mode Fix-First)
- Report includes parallel time-saved stats
- **Health mode**: pure diagnosis, no file changes (except the health-history log)
- **Only reference checks that actually exist in your project** — don't invent scripts the toolchain doesn't have
