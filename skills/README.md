# oh-my-dag skills

The skill bundle of the **oh-my-dag** harness: **12 harness skills** (session
rituals, memory, verification, review workflows) + **5 DAG skills** (each the usage
guide for a `scripts/dag-*.ts` engine entry point). Drop into any Claude Code / pi
harness — `.claude/skills` compatible.

## Contents

- `skills/` — 17 skills (one dir each, with `SKILL.md` + optional scripts/evals)
- `substrate/schema.sql` — compounding-substrate schema (skills/genes/evolution_events + bridges)
- `umbrella.md` — prompt-level long-tail routing umbrella (re-discovery entry for DMI-hidden skills)
- `manifest.json` — machine-readable manifest

## Harness skills

| skill | purpose |
|---|---|
| `start` / `handoff` | Session bootstrap / wrap-up rituals — context survives across sessions |
| `commit` | Smart git commit: change analysis + zone checks + conventional message |
| `verify` | Unified verification gate (tsc/test/build by changed files, 5 modes) |
| `review` | On-demand audit: security / coverage / tech-debt / gate / PR review |
| `investigate` | Systematic root-cause debugging (8 phases; no fix without a root cause) |
| `council` | Multi-perspective generation + judge-and-select, incl. grounded tier |
| `recall` / `dream` | Memory: active recall / consolidation of raw events into durable facts |
| `retro` | Engineering retrospective from git history |
| `caveman` | Ultra-compressed communication mode (~75% fewer tokens) |
| `skill-creator` | Meta-skill: create / improve / eval skills |

## DAG skills

| skill | purpose |
|---|---|
| `dag-research` | Web research as a DAG: multi-lens retrieval fan-out → judged synthesis |
| `dag-council` | Auto-authored expert council: N personas → concurrent candidates → judge + graft |
| `dag-fanout` | Hand-written lens spec, straight to fan-out (manual gearbox) |
| `dag-review` | Adversarial multi-lens diff/PR review with verify/refute convergence |
| `dag-build` | Conductor plans → agent leaves build concurrently → oracle gates, resumable |
