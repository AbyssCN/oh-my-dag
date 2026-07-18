---
name: dag-review
tier: core
runtime: on-demand
trigger: mention
description: "Adversarial multi-dimension diff review as a DAG: correctness/security/boundary/contract lenses review the diff concurrently, then a verify/refute layer converges findings (kills plausible-but-wrong ones). Trigger: review this diff / PR review / 审查这组改动 / 提交前对抗审查 / find P0s before merge / dag-review. Skip: root-cause debugging of a known bug (investigate directly) / building code (/dag-build embeds its own gated review)."
metadata:
  source: oh-my-dag
  version: "1.0.0"
  methodology: "dimension fanout + adversarial verify/refute convergence + gate levels"
---
# /dag-review — adversarial diff review

Reviews a git diff through independent dimension lenses **concurrently**, then runs an
adversarial verify layer over the findings — each finding must survive an attempted
refutation before it reaches the report. Gate levels size the dimension set.

## Usage

```bash
bun run dag-review \
  [--gate G2|G3]      # G1=[contract,boundary] G2=[correctness,security,boundary] G3=G2+contract
  [--base main]       # diff base (default main)
  [--staged]          # review staged changes instead
  [--dims correctness,security,boundary,contract]   # explicit dimension override
  [--extra "<focus>"] # extra reviewer focus, free text
  [--model M] [--brief] [--no-verify] [--paths "src,sql"] [--out path]
```

Exit 2 on empty diff. Artifact default: `/tmp/pi-dag-review-<gate>-<ts>.md`.

## Discipline

- **Findings that fail refutation are dropped, not softened** — the verify layer exists
  to kill plausible-but-wrong reviews, the classic weak spot of single-pass LLM review.
- `--no-verify` only for quick brainstorm passes; never for a merge gate.
