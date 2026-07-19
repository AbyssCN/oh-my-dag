---
name: review
tier: capability
runtime: on-demand
trigger: mention
description: "On-demand audit: security / coverage / tech-debt / full Gate / PR code review (dispatch specialist lenses + optional cross-model review). For Phase/Gate milestones, after a security incident, pre-merge PR review. Trigger: audit / security scan / full check / Gate check / review --security / review --gate / tech-debt inventory / security audit / review PR / code review / 审计 / 安全扫描 / 全量检查 / Gate检查 / 技术债盘点 / 代码审查 / PR审查. Skip: routine verification (/verify) / commit (/commit)."
metadata:
  source: oh-my-dag
  version: "5.0.0"
  methodology: "on-demand audit + specialist lenses + optional cross-model review"
disable-model-invocation: true
---

# /review — On-Demand Audit

> On-demand full scan, for Phase completion / pre-Gate / post-security-incident. Routine changes go `/verify` → `/commit`.
> **Review model**: review is read-only diagnosis (specialist lenses) + an optional cross-model adversarial pass + the agent's own judgment (the verdict — taste is not hostage to findings). The real check is your build/typecheck/test commands.

## Modes

```
--security      → scan trust boundaries (sig-verify/auth/injection/fail-open) across request/event/integration entrypoints
--coverage      → test coverage + missing-test detection
--debt          → typecheck + unfixed known issues + TODO/FIXME scan
--zod           → input-validation coverage audit of untrusted entrypoints (route/callback/inbound)
--pr            → PR-level review (specialist lenses in parallel + plan completion + scope drift)
--gate          → the above in parallel, pre-Gate aggregate check
--release-gate  → final delivery review (aggregate scan)
--with-codex    → modifier (combine with --gate/--release-gate/--pr): adds a cross-model review pass in parallel in the same message
```

## `--with-codex` — Cross-Model Phase Gate

`--with-codex` is a modifier flag. On top of the specialist lenses, it adds a **cross-model review** in parallel in the same message — independence from a second model family that the primary model cannot self-check.

| Gate | Max rounds (hard cap) | BLOCK fallback |
|---|---|---|
| `--gate` (phase end) | **1** per phase end (fix folds into the next phase, no second round) | agent judgment |
| `--release-gate` | **1 + max 1 fix = 2** | the developer |
| `--pr` | 1 | agent judgment |

**anti-slop**: a cross-model finding ≠ ground truth. Must reject niche/theoretical/telemetry/tests-for-tests/style/doc-completeness; must accept P0/P1 reproducible bug (file:line+steps) + contract violation + ship-blocker + mechanism-level boundary failure.

**Finding → fix routing**: each finding is routed to the matching specialist lens (read-only diagnosis), then the fix is written on the main line. Type errors / typos (≤3 lines) are fixed directly without dispatching a lens.

---

## Trigger

`/review --<mode>` or `/review --gate`

## Security Mode (--security)

Dispatch the relevant specialist lenses (read-only), or scan directly:
- Scan scope: request handlers + websocket/event entrypoints + external integrations + SQL/migrations
- Checks: trust-boundary sig-verify (HMAC/timing-safe compare) / auth gap / injection / fail-open (`catch { return null }` swallowing errors) / GET read-only / no existence leakage / input validation / row-level deny-all
- Output: P0/P1/P2 + verdict (PASS/BLOCK)

## Coverage Mode (--coverage)

1. Run tests with coverage
2. Compare against `git diff` changed files: added/changed files with no corresponding test → warning
3. Identify gaps: 0-test danger zones

## Debt Mode (--debt)

1. Typecheck — type debt
2. Read your known-issues log — unfixed P0/P1
3. Grep TODO/FIXME/HACK + the next-state file's secondary tracks (known backlog)

## Zod Mode (--zod)

Scan untrusted entrypoints (request bodies / channel callbacks / inbound endpoints):
- PROTECTED: has schema validation | UNPROTECTED: accepts external input but no validation
- Output: coverage table + unprotected entrypoints + suggested schemas

## Gate Mode (--gate)

**Phase completion / pre-Gate.** In parallel:

| Lens/Check | maps to |
|---|---|
| specialist lens (routed by diff to data-layer / pipeline / interface / agent-protocol) | methodology review |
| typecheck + tests | types + tests |
| cross-model review (if --with-codex) | cross-model |

Synthesis: All green → GATE PASS | Any P1 → NEEDS-CHANGE | Any P0 → GATE BLOCK

### Specialist prompt injection

```text
Read the review checklist / required-reads kernel, then review the scope.
Your lens: {data-layer | pipeline | interface | agent-protocol | stack}
Review scope: git diff $(git merge-base HEAD main)..HEAD
Binary PASS/FAIL + stack-specific checks.
```

---

## PR Review Mode (--pr)

> PR-level code review.

### Step 1: Branch Diff

```bash
git diff main...HEAD --stat && git log main..HEAD --oneline
```
No diff → "Nothing to review", terminate.

### Step 2: Plan Completion Audit

Read the next-state file's active plan + commitments → compare against diff: DONE / PARTIAL / NOT DONE / EXTRA (scope creep).

### Step 3: Critical Pass

Scan diff for high-risk patterns: SQL injection (`IN` instead of `= ANY`), races (mutation without compare-and-swap), trust-boundary writes bypassing validation, auth gap, enum completeness (switch without default). Each finding carries confidence 1-10 (1-3 suppress / 4-6 mark low / 7-10 show).

### Step 4: Specialist Dispatch (parallel, read-only)

Routed by diff (parallel, same message):

| lens | condition | checks |
|------|------|------|
| **data-layer** | touches SQL / schema | schema safety + row-level security + indexes + immutability |
| **pipeline** | touches retrieval / memory | data flow + validated writes + naming |
| **interface** | touches routes / websocket | idempotency + sig-verify + error shape + type contract |
| **agent-protocol** | touches agent/skill/hook / DAG | agent/skill/hook + node contract |
| **stack** | touches dispatcher / entrypoint | loop blocking + compare-and-swap + lifecycle |

Each lens sees only the diff + context, outputs findings (criterion + verdict + confidence + evidence + fix).

### Step 5: Synthesis

Dedup (multiple lenses reporting the same → merge and raise confidence) → grade P0/P1/P2 → 2+ lenses reporting the same P1 → escalate to P0.

### Output

```
## PR Review — {branch} → main
### Plan Completion / ### Scope Check (CLEAN/DRIFT/MISSING)
### Findings ({N}: {P0} P0, {P1} P1, {P2} P2)
| # | Severity | File:Line | Finding | Confidence | Source |
### Verdict: APPROVE / NEEDS-CHANGE / BLOCK
```

---

## Release Gate Mode (--release-gate)

> Final delivery review. /handoff recommends it on significant changes.

1. Read the release-gate checklist
2. Dispatch the aggregate-review lens (read-only), inject the template
3. Scan this session's changes, output the delivery checklist + VERDICT → a dated report under `docs/reports/`

### /handoff recommendation triggers

| Condition | Recommend |
| --- | --- |
| This session changed ≥5 files + cross-layer | `/review --release-gate` |
| This session has a new migration | `/review --release-gate` |
| This session changed schema / safeguards / orchestration | `/review --release-gate` |
| None of the above | Silently skip |

---

## Fix-First Protocol (common to all modes)

- **AUTO-FIX**: mechanical issues (naming/formatting/import/dead code/typo) → fix directly
- **ASK**: needs judgment (architecture/performance tradeoff/security decision) → AskUserQuestion

Execution: classify → batch AUTO-FIX (one line each `[AUTO-FIXED] file:line Problem → done`) → remaining ASK ≤3 asked individually / >3 batched.

## Scope Drift Detection (automatic for --gate / --release-gate)

Read the next-state file's active plan (stated) vs `git diff --stat` (delivered) → SCOPE CREEP (out-of-scope files) / MISSING (promised but absent) → `Scope Check: [CLEAN / DRIFT / MISSING]` (INFORMATIONAL, non-blocking).

## Doc Staleness Check (automatic at the end)

diff's impact on `docs/`: code changed but docs not updated → flag (INFORMATIONAL).

## Constraints

- **Code may be changed under Fix-First** — AUTO-FIX fixes directly, ASK needs confirmation
- Each mode usable independently; --gate runs all in parallel; --release-gate is delivery review
- Frequency: Phase completion / pre-Gate / post-security-incident (not routine)
- Output a dated `audit-report-{date}.md` or `release-gate-{date}.md` under `docs/reports/`
