---
name: start
tier: foundation
runtime: always
trigger: mention
description: "Session initialization ritual: read _NEXT.md + git status in parallel to restore the previous context, output a Briefing with the current task + suggested next step. The first command of every new session to prevent context loss. Trigger: start / 开始 / 恢复进度 / 继续上次的 / 新session / 从哪里继续. Skip: save progress (/handoff) / commit (/commit)."
metadata:
  source: claude-skills
  version: "3.1.0"
---
# /start — Session Initialization

> The first command of every new session. Restore context, output a briefing, suggest the next step.
> **Design principles**: minimal IO (2 calls), minimal tokens (partial reads), ≤30 lines of output.

## Input

- Optional: feature hint (e.g., `/start G5残留`) — focus on a specific module
- Optional: `--scope <dirs>` — declare the file range for multi-session isolation
- Without a hint, derive the focus from `active_plan` in `_NEXT.md`

## Workflow

### Step 0.5: Memory Layer pre-flush (crash safety net, runs unconditionally)

If the previous session crashed unexpectedly without going through `/handoff`, `.claude/memory/index/pending.jsonl` may still hold un-embedded captured entries. Drain them before the briefing:

```bash
npx tsx .claude/memory/scripts/flush.ts || true
```

When pending is empty it's a no-op (<50ms). `|| true` guarantees it won't block /start, **but stderr stays visible** (on non-zero exit Claude sees the provider error/drift signal).

**Non-zero exit handling**: if flush exits non-zero (e.g. model drift, provider auth failure, corrupted pending), inject at the very top of the Step 3 Briefing (the line right under the `## Session Briefing` title):
```
⚠️ Memory flush failed (exit {code}) — check stderr; memory may not be updated
```
This session still runs the full flow, but mark the 💾 Relevant Memory section in the briefing as `(stale — flush failed)`.

### Step 1: Parallel reads (3 calls, emitted in the same message)

| # | Tool | Args | Extract |
|---|------|------|----------|
| 1 | Read | `docs/session/session-state.json` | **v5 schema (state-arch-v2)**: only last_session + cognitive.class_distribution. Current-state fields have migrated to _NEXT.md ROUTER_V6 (parse strictly with the active-task-v2 helper). |
| 2 | Read | `_NEXT.md` **offset=60, limit=100** | strategic context + completed_modules + backlog (strategic info not in the JSON) |
| 3 | Bash | *(see git command below)* | git + spec size + sessions fetched in one shot |
| 4 | Read | `docs/knowledge/_INDEX.md` | Domain knowledge registry (used for domain matching) |

**Step 1 Bash command** (combines the checks into 1 call):
```bash
cd "$(git rev-parse --show-toplevel)" && \
echo "=LOG=" && git log --oneline -5 && \
echo "=STATUS=" && git status --short --branch && \
echo "=SPEC=" && wc -l .claude/CLAUDE.md 2>/dev/null; wc -l "$HOME/.claude/projects/c--a sibling project/memory/MEMORY.md" 2>/dev/null && \
echo "=SESSIONS=" && ls -t .claude/sessions/*.md 2>/dev/null | head -3
```

Parsing rules (extract from the `=TAG=` delimiters):
- `=LOG=` → last 5 commits
- `=STATUS=` → branch + uncommitted files
- `=SPEC=` → CLAUDE.md line count + MEMORY.md line count
- `=SESSIONS=` → paths of the 3 most recent session summary files (L1 data source)

### Step 1.7: L1 Session Memory (conditional read)

**Only when** `=SESSIONS=` output file paths (at most 1 extra Read):
- Pick the single most recent session file → Read it in full
- Extract the YAML frontmatter (status, task, commit_range, next_session_hint)
- Extract the `## Decisions` + `## Dead Ends` + `## Remaining` sections
- Token budget: L1 data ≤ 500 tokens (truncate an over-long Decisions to the first 5)
- **L2 traces** (`.claude/traces/`) are not auto-loaded — only searched on demand via `trace-search.sh`

### Step 2: Context restoration (extract from data already read in Step 1, no extra IO)

**2a. Active Task restoration** (v5: the single source of current state = _NEXT.md ROUTER_V6, cumulative state = session-state.json):
- **Current state**: extract from the `_NEXT.md` ROUTER_V6 yaml fence (use the active-task-v2 helper or grep directly):
  - `active_plan.feature` → null = IDLE, non-null = active plan
  - `active_plan.{plan_file, complexity, blocked_on}` → current posture
  - `next_3_steps[]` → next 3 steps
- **Cumulative state**: read `last_session.{date,session_id,summary}` from `session-state.json` (v5 schema, only this section)
- **status derivation**: `active_plan.feature` non-null = ACTIVE, otherwise IDLE (no longer reads a status field from the JSON)

**2a-fallback. Backlog fallback recommendation** (auto-triggers when IDLE):
- Condition: `_NEXT.md` `active_plan.feature` is null (derived status === IDLE)
- Action: Read `docs/session/_BACKLOG.md` → line-by-line match `/\*\*\[(P[0-1])\/([SMLX]+)\]\s*(.+?)\*\*/` to extract P0/P1 items
- Sort: P0 before P1, same priority in document order
- Take the first 3 → fill the Briefing "next 3 steps" section:
  ```
  1. [Backlog P0/M] {title}
  2. [Backlog P1/L] {title}
  3. [Backlog P1/M] {title}
  ```
- Extra hint: `💡 Run /start <feature-hint> to activate a backlog item`
- If `_BACKLOG.md` does not exist or has no P0/P1 items → show "Backlog empty" + suggest `AskUserQuestion` to ask for the goal

**2b. Domain Knowledge Matching** (match from Step 1 Read #5 `_INDEX.md`):

Collect 4 kinds of signals and match each domain in _INDEX.md:

1. **file_touched**: from the changed file paths in `=STATUS=` → match the `match_signals.file_touched` globs
2. **feature**: from `active_task.feature` (JSON) or `active_plan.feature` (YAML) → match the `match_signals.feature_pattern` regex
3. **plan_file**: from the `context_pointers.plan_file` path string → match the `match_signals.plan_ref_contains` keywords (v4: plan_ref merged → plan_file, the path already contains the PLAN slug keywords)
4. **explicit**: `/start --domain <name>` → direct hit

Matching rules:
- `/start --domain X` → directly load X's invariants + dead-ends (Read the corresponding files)
- 2+ auto signals hit → auto-load domain invariants + dead-ends
- 1 auto signal hit → mention it in the briefing, do not auto-load
- 0 hits → skip the domain knowledge section

On load, execute: Read `docs/knowledge/{domain}/invariants.md` + Read `docs/knowledge/{domain}/dead-ends.md` (at most 2 extra Read calls). Record the invariant count + dead-end count + latest experiment champion in the briefing.

**2c. L1 Session Memory** (extract from the data read in Step 1.7):
- YAML frontmatter `task` + `next_session_hint` → last focus + suggested handoff point
- `## Decisions` → decision list (first 5, each a 1-line summary)
- `## Dead Ends` → dead-end list (highlight a reminder when related to the current active_task)
- `## Remaining` → validate consistency against `_NEXT.md` `next_3_steps` (v5: no longer reads session-state.progress.remaining_steps)
- No session file → skip the L1 section

**2d. Drift Events display** (v5 state-arch-v2: read from .claude/telemetry/drift-events.jsonl):

Reverse-tail the last N lines from the end of `.claude/telemetry/drift-events.jsonl` (state-arch-v2 commit C: drift_events is now JSONL append-only, no longer in session-state.json). Or call the `cognitive-state.mjs:readDriftEvents(lookbackDays)` API.
Rules:
- JSONL missing or empty → don't display
- Non-empty → show the most recent 3 (by ts desc), format per the Step 3 briefing template `### ⚠️ Prior Drifts`
- **Do not automatically** treat drift_events as a framing premise for the current session. Only **show them to the owner**, and let the owner decide whether to raise `/ceo` to re-review the direction or proactively avoid them

Note: drift_events is **content** knowledge (topic + anchor), not a **state label** (L<N> count). The hook layer no longer injects any cross-session cognitive state (see `session-cognitive-inject.mjs` v3 + core-rules-full §10.5.1).

### Step 2.5: Memory Layer Retrieval (top-K semantic recall injected into the briefing)

**Query construction** — produced **deterministically** by the `retrieve.ts` code layer (S1.1: the LLM no longer assembles the query string).

**Bash**:
```bash
# user /start <hint>: positional argument takes priority
npx tsx .claude/memory/scripts/retrieve.ts "<hint>" --k 3 --format briefing

# no hint: --from-state auto-constructs from the state files (internal priority below)
npx tsx .claude/memory/scripts/retrieve.ts --from-state --k 3 --format briefing
```

`--from-state` fixed priority (not adjustable):
1. `session-state.json` `active_task.feature`
2. any `_NEXT.wt-*.md` active_plan.feature (worktree mode)
3. `_NEXT.md` active_plan.feature
4. `_NEXT.md` next_3_steps[0] first 80 chars (IDLE fallback)
5. `session-state.json` progress.remaining_steps[0]

**Output spec**: stdout = markdown block (`### 💾 Relevant Memory` header) embedded directly into the briefing; stderr carries `[retrieve] query="..." (source: ...)` so Claude sees the source without polluting the render. All empty → stdout `_(no active task — skipping retrieval)_`, no error. 

**Failure semantics**: a non-zero exit does not block /start; inject `⚠️ Memory retrieve failed (exit N)` at the top of the briefing. Cost ~5KB × ~10 sessions/day ≈ $0.75/day.

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

### 💾 Session Memory (L1)
{shown only when Step 1.7 read a session file, otherwise omit the whole section}
- Last: {session_id} — {task first 50 chars}
- Decisions: {top 2-3 decisions, comma-separated}
- Dead Ends: {count} items{, ⚠️ related to the current task: "{dead_end_title}" — if any}

### ⚠️ Prior Drifts (2d tier B)
{shown only when session-state.json.cognitive.drift_events[] is non-empty, otherwise omit the whole section}
{show the most recent 3, each formatted as:}
- {session_id_short} — {topic}
  Rewind-Anchor: {rewind_anchor}
{trailing hint:}
_Nick decides whether to relate it to the current task — the hook does not auto-inject_

{Step 2.5 retrieve.ts --format briefing output embedded as-is (with the "### 💾 Relevant Memory (top-3)" header); omit the whole section when skipped}

### 🧠 Domain Knowledge ({domain})
{shown only when Step 2b matched a domain, otherwise omit the whole section}
- {N} invariants loaded (last updated: {freshness})
- {N} experiments recorded (champion: {latest_champion_id})
- {N} dead-ends flagged
- Active plan: {crystallized_plan_path or "none"}

### 💡 Suggestion
{best next skill + a one-sentence reason}
```

**Suggestion recommendation logic** (by priority):
1. uncommitted + CODE_REVIEW=PASS → `/commit`
2. modified files → `/verify --smart`
3. `_NEXT.md` contains `blocked_on` → prompt to read `.claude/knowledge/error-journal.json`
4. commits ahead of origin → remind to `git push`
5. IDLE + no hint → `AskUserQuestion` to ask for today's goal

### Step 4: Feature Hint search (only when the user provides a hint)

Glob + Grep for files in `docs/plan/` and `docs/prd/exec/` matching the hint.
If found, append to the briefing:
```
### 🔎 Matched Plan/PRD
- {filename}: {first heading}
```

### Step 5: Health status line (no extra IO, computed from Step 1 data)

Append one line at the end of the briefing, formatted:
```
{✅|⚠️} Spec: {CLAUDE_lines+MEMORY_lines} lines
```

Judgment:
- Spec > 300 lines → ⚠️, append `— needs slimming`
- Otherwise → ✅ healthy

### Step 6: Disambiguation hints

```
> Routing: Vibe(single file) | Lite(2-5 files) | Full(cross-layer/Plan Mode)
> skill: commit↔verify | verify --smart↔--full | design --spec↔--review
```

## Constraints

- Read-only — modifying files is forbidden
- **The 2 calls in Step 1 must be emitted in parallel in the same message** (no dependency, must not be serial)
- **Total output ≤ 30 lines (hard limit)** — count the lines before output, cut the longest section if over. DO NOT add sections outside the template (no extra "health metrics"/"test coverage"/"disambiguation" sections, etc.). The output contains only: Session Briefing title + Last/Phase + Active Plan + Next 3 steps + Git + Suggestion + Spec health line + the one disambiguation line. Each `###` section's content is limited to 1-3 lines; commits list only hash + scope, not the full message.
- Target completion < 5 seconds
- `_NEXT.md` missing or corrupted → **immediately** output the `⚠️ _NEXT.md missing` warning + suggest `/handoff` to rebuild or create it manually. DO NOT use Glob/Grep to try other paths to recover the file. Just output a shortened briefing (Git + Suggestion sections only)
- error-journal no longer injected — only prompt to read it on demand when `_NEXT.md` contains `blocked_on`
- **VF-2.3 Recurrence Check**: when reading error-journal on demand, additionally scan `status: crystallized` entries. If this session's work area (inferred from `active_plan.feature`) touches the module of some crystallized entry, hint in the suggestion: `⚠ crystallized pattern [{title}] — confirm the corresponding rule still holds`. Do not proactively read the journal, only check incidentally when a read has already been triggered
