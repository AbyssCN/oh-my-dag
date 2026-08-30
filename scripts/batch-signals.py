#!/usr/bin/env python3
"""逐信号机械归因 —— 从一批 bench 结果里数出 §2.3 那几个信号,**不看 reward 均值**。

用法:
    python3 scripts/batch-signals.py <批目录> [<批目录> ...]
    python3 scripts/batch-signals.py --md <批目录> ...    # 出 markdown 表

## 为什么不看 reward 均值

σ̂ 实测 0.336(`runs/2026-08-30-σ̂读数.md`)⇒ 80 题尺上单批对比分辨不了 0.1 量级的差。
所以「周四之后的改动有没有用」这个问题**不能**由 reward 均值回答,只能逐信号数:
每个信号都是一个机械可数的 0→N,不经过判官,不吃噪声。

## 三态,别压平(仓规 §静默坑 1)

每个信号出三列,含义**互不相同**,任何一列都不许用 0 顶另一列:

  · `hit`      = 数到的条数/trial 数 —— 真读数;
  · `0`        = 数据面在、就是没出现 —— **有效读数**(0→N 的那个 0);
  · `n/a`      = 数据面本身不在(该 trial 没有这个文件 / 账本写失败)—— **不是 0**。

一个信号如果在**所有** trial 上都 `n/a`,那量的是尺子不是被测物,报表会显式说出来。

## 已知的 n/a 面(实测,别当成"引擎没做")

`seat-usage.jsonl` 在 2026-08-30 之前的镜像里**容器内每发都写失败**(只读挂载 EROFS,
`2026-08-29__21-54-51` 批 75/77 trial 命中)。修在 `seat-usage.ts:seatUsagePathWritable`,
**镜像重打之后**协调税分子才取得到数。在那之前本脚本对协调税一律报 `n/a`,不报 0。
"""

import argparse
import json
import os
import statistics as st
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

# ── 信号表 ───────────────────────────────────────────────────────────────────
# 每条: (显示名, 在 omd-output.txt 里找的字面串, 一句话这个数意味着什么)
# 字面串取自源码里的**导出常量**,不是照着日志抄的 —— 常量改了这里要跟着改,
# 所以每条都记了它在哪定义。
LOG_SIGNALS = [
    ("rubric-unwired 终态", "rubric-unwired",
     "run-goal.ts:774 TERMINAL_RUBRIC_UNWIRED —— 应从 oracle-failed 桶里拆出来"),
    ("best-green 棘轮", "best-green",
     "run-goal.ts:821 BEST_GREEN_LABEL —— INV-1 终态棘轮留痕锚串"),
    ("criterion-rebuild", "criterion-rebuild",
     "run-goal.ts:867 CRITERION_REBUILD_LABEL —— 目标修订边首次通电"),
    ("路径参数拒因", "missing-path-arg",
     "acceptance-gate.ts:210 —— A 桶 5/6 的病根(判据指错地)"),
    ("self_check SDK 静音", "SDK 通道不启用",
     "agent-leaf.ts SELF_CHECK_SDK_SKIP_LOG —— S-1 后 self_check 需求面第一次可观测"),
    ("self_check 自证闸拒", "self_check 判据自证闸拒",
     "engine.ts S-1 —— 判据在干活前就绿 ⇒ 不是判据 ⇒ 退回旁路"),
    ("writeScope 在场", "writeScope",
     "goal.ts:1184 注入面 —— solve 报文里的写集对账读数"),
    ("sliceCoverage 在场", "sliceCoverage",
     "goal.ts:1185 注入面 —— 声明了没改的覆盖率读数"),
    ("seat-usage 写失败", "[omd/seat-usage] 台账写入失败",
     "只读挂载 EROFS。>0 = 协调税分子取不到数,该批的协调税只能报 n/a"),
    ("seat-usage 回退", "[omd/seat-usage] 中央台账不可写",
     "回退生效(2026-08-30 修)。有它 = 账写进 /workspace/.omd 了"),
]

# 计划里出现过的 executor 词表项(26895234 才接线,老镜像应为 0 —— 那个 0 是有效读数)。
PLAN_KINDS = ["research", "await", "map", "primitive", "verify", "command"]


def trial_dirs(batch: Path):
    return sorted(p for p in batch.iterdir() if p.is_dir())


def read_text(p: Path):
    """读不到返 None(= n/a),不返空串 —— 空串是「读到了,是空的」。"""
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def node_kinds_from_state(tgz: Path):
    """从 omd-state.tgz 的 dag-runs.db 里数节点 kind。取不到返 None(n/a)。

    ⚠ **必须连 `-wal` / `-shm` 一起解开**。实测:归档时库没 checkpoint,`dag-runs.db` 本体
    只有 4096 字节(空壳),连表结构都在 WAL 里 —— 只解主库会 `no such table`,77 个 trial
    里只有 5 个读得出来。那 5 个不是"数据只有 5 份",是"只有 5 份恰好 checkpoint 过"。
    这正是 §静默坑 1 的形状:少解一个文件,读数从 77 掉到 5,而报表长得像"引擎没记"。
    """
    if not tgz.exists():
        return None
    try:
        with tempfile.TemporaryDirectory() as td:
            with tarfile.open(tgz, "r:gz") as tf:
                members = [m for m in tf.getmembers()
                           if os.path.basename(m.name).startswith("dag-runs.db")]
                main = [m for m in members if os.path.basename(m.name) == "dag-runs.db"]
                if not main:
                    return None
                for m in members:  # 主库 + -wal + -shm 解到同一目录, 缺一就读不全
                    tf.extract(m, td)
                db = os.path.join(td, main[0].name)
                out = subprocess.run(
                    ["sqlite3", db, "select nodes from omd_dag_runs;"],
                    capture_output=True, text=True, timeout=30,
                )
                if out.returncode != 0:
                    return None
                kinds, toks = {}, {"in": 0, "out": 0}
                for line in out.stdout.splitlines():
                    if not line.strip():
                        continue
                    try:
                        for nd in json.loads(line):
                            kinds[nd.get("kind", "?")] = kinds.get(nd.get("kind", "?"), 0) + 1
                            for k, col in (("in", "tokensIn"), ("out", "tokensOut")):
                                v = nd.get(col)
                                if isinstance(v, int):
                                    toks[k] += v
                    except json.JSONDecodeError:
                        continue
                return {"kinds": kinds, "tokens": toks}
    except (tarfile.TarError, OSError, subprocess.SubprocessError):
        return None


def scan_batch(batch: Path):
    trials = trial_dirs(batch)
    res = {
        "batch": batch.name,
        "n_trials": len(trials),
        "log_hits": {name: 0 for name, _, _ in LOG_SIGNALS},   # 命中 trial 数
        "log_occ": {name: 0 for name, _, _ in LOG_SIGNALS},    # 总出现次数
        "log_na": 0,          # 没有 omd-output.txt 的 trial 数
        "rewards": [],
        "reward_na": 0,
        "patch_empty": 0,
        "patch_n": 0,
        "kinds": {},
        "kinds_na": 0,
        "tokens": {"in": 0, "out": 0},
    }
    for t in trials:
        log = read_text(t / "agent" / "omd-output.txt")
        if log is None:
            res["log_na"] += 1
        else:
            for name, needle, _ in LOG_SIGNALS:
                c = log.count(needle)
                if c:
                    res["log_hits"][name] += 1
                    res["log_occ"][name] += c

        rj = t / "verifier" / "reward.json"
        if rj.exists():
            try:
                res["rewards"].append(json.load(open(rj))["reward"])
            except (json.JSONDecodeError, KeyError, OSError):
                res["reward_na"] += 1
        else:
            res["reward_na"] += 1

        patch = t / "verifier" / "agent.patch"
        if patch.exists():
            res["patch_n"] += 1
            if patch.stat().st_size == 0:
                res["patch_empty"] += 1

        st_ = node_kinds_from_state(t / "agent" / "omd-state.tgz")
        if st_ is None:
            res["kinds_na"] += 1
        else:
            for k, v in st_["kinds"].items():
                res["kinds"][k] = res["kinds"].get(k, 0) + v
            res["tokens"]["in"] += st_["tokens"]["in"]
            res["tokens"]["out"] += st_["tokens"]["out"]
    return res


def fmt(res, md=False):
    n = res["n_trials"]
    L = []
    L.append(f"## 批 {res['batch']} —— {n} trial")
    L.append("")
    if res["rewards"]:
        miss = f" · 缺 {res['reward_na']} 条" if res["reward_na"] else ""
        L.append(f"reward: n={len(res['rewards'])} 均值 {st.fmean(res['rewards']):.4f}{miss}")
    else:
        L.append("reward: **n/a**(一条都没读到)")
    if res["patch_n"]:
        pe = res["patch_empty"]
        L.append(f"空 patch: {pe}/{res['patch_n']} = **{pe / res['patch_n'] * 100:.1f}%**")
    else:
        L.append("空 patch: **n/a**")
    L.append("")
    L.append("| 信号 | 命中 trial | 总次数 | 读数含义 |")
    L.append("|---|---|---|---|")
    for name, _, why in LOG_SIGNALS:
        h, o = res["log_hits"][name], res["log_occ"][name]
        cell = "**n/a**" if res["log_na"] == n else (f"{h}/{n - res['log_na']}" if h else "0")
        L.append(f"| `{name}` | {cell} | {o} | {why} |")
    L.append("")
    if res["kinds_na"] == n:
        L.append("节点 kind: **n/a**(没有一个 trial 的 dag-runs.db 读得出来)")
    else:
        got = n - res["kinds_na"]
        kd = ", ".join(f"`{k}`={v}" for k, v in sorted(res["kinds"].items(), key=lambda x: -x[1]))
        L.append(f"节点 kind({got}/{n} trial 读到): {kd or '(空)'}")
        miss = [k for k in PLAN_KINDS if k not in res["kinds"]]
        if miss:
            L.append(f"  ⇒ 词表里**一次没出现**的 kind: {', '.join('`' + k + '`' for k in miss)}"
                     f" —— 这个 0 是有效读数(0→N 的那个 0),不是 n/a")
        L.append(f"节点 token 合计: in={res['tokens']['in']:,} out={res['tokens']['out']:,}")
    if res["log_hits"]["seat-usage 写失败"]:
        L.append("")
        L.append(f"⚠ **协调税 = n/a**:{res['log_hits']['seat-usage 写失败']} 个 trial 的 seat-usage "
                 "每发都写失败(只读挂载),分子里 verifier/judge/classify 那几项结构上取不到数。"
                 "不要用节点 token 去凑一个协调税 —— 那只有分母没有分子。")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("batches", nargs="+")
    ap.add_argument("--md", action="store_true", help="markdown 表(默认也是 markdown,留着显式)")
    a = ap.parse_args()
    outs = []
    for b in a.batches:
        p = Path(b).expanduser()
        if not p.is_dir():
            print(f"跳过(不是目录): {b}", file=sys.stderr)
            continue
        outs.append(fmt(scan_batch(p), md=a.md))
    print("\n\n".join(outs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
