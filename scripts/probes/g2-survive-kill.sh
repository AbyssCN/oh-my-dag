#!/usr/bin/env bash
# scripts/probes/g2-survive-kill.sh — 真机验 SDD §3 G2 的入口壳: 逻辑在 g2-survive-kill.ts (同一目录)。
#
# 为什么从 bash 重写为 TS: bash coproc 版有两个实锤问题 —— ① notifications/initialized 带 id 发
# 会被 server 当请求回 -32601 Method not found (探针读到错 id 的响应, dag_run 被误判失败, 见旧
# /tmp/g2-probe.log 21:47/21:48 两次 FAIL); ② server 起不出独立进程组, 组信号 (SDD §5 反向路)
# 打过去会连探针自己一起杀。TS 版 (Bun.spawn detached + JSON 行跳过读) 是 g1-probe 已验证的形状。
#
# 反向自检 (证伪方式, 写死在 .ts 注释里):
#   - dag-tools defaultSpawnDagExec 去掉 `detached: true` → 子进程留在 server 进程组,
#     探针 RUN 1 的 `kill -9 -<server_pgid>` 组信号 → 子进程陪葬, 断言 1 红
#     (SDD §5 点名的失败模式: server 收到进程组信号时子进程不陪葬)。
#   - 改成 in-proc (不 spawn) → 无子进程, 断言 1 红。
#   - 子进程终态不写穿 runs.db (registry 写侧坏) → 断言 2 红。
#   - dag_status 只查内存 (G1 修前的 getSummary 病) → 断言 3 红 (新 server 内存无此 run)。
#
# 日志: /tmp/omd-g2-probe.log (不留仓根)。退出码 0=全过, 1=任一断言红。
set -euo pipefail
exec bun "$(dirname "$0")/g2-survive-kill.ts" "$@"

