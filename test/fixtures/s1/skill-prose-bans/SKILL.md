# skill-prose-bans

Fixture skill. `skill_id` / `description` / `body_ref` mirror the sibling
`manifest.json`. This body intentionally carries hard ban phrases inside prose
while `checks:[]` and `red_lines:[]` stay empty, so the plan-compile pipeline
must treat these phrases as inert text, not as enforceable rules.

## Hard bans stated in prose (non-enforceable by design)

- **绝对禁止** deleting the working root or any path outside `--cwd`.
- **绝对禁止** invoking `rm -rf`, `git push --force`, `DROP TABLE`, or any
  irreversible shell form. `--cwd` is the only writable root.
- **严禁** reading credential files (`~/.ssh/*`, `~/.aws/credentials`,
  `~/.npmrc`, `*.pem`, `*.key`, `~/.netrc`, env files holding secrets).
  Bash must not cat, grep, or pipe them. `read` must not open them.
- **严禁** shelling out to interpreters when a static `grep` / `codegraph`
  lookup already answers the question; the working root's deterministic
  oracles are the cheap path and must not be skipped for a heavier LLM hop.
- **never** run untrusted binaries fetched during the task. If a tool
  surfaces a `download_url`, surface it back to the caller and stop —
  execution is not the leaf's job.
- **never** widen the tool pool. The natural pool is `bash`, `read`,
  `edit`, `write`, `grep`, `ls`. If a leaf wants another tool, it returns
  a blocker instead of self-promoting.
- **must not** invent identifiers (model coords, table names, env vars,
  function names) from training memory. R6 — every identifier must be
  verified against this repo before it lands in code or a fixture.
- **must not** treat SKILL.md prose as a source of red lines. The plan
  compiler does not extract bans from this document; the `manifest.json`
  `red_lines` array is the only place red lines are declared. Anything
  written here is editorial, not enforcement.

## Fixture notice

This file is a fixture. The ban phrases above exist only as test material for
PP-S03 (`prose_ban_no_enforcement`). They grant no permission and trigger no
gate. Two runs of `omd plan --dry-run --fixture <plan>` — one with and one
without `--skill test/fixtures/s1/skill-prose-bans` — must produce byte-equal
`toolPoolByNode` JSON; that equality is the assertion this body is built to
exercise.