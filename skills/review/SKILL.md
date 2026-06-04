---
name: review
tier: capability
runtime: on-demand
trigger: mention
description: "On-demand audit: security / coverage / tech-debt / full Gate / PR code review (dispatch dream-team specialists + Codex). For Phase/Gate milestones, after a security incident, pre-merge PR review. Trigger: audit / security scan / full check / Gate check / review --security / review --gate / tech-debt inventory / security audit / review PR / code review / 审计 / 安全扫描 / 全量检查 / Gate检查 / 技术债盘点 / 代码审查 / PR审查. Skip: routine verification (/verify) / commit (/commit)."
metadata:
  source: claude-skills
  version: "5.0.0-xihe"
  methodology: "xihe audit + dream-team specialist + Codex G2/G3"
---

# /review — On-Demand Audit (xihe)

> On-demand full scan, for Phase completion / pre-Gate / post-security-incident. Routine changes go `/verify` → `/commit`.
> **xihe review model**: no RW feature-team review agent. Review = **dream-team RO** (pre-Plan methodology lens) + **Codex G2/G3** (post-write cross-model) + **Wright judgment** (the verdict, taste not hostage to findings). The real check = `bunx tsc --noEmit` / `bun test` / `bun build`.

## Modes

```
--security      → scan src/ trust boundaries (sig-verify/auth/injection/fail-open) + dream-team agent-protocol/data-layer lens
--coverage      → bun test --coverage + missing-test detection
--debt          → bunx tsc + unfixed P0/P1 in error-journal + TODO/FIXME scan + dream-team review
--zod           → Zod validation coverage audit of untrusted entrypoints (route/callback/inbox)
--pr            → PR-level review (dream-team specialists in parallel + plan completion + scope drift)
--gate          → the above in parallel, pre-Gate aggregate check (G2)
--release-gate  → Gate 3 delivery review (compound-strategist aggregate scan)
--with-codex    → modifier (combine with --gate/--release-gate/--pr): adds Codex cross-model in parallel in the same message
```

## `--with-codex` — Cross-Model Phase Gate (CLAUDE.md §Codex)

`--with-codex` is a modifier flag. On top of dream-team specialists, it adds **Codex** in parallel in the same message (cross-model GPT independence, the only non-Anthropic model family).

**Invocation** (xihe uses `/codex:*` slash commands — no a sibling project codex-dispatch.mjs/codex-plugin scripts):

| Gate | Codex command | Max rounds (hard cap) | BLOCK fallback |
|---|---|---|---|
| `--gate` (G2 Phase) | `/codex:review --base <last-gate-commit>` | **1** per phase end (CLAUDE.md: fix folds into next phase, no r2 spawn) | Wright judgment |
| `--release-gate` (G3) | `/codex:review --base main` | **1 + max 1 fix = 2** | the owner |
| `--pr` | `/codex:adversarial-review` | 1 | Wright |

**anti-slop** (CLAUDE.md): Codex finding ≠ ground truth. Must reject niche/theoretical/telemetry/tests-for-tests/style/doc-completeness; must accept P0/P1 reproducible bug (file:line+steps) + contract violation + ship-blocker + mechanism-level boundary failure.

**Finding → fix routing** (xihe's real roster — no feature-team RW agent):

| Finding type | routed to |
|---|---|
| PG schema / migration / temporal / RLS | dream-team **data-layer-architect** (RO diagnosis) → **Wright** main-writes the fix |
| RAG / memory / SAFEGUARD / Dream | **ai-pipeline-reviewer** (RO) → **Wright** fixes |
| Hono API / WS / type contract | **interface-architect** (RO) → **Wright** fixes |
| agent/skill/hook / DAG node / MCP | **agent-protocol-architect** (RO) → **Wright** fixes |
| daemon architecture / performance | **stack-architect** (RO) → **Wright** fixes |
| Type error / typo (≤3 lines) | **Wright** fixes directly on the main line |

> xihe is a daemon, execution goes through Wright Hybrid main-write (pet mode); dream-team only gives RO diagnosis, does not write.

---

## Trigger

`/review --<mode>` or `/review --gate`

## Security Mode (--security)

Dispatch dream-team **agent-protocol-architect** + **data-layer-architect** (RO), or Wright scans directly:
- Scan scope: `src/routes/` + `src/ws/` + `src/integrations/` + `sql/`
- Checks: trust-boundary sig-verify (HMAC/timingSafeEqual, benchmark `src/routes/inbox.ts`) / auth gap / injection / fail-open (`catch { return null }` swallowing errors) / GET read-only / no existence leakage / input Zod validation / RLS deny-all
- Output: P0/P1/P2 + verdict (PASS/BLOCK)

## Coverage Mode (--coverage)

1. `bun test --coverage` — coverage
2. Compare against `git diff` changed files: added/changed files with no corresponding `test/*.test.ts` → warning
3. Identify gaps: 0-test danger zones (history: DAG/memory scaffold)

## Debt Mode (--debt)

1. `bunx tsc --noEmit` — type debt
2. Read `.claude/knowledge/error-journal.json` — unfixed P0/P1
3. Grep TODO/FIXME/HACK + `_NEXT.md` secondary_tracks (known backlog: DAG v0.2/v0.3 dead config / Leiden not deployed / inbox WS broadcast TODO)

## Zod Mode (--zod)

Scan untrusted entrypoints (`src/routes/*` body / channel callback / `src/routes/inbox.ts`):
- PROTECTED: has Zod safeParse | UNPROTECTED: accepts external input but no Zod
- Note: `z.string().uuid()` is too strict for a sibling project UUIDs → hex regex (known gotcha)
- Output: coverage table + unprotected entrypoints + suggested schemas

## Gate Mode (--gate)

**Phase completion / pre-Gate.** In parallel:

| Lens/Check | maps to |
|---|---|
| dream-team specialist (routed by diff to data-layer/ai-pipeline/interface/agent-protocol) | methodology review |
| `bunx tsc --noEmit` + `bun test` | types + tests |
| Codex `/codex:review` (if --with-codex) | cross-model |

Synthesis: All green → GATE PASS | Any P1 → NEEDS-CHANGE | Any P0 → GATE BLOCK

### Step 0: Read the unified G2 kernel

Before dispatch, Read `.claude/skills/_modules/quality-gates/EXECUTION-REVIEW.md` (Mandatory Reads: INV-1..3 + project-canon + error-journal + role-oriented required reading) — inject at the top of each specialist prompt.

### Agent Prompt injection

```text
读取 .claude/skills/_modules/quality-gates/EXECUTION-REVIEW.md 获取审查指令 + Mandatory Reads。
按清单读完后开始评审。你的 lens: {data-layer | ai-pipeline | interface | agent-protocol | stack}
审查作用域: git diff $(git merge-base HEAD main)..HEAD
二元 PASS/FAIL + xihe 特化检查项 (Bun/Hono/Drizzle/temporal/SAFEGUARD)。
```

---

## PR Review Mode (--pr)

> PR-level code review. G2 Layer 3 entrypoint, shares the EXECUTION-REVIEW.md template.

### Step 1: Branch Diff

```bash
git diff main...HEAD --stat && git log main..HEAD --oneline
```
No diff → "Nothing to review", terminate.

### Step 2: Plan Completion Audit

Read `_NEXT.md` `active_plan` + commitments → compare against diff: DONE / PARTIAL / NOT DONE / EXTRA(scope creep).

### Step 3: Critical Pass

Scan diff for high-risk patterns: SQL injection (`IN` instead of `= ANY`), races (tick without CAS, DAG-R1), LLM trust boundary (memory write not going through validateFactWrite D54), auth gap, enum completeness (switch without default). Each finding carries confidence 1-10 (1-3 suppress / 4-6 mark low / 7-10 show).

### Step 4: Specialist Dispatch (parallel dream-team RO)

Routed by diff (parallel, same message):

| lens | condition | checks |
|------|------|------|
| **data-layer** | touches `sql/` / `src/schema.ts` | schema safety + RLS + indexes + temporal IMMUTABLE |
| **ai-pipeline** | touches `src/rag/` / `src/memory/` | RAG/memory + D54 validateFactWrite + confidence naming |
| **interface** | touches `src/routes/` / `src/ws/` | idempotency + sig-verify + error shape + type contract |
| **agent-protocol** | touches `.claude/` / `src/dag/` | agent/skill/hook + DAG node contract |
| **stack** | touches `src/dispatcher/` / `src/index.ts` | loop blocking + tick CAS + WS lifecycle |

Each lens RO sees only the diff + context, outputs findings (criterion + verdict + confidence + evidence + fix).

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

> Gate 3: final delivery review. /handoff recommends it on significant changes.

1. Read `.claude/skills/_modules/quality-gates/RELEASE-GATE.md`
2. Dispatch **compound-strategist** (RO), inject the template
3. Scan this session's changes, output the delivery checklist + VERDICT → `docs/reports/release-gate-{date}.md`

### /handoff recommendation triggers

| Condition | Recommend |
| --- | --- |
| This session changed ≥5 files + cross-layer | `/review --release-gate` |
| This session has a new migration (`sql/`) | `/review --release-gate` |
| This session changed schema / SAFEGUARD / DAG orchestration | `/review --release-gate` |
| None of the above | Silently skip |

---

## Fix-First Protocol (common to all modes)

- **AUTO-FIX**: mechanical issues (naming/formatting/import/dead code/typo) → fix directly
- **ASK**: needs judgment (architecture/performance tradeoff/security decision) → AskUserQuestion

Execution: classify → batch AUTO-FIX (one line each `[AUTO-FIXED] file:line Problem → done`) → remaining ASK ≤3 asked individually / >3 batched.

## Scope Drift Detection (automatic for --gate / --release-gate)

Read `_NEXT.md` active_plan (stated) vs `git diff --stat` (delivered) → SCOPE CREEP (out-of-scope files) / MISSING (promised but absent) → `Scope Check: [CLEAN / DRIFT / MISSING]` (INFORMATIONAL, non-blocking).

## Doc Staleness Check (automatic at the end)

diff's impact on `docs/`: code changed but docs not updated → flag (INFORMATIONAL).

## Constraints

- **Code may be changed under Fix-First** — AUTO-FIX fixes directly, ASK needs confirmation
- Each mode usable independently; --gate runs all in parallel; --release-gate is delivery review
- Frequency: Phase completion / pre-Gate / post-security-incident (not routine)
- Output `docs/reports/audit-report-{date}.md` or `release-gate-{date}.md`
- **Do not reference a sibling project dead infra**: `scripts/codex-dispatch.mjs` / `.claude/codex-plugin/` / `harness-ingest-review-finding.mjs` / `graphify-probe.py` / `check:*` / dead feature-team agent — xihe has none of these
