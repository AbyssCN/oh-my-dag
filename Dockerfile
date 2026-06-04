# Xihe · 羲和 — model-agnostic multi-agent runtime (Wright agent)
# Build:  docker build -t xihe .
# Run  :  docker run --rm -it -e XIHE_RUNTIME_PROVIDER=deepseek \
#                              -e XIHE_RUNTIME_MODEL=deepseek-v4-pro \
#                              -e DEEPSEEK_API_KEY=sk-... \
#                              -v "$PWD:/work" -w /work xihe
#         (the agent operates on /work — mount the project you want it to edit)
#
# One-shot, non-interactive:
#   docker run --rm -e XIHE_RUNTIME_PROVIDER=deepseek -e XIHE_RUNTIME_MODEL=deepseek-v4-pro \
#              -e DEEPSEEK_API_KEY=sk-... -v "$PWD:/work" -w /work xihe -p "summarize this repo"

FROM oven/bun:1.3.14

# Deps first — cached unless package.json / lockfile change.
WORKDIR /opt/xihe
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Runtime source + curated skill bundle.
COPY . .

# Wright writes its runtime state (sqlite stores) into the cwd it is launched in.
# Mount your project at /work and `-w /work` so state + edits land there, not in the image.
WORKDIR /work

# Entry = the Wright TUI. Extra args pass straight through to pi
# (e.g. `-p "<task>"` for one-shot, `--model <provider>/<model>` to override).
ENTRYPOINT ["bun", "run", "/opt/xihe/src/wright/tui.ts"]
