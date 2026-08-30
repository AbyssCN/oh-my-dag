#!/usr/bin/env python3
"""σ̂ = 同配置两批之间「配对差的 sd」—— 本仓一切 reward 对比的噪声底。

用法:
    python3 scripts/sigma-paired.py <批A目录> <批B目录>

判据(预登记 `runs/2026-08-29-批2预登记-观测重复批.md`):
  · 两批配置必须**完全相同**(同镜像 · 同 job · 同模型桥)。配置不同 → 量到的不是噪声。
  · 只比**两批共同完成**的题(任一侧缺 reward.json 就整题剔除)。
    ⚠ 批 `2026-08-29__21-54-51` 被机器重启杀在 73/80,所以共同题集会 < 80。
  · 输出的 `sd(配对差)` 就是 σ̂。此后任何改动要算有效,效果必须 > 2σ̂。

⚠ 口径退让(必须一起写进读数文档):预登记要求「安静主机」,实际两批都在有 opus subagent
   并发 + 跑过全量测试的机器上跑。所以量到的是「工作条件下的同臂噪声」,不是理想安静条件。

自检(2026-08-30 实跑,这两批是文档里已复算过的已知值):
    python3 scripts/sigma-paired.py \
      ~/repos/workbuddy-bench/results/omd-bridge-code80-opusv/2026-08-29__10-11-01 \
      ~/repos/workbuddy-bench/results/omd-bridge-code80-opusv/2026-08-29__15-29-23
    → 应得 n=80 · A 0.4487 · B 0.3774 · 配对差 -0.0713 · sd 0.336
    对不上就是本脚本坏了,不是数据变了。
"""

import glob
import json
import os
import statistics as st
import sys


def load(batch_dir: str) -> dict[str, float]:
    """题名 → reward。题名 = trial 目录名去掉 `__<后缀>` 那一段(同题多 trial 的区分位)。"""
    out: dict[str, float] = {}
    for f in glob.glob(os.path.join(batch_dir, "*", "verifier", "reward.json")):
        trial = os.path.basename(os.path.dirname(os.path.dirname(f)))
        out[trial.rsplit("__", 1)[0]] = json.load(open(f))["reward"]
    return out


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    a_dir, b_dir = sys.argv[1], sys.argv[2]
    a, b = load(a_dir), load(b_dir)
    common = sorted(set(a) & set(b))
    if len(common) < 2:
        print(f"共同完成题只有 {len(common)} 道 —— 算不出 sd。A={len(a)} B={len(b)}")
        return 1
    diffs = [b[t] - a[t] for t in common]
    sd = st.stdev(diffs)

    # 两侧都写:剔了谁、为什么剔,不然「n 变小」事后分不清是中断还是筛选。
    only_a, only_b = sorted(set(a) - set(b)), sorted(set(b) - set(a))
    print(f"批 A: {a_dir}  (完成 {len(a)})")
    print(f"批 B: {b_dir}  (完成 {len(b)})")
    print(f"共同完成: n = {len(common)}")
    if only_a:
        print(f"  只有 A 有 ({len(only_a)}): {', '.join(only_a)}")
    if only_b:
        print(f"  只有 B 有 ({len(only_b)}): {', '.join(only_b)}")
    print()
    print(f"A 均值      = {st.fmean([a[t] for t in common]):.4f}")
    print(f"B 均值      = {st.fmean([b[t] for t in common]):.4f}")
    print(f"配对差均值  = {st.fmean(diffs):+.4f}")
    print(f"σ̂ = sd(配对差) = {sd:.4f}")
    print(f"⇒ 判据: 此后单批对比,效果 > 2σ̂ = {2 * sd:.4f} 才算站得住")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
