#!/usr/bin/env bash
# autoresearch-night —— 夜间自迭代链的启动器(薄壳)
#
# 用法:
#   scripts/autoresearch-night.sh            # 点火(后台,日志见 runs/autoresearch/)
#   scripts/autoresearch-night.sh --dry-run  # 过点火闸 + 打印七段链拓扑,不点火
#
# 退出码:0 点火成功/dry-run 通过 · 2 点火闸红(冻结/座位,详见输出)
#
# 设计真源: docs/plan/2026-09-02-夜间自迭代链-执行契约.md(D-8 night.sh 变薄)
# 目标向量: docs/plan/autoresearch-objective.md(签字冻结后才放行)
#
# 本脚本**不再判阶段**(D-8):P0/P1/P2 阶梯已全部走完,阶梯 marker 判断连同 PHASE 变量一起删。
# 今天它只做三件事:声明点火闸 → 探针报告 → 把活交给 scripts/autoresearch-night.ts。
# 拓扑、预算、卡数全在那个 TS 文件里(bash 不该是拓扑的真源)。
#
# t-gate-inmigrate (2026-09-01): 三道点火闸 (A 冻结文件 / B 座位断言 / C 互斥锁) 已内迁
# 引擎 —— solve 的 ignitionPreflight 在点火时机械强制, 声明在 .omd/preflight.json。
# 本脚本不自带闸实现, 只留「探针 + 报告」(dry-run 语义不回归)。
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

# ── dry-run:透传给 driver,由它打印七段链拓扑(零 LLM)──
if [ "$DRY" = 1 ]; then
  say "(dry-run,全部闸绿,不点火)"
  bun scripts/autoresearch-night.ts --dry-run --date "$TS"
  exit 0
fi

# ── 点火 ──────────────────────────────────────────────────────
say "夜链 $TS · 日志 $LOG · 产物 $OUTDIR/night-$TS/"
nohup bun scripts/autoresearch-night.ts --date "$TS" >>"$LOG" 2>&1 &
PID=$!
echo "$PID" >"$LOCK"
say "已点火 pid $PID"
say "跟踪: tail -f $LOG · 晨报: $OUTDIR/night-$TS/morning.md(首行写明两半不一致以附录为准)"
say "锁在进程结束后由下次启动自清;手动停: kill $PID && rm $LOCK"
