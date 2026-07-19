#!/usr/bin/env bash
# PreToolUse hook: dangerous-cmd
# Classifies shell commands for danger. Exit 2 = hard block.
# Claude Code passes tool input via stdin as JSON.

set -euo pipefail

# Only gate Bash tool
TOOL_NAME=$(jq -r '.tool_name // ""' 2>/dev/null || echo "")
case "$TOOL_NAME" in
  Bash|bash) ;;
  *) exit 0 ;;
esac

CMD=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# --- DANGER PATTERNS (exit 2 = hard block) ---

# Recursive delete on project dirs
if echo "$CMD" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive)'; then
  echo "⛔ Blocked: recursive delete. Use targeted removal." >&2
  exit 2
fi

# Force push / hard reset
if echo "$CMD" | grep -qE 'git\s+push\s+.*--force|git\s+reset\s+--hard'; then
  echo "⛔ Blocked: destructive git operation. Confirm with user." >&2
  exit 2
fi

# Pipe-to-shell
if echo "$CMD" | grep -qE 'curl\s.*\|\s*(ba)?sh|wget\s.*\|\s*(ba)?sh'; then
  echo "⛔ Blocked: piping remote content to shell." >&2
  exit 2
fi

# SQL destruction
if echo "$CMD" | grep -qiE 'DROP\s+TABLE|TRUNCATE|DELETE\s+FROM\s+\S+\s*$'; then
  echo "⛔ Blocked: destructive SQL without WHERE clause." >&2
  exit 2
fi

# Overwrite critical files
if echo "$CMD" | grep -qE '>\s*(\.env|\.git/config)|chmod\s+777'; then
  echo "⛔ Blocked: modifying critical config or setting 777 permissions." >&2
  exit 2
fi

# --- WARNING PATTERNS (exit 0 but log) ---

if echo "$CMD" | grep -qE 'git\s+checkout\s+\.|git\s+clean\s+-f'; then
  echo "⚠️  Warning: this discards uncommitted changes." >&2
  # still allow — warning only
fi

exit 0
