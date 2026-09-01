#!/usr/bin/env bash
# autoresearch-night —— 夜间自迭代启动器(阶梯推进:P0+P1 → P2 → …)
# 每晚跑同一条命令,脚本自己判断当前阶段;前置不满足一律 fail-closed 拒点火。
#
# 用法:
#   scripts/autoresearch-night.sh            # 判阶段 + 点火(后台,日志见 runs/autoresearch/)
#   scripts/autoresearch-night.sh --dry-run  # 只过闸 + 报告将点什么,不点火
#
# 退出码:0 点火成功/dry-run 通过 · 2 点火闸红(冻结/座位,详见输出) · 4 阶梯尽头待人
#
# 设计真源: docs/research/2026-09-01-autoresearch-自迭代回路设计.md (v3 §11)
# 目标向量: docs/plan/autoresearch-objective.md(签字冻结后才放行)
#
# t-gate-inmigrate (2026-09-01): 三道点火闸 (A 冻结文件 / B 座位断言 / C 互斥锁) 已内迁
# 引擎 —— solve 的 ignitionPreflight 在点火时机械强制, 声明在 .omd/preflight.json。
# 本脚本不再自带闸实现, 只留「探针 + 报告」(dry-run 语义不回归); 闸 C 由引擎按
# resultOut/sddPath 互斥, 本脚本的 lock 文件仅作跟踪信息 (手动 kill 提示), 不再是闸。
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

# ── 点火闸声明(幂等):缺席才生成, 已存在的 owner 版本一字不动 ──
if [ ! -f .omd/preflight.json ]; then
  cat > .omd/preflight.json << 'PFEOF'
{
  "freezeCheck": {
    "files": [
      { "path": "docs/plan/autoresearch-objective.md", "draftMarker": "草案,待 owner 签字" }
    ]
  },
  "seatExpectations": {
    "conductor": "minimax-cn:MiniMax-M3",
    "verifier": "openai-codex:gpt-5.6-sol"
  }
}
PFEOF
  say "已生成 .omd/preflight.json(点火闸声明;objective §座位)"
fi

# ── 闸探针 + 报告(判定本体在引擎 ignitionPreflight, 此处零 bash 闸实现)──
# 只探 A(冻结)/B(座位) —— C(互斥锁) 有取锁副作用, 探针不取, 点火时由引擎强制。
PF_JSON=$(bun -e '
import { ignitionPreflight } from "./src/harness/goal/ignition-preflight";
import { loadPreFlightConfig } from "./src/harness/goal/preflight-config";
const cfg = loadPreFlightConfig(process.cwd());
const r = ignitionPreflight(process.cwd(), [], {
  ...(cfg?.freezeCheck ? { freezeCheck: cfg.freezeCheck } : {}),
  ...(cfg?.seatExpectations ? { seatExpectations: cfg.seatExpectations } : {}),
});
console.log(JSON.stringify(r));
' 2>&1 | tail -1)
if ! echo "$PF_JSON" | grep -q '"verdict":"ok"'; then
  echo "$PF_JSON" | sed 's/^/  /'
  die "点火闸红(引擎 ignitionPreflight 判词见上)—— 修声明或按判词处置后重跑。" 2
fi
say "点火闸探针绿(A 冻结 / B 座位;C 互斥由引擎点火时强制)"

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
