# Skills — the umbrella, and which one to reach for

[← README](../../README.md) · [workflow](workflow.md) · [MCP tools](mcp-tools.md) ·
[full catalogue](../../client-skills/README.md)

A skill is methodology text. The heavy lifting is an MCP tool; the skill is the discipline that
decides when to call it, what to check afterwards, and what not to do. omd ships **20** of them
under `client-skills/`, all prefixed `omd-` so they cannot collide with skills you already have.

This page is the mechanism plus a "which one" table. It is deliberately **not** a catalogue —
that is [`client-skills/README.md`](../../client-skills/README.md), which is gated against
drifting from the directory listing.

## How they get to you

Nothing to copy. Registering the omd MCP server is enough: the first time `omd mcp` starts, it
lays the packaged skills into your user-level skills directory as a startup side effect
(`src/harness/client-skills-install.ts`).

```bash
cd <your repo> && claude mcp add omd -- omd mcp
```

Four properties, each chosen against a specific failure:

| Property | Mechanism | Failure it prevents |
|---|---|---|
| Idempotent | runs on every start: missing → install; ours and the source changed → update; otherwise nothing | an install step you have to remember |
| Never overwrites your edits | a central manifest `.omd-skills.json` records the sha256 of each `SKILL.md` **we** wrote; if the target's hash differs from what we last wrote, it is yours (or a third party's) and gets skipped | your edited skill silently reverting on the next package upgrade |
| Best-effort | every failure is one line on stderr and nothing else | an install hiccup taking down the MCP server |
| Opt-out | `OMD_INSTALL_SKILLS=0` (also `false` / `no` / `off`) | no way to say no |

The destination respects `CLAUDE_CONFIG_DIR` and otherwise defaults to `~/.claude/skills`. On
Codex, which has no skills mechanism, paste the `SKILL.md` body into the target repo's
`AGENTS.md` or reference it as a prompt fragment.

## Three roots, first one wins

Discovery scans three roots in a fixed order (`defaultSkillRoots`, `src/harness/skills/skills.ts`):

| Order | Root | Holds |
|---|---|---|
| 1 | `<cwd>/.omd/skills` | project-level skills — same name as a packaged one, project wins |
| 2 | packaged `client-skills/` | omd's own 20 |
| 3 | `~/.claude/skills` | everything you installed yourself |

Deduplication is first-come, so root order *is* priority, and project-level being first is the
point: the reverse order would let a stale copy in your user directory silently shadow the
project's current one, with both looking identical from the outside.

Two details that were bought with real failures, not reasoned into existence:

- **A directory is a skill if it contains `SKILL.md`** — not if `isDirectory()` says so.
  `readdirSync(withFileTypes)` has lstat semantics, so a symlink reports `false`; on the machine
  where this was found, 77 of 119 installed skills were symlinks into other repos, and a whole
  family was being skipped without anything on screen saying so.
- **Grouping needs at least 3 members** (`GROUP_MIN`). Lowering it to 1 or 2 manufactures dozens
  of one-member "groups", which is a flat list written at greater length. Prefixes that collide
  with a reserved command name do not become groups either — a visible entry that cannot be
  clicked is worse than no entry.

## Zero prompt tax

Skill bodies are never in the system prompt. The model reaches them through one tool,
`read_skill` (`src/harness/skills/skill-tool.ts`), and everything about how that tool is
declared follows from one fact: **prompt caching matches the prefix byte for byte**, tools first,
then system, then messages.

- The tool's prompt snippet is **static** — one line, no counts, no roster. The first version
  embedded the group overview computed at startup (`lark(26) · omd(21) · …`), which meant that
  installing one new skill changed a byte near the front of the prefix and invalidated every
  cache breakpoint after it.
- The roster did not disappear; it moved into the tool's **return value**. Calling `read_skill`
  with a bare group name lists that group's members. Return values live in messages and are
  appended, so they cost nothing in cache terms.
- There is no `list_skills` tool. A list tool would spend a call fetching what the caller
  already has.
- With zero skills discoverable, the tool is **not mounted at all** — a tool that can only fail
  is worse than an absent one, and its absence keeps the tools array byte-identical to the
  no-skills baseline.

**Two paths, worded differently on purpose.** `/skill <name>`, typed by a human, injects the body
wrapped in "this is an extra discipline for this turn" — a constraint a person imposed.
`read_skill`, called by a model, returns the body alone: a model reading a skill is looking
something up, not issuing itself an order. Both resolve through the same loader, so the human and
the model can never end up reading two different versions of one skill.

## Leaf parity (open ecosystem, S3)

Since `f3a5f09`, `read_skill` is mounted on `agent-leaf` too (`src/harness/agent-leaf.ts`),
in the same assembly step as the external MCP tools. A worker leaf inside a graph can therefore
pull the same methodology text the conversational seat can — the umbrella is not a front-end
feature. Roots are injected explicitly and include the run's project root, so a leaf executing in
a repo sees that repo's `.omd/skills`.

There is a second, separate way a skill reaches the engine: `src/harness/skills/compile.ts`
turns an installed skill into an engine artifact. Classification is deterministic and zero-LLM —
a skill carrying a self-contained script that its own text invokes becomes a **command recipe**
under `.omd/recipes/`; a pure-methodology skill is distilled (the one LLM step) into an **agent
template card** under `.omd/agents/`, which the existing template loader picks up with no new
loading mechanism; a skill that depends on host tools or a logged-in browser is **skipped with
the reason printed**, because a leaf has neither and moving it in would only manufacture
hallucinations. Compilation is explicit opt-in, and each artifact records the source `SKILL.md`
hash so recompiling an unchanged skill is a no-op.

## Which one — by situation

| You are about to… | Reach for | Why that one |
|---|---|---|
| review a batch of diffs | `/omd-review` | multi-angle recall plus cross-model falsification; the `gate` step is chosen by blast radius, not line count. Findings are candidates — the false-positive procedure is part of the skill |
| ship something touching auth, injection surfaces, or fail-open catches | `/omd-sast` then `/omd-audit` | the deterministic semgrep pass is free and its hits are facts; the semantic trust-boundary audit is the expensive half. Cheap first is the money-saving order |
| argue a design and get nowhere | `/omd-council` | a wide solution space answered once lands in the bland centre of the distribution. Diverse personas pull generation into different expert regions, and multiple judging lenses cancel single-judge bias |
| drive one decision line to the bottom | `/omd-grill` | the orthogonal axis to council: serial, human in the loop, recommendation-first, and it stops only at questions that genuinely need the owner |
| freeze what was just decided | `/omd-contract` | writes an SDD addressed to an executor with no conversation context; undecided items go to Open instead of quietly becoming conclusions |
| jot one decision down mid-argument | `/omd-note` | context gets compacted; a decision nobody recorded did not happen. Reference by path, never inline the content |
| run a plan that is already settled | `/omd-execute` | SDD → DAG → the cross-validation checklist → one of four verdicts. `/omd-iterate` is its loop wrapper when the result was close |
| take on work too big to state yet, across sessions | the `/omd-path` family | `/omd-path` opens the map, `/omd-tickets` shows the frontier and folds in background results, `/omd-rule` records the owner's decision, `/omd-deliver` is the power gate that builds |
| find out why something that worked yesterday is broken | `/omd-debug` | eight phases with one iron rule — no root cause, no fix — and a three-strike stop. Fans hypotheses out to `dag_debug` when they want testing in parallel |
| pick up a graph that died halfway | `/omd-resume` | lists the resumable runs with their goals, asks which one, reloads the plan from disk and skips the nodes whose inputs still hash the same |
| suspect the codebase has grown fat, or too thin | `/omd-slim` · `/omd-deepen` | opposite directions and not interchangeable: slim only deletes over-engineering (and first collects the debt you left on purpose); deepen finds shallow modules worth thickening, ranked by git hotspot leverage |
| wonder whether this was decided before | `/omd-recall` | hybrid recall over omd's own memory, every hit carrying confidence and source. Low confidence is a lead, not a citation |

Two boundaries worth stating once, because they are the pair most often blurred: `/omd-execute`
takes a whole SDD and returns a verdict, while `/omd-deliver` builds the settled region of a map
and flips its tickets — [workflow.md](workflow.md) has the three-axis comparison. And `/omd-council`
goes wide across options while `/omd-grill` goes deep down one; they compose in both directions,
a council winner being the natural thing to grill next.

## Two notes on the roster

**`omd-investigate` is not shipped, and that is deliberate.** It is a near-verbatim, older copy of
`/omd-debug` — missing the parallel multi-hypothesis `dag_debug` section — and one methodology
gets one entry point. A leftover local copy on an old machine can be deleted.

**Only what is in `client-skills/` is real.** The repo directory and an installed
`~/.claude/skills` have drifted before, in both directions: listed but absent means users
install and get nothing; present but unlisted means it shipped and nobody knows. The catalogue in
`client-skills/README.md` is checked against `ls client-skills/` for exactly this reason, and the
count above is that listing, not memory.

## Where the code lives

| Concern | Path |
|---|---|
| skill text (the source of truth) | `client-skills/<name>/SKILL.md` |
| install-on-start, manifest, hash guard | `src/harness/client-skills-install.ts` |
| scan · roots · grouping · loading | `src/harness/skills/skills.ts` |
| the `read_skill` tool | `src/harness/skills/skill-tool.ts` |
| skill → agent card / command recipe compiler | `src/harness/skills/compile.ts` |
| mounted onto worker leaves | `src/harness/agent-leaf.ts` |
