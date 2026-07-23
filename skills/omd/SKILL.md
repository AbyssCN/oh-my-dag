---
name: omd
description: "One table of every routed oh-my-dag skill: name → when to use. The one name to remember. Trigger: /omd / list skills / which skill / 有哪些技能 / 该用哪个技能."
metadata:
  source: oh-my-dag
  version: "1.0.0"
disable-model-invocation: true
---
# omd — routed-skill router

Most oh-my-dag skills are hidden from the prompt (`disable-model-invocation`)
to keep the Smart Zone lean. All still work — invoke with `/<name>`.
This table is the whole map.

| 组 | skill | when to use |
|---|---|---|
| 会话 | `/start` | new session: restore last context, print a briefing |
| 会话 | `/handoff` | wrap up: save plan + session log so context survives |
| 会话 | `/caveman` | ultra-compressed replies (~75% fewer tokens) |
| 规划 | `/council` | wide decision: N personas in parallel, judged winner |
| 规划 | `/ponytail` | laziest solution that works; anti over-engineering |
| 实现 | `/commit` | smart git commit: zone checks + conventional message |
| 实现 | `/dag-build` | coding task: plan → parallel build → oracle gate |
| 审查 | `/review` | audit: security / coverage / tech-debt / gate / PR |
| 审查 | `/dag-review` | adversarial multi-lens diff review + verify/refute |
| 研究 | `/dag-research` | web research: retrieve → fanout → judged synthesis |
| 研究 | `/omd-video` | video → per-segment notes (MiMo reads screen+audio); corpus for dag |
| 复利 | `/retro` | engineering retrospective from git history |
| 复利 | `/dream` | consolidate raw session events into durable memory |
| 复利 | `/skill-creator` | create / improve / eval skills |
| DAG | `/dag-council` | auto-authored expert council, judged winner |
| DAG | `/dag-fanout` | hand-written lens spec fanout (manual gearbox) |
| DAG | `/dag-deepen` | hotspot scan for shallow modules → refactor targets |
| DAG | `/dag-slim` | scan repo for over-engineering → deletion targets |

Not listed (resident, always in the prompt):
`verify` · `recall` · `investigate` · `codebase-design`.
