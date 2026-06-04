---
name: recall
tier: capability
runtime: on-demand
trigger: mention
description: "Memory layer active recall: when reasoning/writing/decisions stall, Wright proactively queries the 8734-chunk store rather than relying on hook triggers. Fills the blind spots left by R1-R3 passive consumption. Trigger: /recall / recall / there should be precedent / 查历史 / 翻一下记忆 / 以前怎么做的. Skip: file grep (Grep) / call chains (/graph) / library docs (mcp__context7) / git history (git log)."
metadata:
  source: memory-layer-routing
  version: "1.0.0"
  routing: R10
---

# /recall — Memory Layer active recall

> Phase 1 Memory Layer Routing R10 — active consumption, filling the blind spots of hook passive triggers.

## When to use

When R10 fires (active, not hook-triggered):
- **Stuck while writing a plan/PRD** — wondering "how did we decide similar cases before"
- **Design choice** — "X or Y" and want to see the historical rationale
- **Cross-module reuse** — "which module solved a similar problem before"
- **Methodology query** — "what is our standard"
- **Historical lesson query** — "have we hit this pitfall before"

Not for:
- Literal in-file search → Grep
- Function call chains → /graph what-uses / refs
- Third-party library docs → mcp__context7
- Git commit history → git log

## Input

```
/recall <topic>
/recall <topic> --k 5            # default k=5, higher than the hook route's 3
/recall <topic> --kind decision  # filter sourceKind
/recall <topic> --path docs/plan # path filter (R13)
```

`<topic>` can be:
- A natural-language query: `RLS policy auth.uid cross-tenant isolation`
- Keywords: `Procountor report G3`
- Filename + keywords: `dashboard-overview.ts feature flag`

## Workflow

### Step 1 — Pick K and filter

K defaults to 5 (higher than the hook route's 3 — on active recall Wright wants a fuller view).

If `<topic>` involves:
- decision/proposal → add `--kind decision`
- standard/spec → add `--kind standards`
- failure/pitfall → add `--kind error,journal`
- file history → add `--path <prefix>`

### Step 2 — Call the retrieve.ts CLI

```bash
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing
```

With a `--kind` filter:
```bash
# retrieve.ts does not support sourceKind filter but supports path filter
# sourceKind=decision generally lives in docs/plan/ or docs/prd/
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing --path-filter "docs/(plan|prd)/"
```

With a `--path` filter:
```bash
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing --path-filter "<regex>"
```

### Step 3 — Present + self-assess

Output the retrieve briefing for the owner to see (top-5 sourcePath + breadcrumb + 100-char preview).

Then Wright **self-assesses relevance**:
- which one directly answers the topic
- which one is only tangentially related
- which one is irrelevant (R14 feedback: append `[Memory-Echo-Ack: applied|irrelevant|ignore]` in the response)

## Output format

```
### 💾 Relevant Memory (top-5)

1. **[decision]** PLAN-stage2-dashboard-overview-materials.md — Stage 2 dashboard overview RPC...
   `docs/plan/PLAN-stage2-dashboard-overview-materials.md` · 0d old

2. **[standards]** ACCOUNTING-ENGINEERING-STANDARD.md — accounting-grade business invariants + state machine...
   `docs/standards/ACCOUNTING-ENGINEERING-STANDARD.md` · 7d old

...

[Memory-Echo-Ack: applied|irrelevant|ignore]
(whether this recall was used, written at the end of the response, R14 feedback learning)
```

## R5 Domain-First self-check

The memory layer is a meta-layer, not a domain. `/recall` usage limits:
- ✅ Before/during plan/PRD writing: high value, prevents reinventing the wheel
- ✅ At decision moments: historical decision rationale
- ⚠️ Don't use it for exploratory idle browsing — an 8-second retrieve doesn't beat grep
- ❌ Don't use it as a /retro substitute — /retro reads git, not chunks

## Relationship to other R routes

| Route | Trigger | Query | K |
|---|---|---|---|
| R1 failure-recovery | command failure (hook) | tool + stderr | 3 |
| R2 patch-detector | Edit file (hook) | file path + context | 3 |
| R3 cognitive-trigger | frustration keywords (hook) | feature + recent calls | 3 |
| R8 pre-plan-write | writing a plan (hook) | filename + feature | 5 |
| R9 pre-prd-write | writing a PRD (hook) | filename + feature | 5 |
| R10 /recall | **active call** (this skill) | any topic | 5 |
| R11 pre-dispatch-gate | dispatch agent (hook) | subagent + feature | 3 |

R10 fills the **active consumption** blind spot beyond R1-R3 passive + R8/R9 pre-document-write + R11 agent dispatch.
