---
name: dag-slim
tier: core
runtime: on-demand
trigger: mention
description: "Over-engineering-only review as a DAG: two passes, GLOBAL first (one strong reviewer hunts cross-file dedup/collapse/layer/couple — the -50% win), then LOCAL per-file hunks concurrently (delete/stdlib/native/yagni). One line per finding: what to cut, what replaces it. Trigger: what can we delete / over-engineered? / simplify review / 精简审查 / dag-slim. Skip: correctness/security bugs (/dag-review) / deepening candidates (/dag-deepen) / behavioral lazy mode (/ponytail)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "DietrichGebert/ponytail (MIT) ponytail-review, v2 全局>局部 discipline; vocab from design-vocab.ts"
disable-model-invocation: true
---
# /dag-slim — over-engineering-only diff review

Finds what to DELETE, never what to fix. Every reviewer prompt carries the shared
`DESIGN_VOCAB` + `PONYTAIL_DISCIPLINE` blocks (`src/harness/review/design-vocab.ts`,
single source — same vocabulary as /dag-deepen, opposite direction). The best
outcome is fewer *concepts*, not just fewer lines.

## Usage

```bash
bun run scripts/dag-slim.ts \
  [--base main]         # diff base (default main)
  [--staged]            # review staged changes instead
  [--paths "a,b"]       # limit diff to pathspecs
  [--model M]           # local-pass leaf model  (env OMD_SLIM_MODEL > OMD_LEAF_MODEL)
  [--global-model M]    # global-pass model, stronger slot (env OMD_SLIM_GLOBAL_MODEL > OMD_REVIEW_FIND_MODEL)
  [--no-global|--no-local]  # run only one pass
  [--verify]            # reuse the dag-review refute layer over the findings
  [--out p]             # artifact path (default /tmp/omd-slim-<ts>.md)
```

Exit 2 on empty diff. Terse stdout: one line per finding, Global group first.

## Two passes — GLOBAL runs FIRST

Per-hunk golfing finds pennies; the system-level pass finds the -50%. Pass 1 is
ONE reviewer on a stronger model slot seeing the whole changed surface + what it
touches. Pass 2 splits the diff per file into a pre-built ConductorPlan (one
inproc leaf per file-chunk + a dedup synth node) and fans out concurrently.

| pass | kind | hunts | replacement |
|------|------|-------|-------------|
| global | `dedup:` | same logic hand-rolled in N places | one shared util (biggest win) |
| global | `collapse:` | parallel implementations of one concept | merge to one |
| global | `layer:` | module/indirection/wrapper nobody needs | deletion-test it, drop the layer |
| global | `couple:` | local-"minimal" choice that created coupling/duplication | the globally-coherent alternative |
| local | `delete:` | dead code, unused flexibility, speculative feature | nothing |
| local | `stdlib:` | hand-rolled thing Bun/std ships | name the function |
| local | `native:` | dep or app code doing what the platform does | name the feature |
| local | `yagni:` | abstraction with one impl, config nobody sets, layer with one caller | inline it |

Format: `<kind>: <file:line> — cut <what>, replace with <what>` — one line per
finding, no prose. Nothing to cut → `Lean already. Ship.`

## Guardrails (from PONYTAIL_DISCIPLINE — violating these = false positive)

- A documented `DEFER`, a contract surface, a deliberate extension seam is
  **chosen architecture, not a finding** — planned ≠ speculative.
- Fewer lines, never fewer cases: a suggestion may not drop an edge case, type,
  validation, or error path — that is a bug, not a simplification.
- A single smoke test / assert self-check is the ponytail minimum, not bloat.
- `dedup:`/`collapse:` only merge things that are genuinely ONE concept — merging
  lookalikes manufactures coupling.
- Findings ≠ ground truth: the caller adjudicates (same discipline as /dag-review).

## The `ponytail:` marker + omd-debt

Deliberate shortcuts are marked in code as `// ponytail: <ceiling>, <upgrade trigger>`
(`#` and `/*` prefixes too). Those markers are NOT dag-slim findings — they are
tracked debt. Harvest the ledger with:

```bash
bun run scripts/omd-debt.ts [--paths "src,scripts"]   # pure scan, zero LLM; exit 3 = clean
```

One row per marker: `<file>:<line> — <what>. ceiling: <x>. upgrade: <y>`
(missing trigger → `-` = rot risk).

---
Family: `/ponytail` (behavioral lazy mode) · `omd-debt` (shortcut ledger).
Correctness/security → /dag-review; what to DEEPEN → /dag-deepen.
