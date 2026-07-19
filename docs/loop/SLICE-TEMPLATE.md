# SLICE-TEMPLATE — the atomic construction contract

A **slice** is the smallest unit of work that gets built and reviewed as a whole. Every slice — no
matter its origin — satisfies the same contract below.

A slice arrives from one of two sources:
- the **decomposition of a spec** (small/crisp path: `/sdd` breaks a spec into slices), or
- a **cleared pathfinder region** (big/fuzzy path: a region whose every ticket is ruled compiles,
  with zero LLM, into a slice).

Either way the shape is identical, so the executor downstream is source-agnostic.

---

## The contract

```markdown
# Slice: <short imperative name>

## Goal
<One sentence. What is true after this slice that was not true before.>

## Contracts (GWT)
<The behavioral contract as Given/When/Then invariants. These are what acceptance is judged against —
not prose, not vibes. Types + validation + state-machine transitions belong here.>
- GWT-1: Given <precondition>, When <action>, Then <observable outcome>.
- GWT-2: ...

## Seams
<The test seams. Where the pure, deterministic surface is that red-first tests bite into. Name the
functions/schemas under test and what fakes stand in for I/O, agents, UI.>

## Oracle-cmd
<The exact command that must go green. This is the objective truth the Fleet self-heals toward.>
```bash
<e.g. a typecheck + test invocation>
```

## Allowed files
<Explicit whitelist. The diff may touch these and only these.>
- path/to/file.ts
- path/to/file.test.ts

## Forbidden files
<Explicit blacklist of load-bearing contracts / frozen mechanics that must NOT move, even if tempting.>
- path/to/frozen-schema.ts
- path/to/frozen-downstream/**

## Review Gate
<G0 | G1 | G2 | G3 — sized to blast radius; see GATES.md. G3 requires the Spec axis + Owner sign-off.>

## D-numbers
<The decision records this slice traces to. Provenance back to the spec's ADR deltas or the
pathfinder map's rulings, so the slice can be audited against intent.>
- D-n: <one-line gist>

## `?` escalations
<Anything this slice could NOT rule on. Marked `?` with a leaning + reason, routed to the Owner.
An empty section means the slice is fully ruled and safe to build. A non-empty one is a signal the
region was not actually clear — go back to the map / spec, do not invent the contract.>
```

---

## Rules of the form

- **Assemble, never invent.** If a slice cannot fill a contract field from its source (spec or ruled
  tickets), that is a `?` escalation, not a guess. A slice with open `?`s is not ready to build.
- **The oracle is the arbiter.** Fleet loops against `Oracle-cmd` until green; acceptance judges
  against `Contracts (GWT)`. Prose is never the pass/fail criterion.
- **Whitelist beats blacklist**, but declare both. Allowed files constrain the diff; Forbidden files
  name the frozen seams that scope-creep would otherwise erode.
- **The gate is chosen by blast radius, not line count.** A one-line schema/auth/irreversible change
  is G3.
