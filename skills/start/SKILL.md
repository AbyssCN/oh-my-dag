---
name: start
tier: foundation
runtime: always
trigger: mention
description: "Session initialization ritual: read the project's next-steps file + git status in parallel to restore the previous context, output a Briefing with the current task + suggested next step. The first command of every new session to prevent context loss. Trigger: start / 开始 / 恢复进度 / 继续上次的 / 新session / 从哪里继续. Skip: save progress (/handoff) / commit (/commit)."
metadata:
  source: xihe
  version: "3.1.0"
---
# /start — Session Initialization

> The first command of every new session. Restore context, output a briefing, suggest the next step.
> **Design principles**: minimal IO, minimal tokens (partial reads), ≤30 lines of output.

## Input

- Optional: feature hint (e.g., `/start auth-refactor`) — focus on a specific module
- Optional: `--scope <dirs>` — declare the file range for multi-session isolation
- Without a hint, derive the focus from the active plan in the project's next-steps file

> **Project files referenced below** (adapt the names to your project's conventions):
> - **next-steps file** — the single source of current state (active plan, next 3 steps, backlog). Default `~/.xihe/NEXT.md` or a project-local `NEXT.md`.
> - **session notes** — per-session handoff summaries written by `/handoff` (decisions, dead ends, remaining work).
> - **error journal** — a record of known bugs + fixes, read on demand.

## Workflow

### Step 0.5: Memory pre-flush (crash safety net, runs unconditionally)

If the previous session crashed unexpectedly without going through `/handoff`, the memory layer may still hold un-embedded captured entries. Drain them before the briefing (if your project has a memory flush command):

```bash
xihe memory flush || true
```

When pending is empty it's a no-op. `|| true` guarantees it won't block /start, **but stderr stays visible** (on non-zero exit you see the provider error / drift signal).

**Non-zero exit handling**: if flush exits non-zero (e.g. provider auth failure, corrupted pending), inject a warning at the very top of the Step 3 Briefing:
```
⚠️ Memory flush failed (exit {code}) — check stderr; memory may not be updated
```
This session still runs the full flow, but mark the Relevant Memory section in the briefing as `(stale — flush failed)`.

### Step 1: Parallel reads (emitted in the same message)

| # | Tool | Args | Extract |
|---|------|------|----------|
| 1 | Read | the **next-steps file** | active plan + next 3 steps + completed modules + backlog |
| 2 | Bash | *(see git command below)* | git + spec size + recent session notes, fetched in one shot |
| 3 | Read | the project's domain-knowledge registry (if one exists) | domain knowledge (used for domain matching) |

**Step 1 Bash command** (combines the checks into 1 call):
```bash
cd "$(git rev-parse --show-toplevel)" && \
echo "=LOG=" && git log --oneline -5 && \
echo "=STATUS=" && git status --short --branch && \
echo "=SESSIONS=" && ls -t .xihe/sessions/*.md 2>/dev/null | head -3
```

Parsing rules (extract from the `=TAG=` delimiters):
- `=LOG=` → last 5 commits
- `=STATUS=` → branch + uncommitted files
- `=SESSIONS=` → paths of the 3 most recent session notes

### Step 1.7: Session Memory (conditional read)

**Only when** `=SESSIONS=` output file paths (at most 1 extra Read):
- Pick the single most recent session note → Read it in full
- Extract the YAML frontmatter (status, task, commit_range, next_session_hint)
- Extract the `## Decisions` + `## Dead Ends` + `## Remaining` sections
- Token budget: ≤ 500 tokens (truncate an over-long Decisions list to the first 5)

### Step 2: Context restoration (extract from data already read in Step 1, no extra IO)

**2a. Active Task restoration**:
- **Current state**: extract from the next-steps file:
  - `active_plan.feature` → null = IDLE, non-null = active plan
  - `active_plan.{plan_file, complexity, blocked_on}` → current posture
  - `next_3_steps[]` → next 3 steps
- **status derivation**: `active_plan.feature` non-null = ACTIVE, otherwise IDLE

**2a-fallback. Backlog fallback recommendation** (auto-triggers when IDLE):
- Condition: `active_plan.feature` is null (derived status === IDLE)
- Action: read the backlog (if a separate backlog file exists, else the backlog section of the next-steps file) → extract P0/P1 items
- Sort: P0 before P1, same priority in document order
- Take the first 3 → fill the Briefing "next 3 steps" section:
  ```
  1. [Backlog P0/M] {title}
  2. [Backlog P1/L] {title}
  3. [Backlog P1/M] {title}
  ```
- Extra hint: `💡 Run /start <feature-hint> to activate a backlog item`
- If the backlog is empty → show "Backlog empty" + ask the developer for the goal

**2b. Domain Knowledge Matching** (from the domain-knowledge registry, if one exists):

Collect signals and match each registered domain:

1. **file_touched**: from the changed file paths in `=STATUS=` → match the domain's file globs
2. **feature**: from `active_plan.feature` → match the domain's feature pattern
3. **plan_file**: from the active plan's file path → match the domain's plan-ref keywords
4. **explicit**: `/start --domain <name>` → direct hit

Matching rules:
- `/start --domain X` → directly load X's invariants + dead-ends
- 2+ auto signals hit → auto-load domain invariants + dead-ends
- 1 auto signal hit → mention it in the briefing, do not auto-load
- 0 hits → skip the domain knowledge section

On load, Read the domain's invariants + dead-ends files (at most 2 extra Read calls). Record the invariant count + dead-end count in the briefing.

**2c. Session Memory** (extract from the data read in Step 1.7):
- YAML frontmatter `task` + `next_session_hint` → last focus + suggested handoff point
- `## Decisions` → decision list (first 5, each a 1-line summary)
- `## Dead Ends` → dead-end list (highlight a reminder when related to the current active task)
- `## Remaining` → validate consistency against the next-steps file's `next_3_steps`
- No session note → skip this section

### Step 2.5: Memory Retrieval (top-K semantic recall injected into the briefing)

If your project has a semantic memory layer, retrieve the most relevant prior entries for the current focus and embed them into the briefing.

```bash
# user /start <hint>: positional argument takes priority
xihe memory retrieve "<hint>" --k 3 --format briefing

# no hint: auto-construct the query from the active plan / next step
xihe memory retrieve --from-state --k 3 --format briefing
```

**Output spec**: stdout = a markdown block embedded directly into the briefing; stderr carries the query + source so it's visible without polluting the render. All empty → `_(no active task — skipping retrieval)_`, no error.

**Failure semantics**: a non-zero exit does not block /start; inject `⚠️ Memory retrieve failed (exit N)` at the top of the briefing.

### Step 3: Output the Session Briefing

**Output control**: total line count ≤ 35 lines (+5 for the domain knowledge section when loaded).

```
## Session Briefing — {date}

**Last**: {last_session_summary first 80 chars}
**Phase**: IDLE ({N} modules) | **Updated**: {updated_at}

### 📋 Active Plan
{IDLE: "no active plan" | active: Feature / PlanFile / BlockedOn}

### 🎯 Next 3 steps
1. {step}
2. {step}
3. {step}

### 🌿 Git
Branch: {branch} | Uncommitted: {N} | Ahead: {N}
Commits: {commit1} / {commit2} / {commit3}

### 💾 Session Memory
{shown only when Step 1.7 read a session note, otherwise omit the whole section}
- Last: {session_id} — {task first 50 chars}
- Decisions: {top 2-3 decisions, comma-separated}
- Dead Ends: {count} items{, ⚠️ related to the current task: "{dead_end_title}" — if any}

{Step 2.5 retrieval output embedded as-is (with a "### 💾 Relevant Memory (top-3)" header); omit the whole section when skipped}

### 🧠 Domain Knowledge ({domain})
{shown only when Step 2b matched a domain, otherwise omit the whole section}
- {N} invariants loaded (last updated: {freshness})
- {N} dead-ends flagged
- Active plan: {plan_path or "none"}

### 💡 Suggestion
{best next skill + a one-sentence reason}
```

**Suggestion recommendation logic** (by priority):
1. uncommitted + review passed → `/commit`
2. modified files → `/verify`
3. active plan contains `blocked_on` → prompt to read the error journal
4. commits ahead of origin → remind to `git push`
5. IDLE + no hint → ask the developer for today's goal

### Step 4: Feature Hint search (only when the user provides a hint)

Glob + Grep for files in the project's plan / spec directories matching the hint.
If found, append to the briefing:
```
### 🔎 Matched Plan/Spec
- {filename}: {first heading}
```

### Step 5: Health status line (no extra IO, computed from Step 1 data)

Append one line at the end of the briefing, formatted:
```
{✅|⚠️} Spec: {project rules + memory line count} lines
```

Judgment:
- Spec > 300 lines → ⚠️, append `— needs slimming`
- Otherwise → ✅ healthy

### Step 6: Disambiguation hint

```
> Routing: Vibe(single file) | Lite(2-5 files) | Full(cross-layer/Plan Mode)
> skill: commit↔verify | verify↔verify --full
```

## Constraints

- Read-only — modifying files is forbidden
- **Step 1's reads must be emitted in parallel in the same message** (no dependency, must not be serial)
- **Total output ≤ 30 lines (hard limit)** — count the lines before output, cut the longest section if over. DO NOT add sections outside the template. Each `###` section's content is limited to 1-3 lines; commits list only hash + scope, not the full message.
- Target completion < 5 seconds
- The next-steps file missing or corrupted → **immediately** output a `⚠️ next-steps file missing` warning + suggest `/handoff` to rebuild or create it manually. DO NOT try other paths to recover the file. Just output a shortened briefing (Git + Suggestion sections only)
- The error journal is not auto-injected — only prompt to read it on demand when the active plan contains `blocked_on`
