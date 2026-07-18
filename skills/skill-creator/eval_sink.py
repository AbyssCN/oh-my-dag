#!/usr/bin/env python3
"""omd_sink — 薄包装官方 run_eval.py, 把 description trigger-rate delta 写进 omd substrate。

R6 实测对齐 run_eval.py 真实接口 (scripts/run_eval.py):
  --eval-set <json> (required) · --skill-path <dir> (required) · 输出 stdout JSON, 每条 result 带 trigger_rate。

omd 侧约定 (本 sink 的入参):
  --skill <name> · --root <skills dir> · --db <sqlite path>

流程:
  1. 定位 eval-set: <skill-path>/evals/trigger-eval.json (无则报错让用户先 eval-generate)。
  2. 跑官方 run_eval.py → 解析聚合 trigger_rate (各 result 均值)。
  3. 读上一次 rate (python sqlite3 直读 substrate, 最新 description_trigger_delta 事件 metadata.current_rate)。
  4. delta = current - prev (首跑 prev 未知 → delta=0.0)。
  5. 回调 `bun run omd:skill record-event <skill> description_trigger_delta <delta>
     --metadata {current_rate,prev_rate} --db <db>` → 写进 evolution_events。

**不改 run_eval.py 一行** (复用官方 eval 机器, 约束②)。trigger-rate 是机械度量非 LLM 自评 → T2 信号 (SK-INV-13 合规)。
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys


def aggregate_rate(run_eval_output: str) -> float:
    """从 run_eval.py 的 stdout JSON 取聚合 trigger_rate (各 result 均值)。"""
    data = json.loads(run_eval_output)
    results = data.get("results", data if isinstance(data, list) else [])
    rates = [r["trigger_rate"] for r in results if isinstance(r, dict) and "trigger_rate" in r]
    if not rates:
        # 兼容 summary 形态
        summ = data.get("summary", {})
        if "passed" in summ and "total" in summ and summ["total"]:
            return summ["passed"] / summ["total"]
        raise ValueError("run_eval.py 输出无 trigger_rate")
    return sum(rates) / len(rates)


def previous_rate(db_path: str, skill_id: str) -> float | None:
    """读最新一条 description_trigger_delta 事件的 metadata.current_rate。"""
    if not os.path.exists(db_path):
        return None
    con = sqlite3.connect(db_path)
    try:
        row = con.execute(
            "SELECT metadata FROM skill_evolution_events "
            "WHERE skill_id=? AND event_type='description_trigger_delta' ORDER BY id DESC LIMIT 1",
            (skill_id,),
        ).fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        return None
    try:
        return json.loads(row[0]).get("current_rate")
    except (json.JSONDecodeError, AttributeError):
        return None


def skill_id_of(name: str) -> str:
    """镜像 scanner.skillId: 'grill-me' → 'sk_grill_me'。"""
    import re
    return "sk_" + re.sub(r"[^a-zA-Z0-9]+", "_", name).lower()


def main() -> int:
    p = argparse.ArgumentParser(description="omd sink for skill-creator trigger eval")
    p.add_argument("--skill", required=True)
    p.add_argument("--root", required=True, help="skills root dir")
    p.add_argument("--db", required=True, help="omd substrate sqlite path")
    p.add_argument("--eval-set", default=None, help="override eval-set json (default <skill>/evals/trigger-eval.json)")
    args = p.parse_args()

    skill_path = os.path.join(args.root, args.skill)
    eval_set = args.eval_set or os.path.join(skill_path, "evals", "trigger-eval.json")
    if not os.path.exists(eval_set):
        print(f"✗ 无 eval-set: {eval_set} — 先 `omd skill eval-generate {args.skill}` 起草", file=sys.stderr)
        return 1

    run_eval = os.path.join(os.path.dirname(__file__), "scripts", "run_eval.py")
    proc = subprocess.run(
        [sys.executable, run_eval, "--eval-set", eval_set, "--skill-path", skill_path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"✗ run_eval.py 失败:\n{proc.stderr}", file=sys.stderr)
        return proc.returncode

    rate = aggregate_rate(proc.stdout)
    prev = previous_rate(args.db, skill_id_of(args.skill))
    delta = 0.0 if prev is None else round(rate - prev, 4)
    meta = json.dumps({"current_rate": round(rate, 4), "prev_rate": prev})

    rec = subprocess.run(
        ["bun", "run", "omd:skill", "record-event", args.skill,
         "description_trigger_delta", str(delta), "--metadata", meta, "--db", args.db, "--root", args.root],
        text=True,
    )
    if rec.returncode == 0:
        print(f"✓ {args.skill}: trigger_rate={rate:.3f} delta={delta:+.4f} → substrate")
    return rec.returncode


if __name__ == "__main__":
    sys.exit(main())
