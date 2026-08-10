# Workflow — the contract lane and the map lane

[← README](../../README.md) · [skills](skills.md) · [MCP tools](mcp-tools.md) ·
[deep research](deep-research.md) · [architecture](../architecture/overview.md)

![omd workflow](../../assets/diagrams/omd-workflow.svg)

There are two ways work reaches the engine, and they are not variants of each other.

- **The contract lane** runs **once**, front to back: research a question, grill the answer,
  freeze it as a written contract, execute the contract, check the result against it.
- **The map lane** runs **as a loop**: open a decision map, turn fog into tickets, settle
  tickets one at a time, and — only when the owner says so — compile the settled region and
  build it. Then back to the frontier.

The source of truth for every claim on this page is `client-skills/*/SKILL.md` (the skill text
the runtime actually loads) and the MCP tools in `src/mcp/tools/`.

## Which lane

| | Contract lane | Map lane |
|---|---|---|
| Shape | one pass, strictly forward | a loop over a frontier |
| Fits | a mid-to-large task you can already state in one document | work too big or too foggy to state at all yet |
| Lifetime | one session, usually | many sessions, many machines |
| Truth lives in | `docs/plan/YYYY-MM-DD-<slug>.md` | `docs/plan/pathfinder/<slug>.md` (or GitHub Issues) |
| Executes when | the owner says "execute" | the owner pulls `/omd-deliver` — nothing else |
| Graph comes from | a conductor drawing it at run time | a zero-LLM compiler reading tickets |

The lanes meet in one place: a grilled decision can land either as an SDD section or as a
ruling on a map ticket. Which one you pick is a question about lifetime, not about importance.

---

# The contract lane

| Link | Input | Output | Gate | Skill | MCP tool |
|---|---|---|---|---|---|
| research | an open question | a grounded report on disk | search provider present, or loud refusal | `/omd-council` · `/omd-research-deep` | `dag_research` |
| grill | a plan still at "roughly like this" | a decision record table | every row carries evidence, or it is not a row | `/omd-grill` | none — methodology only |
| contract | that table | an SDD under `docs/plan/` | undecided items go to **Open**, never to Contracts | `/omd-contract` | none — a file |
| execute | the SDD text | changed files + a run record | the acceptance checklist, run by the caller | `/omd-execute` | `run` → `dag_status` → `dag_result` |
| accept | the run result | one of four verdicts | the SDD's own GWT points, one at a time | `/omd-execute` | `dag_result` |

## 1 · research — a deterministic retrieval floor

`dag_research` (`src/mcp/tools/research.ts`) is the grounding link. Two settings matter and they
compose: `council: true` authors several personas over one corpus and picks a winner through a
judge panel; `super: true` + `rounds: N` adds seed authoring (the question split into 3–4
complementary angles) and between-round gap mining, where the gap probe is a **set difference**
over cited-versus-fetched sources — the engine counts, it does not ask the model whether it has
read enough.

One property is load-bearing: with no search provider configured
(`TAVILY_API_KEY` / `ANYSEARCH_API_KEY` / `SEARXNG_URL`), the tool **refuses loudly** rather than
degrading into a paragraph that looks like research. No web, no research.

The full pipeline — seats, cost shape, the report layout, the anchor and seed-query flags that
only exist on the script path — is [deep-research.md](deep-research.md).

## 2 · grill — adversarial interrogation before anything is frozen

`/omd-grill` is the only link in either lane with no MCP tool behind it: it is discipline text,
and it changes no files. Its shape is a decision tree walked root-first, and its central rule is
a three-way split of what a question even is:

| Class | Example | Handling |
|---|---|---|
| Facts | "does this endpoint already exist" | self-check in parallel, mark `[已查证]`, do not ask |
| Self-ruled decision | architecture shape, seam placement, build order | decide, declare inline with the evidence, keep moving |
| Owner decision | business direction, domain red lines, risk appetite, two options that are technically tied | stop, ask **one** question, wait |

Only the third class blocks, and only one at a time — a queue of questions costs the owner more
than it saves. A wide fork (several defensible designs, and no evidence that separates them)
does not get averaged: it fires `/omd-council` on the spot, and the council's winner comes back
as "my recommendation" for the interrogation to keep attacking.

The output is a table, not prose:

| # | Decision | Ruling | Lands in (`/omd-note` · map ticket · SDD section) | Evidence |

## 3 · contract — crystallising into an SDD

`/omd-contract` writes `docs/plan/YYYY-MM-DD-<slug>.md`, addressed to an executor with **no
conversation context**. Six sections, each independently consumable:

| Section | Holds |
|---|---|
| 目标 Destination | one sentence: what "built" looks like |
| 决策 Decisions | D-1..D-N, each with one reason and its evidence |
| 契约 Contracts | invariants + GWT acceptance points — the pass/fail list `/omd-execute` reads |
| 分解 Breakdown | dependency edges with reasons, a slice table (`slice · write set · deps · verify`), and a parallel wave line |
| 非目标 Non-goals | what is deliberately not being built |
| 未决 Open | unruled questions, ticket ids, anything marked "pending measurement" |

Two rules do the actual work. **A decision with no evidence is demoted to Open** rather than
written into Contracts. And in the Breakdown, **only real dependency edges are allowed**, each
annotated with the artifact the downstream slice consumes — an edge whose consumed artifact
cannot be named is a sequencing preference, and it gets deleted. Write sets that are pairwise
disjoint are the machine-checkable form of "these can run in parallel".

## 4 · execute — the SDD becomes a graph

`/omd-execute` hands the SDD text to `run` (the layer name for what is still registered as
`dag_run`; see `src/mcp/tool-renames.ts`). The conductor decomposes it into a typed DAG at run
time — `agent` leaves that change files, `command` leaves that run verification — and fans out.
The call is a three-step, deliberately not a blocking one: take the `runId`, poll `dag_status`,
then `dag_result`. Re-issuing instead of polling starts a second fleet.

## 5 · accept — the cross-validation checklist

Acceptance is an action the caller performs, not a status the run reports. Running the checklist
at least once is the executable form of the word "accepted":

| # | Check | What it catches |
|---|---|---|
| 1 | contract vs the real thing | an SDD that copied a reference implementation without wiring it |
| 2 | demo/test data vs existing gates | unique constraints, state-machine triggers, append-only tables, two-person gates |
| 3 | write shape vs read shape | both sides sharing one wrong shape and passing the oracle together |
| 4 | contract change in all three places | schema + endpoint list + acceptance test |
| 5 | idempotent replay | a re-run whose "created N" reappears is an idempotency claim that lies |
| 6 | "reuses existing X" verified element by element | a ✅ that was scanned, not checked |
| 7 | vertical verifiability | leaves sliced by technical layer cannot be verified alone; that plan gets redrawn |

Then one of four verdicts, chosen by cost:

| Verdict | Action |
|---|---|
| accept | checklist clean and every GWT point passes → report what was done and why |
| redraw | contract-level failure (wrong direction or decomposition) → re-`run` with `===== REDRAW FEEDBACK =====` appended |
| iterate | converging, failing at the finish → `/omd-iterate`, at most 3 rounds |
| fix directly | a small gap — cheaper by hand than by fleet |

---

# The map lane

A decision map is the other store: not what you learned, but **what you still have to decide**.
Tickets live on disk, the frontier is computed from their dependency edges, and rulings
accumulate across sessions until a region is settled enough to build.

| Link | Input | Output | Gate | Skill | MCP tool |
|---|---|---|---|---|---|
| open | a destination | a map + its first tickets | new maps are empty — splitting the destination is the first job | `/omd-path` | `map_init` · `map_open` · `map_add` |
| frontier | background results that landed | reflowed tickets + counts | pull replaces poll: each call reflows first | `/omd-tickets` | `map_tickets` |
| research (per ticket) | a `research` ticket | a result folded back, child tickets hatched | self-continuation capped by `OMD_PATH_RESEARCH_BUDGET` (default 12, counted across sessions) | `/omd-path` · `/omd-tickets` | `map_prefetch` |
| grill (per ticket) | a `grill` ticket | a ruling the owner states | rounds are logged on the ticket, so a dead session loses nothing | `/omd-grill` | — |
| rule | the owner's decision | a ruling in the truth file | `suggested` tickets are refused — they need `map_confirm` first | `/omd-rule` | `map_rule` · `map_confirm` |
| deliver | a settled region | changed files, tickets flipped | the power gate — see below | `/omd-deliver` | `map_deliver` |

## Opening a map, and the four ticket types

`/omd-path` with no argument lists open maps; with a destination it resumes or creates one.
A new map is empty, and the first job is turning the destination into tickets:

| Type | Means | Note |
|---|---|---|
| `research` | an open question needing retrieval | dispatched to detached background processes; it costs money, so keep the bar high |
| `grill` | a decision needing the owner | |
| `prototype` | a hypothesis needing a sandbox | |
| `task` | specific enough to build | carries `executorKind`; file-changing work uses `agent` |

`blockedBy` expresses dependency: a ticket enters the frontier only after its blockers are ruled.
And `task` tickets are sliced **vertically** — one end-to-end user-visible slice carrying its own
data, logic and surface — never by technical layer. A horizontal slicing ("tables first, then
backend, then frontend") is only testable at the very end, which is where its accumulated
mistakes all surface at once.

## Ruling — recording the decision, not making it

`map_rule` records what the owner decided. A `task` ticket's ruling text **becomes the goal of a
slice node later**, so it has to read as a standalone instruction to a weak executor. Before
writing one, three things get settled in the ruling rather than left to guesswork:

- **Three layers of "is there a real source"**, answered separately: read surface (missing → the
  ruling includes building it) · producer (missing → build the read surface anyway, and name the
  ticket that owns the producer) · data (missing → extend the seed, generated only by the real
  mechanism). Turning a ticket into a defer *because the producer is missing* is a silent scope cut.
- **Three legal ways to draw a grey state** when an upstream capability physically does not exist:
  absent key with "—" rendered · a disabled explanation card with a broken-link icon and **zero
  fake data** · a grey constant that simply is the truth until the pipeline exists.
- **What must not be self-ruled**: sign-off gates, reversal channels, state-machine transitions
  and posting, amount/rate formulas, contract field semantics, DB-level invariant migrations,
  deleting an existing gate. These get `?` and escalate. The discriminator is whether being wrong
  pollutes the books or bypasses an audit, versus merely looking bad.

A successful ruling also writes an `omd.pattern` fact into omd's own memory so `memory_recall`
can surface it later. That write is a bonus: if it fails it warns and moves on, because the
decision is already on disk.

Two constraints hold the lane's shape. **Machine suggestions cannot skip the human** — a
`suggested` ticket is refused by `map_rule` and pointed at `map_confirm`, because collapsing
"receiving a suggestion" into "deciding" would make the acceptance-rate readout meaningless.
And **"the region is clear" is reported, never acted on**.

## The deliver gate

`/omd-deliver` → `map_deliver` is the one place in either lane described as a *power gate*, and
the properties below are what the phrase means:

| Property | Statement |
|---|---|
| Trigger | only an explicit owner instruction. A "region is clear" report is not authorisation. |
| Never in the cloud | delivery is always pulled locally by the owner and is **never** fired by a GitHub Issue event. Cloud automation (canary, Actions) touches research dispatch only. Work that changes files does not run on CI — the `gh` backend included. |
| Compilation | zero LLM: ruled `task` tickets → DAG nodes, `blockedBy` → dependency edges (`src/harness/pathfinder/slice-compiler.ts`). It assembles, it does not invent. |
| Flip condition | tickets become `delivered` only when **every** node finishes. A failed node means no flip, a loud error, and a repairable retry. |
| Duration | minutes is expected — it is a real graph running real models. Do not abandon and re-issue. |

Then the part that the tool cannot do for you: **`delivered ✅` means the nodes finished, not
that the thing you wanted exists.** Before relaying, check each ticket against reality — the
endpoint or function the ticket claims exists, actually exists in code (not just in a contract
mirror); a ruling that said "reuse X" checked element by element inside X; a new read surface
carrying a test that asserts the **stored** shape, so a seed and a reader sharing one wrong shape
cannot pass the oracle together; and a replay whose counts go to zero or skip.

## The truth files

State lives on disk and the MCP server keeps no watcher, which is what makes any client able to
resume the map. Maps are markdown under `docs/plan/pathfinder/<slug>.md` with run state in
`.omd/pathfinder/`; the `gh` backend puts the same lifecycle into GitHub Issues (map = a `🧭 [map]`
issue, ticket = a sub-issue, ruling = a resolution comment plus close). Backend resolution is
`OMD_PATH_BACKEND` → `.omd/pathfinder/config.json` → `md`. Because nothing polls, `map_tickets`
and `map_rule` each do one reflow tick first — pull replaces the poll, and `map_rule` reflows
*before* showing you the ticket so you never adjudicate a stale view.

---

## execute vs deliver — three axes

Both end in changed files. They are not interchangeable.

| Axis | `/omd-execute` | `/omd-deliver` |
|---|---|---|
| Entry | one SDD (or task text) handed over whole | the settled region of a map — N ruled `task` tickets |
| Compilation | a conductor **draws** the graph from the text at run time; one LLM planning call | a compiler **translates** tickets into nodes; zero LLM, no planning call |
| Bookkeeping afterwards | the caller runs the cross-validation checklist and returns one of four verdicts; nothing in the repo changes state | tickets flip to `delivered` on full success only, and the frontier advances to the next layer |

The compilation axis is the one that decides which to reach for. A conductor can find a step the
document never mentioned; a compiler cannot, and in exchange it is reproducible, free, and
incapable of quietly renaming your work. Which is why rulings have to be written well: on the
deliver path, the ruling *is* the node goal, with nothing in between to fix it up.

## Where the code lives

| Concern | Path |
|---|---|
| skill text — the source of truth for every `/omd-*` step above | `client-skills/<name>/SKILL.md` |
| entry tools · layer renames | `src/mcp/tools/dag-tools.ts` · `src/mcp/tool-renames.ts` |
| research tool | `src/mcp/tools/research.ts` |
| map tools (8) | `src/mcp/tools/pathfinder.ts` |
| ticket → plan compiler (zero LLM) | `src/harness/pathfinder/slice-compiler.ts` |
| ticket states · frontier · background dispatch | `src/harness/pathfinder/{types,frontier,dispatch,afk-hook}.ts` |
| plan schema (the seam both lanes hand off to) | `src/harness/conductor-plan.ts` |
