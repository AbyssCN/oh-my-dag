#!/usr/bin/env bash
# PreToolUse hook: verify-after-edit
# Triggers after Write/Edit tool use. Runs tsc + tests.
# Exit 0 = allow. Exit 2 = hard block (Claude Code will NOT proceed).
# Claude Code passes tool input via stdin as JSON.

set -euo pipefail

# Only gate on file-writing tools
TOOL_NAME=$(jq -r '.tool_name // ""' 2>/dev/null || echo "")
case "$TOOL_NAME" in
  Write|Edit|write|edit|MultiEdit) ;;
  *) exit 0 ;;
esac

# Only gate on source/test files (skip docs, configs, lock files)
FILE_PATH=$(jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null || echo "")
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx) ;;
  test/*|*.test.*|*.spec.*) ;;
  src/*) ;;
  *) exit 0 ;;
esac

# Run typecheck
if ! bunx tsc --noEmit 2>/tmp/omd-hook-tsc-stderr.txt; then
  echo "⛔ Typecheck failed after edit. Fix errors before proceeding." >&2
  cat /tmp/omd-hook-tsc-stderr.txt >&2
  exit 2
fi

# Run related tests (fast bail)
if [ -d "test" ] || [ -d "tests" ] || [ -d "__tests__" ]; then
  if ! bun test --bail 2>/tmp/omd-hook-test-stderr.txt; then
    echo "⛔ Tests failed after edit. Fix failures before proceeding." >&2
    cat /tmp/omd-hook-test-stderr.txt >&2
    exit 2
  fi
fi

exit 0
