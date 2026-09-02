#!/usr/bin/env bash
# scripts/hygiene-night.sh —— 仓库治理链的周批启动脚本 (契约 §目标: 每周日 02:00 一条命令)。
#
#   scripts/hygiene-night.sh [YYYY-MM-DD]
#
# 做完三件确定性的事, 然后把要模型的那四段交出去:
#   ① 扫描九个矿源 → <hy>/scan.json          (零 LLM)
#   ② 棘轮对基线   → 升了打印哪一类升的       (零 LLM; 不 exit 1, 周批不因棘轮红而停)
#   ③ 编链 + 装饰  → <hy>/plan.json           (零 LLM; 拓扑脚本产, 点火时不经 conductor)
#   ④ 票草稿       → <hy>/tickets.json        (零 LLM; 进图仍要人 map_confirm)
#
# ⚠ **点火没有接进本脚本。** triage / apply / verify / report 四段要模型, 引擎入口是
#   MCP 的 `dag_run_plan`(没有对应的 CLI 子命令), 从 shell 里调它需要一个 MCP 客户端。
#   与其在这里半接一条验证不了的点火路, 不如把 plan.json 摆出来 + 打印那一行调用 ——
#   缺的那一跳写在这里, 比藏在一段跑不通的代码里诚实。接上之后删掉这段注释。
set -euo pipefail

cd "$(dirname "$0")/.."

DATE="${1:-$(date +%F)}"
HY="runs/hygiene/${DATE}"
mkdir -p "${HY}"

echo "[hygiene-night] ${DATE} → ${HY}"

# ① 扫描 (九个矿源; 任一矿源读不到进 errors[], 不中断)
bun scripts/hygiene-scan.ts --out "${HY}/scan.json"

# ② 棘轮 (基线缺席时 --check 会退出 1 —— 周批不为此停, 只把判词留在日志里)
bun scripts/hygiene-scan.ts --check || echo "[hygiene-night] 棘轮判红或基线缺席 (见上) — 周批继续"

# ③ 链形状 + plan.json (任何一步不合 schema 当场抛, 那时才该停)
bun scripts/hygiene-night.ts --dry-run --date "${DATE}" --out "${HY}/plan.json"

# ④ 票草稿 (worklist 要等 refute 段跑完; 头一趟只有 scan 那部分的票)
bun scripts/hygiene-tickets.ts \
  --scan "${HY}/scan.json" \
  --worklist "${HY}/worklist.json" \
  --slug hygiene \
  --out "${HY}/tickets.json"

cat <<EOF

[hygiene-night] 确定性四步完成。要模型的四段 (triage / apply / verify / report) 这样点火:

  omd MCP → dag_run_plan  { "planPath": "${HY}/plan.json", "branchStrategy": "branch" }

座位不在 plan 里 (D-9): conductor / agent / leaf / verifier 全取 config。
点完之后重跑一次拿票: bun scripts/hygiene-tickets.ts --scan ${HY}/scan.json \\
  --worklist ${HY}/worklist.json --slug hygiene --out ${HY}/tickets.json
分支 hygiene/${DATE} 由人 merge —— merge 率是第一周的读数 (契约 §首周预登记)。
EOF
