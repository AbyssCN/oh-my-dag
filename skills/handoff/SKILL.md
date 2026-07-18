---
name: handoff
tier: foundation
runtime: on-demand
trigger: mention
argument-hint: "(optional) focus for the next session — used to trim next_3_steps + Suggested Skills"
description: "Session wrap-up ritual: update the active plan / next-state file + write a session log + capture memory. Skipping = the next session loses context. Trigger: end / wrap up / handoff / hand over / save progress / call it for today / session end / 结束 / 收工 / 交接 / 保存进度 / 今天到这 / session结束. Skip: commit code (/commit) / start a new session (/start)."
metadata:
  source: oh-my-dag
  version: "8.0.0"
---
# /handoff — Session Wrap-Up

> Single Fast Path, target ≤ 4 tool calls. Body trimmed; templates/internals in `references/`, read on demand.
>
> The next-state file (e.g. `_NEXT.md`) is a prose block, not a yaml fence → Edit the top block directly. Memory flush runs in the background and never blocks.

## Trigger / Input

`/handoff` or `/handoff <focus>`. `<focus>` = the next session's focus → trim next_3_steps + Suggested Skills accordingly. No arg → auto-generate from session activity.

## Three threading principles (directly lowers tokens)

1. **Reference, don't duplicate** — the session log / next-state file references the **path/URL** of an existing artifact (commit sha / plan path / ADR / diff / previous session log), never inlines its content. Write **why**; git diff already has the **what**.
2. **Redact** — in the session log, mask secrets / API key / token / HMAC / PII. On a hit write `<redacted:kind>`.
3. **Suggested Skills** — the report contains a section: which skills the next agent should invoke first (per `<focus>` + current gate).

---

## Fast Path (≤ 4 tool calls)

### Step 1: Gather (1 message)

```bash
cd "$(git rev-parse --show-toplevel)" && \
echo "=LOG=" && git log --oneline -5 && \
echo "=STATUS=" && git status --short --branch && \
echo "=DIFF_STAT=" && git diff --stat "$(git rev-parse origin/main 2>/dev/null || echo HEAD~1)"..HEAD
```
\+ Read the top block of the next-state file (e.g. `_NEXT.md`; under a worktree read the per-branch variant such as `_NEXT.wt-<slug>.md`). The next-state file = prose `##` blocks separated by `---`, **no yaml fence** — the current state is the topmost block.

### Step 2: Analyze (pure reasoning, 0 IO)

- **2a Summary**: feature / last_session_summary (1-2 sentences) / blocked_on / next_3_steps (verb+object; if there is a `<focus>`, align to it)
- **2b Gap**: the next-state file's original next_3_steps vs actual → DONE / PARTIAL / SKIPPED / UNPLANNED
- **2c Wisdom candidates**: only scan for explicit `wisdom: <title>` markers in the session (record only on a hit, default 0; protocol in references)
- **2d Slug**: feature → lowercase-hyphenated

### Step 3: Write (2 calls — next-state first, log second)

**3a Next-state current-state block (Edit, succeed first)** — prepend a new block at the top of the file (above the first `## ` block):
```markdown
## {emoji} {date} session ({phase}) — {title} (read here next time)

> {1-2 sentences of current state + commit range}.

**Shipped**: {key points, reference commit/path — do not copy the diff}
**Acceptance**: tsc {0} / {N} pass / {0} fail / build {green}
> **Next start = {next}**: {dependency-ordered plan § reference}

---
```
Keep the old blocks below (FIFO, do not delete history; when too long, manually move the oldest block to an archive/journal file). Apply principles 1+2.

**3b Session Log (Write)** — `.claude/sessions/{date}-{slug}.md`. Template (4 required + 6 optional) in `references/session-log-template.md`. Reference-don't-duplicate + redact.

### Step 3.4 Claim-Evidence Gate (pure reasoning, no test re-run, no script)

Scan completion-claim keywords (done/merged/deleted/fixed/passed · 完成/合并/删除/修复/通过) against Step 1's git diff-stat. No match → mark `⚠ CLAIM-UNVERIFIED: {claim}` in Step 5. No keywords → skip. Rules table in references.

### Step 4: Memory flush (1 message, background)

If your harness has a memory-capture step, run it detached so it never blocks the handoff:
```bash
cd "$(git rev-parse --show-toplevel)" && ( <your-memory-flush-command> > /dev/null 2>&1 & disown )
```
Empty pending = no-op. Never blocks handoff. If there is no memory step, skip Step 4.

### Step 5: Report (≤ 15 lines)

```
## Session Handoff — {date}
### {last_session_summary}
### Gap   | # | Goal | ✅/🔸/⏭️ | Note |
### Next  1. … 2. … 3. …
### Suggested Skills   (per <focus> + gate)
- Next session first: {/start, then X}
### Wisdom (if any) — [{type}] {title}
### Claim-Evidence (only ⚠ unverified)
### {clean / suggest /commit / /verify / /review}
```
**Gate**: ≥3 source files changed → suggest `/review`; ≥5 files + cross-layer/migration → suggest `/review --release-gate`.

---

## Constraints

- Tool calls ≤ 4 (gather 1 + write 2 + flush 1); report ≤ 15 lines
- **Never auto-commit** — exception: when the user explicitly says "push"/"commit" this turn, committing the session log (docs commit) and pushing is an owner instruction, not auto
- Wisdom is triggered only by an explicit `wisdom:` marker in the session; handoff does not decide on its own
- Worktree: only write the per-branch next-state file, never touch the master one
- Memory flush never blocks (it handles empty pending / embed failure internally)
- **No abort-on-fail**: both the next-state Edit and the log Write are native tools — they error on failure and never leave partial state
- Applying the three principles (reference-not-duplicate / redact / suggested-skills) is the core of lowering tokens

---

## References (read on demand)

- `references/session-log-template.md` — read when writing the log in Step 3b (4 required + 6 optional + decision table)
- `references/handoff-internals.md` — claim-evidence rules table / wisdom protocol / debugging / ship history
