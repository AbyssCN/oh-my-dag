# oh-my-dag skills

The skill bundle of the **oh-my-dag** harness, layered for the Smart Zone: an LLM is
sharp only in roughly its first ~120k context tokens, and every model-invoked skill
description permanently occupies that zone — so only a tiny **resident core** stays in
the prompt, and everything else is **routed** (hidden via `disable-model-invocation`,
reached by `/<name>` or the `/omd` router). Drop into any Claude Code / pi harness —
`.claude/skills` compatible.

## Contents

- `skills/` — 22 skills (one dir each, with `SKILL.md` + optional scripts/evals)
- `substrate/schema.sql` — compounding-substrate schema (skills/genes/evolution_events + bridges)
- `umbrella.md` — prompt-level routing umbrella for the DMI-hidden skills (points to `/omd`)
- `manifest.json` — machine-readable manifest

## Resident core (always in the prompt)

The only skills the model must be able to invoke spontaneously — kept ≤5.

| skill | purpose |
|---|---|
| `verify` | Unified verification gate — run before claiming anything is done |
| `recall` | Active memory recall when reasoning stalls |
| `investigate` | Systematic root-cause debugging (no fix without a root cause) |
| `codebase-design` | Deep-module design vocabulary shared by other skills |

## Routed (hidden from the prompt — invoke `/<name>`, discover via `/omd`)

| skill | purpose |
|---|---|
| `omd` | **The router**: one grouped table of every routed skill |
| `start` / `handoff` | Session bootstrap / wrap-up rituals — context survives across sessions |
| `caveman` | Ultra-compressed communication mode (~75% fewer tokens) |
| `council` | Multi-perspective generation + judge-and-select, incl. grounded tier |
| `ponytail` | Forces the laziest solution that works — anti over-engineering |
| `commit` | Smart git commit: change analysis + zone checks + conventional message |
| `review` | On-demand audit: security / coverage / tech-debt / gate / PR review |
| `retro` | Engineering retrospective from git history |
| `dream` | Memory consolidation of raw events into durable facts |
| `skill-creator` | Meta-skill: create / improve / eval skills |
| `dag-research` | Web research as a DAG: multi-lens retrieval fan-out → judged synthesis |
| `dag-council` | Auto-authored expert council: N personas → concurrent candidates → judge + graft |
| `dag-fanout` | Hand-written lens spec, straight to fan-out (manual gearbox) |
| `dag-review` | Adversarial multi-lens diff/PR review with verify/refute convergence |
| `dag-build` | Conductor plans → agent leaves build concurrently → oracle gates, resumable |
| `dag-deepen` | Whole-repo scan for shallow modules → deepening refactor targets |
| `dag-slim` | Whole-repo scan for over-engineering → deletion targets |
