# CLAUDE.md — oh-my-dag discipline for Claude Code

This file enforces omd engineering discipline in Claude Code sessions.

## Core rules

### Verify after every edit (edit→verify gate)

After ANY file edit, run verification before proceeding:

```bash
bunx tsc --noEmit          # typecheck
bun test --bail             # tests, stop on first failure
```

Both must pass. If either fails → STOP. Fix the error, re-verify. Never proceed past a red gate.
Never mark a task done if verification hasn't run.

### Dangerous command classification

These commands require explicit user confirmation before execution:

- `rm -rf` / `rm -r` on project directories
- `git push --force` / `git reset --hard`
- `DROP TABLE` / `DELETE FROM` / `TRUNCATE`
- `curl | sh` / `curl | bash`
- Any command modifying `.env`, `.git/config`, or `node_modules/` outside install
- `chmod 777` / `chown` on project files

If a hook blocks a command (exit code 2), do NOT retry or bypass. Ask the user.

### No try/catch as fix

Don't wrap unknown errors in try/catch and call it solved. Reproduce → find root cause → fix.
If you've tried the same fix 3 times without success, stop — you're drifting, not debugging.

### Evidence grounding

Before writing any identifier (function name, type name, config key, env var):
1. Verify it exists in this repo with grep or codegraph
2. Confirm exact spelling
3. Never assume from memory — your training data ≠ this repo's reality

### Think in code

If the answer is a number or a small table (<20 rows), write a script to compute it.
Don't load N files into context to eyeball an answer.

### Naming and structure

Match surrounding code style. No "temporary" comments. No scaffolding left behind.

## Hooks

Install the PreToolUse hooks in `.claude/hooks/` to enforce these rules automatically:

```bash
mkdir -p .claude/hooks
cp docs/examples/claude-code/hooks/*.sh .claude/hooks/
chmod +x .claude/hooks/*.sh
```

See `docs/examples/claude-code/hooks/` for:
- `verify-after-edit.sh` — blocks after edits until tsc + tests pass
- `dangerous-cmd.sh` — blocks dangerous shell commands (exit 2 = hard stop)
- `memory-distill.sh` — Stop hook; soft-nudges memory distillation at session end

## 会话记忆蒸馏 (session memory distillation)

When a session ends, decide whether anything is worth keeping in omd self-memory:

- **Store** only durable, reusable conclusions: a verified root cause, a repo-specific
  gotcha (wrong-identifier trap, surprising config behavior), a confirmed decision and why.
- **Skip** transient state: task progress, intermediate errors already fixed, anything
  recoverable from git history or the code itself.
- At most **one fact per session**. If in doubt, skip — noise degrades recall quality.
- **Namespace discipline**: use the repo-scoped namespace (e.g. this project's), never a
  global one; include `confidence` and a `source_event_id`/`source_doc_id` reference.
- Never store secrets, credentials, or personal data — the safeguard gate rejects them.

Store via the omd `memory_remember` MCP tool. Retrieve later with `memory_recall`.
