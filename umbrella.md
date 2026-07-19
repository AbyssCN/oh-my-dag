# Hidden skills router (DMI umbrella)

以下技能为省 prompt token 已从自动列举中移除 (disable-model-invocation)。
它们依旧可用 —— 当任务匹配下方某条描述时, 用 `/<name>` 显式唤起。
总入口: `/omd` — 一张分组表列出全部 routed skill (要记的唯一名字)。

- `/caveman` — Ultra-compressed communication mode. Cuts token usage ~75% while keeping full technical accuracy.
- `/commit` — Smart git commit: analyze changes + zone checks (tsc/test/build) + conventional message. --ship: merge + tests + PR.
- `/council` — Multi-perspective parallel generation + judge-and-select for wide design/decision spaces, incl. grounded tier.
- `/dag-build` — Decomposable coding task as a DAG: conductor plans, leaves build concurrently, oracle gates, heal fixpoint, resumable.
- `/dag-council` — Auto-authored expert council as a DAG: conductor authors N personas, concurrent candidates, multi-lens judge + graft.
- `/dag-deepen` — Architecture-deepening scan as a DAG: git-hotspot discovery → per-hotspot shallow-module hunt → ranked targets.
- `/dag-fanout` — Hand-written lens-spec fanout: you author the lenses, the engine runs them concurrently and judges.
- `/dag-research` — Web research as a DAG: retrieve (multi-query search + tiered crawl) → multi-lens fanout → judged synthesis.
- `/dag-review` — Adversarial multi-dimension diff review as a DAG: lenses review concurrently, verify/refute layer converges findings.
- `/dag-slim` — Whole-repo scan for over-engineering / dead flexibility → deletion targets.
- `/dream` — Manually trigger Dream consolidation: distill raw events into durable memory facts, with safeguards.
- `/handoff` — Session wrap-up ritual: update the active plan + write a session log + capture memory. Skipping loses context.
- `/omd` — One table of every routed oh-my-dag skill: name → when to use. The one name to remember.
- `/ponytail` — Forces the laziest solution that actually works — simplest, shortest, most minimal. Anti over-engineering.
- `/retro` — Engineering retrospective from git history: commit patterns, type mix, focus score, test discipline, trends.
- `/review` — On-demand audit: security / coverage / tech-debt / full Gate / PR code review with specialist lenses.
- `/skill-creator` — Create new skills, modify and improve existing skills, and measure skill performance.
- `/start` — Session initialization ritual: restore previous context, output a Briefing with current task + next step.
