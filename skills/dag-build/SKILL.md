---
name: dag-build
tier: core
runtime: on-demand
trigger: mention
description: "Decomposable coding task as a DAG: conductor plans, agent leaves build files concurrently, a deterministic oracle command gates, a heal fixpoint retries with failure context, halt-judge stops unproductive loops, checkpoints make runs resumable. Trigger: build this module across N files / 实装这个可分解任务 / parallel implementation with a test gate / dag-build. Skip: small single-file change (edit directly — dispatch overhead loses) / root-cause unknown (investigate first) / frontend visual work (needs a human eye)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "conductor decompose + agent-leaf fanout + oracle gate + heal fixpoint + halt-judge + checkpoint resume"
---
# /dag-build — parallel build with a hard oracle

For coding tasks that decompose into independently-buildable pieces **and** have a
deterministic pass/fail command. The conductor plans the DAG, agent leaves edit files
concurrently, the oracle command gates the result; on red, a heal round re-plans with
the failure output injected; a halt-judge kills unproductive loops; node checkpoints
make interrupted runs resumable.

## Usage

```bash
bun run dag-build "<build goal>" \
  [--cwd <target repo>]              # where the build happens
  [--oracle-cmd "bun run typecheck"] # deterministic gate; exit 0 = pass
  [--context "<contract>"|--context-file p]  # spec/contract fed to the conductor
  [--test | --test-glob "<files>"]   # run tests as part of the oracle
  [--conductor-model M] [--agent-model M] [--leaf-model M]
  [--agent-thinking off|low|medium|high|xhigh] [--leaf-ponytail]
  [--max-fanout 8] [--heal N]        # heal rounds on red oracle (default 1)
  [--review|--no-review] [--review-gate G2|G3]  # embedded dag-review before finish
  [--resume <runId>]                 # resume from checkpoints
  [--allow-dirty] [--no-judge] [--judge-cap N]
```

Exit code = oracle ∧ judge — safe to chain in CI.

## Discipline

- **No oracle, no dag-build.** If you can't state a deterministic pass command, the
  task isn't ready for parallel dispatch — tighten the contract first.
- Requires a clean git tree by default (`--allow-dirty` to override) so a failed run
  is trivially revertible.
- Small, already-loaded single-file edits are cheaper done directly — dispatch has
  fixed overhead; use this where width pays.
