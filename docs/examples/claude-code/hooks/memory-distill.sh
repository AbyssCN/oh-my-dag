#!/usr/bin/env bash
# Stop hook: memory-distill
# Triggers when the session stops. Prints a soft prompt (stdout, exit 0)
# nudging the model to distill reusable conclusions into omd self-memory
# via the memory_remember MCP tool. Never blocks — advisory only.

set -euo pipefail

cat <<'EOF'
💡 Session ending. Before you go: is there ONE reusable conclusion from this session
(a verified root cause, a repo-specific gotcha, a confirmed identifier/decision)?
If yes, store it via the omd memory_remember tool — one fact only, concise text,
namespace scoped to this repo. If nothing reusable happened, skip silently.
EOF

exit 0
