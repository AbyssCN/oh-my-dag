# oh-my-dag (omd) — model-agnostic multi-agent runtime
# Build:  docker build -t oh-my-dag .
# Run  :  docker run --rm -it -e OMD_RUNTIME_PROVIDER=deepseek \
#                              -e OMD_RUNTIME_MODEL=deepseek-v4-pro \
#                              -e DEEPSEEK_API_KEY=sk-... \
#                              -v "$PWD:/work" -w /work oh-my-dag
#         (the agent operates on /work — mount the project you want it to edit)
#
# One-shot, non-interactive:
#   docker run --rm -e OMD_RUNTIME_PROVIDER=deepseek -e OMD_RUNTIME_MODEL=deepseek-v4-pro \
#              -e DEEPSEEK_API_KEY=sk-... -v "$PWD:/work" -w /work oh-my-dag -p "summarize this repo"

FROM oven/bun:1.3.14

# Deps first — cached unless package.json / lockfile change.
WORKDIR /opt/oh-my-dag
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Runtime source + curated skill bundle.
COPY . .

# The agent writes its runtime state (sqlite stores) into the cwd it is launched in.
# Mount your project at /work and `-w /work` so state + edits land there, not in the image.
WORKDIR /work

# Entry = the omd TUI. Extra args pass straight through to pi
# (e.g. `-p "<task>"` for one-shot, `--model <provider>/<model>` to override).
ENTRYPOINT ["bun", "run", "/opt/oh-my-dag/src/harness/tui.ts"]
