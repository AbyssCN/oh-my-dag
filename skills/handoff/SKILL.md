---
name: handoff
tier: foundation
runtime: on-demand
trigger: mention
argument-hint: "(optional) 下个 session 的 focus — 据此裁剪 next_3_steps + Suggested Skills"
description: "Session wrap-up ritual: update _NEXT.md active plan + write session log + memory capture. Skipping = the next session loses context. Trigger: end / wrap up / handoff / hand over / save progress / call it for today / session end / 结束 / 收工 / 交接 / 保存进度 / 今天到这 / session结束. Skip: commit code (/commit) / start a new session (/start)."
metadata:
  source: claude-skills
  version: "8.0.0"
---
# /handoff — Session Wrap-Up v8 (xihe-real)

> Single Fast Path, target ≤ 4 tool calls. Body trimmed; templates/internals in `references/`, read on demand.
>
> **v8 (2026-06-01)**: aligned to xihe's real infra — removed the 6 non-existent scripts left over from the a sibling project port
> (`handoff-write-router`/`force-capture`/`gen-sessions-manifest`/`codex-scan`/`append-journal`/`graphify`)
> + the abort-on-fail landmine. `_NEXT.md` is a prose block (not a router_v6 yaml fence) → Edit the top block directly.
> The only surviving script = `.claude/memory/scripts/flush.ts`. See §Ship History.

## Trigger / Input

`/handoff` or `/handoff <focus>`. `<focus>` = the next session's focus → trim next_3_steps + Suggested Skills accordingly. No arg → auto-generate from session activity.

## Three threading principles (mattpocock-merge — directly lowers tokens)

1. **Reference, don't duplicate** — session log / `_NEXT.md` references the **path/URL** of an existing artifact (commit sha / plan path / ADR / diff / previous session log), never inlines its content. Write **why**, git diff already has the **what**.
2. **Redact** — in the session log, mask secrets / API key / token / HMAC / PII (xihe touches WeCom/Lark/MiMo keys). On a hit write `<redacted:kind>`.
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
\+ Read the top block of `_NEXT.md` (under a worktree read `_NEXT.wt-<slug>.md`). `_NEXT.md` = prose `##` blocks separated by `---`, **no yaml router fence** — the current state is the topmost block.

### Step 2: Analyze (pure reasoning, 0 IO)

- **2a Summary**: feature / last_session_summary (1-2 sentences) / blocked_on / next_3_steps (verb+object; if there is a `<focus>`, align to it)
- **2b Gap**: _NEXT's original next_3_steps vs actual → DONE / PARTIAL / SKIPPED / UNPLANNED
- **2c Wisdom candidates**: only scan for explicit `wisdom: <title>` markers in the session (record only on a hit, default 0; protocol in references)
- **2d Slug**: feature → lowercase-hyphenated

### Step 3: Write (2 calls — _NEXT first, log second)

**3a `_NEXT.md` current-state block (Edit, succeed first)** — prepend a new block at the top of the file (above the first `## ` block):
```markdown
## {emoji} {date} session ({phase}) — {title} (下次从这读)

> {1-2 句当前态 + commit range}。

**ship 了**: {要点, 引用 commit/path 不复制 diff}
**验收**: tsc {0} / {N} pass / {0} fail / build {绿}
> **下次起手 = {next}**: {依赖序引用 plan §}

---
```
Keep the old blocks below (FIFO, do not delete history; when too long, manually move the oldest block to `docs/session/_JOURNAL.md`). Apply principles 1+2.

**3b Session Log (Write)** — `.claude/sessions/{date}-{slug}.md`. Template (4 required + 6 optional) in `references/session-log-template.md`. Reference-don't-duplicate + redact.

### Step 3.4 Claim-Evidence Gate (pure reasoning, no test re-run, no script)

Scan completion-claim keywords (完成/合并/删除/修复/通过 · done/merged/deleted/fixed/passed) against Step 1's git diff-stat. No match → mark `⚠ CLAIM-UNVERIFIED: {claim}` in Step 5. No keywords → skip. Rules table in references.

### Step 4: Memory flush (1 message, background)

```bash
cd "$(git rev-parse --show-toplevel)" && ( npx tsx .claude/memory/scripts/flush.ts > /dev/null 2>&1 & disown )
```
Empty pending = no-op (~50ms). Never blocks handoff. (a sibling project's force-capture/manifest/graphify do not exist in xihe → not called.)

### Step 5: Report (≤ 15 lines)

```
## Session Handoff — {date}
### {last_session_summary}
### Gap   | # | 目标 | ✅/🔸/⏭️ | 备注 |
### Next  1. … 2. … 3. …
### Suggested Skills   (依 <focus> + gate)
- 下个 session 先: {/start, 然后 X}
### Wisdom (如有) — [{type}] {title}  (xihe 无 append-journal → 手动 Edit error-journal.json 或交下个 session)
### Claim-Evidence (仅 ⚠ unverified)
### {clean / 建议 /commit / /verify / /review}
```
**Gate**: ≥3 src files changed → suggest `/review --sweep`; ≥5 files + cross-layer/migration → `/review --release-gate`.

---

## Constraints

- Tool calls ≤ 4 (gather 1 + write 2 + flush 1); report ≤ 15 lines
- **Never auto-commit** — exception: when the owner explicitly says "push"/"commit" this turn, committing the session log (docs commit) and pushing is an owner instruction, not auto
- Wisdom is triggered only by an explicit `wisdom:` marker in the session; handoff does not decide on its own
- Worktree: only write `_NEXT.wt-<slug>.md`, never touch master `_NEXT.md`
- Memory flush never blocks (flush.ts handles empty pending / embed failure internally)
- **No abort-on-fail**: both the `_NEXT` Edit and the log Write are native tools, they error on failure and never leave partial state
- Applying the three principles (reference-not-duplicate / redact / suggested-skills) is the core of lowering tokens

---

## References (read on demand)

- `references/session-log-template.md` — read when writing the log in Step 3b (4 required + 6 optional + decision table)
- `references/handoff-internals.md` — claim-evidence rules table / wisdom protocol / debugging / ship history
