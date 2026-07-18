---
name: recall
tier: capability
runtime: on-demand
trigger: mention
description: "Memory layer active recall: when reasoning/writing/decisions stall, the agent proactively queries the memory store instead of waiting for a hook to fire. Fills the blind spots left by passive (hook-triggered) consumption. Trigger: /recall / recall / there should be precedent / 查历史 / 翻一下记忆 / 以前怎么做的. Skip: file grep / call chains (/graph) / library docs (context7) / git history (git log)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
---

# /recall — Memory Layer active recall

> Active consumption of the memory layer, filling the blind spots of hook-triggered passive recall.

## When to use

When you proactively want past context (not a hook firing automatically):
- **Stuck while writing a plan/spec** — wondering "how did we decide similar cases before"
- **Design choice** — "X or Y" and want to see the historical rationale
- **Cross-module reuse** — "which module solved a similar problem before"
- **Methodology query** — "what is our standard here"
- **Historical lesson query** — "have we hit this pitfall before"

Not for:
- Literal in-file search → grep
- Function call chains → /graph what-uses / refs
- Third-party library docs → context7
- Git commit history → git log

## Input

```
/recall <topic>
/recall <topic> --k 5            # default k=5
/recall <topic> --kind decision  # filter by source kind
/recall <topic> --path docs/plan # path filter
```

`<topic>` can be:
- A natural-language query: `auth cross-tenant isolation`
- Keywords: `report pipeline release gate`
- Filename + keywords: `dashboard-overview.ts feature flag`

## Workflow

### Step 1 — Pick K and filter

K defaults to 5 (a fuller view on active recall).

If `<topic>` involves:
- decision/proposal → add `--kind decision`
- standard/spec → add `--kind standards`
- failure/pitfall → add `--kind error,journal`
- file history → add `--path <prefix>`

### Step 2 — Call the retrieve CLI

```bash
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing
```

With a path filter (decisions generally live under `docs/plan/` or `docs/spec/`):
```bash
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing --path-filter "docs/(plan|spec)/"
```

With an arbitrary path filter:
```bash
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing --path-filter "<regex>"
```

### Step 3 — Present + self-assess

Output the retrieve briefing (top-5 source path + breadcrumb + short preview).

Then self-assess relevance:
- which one directly answers the topic
- which one is only tangentially related
- which one is irrelevant

## Output format

```
### 💾 Relevant Memory (top-5)

1. **[decision]** PLAN-dashboard-overview.md — dashboard overview pipeline...
   `docs/plan/PLAN-dashboard-overview.md` · 0d old

2. **[standards]** ENGINEERING-STANDARD.md — engineering invariants + state machine...
   `docs/standards/ENGINEERING-STANDARD.md` · 7d old

...
```

## Domain-first self-check

The memory layer is a meta-layer, not a domain. `/recall` usage limits:
- ✅ Before/during plan/spec writing: high value, prevents reinventing the wheel
- ✅ At decision moments: historical decision rationale
- ⚠️ Don't use it for exploratory idle browsing — a slow retrieve doesn't beat grep
- ❌ Don't use it as a retrospective substitute — a retro reads git, not memory chunks
