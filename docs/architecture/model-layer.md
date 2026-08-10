# Model layer — how a model lands on a node

[← README](../README.md) · [architecture](architecture.md) · [primitives](primitives.md) ·
[model-config](model-config.md) · [diagram 04](diagrams/04-model-layer.md)

Two things are deliberately separate:

- a **template card** says *how* the work is done (method, checklist, output discipline);
- a **seat / pool** says *who* does it (which model coordinate).

They compose freely — the same card can run on any model, and one model can execute many
cards. This is the main structural difference from a subagent, where "who" and "how" are
welded into one definition.

## Resolution order

For a given node, the first hit wins:

1. `node.model` — an explicit coordinate. Usually written by the `stamp` pass at plan
   time; a hand-written plan or a patch can set it directly.
2. `template.model` — a card that pins its own model. **This is the subagent equivalent**:
   a card that pins a coordinate gets that coordinate in any graph (TPL-3 in
   `src/harness/agent-templates.ts`).
3. the **seat** coordinate for that executor — `resolveEngineModels` in `src/mcp/assemble.ts`
   resolves the `leaf` / `agent` / `conductor` seats through the seat chain below.

## The seat registry is code, not prose

`src/model/seats.ts` is the **single source of truth** for seats: 16 entries, one per seat,
each carrying everything anyone needs to know about it. `src/model/role-models.ts` keeps only
**derived views** (`ALL_SEATS`, `NODE_TIER`, `seatSpec`, `seatSampling` are re-exports;
`ModelRole = OmdSeat`) — there is no second table to keep in sync.

| Field | What it pins down |
|---|---|
| `id` · `tier` | the config key (`config.models[id]`, `OMD_<ID>_MODEL`) and the economics class |
| `what` · `frequency` | what this seat decides, and how often it is called — frequency *is* its economics |
| `where` | the consumption points, as `file:symbol`. Empty = nobody reads it = an empty knob |
| `crossFamily` | `required` (adversarial seats must not share the brain's family) / `preferred` / `no` |
| `thinking` · `sampling` | **intent**, not the wire value — the transport clamps both to what the model accepts |
| `recommend` · `preferredCoord` | the suggested tier **and why**; `preferredCoord` overrides auto-assign per seat |
| `advisor` | default advisor coordinate — deliberately empty for every seat (see below) |

Three gates keep the registry honest, and each one has been made to go red on purpose:

- `src/model/seats.test.ts` — registry shape and bounds.
- `src/model/seats-where.test.ts` — every `where` entry names a file that exists and a symbol
  that literally appears in it. It kills renames-without-updates, not semantic drift.
- `src/eval/seat-coordinate-gate.test.ts` — scans `src/**/*.ts` for **literal coordinates** on
  runtime paths. Anything not on the declaration-surface allowlist is red: a literal coordinate
  is a seat that silently cannot be reconfigured.

The human-readable rendering is generated, never written: `bun run scripts/omd-seats.ts`
(`--md` for a table, `--spec` for the registry without touching config or credentials).

## Seats

A **seat** is a *model-choice axis*, not a role. It answers "which model, how much effort, how
much spread for this class of work" — not "who is this character". Four different judging call
sites can share the `judge` seat because they want the same tier of model; conversely, judging
*"is it done"* and judging *"which is better"* want different things, so they are two seats
(`gate` / `judge`).

| Class | Seats | Job |
|---|---|---|
| `decomposer` | `conductor` · `escalation` | plan the graph; re-plan on failure |
| `judge_synth` | `gate` · `judge` · `reason` · `reduce` | the convergence gate, then pick winners / synthesize / fold |
| `worker` | `leaf` · `agent` · `lens` · `expand` · `distill` · `overflow` · `continuity` | the mass fan-out, plus session hand-off distillation |
| `verify` | `verifier` · `review-spec` · `review` | adversarial falsification; spec-vs-diff; the review find axis |

Two splits worth keeping in mind:

- **`gate` is not `judge`.** `gate` is the inner-loop convergence gate — one call per conductor
  node per round, the highest-frequency judging call in the repo, and it wants strict checking,
  not deliberation. `judge` scores candidates against each other. Different frequency,
  different economics, different sampling intent — hence different seats.
- **`verifier`, `review-spec` and `review` share a strength class only.** `verifier` is the
  in-graph skeptic gating a DAG run; `review-spec` reads a whole SDD and needs a long window;
  `review` is the find axis of `dag_review`.

`expand` and `overflow` are **pool members** more than roles: they are consumed through the
stamp pools. To change exploration models, change `config.pools.cheap` rather than those seats.

## Seat resolution chain

One chain, one authority (`resolveSeatModel` in `role-models.ts`), highest first:

```
explicit (caller argument)
  → in-memory override (CLI / test, non-durable)
    → .omd/config.json  models[seat]          ← the hand-config surface
      → env OMD_<SEAT>_MODEL, then historical aliases (OMD_ITER_* / OMD_CG_*)
        → .omd/config.json  autoAssigned[seat]  ← `omd models auto` proposal
          → the single configurable fallback: config.defaultModel / OMD_DEFAULT_MODEL / OMD_RUNTIME_*
            → SeatUnresolvedError (INV-MODEL-5 — loud failure at plan time)
```

Two properties of that chain that were bought with incidents:

- **No factory coordinate.** Nothing is baked in; an unconfigured seat fails loudly at plan
  time instead of quietly falling to somebody's provider and dying with a 402 mid-run.
- **The historical env aliases sit *below* `config.models`.** They used to sit above it, so the
  same seat resolved differently on two code paths and "I changed the config and it still uses
  the old model" was true.

**Every seat is configurable.** `TUNABLE_CONFIG_ROLES` (in `src/harness/init/headless-config.ts`)
is `ALL_SEAT_IDS` — derived from the registry, never hand-copied — so the write entry points
(`omd_set_role`, the TUI, hand-editing `.omd/config.json`) all accept any of the 16. The TUI is
the interactive surface for all of it (`/seat`, `/models`, `/login`, `/settings`); its layout and
the provider directory behind `/login` are documented in [tui](tui.md). Config file layout and
the provider-side half (`~/.pi/agent/models.json`, `auth.json`) are in
[model-config](model-config.md).

## Channels — an API key is not the only way to reach a model

A coordinate is `provider:modelId`, but providers are reached through structurally different
channels, and the difference is visible in the model layer:

| Channel | Reached by | Credential | Sampling knobs | Cost |
|---|---|---|---|---|
| API key / OAuth | the pi transport (`src/model/pi-transport.ts`) or the local provider registry | env key, `~/.pi/agent/auth.json`, or a registered provider | `temperature` / `topP` / `maxTokens` subject to `model-caps` | metered or flat, per the price table |
| Claude subscription | the Agent SDK (`src/model/claude-sdk-complete.ts` for completions, `src/harness/chat/claude-sdk-turn.ts` and the `agent-leaf` branch for tool loops) | the SDK's own: `CLAUDE_CODE_OAUTH_TOKEN` or `<CLAUDE_CONFIG_DIR>/.credentials.json` | **none** — the SDK exposes no sampling parameters, so they are dropped with a warning rather than silently | subscription quota; deliberately **unpriced** in the ledger |

`callModel` dispatches `claude-code:*` **before** the provider registry lookup — the subscription
channel is not in the pi directory, so a later branch would just be a resolution error. On that
channel `thinkingLevel` maps to the SDK's `effort` (`off` → `low`, the rest by name).

### The probe surface must know every channel (issue #6)

The credential check (`credentialed` in `src/model/role-fallback.ts`) originally knew exactly two
sources: the local provider registry and `piHasCredential`. Neither can see the SDK's credentials,
so `claude-code:*` was **always** judged un-credentialed → `usable()` false → every seat that goes
through the fallback chain silently downgraded to another provider, **in every process** — while
the direct completion path on the same coordinate worked fine. The two answers never met, so
nothing looked broken; the evidence was in the run ledger, where the leaves were all on the wrong
model.

The fix is one branch (`claudeSdkCredentialed`) that reads the SDK's own two credential sources.
The generalisable part is not the branch: **a "can I use this?" surface that does not enumerate
every transport reports confident, wrong answers, and its failure mode is a downgrade, which
looks like nothing at all.**

## Advisor — a seat property, not a seventeenth seat

A seat may consult a stronger model mid-execution. That is configured **per seat**, and dispatched
by the seat's own channel:

- a `claude-code` seat gets the official server-side advisor tool (the SDK's
  `settings.advisorModel`; the model pairing is validated by the CLI/API — an illegal pairing is
  not attached, and does not crash);
- a pi-channel seat gets the internal escalation tool (`src/harness/advisor-tool.ts`), which
  serializes the run transcript and calls the configured coordinate through `callModel`.

Both surface the *same tool name* to the leaf prompt, so moving a seat between channels does not
change its prompt.

Resolution (`resolveSeatAdvisor`): `OMD_<SEAT>_ADVISOR` → `config.advisors[seat]` → the registry
default. **The registry defaults are all empty on purpose** — the transcript is sent to that
provider, so an advisor is never chosen automatically. `persistSeatAdvisor(seat, null)` **deletes
the key** rather than writing an empty string: "explicitly cleared" and "never configured" must
not collapse into one fake coordinate.

## Tier pools

`stamp` picks from a pool, not from a seat. Pools are configured in `.omd/config.json` under
`pools`; absent, the tier pools are derived from seat coordinates (which makes `mid` and `cheap`
collapse into the same model — configure them).

| Pool | Selected by | Why more than one model |
|---|---|---|
| `strong` | `tier: "strong"` | judgement that gates the run; **≥2 families here is what makes sibling spread work** |
| `mid` | default floor | the fan-out majority |
| `cheap` | `tier: "cheap"` | mechanical enumeration |
| `multimodal` | `attach_media: true` | capability is a hard constraint — a text-only model cannot see the screenshot |
| `multimodalStrong` | `attach_media` **and** `tier: "strong"` (or a media ancestor) | the judge of a screenshot should get SOTA vision too; falls back to `multimodal` when unset |
| `judge` · `lens` | research fan-out | rotate the judge panel and the lens generators across families |
| `fallback*` (per class) | auto-assign overflow | where a class lands when its primary bucket is burnt through |

Two things about that surface:

- Pools **do not go through the seat chain**. `config.models`, `OMD_<SEAT>_MODEL` and the CLI
  flags cannot reach them — only `.omd/config.json`'s `pools` section and `OMD_POOL_*`. That is
  why the startup self-check has a *separate* pool check (`checkPools`): a fully green seat table
  can still sit on a pool whose every coordinate is out of credit.
- `OMD_POOL_*` **beats** the config file, the opposite direction from the seat env aliases. It is
  deliberate: the seat aliases are historical names that once shadowed the config, while
  `OMD_POOL_*` is a per-process override that would be pointless if the config file always won.

### Vision is verified, not assumed

Vendor multimodality claims are not a qualification. A model that *sees* the image but misreads
text in it is worse than one that cannot see at all: it produces confident, wrong findings about
labels and copy, and nothing in the pipeline contradicts it.

**The bar for entering the multimodal pool**: render a page containing a random short code and a
coloured shape, ask the coordinate to read both back, and admit it only if both are exact.
`scripts/omd-seat-image-probe.ts` is the executable version for the engine's own transport — it
generates a PNG with a known phrase, sends exactly one call, and reports one of four
**pre-declared** states (pass / fail / unavailable / undecidable). Run it before adding any
coordinate — the answer differs between siblings in the same family, and it changes as providers
ship.

## Stamp rules, in priority order

1. **Chain affinity** — exactly one real dep, this node is its only consumer, the upstream
   model is in this node's pool, same `cluster` → **inherit the upstream model**. Switching
   models means re-sending the whole context cold; on a single-consumer chain that is pure
   loss. `cluster` is the boundary where switching is allowed.
2. **Sibling family spread** — when one consumer has ≥2 unstamped deps in the same tier,
   rotate them across model **families** (`modelFamily` in `src/model/channels.ts` normalises
   provider aliases and aggregator channels, so `zhipu`/`glm` or `openai-codex`/`openai` count as
   one family). Three lenses researching one question on three models from the same family
   produce three copies of the same blind spot; the fan-in "consensus" is then fake.
3. **Rotation** — everything else round-robins inside its tier to spread channel load.

`stamp` deliberately skips: nodes with an explicit `model`, nodes using a card that pins a
model, `command` / `map` nodes (no model call), and `primitive` nodes (the primitive layer
picks its own).

## Reasoning effort

Effort is delivered **with** the coordinate, not globally. Three knobs, three owners, never mixed:

| Layer | Where | Expresses |
|---|---|---|
| intent | `seats.ts` (`thinking` / `sampling`) | what this *role* wants |
| capability | `model-caps.ts` | what this *model* accepts (rejects `max`? rejects `temperature`?) |
| reconciliation | `pi-transport` | the value actually sent — intent clamped to capability |

So "different models have different knobs" is not handled in the registry: it says `xhigh`, and
the transport downgrades it wherever the model will not take it. Add a model → touch
`model-caps`; add a role → touch `seats.ts`; the two never entangle. Resolution order for the
intent itself, highest first: `node.thinking` → explicit run config → seat tier → the built-in
default.

**The clamp is not optional.** Providers accept different effort vocabularies, and sending one an
unsupported value is an HTTP error, not a graceful downgrade — a whole node dies for a parameter.
An unknown provider gets only the one level every reasoning API accepts.

Two disciplines around that table:

- **Add a row only after calling that provider's API for real.** Vendor docs and sibling models
  disagree often enough that copying either is how the 400s get in.
- **Lower a seat's effort only against a measurement.** "Cheaper models should think less" is an
  assumption, not a finding; on some models the levels do not separate at all, and then you have
  traded quality for nothing. The registry carries the measurements that produced its current
  values — read the comment before changing a number.

## Two ways to ask "is this seat usable?" — keep both

| | `checkSeats` / `omd_config_status` | `bun run scripts/omd-seat-probe.ts` |
|---|---|---|
| Test | has credentials **and** not in a circuit-breaker cooldown | sends **one real call** per coordinate |
| Cost | free, always available | a few dozen seconds and a few dozen tokens |
| Misses | quota exhausted · no balance · region-locked — all look green | nothing about the future; it is a point measurement |
| When | continuously, as a startup warning surface | **before changing a seat**, on the candidate coordinate |

The startup check warns; it does not block. The blocking gate is `assertSeatsUsable`, and it only
covers the seats this run actually needs — opt-in background seats should not stop a `dag_run`.

The probe exists because inferring availability from logs is how eleven working seats got bulk-
rewritten onto a region-locked channel, and the resulting 403s got written up as a provider-side
account limit — while the one coordinate that was actually broken had been introduced by the
rewrite itself. Nine coordinates took under 30 seconds to test for real. The probe must
must `bootstrapModelRuntime()` first: a probe that gives false negatives is worse than no probe,
because it makes people delete seats that work.

## Multi-perspective review

`dag_review` runs several dimensions in parallel. By default they all hit one model — which
means N dimensions share one family's blind spots. Route each dimension to a different
family instead:

```bash
OMD_REVIEW_DIM_MODELS=correctness=openai-codex:gpt-5.6-sol,security=kimi-coding:k3,boundary=opencode-go:glm-5.2
```

Unlisted dimensions fall back to the `review` seat; the spec dimension keeps its own
`OMD_REVIEW_SPEC_MODEL`; the verify layer keeps `OMD_REVIEW_VERIFY_MODEL`. Unreachable
coordinates fall forward to a registered provider rather than killing the review.

## What is deliberately not here

An ε-greedy **bandit router** exists in the tree and is **off**. Its reward signal is cost,
and on flat-subscription or prepaid channels cost is ≈0 for every arm — the arms are not
separable, so it would learn nothing while its exploration destroyed the prompt-cache hits
that chain affinity works to earn. It is also currently pre-empted by `stamp`, which fills
`node.model` before the router is ever consulted. See the header of
`src/harness/model-router.ts` before turning it on.
