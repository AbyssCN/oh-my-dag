# Session Log Template (elastic version)

> 4 required + 6 optional by judgment. The model picks which evidence anchors to keep based on the nature of the session.
> **Core principle**: don't duplicate an existing artifact (PRD/plan/ADR/commit/diff/_NEXT.md) — reference the path/URL, don't inline a copy. Write the **why**, not the **what** (git diff already has the what).

## 4 required sections (any session)

```yaml
---
date: YYYY-MM-DD
session_id: s-YYYY-MM-DD-<slug>
feature: <slug>
parent_plan: <docs/plan/... or null>
keywords: [<5-10 recall anchors — a frontmatter array is boosted directly in BM25>]
commits: [<sha1>, <sha2>, ...]
---

# Session: <feature>

## Why (required)
1-3 paragraphs: the why behind each decision + rejected alternatives + triggering evidence. Don't write what, write why (the semantic-recall lever).

## Dead Ends + Rewind (required; write "none" if none)
- {wrong path, one line}
  - Root cause: {the real problem}
  - rewind_target: {where to jump next time to land the answer directly}

## Wisdom (required; "none" if none)
- <id> [type] — <title>

## Open Threads (required)
- {semantic-layer supplement to next_3_steps, don't duplicate the current state in _NEXT.md}
```

## 6 optional sections (by judgment)

```markdown
## (optional) Evidence          — harness/standards/complex debugging: file:line / commit / key numbers from test stdout
## (optional) Files Produced    — major architectural change (≥10 files): list outputs + line counts
## (optional) Plan Status Table — phase × commit × status table for a multi-phase plan
## (optional) Test Outputs      — verification-heavy (RAG eval / E2E / benchmark): cite key numbers from stdout
## (optional) Drift Events      — when a real drift occurs, cite the rewind anchor + failure classification
## (optional) Agent Lessons     — abstract lessons from a reflection-heavy session (high cross-session reuse value)
```

## Decision rules

| Session nature | Optional sections to add | Expected total lines |
|---|---|---|
| ordinary feature dev | only the 4 required | 30-50 |
| harness / standards / cognitive-arch | + Evidence + Agent Lessons | 80-120 |
| multi-phase large refactor | + Plan Status + Files Produced | 100-150 |
| verification / RAG eval / benchmark | + Test Outputs | 60-100 |
| full-element sprint wrap-up | all 10 sections | 150-200 |
