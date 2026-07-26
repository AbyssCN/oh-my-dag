# Model layer — how a model lands on a node

[← README](../README.md) · [architecture](architecture.md) · [primitives](primitives.md)

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
   `frontend-impl` pins `kimi-coding:k3`, so any node using that card gets k3 in any graph.
3. static fallback — `leafModel` / `agentLeafModel` from the run config.

## Seats

A **seat** is a role in the engine, not a node in your graph. `auto-assign` maps each
seat to a coordinate once (channel economics: prepaid sunk cost → flat-sub → metered) and
writes the result to `.omd/config.json`, where it is readable and hand-editable.

| Class | Seats | Job |
|---|---|---|
| `decomposer` | `conductor` · `escalation` | plan the graph; re-plan on failure |
| `judge_synth` | `judge` · `reason` · `reduce` | pick winners, synthesize, fold per-lens results |
| `worker` | `leaf` · `agent` · `lens` · `expand` · `distill` · `overflow` | the mass fan-out |
| `verify` | `verifier` · `review-spec` | adversarial falsification; spec-vs-diff comparison |
| `dream` | `dream` | memory consolidation |

`verifier` and `review-spec` are **different things** that happen to share a strength
class: `verifier` is the in-graph skeptic gating a DAG run, `review-spec` is the model for
the spec dimension of `dag_review`, which reads a whole SDD and needs a long window.

## Tier pools

`stamp` picks from a pool, not from a seat. Pools are configured explicitly in
`.omd/config.json` under `pools`; absent, they are derived from seat coordinates (which
makes `mid` and `cheap` collapse into the same model — configure them).

| Pool | Selected by | Why more than one model |
|---|---|---|
| `strong` | `tier: "strong"` | judgement that gates the run; **≥2 families here is what makes sibling spread work** |
| `mid` | default floor | the fan-out majority |
| `cheap` | `tier: "cheap"` | mechanical enumeration |
| `multimodal` | `attach_media: true` | capability is a hard constraint — a text-only model cannot see the screenshot |

### Vision is verified, not assumed

Vendor multimodality claims are not a qualification. A model that *sees* the image but misreads
text in it is worse than one that cannot see at all: it produces confident, wrong findings about
labels and copy, and nothing in the pipeline contradicts it.

**The bar for entering the multimodal pool**: render a page containing a random short code and a
coloured shape, ask the coordinate to read both back, and admit it only if both are exact. Run that
before adding any coordinate — the answer differs between siblings in the same family, and it
changes as providers ship.

## Stamp rules, in priority order

1. **Chain affinity** — exactly one real dep, this node is its only consumer, the upstream
   model is in this node's pool, same `cluster` → **inherit the upstream model**. Switching
   models means re-sending the whole context cold; on a single-consumer chain that is pure
   loss. `cluster` is the boundary where switching is allowed.
2. **Sibling family spread** — when one consumer has ≥2 unstamped deps in the same tier,
   rotate them across model **families**. Three lenses researching one question on three
   models from the same family produce three copies of the same blind spot; the fan-in
   "consensus" is then fake.
3. **Rotation** — everything else round-robins inside its tier to spread channel load.

`stamp` deliberately skips: nodes with an explicit `model`, nodes using a card that pins a
model, `command` / `map` nodes (no model call), and `primitive` nodes (the primitive layer
picks its own).

## Reasoning effort

Effort is delivered **with** the coordinate, not globally. Resolution order, highest first:
`node.thinking` → explicit run config → seat tier → the built-in default.

**The transport clamps effort per provider.** Providers accept different effort vocabularies, and
sending one an unsupported value is an HTTP error, not a graceful downgrade — a whole node dies for
a parameter. The clamp table is therefore keyed by provider, and an unknown provider gets only the
one level every reasoning API accepts.

Two disciplines around that table:

- **Add a row only after calling that provider's API for real.** Vendor docs and sibling models
  disagree often enough that copying either is how the 400s get in.
- **Lower a seat's effort only against a measurement.** "Cheaper models should think less" is an
  assumption, not a finding; on some models the levels do not separate at all, and then you have
  traded quality for nothing.

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
