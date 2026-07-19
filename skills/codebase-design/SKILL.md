---
name: codebase-design
tier: core
runtime: on-demand
trigger: mention
description: "Shared vocabulary for designing deep modules — module / interface / depth / seam / adapter / leverage / locality, the deletion test, deep-vs-shallow. Use when designing or improving a module's interface, deciding where a seam goes, making code testable or AI-navigable, or when another skill (dag-deepen / dag-slim) needs the design vocabulary. Trigger: design this module / where should the seam go / is this module too shallow / deep module / deletion test / codebase-design. Skip: finding what to refactor (/dag-deepen) / finding what to delete (/dag-slim) / reviewing a diff (/dag-review)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "Ousterhout deep modules + Feathers seams; single source shared with src/harness/review/design-vocab.ts"
---
# codebase-design — deep-module vocabulary

Design **deep modules**: a lot of behaviour behind a small interface, placed at a clean
seam, testable through that interface. Use this exact language wherever code is being
designed or restructured — consistent vocabulary is the whole point. The machine-readable
twin of this glossary lives in `src/harness/review/design-vocab.ts` (injected into
dag-deepen / dag-slim prompts); keep the two in sync.

## Glossary

Use these terms exactly — never substitute "component," "service," "API," or "boundary."

- **Module** — anything with an interface and an implementation; deliberately
  scale-agnostic (a function, class, package, or tier-spanning slice).
- **Interface** — everything a caller must know to use the module correctly: type
  signature plus invariants, ordering constraints, error modes, required configuration,
  performance characteristics.
- **Implementation** — the code body inside a module.
- **Depth** — leverage at the interface: behaviour exercised per unit of interface
  learned. **Deep** = small interface hiding lots of behaviour. **Shallow** = interface
  nearly as complex as the implementation (avoid).
- **Seam** *(Feathers)* — a place where you can alter behaviour without editing in that
  place; where an interface lives. Placement is its own design decision.
- **Adapter** — a concrete thing satisfying an interface at a seam; names the *role*.
  One adapter = hypothetical seam; two = real.
- **Leverage** — what callers get from depth: one implementation pays back across N call
  sites and M tests.
- **Locality** — what maintainers get from depth: change, bugs, knowledge and
  verification concentrate in one place. Fix once, fixed everywhere.

## Judgments

- **Deletion test** — imagine deleting the module and inlining its logic into callers:
  complexity explodes → it truly absorbs complexity (deep); barely changes → shallow, or
  outright noise to delete. (The same test prunes prose and skills, not just code.)
- **The interface is the test surface** — if you can't test through the interface, the
  design is wrong, not the test.
- **Wide over deep applies to DAGs, deep over shallow applies to modules** — don't
  confuse the two axes.
