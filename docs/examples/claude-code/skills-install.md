# Installing oh-my-dag Skills into Claude Code

Claude Code reads `.claude/skills/` for skill definitions. oh-my-dag ships 22 skills in `skills/` — symlink or copy them straight in.

## Quick install (symlink)

```bash
# from repo root
mkdir -p .claude/skills
for skill in skills/*/; do
  name=$(basename "$skill")
  ln -sf "../../skills/$name" ".claude/skills/$name"
done
```

This gives Claude Code direct access to all 22 skills without duplicating files. Edits to `skills/` propagate instantly.

## Manual install (copy)

```bash
cp -r skills/* .claude/skills/
```

## Skill list (all 22)

| Tier | Skill | Purpose |
|------|-------|---------|
| ● resident | `verify` | Unified verification gate (tsc/test/build) |
| ● resident | `recall` | Active memory recall from chunk store |
| ● resident | `investigate` | 8-phase root-cause debugging |
| ● resident | `codebase-design` | Deep-module vocabulary |
| routed | `start` | Session bootstrap briefing |
| routed | `handoff` | Session close-out ritual |
| routed | `commit` | Analyzed conventional commits |
| routed | `retro` | Engineering retrospective |
| routed | `review` | On-demand audit |
| routed | `dream` | Memory consolidation |
| routed | `caveman` | Ultra-compressed output |
| routed | `ponytail` | YAGNI enforcement |
| routed | `council` | Multi-persona debate |
| routed | `skill-creator` | Create/improve skills |
| routed | `omd` | Skill index |
| routed | `dag-research` | Deep web research DAG |
| routed | `dag-review` | Adversarial diff review |
| routed | `dag-slim` | Deletion-only audit |
| routed | `dag-deepen` | Architecture scan |
| routed | `dag-build` | Coding task with oracle gate |
| routed | `dag-council` | Auto-authored council |
| routed | `dag-fanout` | Hand-written lens fan-out |

## Verify install

After linking, confirm Claude Code sees the skills:

```bash
ls -la .claude/skills/
# should show 22 symlinks pointing to ../../skills/<name>
```

Claude Code will load resident skills into context automatically; routed skills are invoked via `/<name>`.
