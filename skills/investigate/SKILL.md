---
name: investigate
tier: capability
runtime: on-demand
trigger: mention
description: "Systematic root-cause debugging: 8 phases — history search / reproduce / scope lock / pattern match / hypothesis test / fix / verify / report. Iron Law: no fix without a root cause. Trigger: investigate / debug / 调查 / 排查 / 为什么挂了 / 这个bug / 根因分析 / 错误报错 / 500 / stack trace / 昨天还好的. Skip: general code review (/review) / verification (/verify) / planned refactor (/implement)."
metadata:
  source: claude-skills
  version: "1.0.0"
---
# /investigate -- Systematic Debugging

> ⚠️ **`$B snapshot` reference is deprecated** (2026-05-01, 2 light dependencies)
>
> The `$B snapshot -i` UI-bug screenshot references on lines 49 / 254 — the `$B` daemon has been removed; when invoked, use `/e2e-testing --browser` screenshots or Chrome CDP instead. The main flow is unaffected (the investigate 8 phases do not depend on a browser).
>
> Migration spec: `docs/plan/PLAN-2026-05-01-b1-dollar-B-chrome-cdp-migration.md`
>
> ---
>
> **Iron Law: no fix without a root cause.** Fixing symptoms = whack-a-mole. Find the root cause before touching anything.
>
> Source: core-rules-full.md §10.1 Bugfix flow + gstack investigate mode

## Input

- Required: bug description (error message / screenshot / repro steps)
- Optional: `--skip-history` skip the history search (when you've confirmed it's a new problem)
- Optional: `--module <dir>` preset scope-lock directory

---

## Phase 1: History Search (search before you investigate)

> core-rules-full.md §1: "On failure, first search session Dead Ends -> then search error-journal -> only then investigate from scratch"

**Emit 3 calls in parallel in the same message:**

| # | Tool | Target | Extract |
|---|------|------|------|
| 1 | Read | `.claude/knowledge/error-journal.json` (limit=200) | Known P0/P1 issues + existing fixes |
| 2 | Grep | `.claude/sessions/*.md` searching for "Dead End" + error keywords | Historical dead ends |
| 3 | Bash | `git log --oneline -20 -- <affected-files>` | Recent changes |

**Matching rules:**
- error-journal has the same pattern -> cite the known fix directly, jump to Phase 6
- session has a matching Dead End -> mark it "known dead end", avoid repeating the attempt
- No match -> continue to Phase 2

With `--skip-history`, skip this phase.

---

## Phase 2: Reproduce

Confirm the bug exists, capture evidence.

1. **Collect symptoms**: error message, stack, repro steps. When information is insufficient, use AskUserQuestion to ask one at a time (only one question per turn)
2. **Reproduce**: can you trigger it deterministically? If not -> collect more evidence before continuing
3. **Evidence snapshot**: save error output / screenshots. For UI bugs use `$B snapshot -i` to capture

**Output**: `## Symptom confirmed` -- a brief description of the phenomenon + how to reproduce

---

## Phase 3: Scope Lock (K8 Iron Law · 2026-04-27 §S2.9 hardened)

Identify the affected modules, restrict the edit range to prevent scope creep.

> **Protocol**: see `.claude/skills/_modules/scope-lock/MODULE.md` (K8 kernel · landed in S2.8).
> This Phase is a consumer of the scope-lock MODULE, observing the Iron Law: during investigate, do not change code outside scope.

1. Trace from the symptom back through the code path, determine the narrowest affected directory
2. Declare the scope lock:

```
SCOPE LOCK: src/dag/dispatcher.ts + src/dag/
Reason: the bug is in the DAG dispatch module, no other area is involved
Lock duration: 30min auto-timeout (consistent with scope-lock MODULE §Step 3)
```

3. **From here on every Edit/Write must be inside scope**. Need to modify a file outside scope -> confirm with the owner first
4. With `--module <dir>` preset, use it directly
5. **Mode coupling** (scope-lock MODULE §coupling with cognitive-modes):
   - M1 rca / M3 subtraction → scope lock defaults ON
   - other modes → scope lock defaults OFF

**Cross-module bugs**: when scope is unclear, note the reason, do not lock, but self-check whether each edit is necessary before making it.

**Iron Law violation signals** (on appearance, stop immediately + re-evaluate):
- "Might as well fix a related issue while I'm here" → it's not convenient, note it in _NEXT.md as a follow-up
- "Since I'm editing this file, may as well refactor a bit" → don't refactor, evaluate after this bug fix is done
- "An out-of-scope file seems to affect this bug" → don't assume, go back to Phase 1 and re-trace

**Related §5 frames**:
- FR-9 Focus subtraction ("what not to do") — Scope Lock is the hard enforcement of this frame
- FR-2 Blast radius instinct — limit this fix's blast radius to the narrowest dir

---

## Phase 4: Pattern Matching

<!-- reasoning-tool: step-back (docs/standards/PROMPT-STRUCTURE-STANDARD.md §4.4) -->

Before matching against specific patterns, first ask yourself:
> "What level of problem usually causes **this class of symptom** ({symptom category: data inconsistency / timeout / type error / duplicate dispatch / permission issue}) under a Bun/Hono daemon + self-hosted PG + DAG/memory architecture?"

After establishing a macro diagnostic frame, use the frame to narrow the specific pattern-matching range. This avoids jumping straight to the most "look-alike" pattern while ignoring deeper causes.

Compare against 8 known bug patterns (the 6 from core-rules-full.md §10.4 + 2 xihe PG/daemon-specific):

| # | Pattern | Signature | Investigation direction |
|---|------|------|----------|
| 1 | Race | Intermittent, timing-dependent | DAG tick concurrency without CAS (DAG-R1), Promise.all ordering, loop fire-and-forget |
| 2 | Nil | TypeError, undefined | optional value missing a guard, broken `?.` chain |
| 3 | State corruption | Data inconsistency, partial updates | missing transaction, event cursor missing rows (timestamp instead of bigserial id) |
| 4 | Integration | Timeout, unexpected response | WeCom/Lark callback, postgres-js pool, RAG cross-db, RC client WS timeout |
| 5 | Config drift | OK locally / broken on NAS | env variables, `.env`, NAS docker compose, feature flag |
| 6 | Cache | Stale data, fine after refresh | client-context LRU=5, dispatcher in-flight guard, WS pub/sub stale |
| 7 | **RLS / tenant leak** | Tenant data crossing over, permission anomaly | missing RLS deny-all, missing tenant/scope filter, multi-app router misrouting |
| 8 | **Drizzle schema drift** | Type mismatch, migration failure | `sql/` ↔ `src/schema.ts` out of sync, migration ordering wrong, temporal generated column not IMMUTABLE (TKG-1), `z.string().uuid()` rejecting a a sibling project UUID |

**Matching flow:**
1. Compare the symptom against pattern signatures, match the 1-2 most likely patterns
2. Focus the investigation along the pattern's direction

### Phase 4.5: Domain Pitfall Matching (Layer A-Express, lightweight injection)

Read `.claude/hooks/prompt-library.json`
→ keyword-match the module name of the current scope lock (e.g. "billing" / "work" / "ai")
→ extract only the `pitfalls` of the matching fragment (≤3), do not extract constraints
→ add them as extra hypothesis candidates to the Phase 5 hypothesis tracking table
→ if a pitfall directly matches the current symptom (e.g. "pgvector search_path" + RPC 500 error) → mark "known domain pitfall" + skip Phase 5 and go straight to the Phase 6 fix

### Phase 4.6: Cognitive Mode Activation (cognitive-modes invocation)

> Execute the matching logic in the shared module `.claude/skills/_modules/cognitive-modes/MODULE.md`.
> Input: task_description="debug symptom" + task_type="bugfix".
> depth: standard.
>
> **Default activates M1 RCA** (root-cause tracing) — 5-Why + red-team self-check + process consolidation.
> **Output injection**: 3 behavioral constraints (5-Why tracing / red-team perspective / scan for same-class issues after the fix) + 2 self-checks (process locked in? attacked from the opposing side?).
>
> During Phase 5 hypothesis verification, every hypothesis must pass M1's "red-team self-check" before entering the Phase 6 fix.

**Extra checks:**
- `git log` historical fixes in the same area -- **repeatedly fixing a bug in the same file = an architecture problem**, not a coincidence
- Supabase bug: `npm run check:migration-safety` + check whether `src/types/supabase.ts` is up to date

---

## Phase 5: Hypothesis Verification

At most 3 hypotheses, verified one by one.

### Hypothesis Tracking Table

<!-- reasoning-tool: cot (docs/standards/PROMPT-STRUCTURE-STANDARD.md §4.1) -->

For each hypothesis, complete the three-step derivation before filling in the tracking table:
1. **Observation**: what I see in the code/logs/symptom (cite file:line)
2. **Inference**: if this hypothesis holds, what else should be observable
3. **Verification**: design an experiment that distinguishes "hypothesis holds" from "hypothesis does not hold"

```
| # | Hypothesis | Verification method | Result |
|---|------|----------|------|
| 1 | [concrete testable claim] | [how to verify] | CONFIRMED / REJECTED |
| 2 | ... | ... | ... |
| 3 | ... | ... | ... |
```

### Verification Rules

1. **Verify before fixing**: add a temporary log/assertion at the suspected root cause, run the repro, see whether the evidence matches
2. **When a hypothesis is wrong**: don't guess. Go back to Phase 2 and collect more evidence
3. **Three strikes**: all 3 hypotheses fail -> **STOP**, use AskUserQuestion to ask the owner:

```
None of the 3 hypotheses hit. It may be an architecture-level problem rather than a simple bug.

A) Keep investigating -- I have a new hypothesis: [description]
B) Escalate to human review -- need someone familiar with the system to step in
C) Add logging and observe -- instrument and wait for the next trigger
```

### Danger Signals (slow down when you see them)

- "Let me just do a temporary fix" -> there is no temporary fix. Fix it right or escalate
- Proposing a fix before tracing the data flow -> you're guessing
- New problems pop up after every fix -> the level is wrong, not the code

---

## Phase 5.5: Stuck Protocol (when all 3 hypotheses fail)

> Source: core-rules-full.md §10.8 stuck checklist + PUA v3 L3 protocol
> Trigger: must run when Phase 5 strikes out but the owner chooses "keep investigating" (option A)

**7-item checklist** (go through every item before continuing; mark unpassed items ❌, only all ✅ counts as exhausted):

- [ ] Did you read the failure signal word for word? (not glance at the title —— the whole stack trace / the full error body)
- [ ] Did you search for the core problem with tools? (`.claude/knowledge/error-journal.json` → session dead-ends → WebSearch the original error text)
- [ ] Did you read the original 50 lines of context at the failure site? (`Read` the original source, not a README or summary)
- [ ] Did you confirm every hypothesis with tools? (`Grep`/`Bash` verification, not imagination —— against §10.5 anti-rationalization table item 4 "might be an environment problem")
- [ ] Did you try the exact opposite hypothesis? (original "the problem is in A" → reverse "the problem is NOT in A")
- [ ] Can you reproduce the problem in the smallest scope? (if reproducible but not minimal → keep shrinking the scope)
- [ ] Did you switch tools/methods/angles/tech stacks? (Grep → WebSearch; Bash → MCP; static analysis → dynamic log)

### Cognitive Mode Switching (switch chains come from cognitive-modes/MODULE.md)

If all 7 items above are ✅ and still no solution, **force a cognitive mode switch**:

| Current stuck symptom | Switch chain (try left to right in order) |
|------------|-------------------------|
| Repeatedly debugging the same spot without changing approach | M2 first principles → M3 subtraction → M1 RCA |
| Thoughts like "suggest the owner handle it manually" | M6 evidence-driven → M1 RCA → M2 first principles |
| Drawing a conclusion before using tools | M4 search-first → M5 user-backward → M6 evidence-driven |

Before switching, Read the corresponding `modes/*.md` to get the full behavioral constraints.

### Graceful Exit (still no solution after exhausting everything)

Output the core-rules §10.7 **structured failure report**:

```
[FAILURE-REPORT]
Verified facts: [with evidence]
Excluded possibilities: [with exclusion basis]
Methodologies attempted: [M1/M2/M4 etc. results]
Narrowed problem boundary: [down to function/line]
3 options for the owner to decide on: [with costs]
```

---

## Phase 6: Fix

After the root cause is confirmed, fix with the minimal change.

1. **Fix the root cause, not the symptom**: fewest files, fewest lines. Do not refactor adjacent code while you're at it
2. **Regression test**: write a test -- FAIL without the fix, PASS after the fix
3. **Run the test suite**: `npx vitest run`, paste the output. No regressions allowed
4. **Blast Radius Gate**: when modifying >5 files, use AskUserQuestion:

```
This fix touches N files. For a bugfix the blast radius is on the large side.

A) Continue -- the root cause genuinely spans these files
B) Split -- fix the critical path first, defer the rest
C) Rethink -- there may be a more precise approach
```

5. **Supabase migration**: go through `/data-pipeline`, do not write SQL directly inside this skill
6. **Atomic commit**: a fix = one commit, message format `fix(scope): 中文描述`

---

## Phase 7: Verification Loop

> Verify > trust. No commit without verification.

1. **Reproduce the original scenario**: confirm the bug is fixed
2. **Automated verification**: invoke `/verify --smart` to run change-related checks
3. **UI bug extra**: `$B snapshot -i` screenshot to confirm visual correctness
4. **RLS bug extra**: `npm run check:tenant` + `npm run check:rls`
5. **Update error-journal**: when Phase 1 matched a known issue, update its status to resolved

---

## Phase 8: Debug Report

```
DEBUG REPORT
========================================
Symptom:     [what the user observed]
Root cause:  [what actually went wrong + why]
Pattern:     [matched bug pattern number + name]
Fix:         [what changed, file:line reference]
Evidence:    [test output / repro result]
Regression test: [test file:line]
History link: [error-journal entry / session Dead End / historical bug in the same area]
Scope Lock:  [locked range + whether breached]
Blast radius: [N files changed]
Status:      DONE | DONE_WITH_CONCERNS | BLOCKED
========================================
```

**Status definitions:**
- **DONE** -- root cause found + fixed + regression test + all tests pass
- **DONE_WITH_CONCERNS** -- fixed but cannot be fully verified (intermittent bug / needs production confirmation)
- **BLOCKED** -- cannot continue. Explain the blocking reason + what was tried + suggested next step for the owner

---

## Phase 8.5: Same-Class Scan (fix one, scan a swath)

> Source: core-rules-full.md §10.1 "one problem comes in, a class of problems goes out"
> cognitive-modes M1 RCA's "scan for same-class issues after the fix" behavioral constraint
> Trigger: **must** execute after Phase 8 status = DONE, before closing the task

After fixing the bug, don't walk away just because it's DONE. Use the root cause to reason back to same-class problems:

1. **Grep the same pattern**
   ```
   For the key API/function/pattern in the root cause, Grep the whole repo:
   - if the root cause is "missing tenant/scope filter" → Grep drizzle queries (`.select`/`.where`) to find all db access points
   - if the root cause is "unvalidated zod" → Grep route/callback handlers to find all untrusted entries
   - if the root cause is "tick without CAS" → Grep `setInterval`/`status='ready'` to find all dispatch points
   ```

2. **Same-module scan**
   ```
   Within the directory of the current scope lock, use Grep to find the same code pattern.
   e.g. scope=src/dag/, Grep whether all handlers under that directory have the same class of defect.
   ```

3. **Upstream/downstream impact**
   ```
   Use the dependency-explorer agent to check:
   - who calls the function you modified? Are the callers also affected?
   - if you changed a schema, which actions read this field? Do they need a coordinated change?
   ```

4. **Output the same-class scan report**
   ```
   Same-class scan result:
   - scanned pattern: [Grep query]
   - hit file count: N
   - suspected same-class problems: [file:line, ≤5]
   - handled this time: [fixed directly / recorded as tech debt in error-journal / left for the owner to decide]
   ```

**Principle**: if same-class problems > 5 → don't fix them all at once (avoid scope creep);
→ fix the most important 1-2, record the rest in `error-journal.json` as a pattern entry;
→ the next domain-inject will automatically inject these pitfalls.

---

## Constraints

- **Iron Law**: do not write fix code without finding the root cause. During the diagnosis phase, proposing a fix is forbidden
- **Three strikes**: 3 failed hypotheses -> STOP and ask the owner
- **Scope Lock**: edits must be within the declared range, crossing the boundary needs confirmation
- **Blast Radius**: >5 files must ask the owner
- **Don't say "this should fix it"**: verify and prove it. Run the tests
- **History first**: search error-journal + sessions first, don't start from scratch
- **Don't write migrations directly**: Supabase migration goes through `/data-pipeline`
- **Output in Chinese, code in English**
