# GATES — the review-gate ladder

Every slice passes exactly one review gate, sized to its blast radius. The gate is chosen by *what
the change can break*, not by how many lines it touches. Higher gate = more axes of scrutiny, capped
at one adversarial round each to prevent slop.

**Iron law: code can loop, rules cannot loop.** Implementation may iterate against an oracle without
a human. A gate is a rule — it runs once (plus at most one fix round at G3). If a *rule* keeps
getting skipped, that is a defect to engineer out, never a retry.

---

## The ladder

| Gate | Applies to | Review |
|------|-----------|--------|
| **G0** | Docs / mechanical (comment, config, pure rename, formatting) | **No review.** Merge on green oracle. |
| **G1** | Skeleton (new module scaffold, signatures, wiring) | `tsc` clean **+ scoped diff** (touched only the allowed files). |
| **G2** | Regular logic (ordinary business code, refactors with behavior tests) | G1 **+ multi-dimensional adversarial review** (Diff axis: correctness/contract/edge falsification). |
| **G3** | Sensitive: **schema · auth · security boundary · irreversible** | G2 **+ mandatory Spec axis** (diff checked against the governing spec) **+ Owner final review.** |

### G0 — docs / mechanical
No human or model review. The oracle (typecheck/tests) is the whole gate. Prose, config values, pure
renames, formatting.

### G1 — skeleton
The change lands structure, not behavior. Two checks: the typechecker is clean, and the diff is
**scoped** — it touched only the slice's Allowed files and nothing in Forbidden. No logic review yet
because there is no logic to falsify.

### G2 — regular logic
Ordinary business logic and behavior-preserving refactors. Adds a **multi-dimensional adversarial
review** on the Diff axis: a reviewer actively tries to falsify correctness, contract adherence, and
edge-case handling — not a happy-path skim. One round, hard cap.

### G3 — sensitive
Reserved for the blast-radius categories: **schema changes, authentication, security-boundary
rewrites, and anything irreversible.** Adds two things on top of G2:
- a **mandatory Spec axis** — the diff is read against the governing spec, clause by clause, not just
  against itself; and
- **Owner final review** — the human signs off before merge.

One adversarial round, plus at most one fix round.

---

## Where the deliberate/build boundary lives

There is **no `src` write-lock.** Deliberation (pathfinder, planning, prototyping) may read and write
source freely — the workspace is a workbench, not a locked cockpit.

The deliberate→build boundary is enforced **here, at the gate**, plus by worktree isolation:

1. **The slice must pass its gate.** Nothing reaches the repo's history until its slice clears the
   gate its blast radius demands. That is the real boundary — high-位, at merge, not at every keystroke.
2. **Prototype worktree isolation.** Spikes run in a throwaway git-branch worktree; experimental code
   never touches the main tree, and abandoning a spike is just deleting the worktree.

The only hard write-lock retained anywhere is **dangerous-command interception** (force-push,
hard-reset, DROP TABLE, deleting data, flipping a prod flag, committing secrets) — an irreversibility
guard, not a deliberate/build fence.
