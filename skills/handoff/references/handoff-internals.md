# Handoff Internals (read on demand — not loaded by default)

## Three-Layer Architecture (what handoff should do)

```
Cognitive layer (instant validation) — handoff doesn't do this; hooks already cover it (drift-class-check Stop hook / dangerous-cmd / stop-verify-check)
Learning layer (explicit extraction) — handoff only writes "what was already identified": an explicit `wisdom: <title>` flagged during the session → recorded manually
Memory layer (full consolidation)    — handoff's main job: Write the session log → background flush (the memory-capture hook already enqueued events earlier)
```

> **Infra reality**: `_NEXT.md` is a prose block (edit it directly). The only live helper is the memory flush script. Don't reference scripts that don't exist in this setup.

## Step 3.4 Claim-Evidence Gate (minimal ~10 lines, does not re-run tests)

> The drift-class hook only validates response tags, not claim content; docs/harness handoffs that skip a commit have no safety net.

Scan the session for the agent's completion-claim keywords (done / merged / deleted / fixed / passed / added), extract `{subject, action}` pairs, and cross-check against Step 1 `git diff-stat` / `status`:

| Claim | Evidence | Rule |
|---|---|---|
| merge X→Y | git diff X deletions + Y additions | X -N + Y +N |
| delete X | status `D` / log `--diff-filter=D` | confirm deletion |
| fix bug X | test file diff (cite the verify run, **don't re-run**) | ≥1 test file diff |
| N/M passed | cite the latest verify or commit stdout | numbers match |
| add X feature | grep the symbol | symbol is grep-able |

No match → report `⚠ CLAIM-UNVERIFIED: {claim}` in Step 5. No claim keywords → skip.

## Wisdom Trigger Protocol

Don't make the model "decide whether to write" at handoff time. The moment something is identified during the session, flag a line `wisdom: <title>`; handoff Step 2c only scans for the keyword → extracts type/title/body.
- ✅ Flag: pattern/decision/lesson at an abstract level + high cross-session reuse value
- ❌ Don't flag: one-off / too specific / already covered by memory recall
- **Landing it**: on a hit, manually edit the knowledge journal (append a `{id, type, title, body, keywords}` record) or note it under a `## Wisdom` section in the session log for the next session. The frequency is low enough that it isn't worth building a script for.

## `_NEXT.md` top block (Step 3a, direct edit, not a script)

A prose `##` block. Prepend the new block above the first `## `. The current state lives in the topmost block; older blocks are kept FIFO (history audit). When the file grows too long, move the oldest block to a journal file by hand. Failure just surfaces as an edit error (no partial state, no abort-on-fail trap).

## Debugging

| Symptom | Check |
|---|---|
| pending log doesn't grow | Is the memory-capture hook registered in settings.json? |
| flush says "pending empty" | hook didn't fire, or every file was EXCLUDE-listed (normal, no-op) |
| `_NEXT.md` edit old_string not unique | Pick a longer unique anchor for the top-block marker (include date + title) |
| session log written but not recalled | Is the frontmatter `keywords` array filled (BM25 boost anchors)? |

## Ship History

- Aligned to the real infra: prose `_NEXT.md` edited directly; the only live script is the memory flush helper.
- progressive disclosure (body trimmed, template/internals moved to references/) + reference-not-duplicate emphasis / Suggested Skills section / redaction / arg = next-focus. Lowers token cost.
- Codex finding integration + capture enabled + elastic log template.
- Cognitive fields cut, hook takes over drift handling.
- Critical Index Deletion Guard.
- Claim vs Evidence gate.
- Wisdom + dual-track writes.
