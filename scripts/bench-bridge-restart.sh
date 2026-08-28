#!/usr/bin/env bash
# 桥的唯一合法重启面。**别手写 `pkill -f 'bench-bridge.ts'`**:
# 2026-08-27 实账 —— kill 与重启写在同一条命令行, pkill 自匹配到发起它的 shell,
# 桥死了、同行的重启没跑, 8 个 trial 连不上上游, 三个 code80-m3 批整批作废
# (workbuddy-bench results/omd-bridge-code80-m3/*/VOID.md)。
# 本脚本: 配置读 ~/.omd/bridge.env (含 token, 不入库) → 按 pidfile 杀 → 兜底 pgrep
# (脚本文件名不含 `.ts`, 不会自匹配) → 等端口释放 → nohup 拉起 → 健康探一次。
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="$HOME/.omd/bridge.env"
if [[ ! -f $ENV_FILE ]]; then
  echo "bench-bridge-restart: $ENV_FILE 缺失 —— 无 token 桥拒绝启动 (fail-closed), 先补配置" >&2
  exit 1
fi
set -a; source "$ENV_FILE"; set +a

PIDFILE="$HOME/.omd/bench-bridge.pid"
if [[ -f $PIDFILE ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")"
else
  pgrep -f 'bun scripts/bench-bridge\.ts' | xargs -r kill
fi
for _ in $(seq 1 50); do
  pgrep -f 'bun scripts/bench-bridge\.ts' >/dev/null || break
  sleep 0.2
done
if pgrep -f 'bun scripts/bench-bridge\.ts' >/dev/null; then
  echo "bench-bridge-restart: 旧桥 10s 内没退, 不强杀 (SIGKILL 会吞在飞请求), 人工处置" >&2
  exit 1
fi

LOG="$HOME/.omd/bench-bridge.log"
nohup bun scripts/bench-bridge.ts >>"$LOG" 2>&1 &
NEW_PID=$!
sleep 1
PORT="${OMD_BRIDGE_PORT:-4519}"
if curl -sf -m 3 -H "Authorization: Bearer $OMD_BRIDGE_TOKEN" "http://127.0.0.1:$PORT/v1/models" >/dev/null; then
  echo "bench-bridge 已重启: pid=$NEW_PID port=$PORT log=$LOG"
else
  echo "bench-bridge-restart: 拉起后健康探测失败, 看 $LOG 尾部" >&2
  tail -5 "$LOG" >&2
  exit 1
fi
