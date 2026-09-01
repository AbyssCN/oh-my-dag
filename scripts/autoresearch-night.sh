#!/usr/bin/env bash
# autoresearch-night —— 夜间自迭代启动器(阶梯推进:P0+P1 → P2 → …)
# 每晚跑同一条命令,脚本自己判断当前阶段;前置不满足一律 fail-closed 拒点火。
#
# 用法:
#   scripts/autoresearch-night.sh            # 判阶段 + 点火(后台,日志见 runs/autoresearch/)
#   scripts/autoresearch-night.sh --dry-run  # 只过闸 + 报告将点什么,不点火
#
# 退出码:0 点火成功/dry-run 通过 · 2 目标向量未冻结 · 3 座位闸红 · 4 阶梯尽头待人 · 5 已有夜跑在进行
#
# 设计真源: docs/research/2026-09-01-autoresearch-自迭代回路设计.md (v3 §11)
# 目标向量: docs/plan/autoresearch-objective.md(签字冻结后本脚本才放行)
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; fi

TS=$(date +%F)
OUTDIR=runs/autoresearch
LOG="$OUTDIR/night-$TS.log"
LOCK="$OUTDIR/night.lock"
mkdir -p "$OUTDIR"

say() { echo "[autoresearch-night] $*"; }
die() { say "✗ $1"; exit "${2:-1}"; }

# ── 闸 0:重复点火 ──────────────────────────────────────────────
if [ -f "$LOCK" ]; then
  OLDPID=$(cat "$LOCK")
  if kill -0 "$OLDPID" 2>/dev/null; then
    die "已有夜跑在进行 (pid $OLDPID)。跟踪: tail -f $LOG" 5
  fi
  say "残留锁 (pid $OLDPID 已死) → 清除"
  rm -f "$LOCK"
fi

# ── 闸 1:目标向量必须已冻结(草案状态拒点火)────────────────────
OBJ=docs/plan/autoresearch-objective.md
if [ ! -f "$OBJ" ]; then die "缺 $OBJ" 2; fi
if grep -q '草案,待 owner 签字' "$OBJ"; then
  die "目标向量仍是草案 —— owner 在 $OBJ 改状态行签字冻结后再点火。" 2
fi

# ── 闸 2:座位 = M3 + deepseek-v4-pro(objective §座位;省额度是硬约束)──
DUMP=$(bun run src/harness/cli.ts config dump 2>&1 || true)
COND_LINE=$(echo "$DUMP" | grep -E '^\s*conductor\s' | head -1 || true)
VERI_LINE=$(echo "$DUMP" | grep -E '^\s*verifier\s' | head -1 || true)
if ! echo "$COND_LINE" | grep -q 'MiniMax-M3'; then
  die "conductor 座位不对:${COND_LINE:-<未读到>} —— 需 minimax-cn:MiniMax-M3(TUI: omd_set_model)。" 3
fi
if ! echo "$VERI_LINE" | grep -q 'gpt-5.6-sol'; then
  die "verifier 座位不对:${VERI_LINE:-<未读到>} —— 需 openai-codex:gpt-5.6-sol(异族终审,objective §座位)。" 3
fi
if ! bun run src/harness/cli.ts config verify-seats >/dev/null 2>&1; then
  bun run src/harness/cli.ts config verify-seats 2>&1 | sed 's/^/  /' || true
  die "座位家族闸 (I-14) 红 —— 上列违规行先修(同族审自己不放行)。" 3
fi

# ── 阶段判定:交付件存在性 = 阶梯 marker ───────────────────────
if [ ! -f scripts/autoresearch-replay.ts ] || [ ! -f runs/autoresearch/corpus/manifest.json ]; then
  PHASE="P0+P1(前置件)"
  SDD=docs/plan/2026-09-01-autoresearch-前置-执行契约.md
  GOAL="按契约实现 autoresearch 前置件 P0+P1"
  BUDGET=240
else
  SDD=$(ls docs/plan/*autoresearch*P2*执行契约.md 2>/dev/null | head -1 || true)
  if [ -z "$SDD" ]; then
    die "P0+P1 交付件已在,但 P2 契约未立 —— 人读 P1 稳定性读数(--stability)后立契约(设计 v3 §7 P2 行)。" 4
  fi
  PHASE="P2(首个进化 session)"
  GOAL="按契约跑 autoresearch P2 进化 session"
  BUDGET=180
fi
if [ ! -f "$SDD" ]; then die "契约文件缺失: $SDD" 4; fi

say "阶段 $PHASE"
say "契约 $SDD · 预算 ${BUDGET}min · 日志 $LOG"
if [ "$DRY" = 1 ]; then
  say "(dry-run,全部闸绿,不点火)"
  exit 0
fi

# ── 点火 ──────────────────────────────────────────────────────
RESULT="$OUTDIR/night-$TS-result.json"
nohup bun run src/harness/cli.ts solve "$GOAL" --sdd "$SDD" \
  --budget-minutes "$BUDGET" --result-out "$RESULT" >>"$LOG" 2>&1 &
PID=$!
echo "$PID" >"$LOCK"
say "已点火 pid $PID"
say "跟踪: tail -f $LOG · 结果: $RESULT(outcome 首部即判词)"
say "锁在进程结束后由下次启动自清;手动停: kill $PID && rm $LOCK"
