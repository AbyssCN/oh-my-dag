---
name: dag-deepen
tier: core
runtime: on-demand
trigger: mention
description: "Architecture-deepening scan as a DAG: deterministic git-hotspot discovery picks the highest-friction modules, one agent leaf per hotspot concurrently hunts shallow modules (deletion test, deep-interface sketches), a synthesis leaf dedups cross-hotspot repetition and ranks by leverage, HTML report of candidates. Trigger: improve architecture / 找重构机会 / deepen modules / architecture report / dag-deepen. Skip: what to delete (/dag-slim) / diff review (/dag-review) / design vocabulary only (/codebase-design)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "deterministic hotspot discovery + per-hotspot agent fanout (prebuilt plan, zero conductor LLM) + cross-hotspot synthesis + leverage ranking"
disable-model-invocation: true
---
# /dag-deepen — architecture-deepening candidate scan

Engine-shaped port of Matt Pocock's improve-codebase-architecture: instead of one agent
wandering the repo, a **deterministic hotspot pass** (git touch frequency over recent
commits, zero LLM) picks the modules where friction actually lives, then a **fleet of
agent leaves scans them concurrently** — each hunting shallow modules with the deletion
test — and a synthesis leaf merges cross-hotspot duplication (the same logic hand-rolled
in N places = one shared-util candidate, the global win a single scan can't see) and
ranks by leverage. Output: an HTML report of before/after interface sketches.

## Usage

```bash
bun run scripts/dag-deepen.ts [<scope-path>] \
  [--commits N]    # commits scanned for hotspot discovery (default 200)
  [--hotspots K]   # top-K hotspot modules to scan (default 6)
  [--model M]      # leaf model (default OMD_LEAF_MODEL → deepseek:deepseek-v4-flash)
  [--out path]     # report path (default $TMPDIR/omd-deepen-<ts>.html)
```

Name a direction to skip repo-wide ranking: `bun run scripts/dag-deepen.ts "src/harness/plan"`.
Report lands in `$TMPDIR/omd-deepen-<ts>.html` (Tailwind + Mermaid cards, one per candidate:
files / friction / deletion-test verdict / before-after / strength).

## Discipline

- **Hotspot-first is YAGNI for architecture**: only recently-touched modules get scanned —
  friction you aren't paying is friction you don't refactor. Widen with `--commits`, don't
  tour the whole repo.
- **Candidates are inputs to `/grill`, not conclusions**: every run ends by telling you to
  grill the chosen candidate before touching code. dag-deepen never edits files, never
  opens a PR.
- **Vocabulary lives in `/codebase-design`** (shallow module / deletion test / deep
  interface / leverage / locality): the scan prompts inject that single source — read it
  there, don't re-derive it here.
