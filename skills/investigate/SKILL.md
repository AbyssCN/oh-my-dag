---
name: investigate
tier: capability
runtime: on-demand
trigger: mention
description: "Systematic root-cause debugging: 8 phases — history search / reproduce / scope lock / pattern match / hypothesis test / fix / verify / report. Iron Law: no fix without a root cause. Trigger: investigate / debug / 调查 / 排查 / 为什么挂了 / 这个bug / 根因分析 / 错误报错 / 500 / stack trace / 昨天还好的. Skip: general code review (/review) / verification (/verify) / planned refactor (/implement)."
metadata:
  source: xihe
  version: "1.0.0"
---
# /investigate -- Systematic Debugging

> **Iron Law: no fix without a root cause.** Fixing symptoms = whack-a-mole. Find the root cause before touching anything.

## Input

- Required: bug description (error message / screenshot / repro steps)
- Optional: `--skip-history` skip the history search (when you've confirmed it's a new problem)
- Optional: `--module <dir>` preset scope-lock directory

---

## Phase 1: History Search (search before you investigate)

> Rule of thumb: on failure, first search past sessions for dead ends → then search the error journal → only then investigate from scratch.

**Emit 3 calls in parallel in the same message:**

| # | Tool | Target | Extract |
|---|------|------|------|
| 1 | Read | the project's error journal (a record of known bugs + fixes, if one exists) | Known P0/P1 issues + existing fixes |
| 2 | Grep | past session notes, searching for "Dead End" + error keywords | Historical dead ends |
| 3 | Bash | `git log --oneline -20 -- <affected-files>` | Recent changes |

**Matching rules:**
- The error journal has the same pattern -> cite the known fix directly, jump to Phase 6
- A session note has a matching dead end -> mark it "known dead end", avoid repeating the attempt
- No match -> continue to Phase 2

With `--skip-history`, skip this phase.

---

## Phase 2: Reproduce

Confirm the bug exists, capture evidence.

1. **Collect symptoms**: error message, stack, repro steps. When information is insufficient, ask one clarifying question at a time (only one question per turn)
2. **Reproduce**: can you trigger it deterministically? If not -> collect more evidence before continuing
3. **Evidence snapshot**: save error output / screenshots

**Output**: `## Symptom confirmed` -- a brief description of the phenomenon + how to reproduce

---

## Phase 3: Scope Lock

Identify the affected modules, restrict the edit range to prevent scope creep.

> The Iron Law of this phase: during investigate, do not change code outside the locked scope.

1. Trace from the symptom back through the code path, determine the narrowest affected directory
2. Declare the scope lock:

```
SCOPE LOCK: <the narrowest affected file + directory>
Reason: the bug is in <module>, no other area is involved
Lock duration: 30min auto-timeout
```

3. **From here on every Edit/Write must be inside scope**. Need to modify a file outside scope -> confirm first
4. With `--module <dir>` preset, use it directly

**Cross-module bugs**: when scope is unclear, note the reason, do not lock, but self-check whether each edit is necessary before making it.

**Iron Law violation signals** (on appearance, stop immediately + re-evaluate):
- "Might as well fix a related issue while I'm here" → it's not convenient, note it as a follow-up for later
- "Since I'm editing this file, may as well refactor a bit" → don't refactor, evaluate after this bug fix is done
- "An out-of-scope file seems to affect this bug" → don't assume, go back to Phase 1 and re-trace

**Why scope lock matters**: it is the hard enforcement of "decide what *not* to do" — limit this fix's blast radius to the narrowest dir.

---

## Phase 4: Pattern Matching

Before matching against specific patterns, first ask yourself:
> "What level of problem usually causes **this class of symptom** ({symptom category: data inconsistency / timeout / type error / duplicate dispatch / permission issue}) in this system's architecture?"

After establishing a macro diagnostic frame, use the frame to narrow the specific pattern-matching range. This avoids jumping straight to the most "look-alike" pattern while ignoring deeper causes.

Compare against common bug patterns:

| # | Pattern | Signature | Investigation direction |
|---|------|------|----------|
| 1 | Race | Intermittent, timing-dependent | concurrent updates without a compare-and-swap guard, unordered parallel execution, fire-and-forget calls |
| 2 | Nil | TypeError, undefined | optional value missing a guard, broken `?.` chain |
| 3 | State corruption | Data inconsistency, partial updates | missing transaction, cursor skipping rows (ordering by timestamp instead of a monotonic id) |
| 4 | Integration | Timeout, unexpected response | external API / webhook callback, connection pool exhaustion, cross-service / WebSocket timeout |
| 5 | Config drift | OK locally / broken in deployment | env variables, `.env`, container/compose config, feature flag |
| 6 | Cache | Stale data, fine after refresh | in-memory LRU, in-flight guard, pub/sub stale state |
| 7 | Auth / tenant leak | Data crossing tenant boundaries, permission anomaly | missing deny-all default, missing tenant/scope filter, misrouting |
| 8 | Schema drift | Type mismatch, migration failure | ORM model out of sync with migrations, migration ordering wrong, generated column not immutable, an over-strict validator rejecting valid input |

**Matching flow:**
1. Compare the symptom against pattern signatures, match the 1-2 most likely patterns
2. Focus the investigation along the pattern's direction

### Phase 4.5: Domain Pitfall Matching (lightweight injection)

If the project keeps a registry of domain pitfalls:
→ keyword-match the module name of the current scope lock
→ extract only the matching `pitfalls` (≤3), do not extract constraints
→ add them as extra hypothesis candidates to the Phase 5 hypothesis tracking table
→ if a pitfall directly matches the current symptom → mark "known domain pitfall" + skip Phase 5 and go straight to the Phase 6 fix

### Phase 4.6: Cognitive Mode — root-cause tracing

Default mode for debugging is root-cause analysis (RCA): 5-Why tracing + red-team self-check + process consolidation.

- **Behavioral constraints**: trace with 5-Why / take the opposing (red-team) view on each hypothesis / scan for same-class issues after the fix.
- **Self-checks**: is the fix mechanism locked in? Have you attacked it from the opposing side?

During Phase 5 hypothesis verification, every hypothesis must pass the red-team self-check before entering the Phase 6 fix.

**Extra check:**
- `git log` historical fixes in the same area -- **repeatedly fixing a bug in the same file = an architecture problem**, not a coincidence

---

## Phase 5: Hypothesis Verification

At most 3 hypotheses, verified one by one.

### Hypothesis Tracking Table

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
3. **Three strikes**: all 3 hypotheses fail -> **STOP** and ask the developer:

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

> Trigger: must run when Phase 5 strikes out but the developer chooses "keep investigating" (option A)

**7-item checklist** (go through every item before continuing; mark unpassed items ❌, only all ✅ counts as exhausted):

- [ ] Did you read the failure signal word for word? (not glance at the title — the whole stack trace / the full error body)
- [ ] Did you search for the core problem with tools? (error journal → session dead-ends → web-search the original error text)
- [ ] Did you read the original 50 lines of context at the failure site? (Read the original source, not a README or summary)
- [ ] Did you confirm every hypothesis with tools? (grep / shell verification, not imagination — beware the rationalization "it's probably an environment problem")
- [ ] Did you try the exact opposite hypothesis? (original "the problem is in A" → reverse "the problem is NOT in A")
- [ ] Can you reproduce the problem in the smallest scope? (if reproducible but not minimal → keep shrinking the scope)
- [ ] Did you switch tools/methods/angles/tech stacks? (grep → web search; shell → another tool; static analysis → dynamic log)

### Cognitive Mode Switching

If all 7 items above are ✅ and still no solution, **force a cognitive mode switch**:

| Current stuck symptom | Switch chain (try left to right in order) |
|------------|-------------------------|
| Repeatedly debugging the same spot without changing approach | first principles → subtraction → RCA |
| Thoughts like "suggest the developer handle it manually" | evidence-driven → RCA → first principles |
| Drawing a conclusion before using tools | search-first → user-backward → evidence-driven |

### Graceful Exit (still no solution after exhausting everything)

Output a **structured failure report**:

```
[FAILURE-REPORT]
Verified facts: [with evidence]
Excluded possibilities: [with exclusion basis]
Methodologies attempted: [which approaches, and their results]
Narrowed problem boundary: [down to function/line]
3 options for the developer to decide on: [with costs]
```

---

## Phase 6: Fix

After the root cause is confirmed, fix with the minimal change.

1. **Fix the root cause, not the symptom**: fewest files, fewest lines. Do not refactor adjacent code while you're at it
2. **Regression test**: write a test -- FAIL without the fix, PASS after the fix
3. **Run the test suite**: paste the output. No regressions allowed
4. **Blast Radius Gate**: when modifying >5 files, ask the developer:

```
This fix touches N files. For a bugfix the blast radius is on the large side.

A) Continue -- the root cause genuinely spans these files
B) Split -- fix the critical path first, defer the rest
C) Rethink -- there may be a more precise approach
```

5. **Atomic commit**: a fix = one commit, message format `fix(scope): description`

---

## Phase 7: Verification Loop

> Verify > trust. No commit without verification.

1. **Reproduce the original scenario**: confirm the bug is fixed
2. **Automated verification**: invoke `/verify` to run change-related checks
3. **Update the error journal**: when Phase 1 matched a known issue, update its status to resolved

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
History link: [error journal entry / session dead end / historical bug in the same area]
Scope Lock:  [locked range + whether breached]
Blast radius: [N files changed]
Status:      DONE | DONE_WITH_CONCERNS | BLOCKED
========================================
```

**Status definitions:**
- **DONE** -- root cause found + fixed + regression test + all tests pass
- **DONE_WITH_CONCERNS** -- fixed but cannot be fully verified (intermittent bug / needs production confirmation)
- **BLOCKED** -- cannot continue. Explain the blocking reason + what was tried + suggested next step

---

## Phase 8.5: Same-Class Scan (fix one, scan a swath)

> Principle: "one problem comes in, a class of problems goes out"
> Trigger: **must** execute after Phase 8 status = DONE, before closing the task

After fixing the bug, don't walk away just because it's DONE. Use the root cause to reason back to same-class problems:

1. **Grep the same pattern**
   ```
   For the key API/function/pattern in the root cause, Grep the whole repo:
   - if the root cause is "missing tenant/scope filter" → Grep DB queries to find all data access points
   - if the root cause is "unvalidated input" → Grep route/callback handlers to find all untrusted entries
   - if the root cause is "update without compare-and-swap" → Grep the scheduling/dispatch points
   ```

2. **Same-module scan**
   ```
   Within the directory of the current scope lock, use Grep to find the same code pattern.
   ```

3. **Upstream/downstream impact**
   ```
   Check:
   - who calls the function you modified? Are the callers also affected?
   - if you changed a schema, which call sites read this field? Do they need a coordinated change?
   ```

4. **Output the same-class scan report**
   ```
   Same-class scan result:
   - scanned pattern: [Grep query]
   - hit file count: N
   - suspected same-class problems: [file:line, ≤5]
   - handled this time: [fixed directly / recorded as tech debt / left to decide later]
   ```

**Principle**: if same-class problems > 5 → don't fix them all at once (avoid scope creep);
→ fix the most important 1-2, record the rest in the error journal as a pattern entry.

---

## Constraints

- **Iron Law**: do not write fix code without finding the root cause. During the diagnosis phase, proposing a fix is forbidden
- **Three strikes**: 3 failed hypotheses -> STOP and ask the developer
- **Scope Lock**: edits must be within the declared range, crossing the boundary needs confirmation
- **Blast Radius**: >5 files must ask first
- **Don't say "this should fix it"**: verify and prove it. Run the tests
- **History first**: search the error journal + session notes first, don't start from scratch
