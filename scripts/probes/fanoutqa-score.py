"""FanOutQA 判分 —— **调官方函数**, 不重写。

`fanoutqa.eval.__init__` 顶层 import BLEURT (Google TF 模型, 几百 MB checkpoint), 而我们只要
确定性的 loose/strict accuracy。所以按文件路径直接加载 `eval/string.py` 与 `eval/utils.py`
(这两个只依赖 `fanoutqa.norm`, 不碰 bleurt), 判分逻辑仍是官方原样。

⚠ 尺子量程 (先量过): 金标答案自评 loose 0.94 / strict 0.725, **不是 1.0** ——
官方 str_answer 序列化 dict 后再做词边界匹配本身有损。负控制: 空串 0.0 · 无关文本 0.0。

用: /tmp/fq-venv/bin/python scripts/probes/fanoutqa-score.py <outdir>
"""

import importlib.util as iu
import json
import statistics
import sys
from pathlib import Path

SP = Path("/tmp/fq-venv/lib/python3.12/site-packages/fanoutqa/eval")


def _load(name, path):
    spec = iu.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"装不上官方判分模块 {path} —— 先跑 uv pip install 'fanoutqa[all]'")
    mod = iu.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


answer_in_text = _load("fq_string", SP / "string.py").answer_in_text
str_answer = _load("fq_utils", SP / "utils.py").str_answer

out = Path(sys.argv[1] if len(sys.argv) > 1 else ".omd/eval/fanoutqa-2arm")
questions = {q["id"]: q for q in json.loads((out / "questions.json").read_text())}
rows = json.loads((out / "answers.json").read_text())

# 尺子量程: 同一批题上的金标自评 (天花板) 与空串 (地板) —— 每次判分都重算并印出,
# 免得读的人拿 0.94 去和 1.0 比。
gold = [answer_in_text(q["answer"], str_answer(q["answer"])).score for q in questions.values()]
print(f"尺子量程: 金标自评 loose={statistics.mean(gold):.4f} (天花板) · 空串 loose=0.0 (地板)")
print(f"题数 {len(questions)}\n")

arms = []
for arm in dict.fromkeys(r["arm"] for r in rows):
    sub = [r for r in rows if r["arm"] == arm]
    stats = {"arm": arm, "n": len(sub), "errors": sum(1 for r in sub if r.get("error"))}
    for field, label in (("answer", "strip"), ("answerRaw", "raw")):
        scores, perfect = [], 0
        for r in sub:
            q = questions.get(r["id"])
            if q is None:
                continue
            res = answer_in_text(q["answer"], r[field])
            scores.append(res.score)
            perfect += 1 if res.found else 0
        stats[f"loose_{label}"] = statistics.mean(scores) if scores else 0.0
        stats[f"strict_{label}"] = perfect / len(scores) if scores else 0.0
    stats["think"] = sum(1 for r in sub if r.get("hadThink")) / max(1, len(sub))
    stats["unclosed"] = sum(1 for r in sub if r.get("unclosed")) / max(1, len(sub))
    # 撞顶率与 think 占比: 前者说"这个分是不是被我的 maxTokens 压低的", 后者说"它把多少产出花在思考上"。
    stats["trunc"] = sum(1 for r in sub if r.get("truncated")) / max(1, len(sub))
    stats["thinkRatio"] = statistics.mean([r.get("thinkRatio", 0) for r in sub]) if sub else 0
    stats["out"] = statistics.mean([r["outTokens"] for r in sub]) if sub else 0
    stats["sec"] = statistics.median([r["latencyMs"] / 1000 for r in sub]) if sub else 0
    arms.append(stats)

hdr = f"{'臂':<20}{'题':>4}{'loose(剥)':>11}{'strict(剥)':>12}{'loose(未剥)':>13}{'think占':>9}{'撞顶':>7}{'未闭合':>8}{'平均out':>9}{'中位延迟':>9}{'错':>4}"
print(hdr)
print("-" * len(hdr))
for a in arms:
    print(
        f"{a['arm']:<20}{a['n']:>4}{a['loose_strip']:>11.3f}{a['strict_strip']:>12.3f}"
        f"{a['loose_raw']:>13.3f}{a['thinkRatio']:>9.0%}{a['trunc']:>7.0%}{a['unclosed']:>8.0%}"
        f"{a['out']:>9.0f}{a['sec']:>9.1f}{a['errors']:>4}"
    )

# 噪声地板: 同一模型两臂之差 —— 任何小于它的跨模型差都读不出来。
print()
for base in dict.fromkeys(a["arm"].replace("·control", "") for a in arms):
    pair = [a for a in arms if a["arm"].replace("·control", "") == base]
    if len(pair) == 2:
        print(f"噪声地板 {base}: |Δloose| = {abs(pair[0]['loose_strip'] - pair[1]['loose_strip']):.3f}")

json.dump(arms, (out / "scores.json").open("w"), indent=2, ensure_ascii=False)
print(f"\n→ 落盘 {out}/scores.json")
