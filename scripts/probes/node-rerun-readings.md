# 票 #103 node-rerun 两臂读数 —— 终稿 (stub 臂 + 真模型臂, 2026-08-17)

> 两次测量, 两把尺子各自失效在相反的一端 —— 这本身就是本实验最硬的读数。
> v1 (stub 臂, run 216f30a1 产物) 存档于 `node-rerun-readings-v1-stub.md`;
> raw: `node-rerun-raw-v1-stub.json` (stub) / `node-rerun-raw-real.json` (真臂)。
> 真臂 = `--real` 旗标: 摘掉注入 generate, 走真 leaf 座 (minimax-cn:MiniMax-M3),
> goal/plan/resume 机制一字不动 (单一变量 = 模型真/假)。

## 信号 a · resume 换 cwd 到独立 worktree 重建上下文 —— **GO (两臂一致)**

- stub 臂: 6/6 GO。
- 真臂: 机制锚点全过 —— A 命中 checkpoint 跳过 (`smokeASkipped=true`) · 绿节点 2 ·
  resume 透传在 · B 真重跑并返回。第一次真臂被 smoke 判据③ (字节相等) 误闸 ——
  那是 stub 时代不变量, 真模型下字节不等**正是 c 要量的噪声**; 已把③限定 stub 臂
  (探针注释记了理由), 复跑 GO。
- **结论: B 路线 (跨 worktree resume) 机制成立。O-2 的真问题答完, 正侧。**

## 信号 b · 首发 cache_read_input_tokens —— **真臂 >0 (C-9 正侧)**

- stub 臂: 0/6 (stub 无 provider 遥测, 不算数)。
- 真臂: control 148×3 · treatment 472×3 (真 provider 遥测, 逐样本恒定 —— 同 prompt
  前缀命中同段缓存, 形状合理)。
- **结论: C-9 提前验到 —— 不写新原语, 节点级 resume 的 rerun 发已吃到 prompt cache。**

## 信号 c/d · 同/不同 goal 的 diff 距离可分性 —— **在两把尺子上都不可判**

| 臂 | stub (v1) | 真臂 (v2) |
|---|---|---|
| c (同 goal) 全样本 | 0.0833 逐位相等, 极差 0 | **1.0000 逐位相等**, 极差 0 |
| d (不同 goal) 全样本 | 0.0833 (=c) | **1.0000 (=c)** |

两次"任何干预下都不动的数", 方向相反, 都在量尺子:
- stub 臂: 确定性假模型 ⇒ 零方差是**构造使然** —— c 量不到真噪声底;
- 真臂: 行级 Jaccard 在 M3 散文上**饱和** —— 同 goal 重跑两份输出没有一行逐字相同
  ⇒ 距离恒 1.0, 尺子打满, d 没有任何高于 c 的余地。

**这不是"没有分化", 是"行级确定性比较器对真模型输出零分辨率"。**
而它恰恰回答了裁决判词真正关心的事: fork 择优需要一把**便宜的确定性尺子**;
实测行级尺子两端失效 ⇒ 择优只能靠语义 judge (每 fork 一发 LLM 判卷) ——
成本结构回到 exec-fork 封存裁决点名的"过早优化"。

## 墙钟 (真臂, ms)

- baseline: 4775–12476 (中位 ~6.7s) · rerun: 3072–9278 (中位 ~4.0s)
- rerun 中位 < baseline 中位: A 节点被 resume 跳过, 只烧 B —— 节点级 rerun 的
  墙钟收益真实存在 (省的是被跳过节点), 但这是 resume 本来的收益, 不是 fork 的。

## 三选一判词: **无可测收益, 归档 —— 带解冻条件**

- 不选「B 不成立」: 信号 a 两臂 GO。
- 不选「可分值得下一步」: c/d 在现有尺子上不可判, 把不可判写成可分 = 超数据。
- **选「归档」**, 判据链: 择优的前提是廉价 oracle 能分辨 fork 产物; 行级确定性尺子
  实测两端失效 (stub 归零 / 真臂打满); 换语义 judge 当尺子 = 每 fork 付一发判卷,
  即封存裁决点名的成本形状。exec-fork 维持封存。
- **解冻条件 (可证伪)**: 出现一把便宜的中分辨率距离尺 (如本地 embedding 余弦 /
  token 级 Jaccard) 且在「同 goal n≥10」上量出**非退化**噪声底 (0 < c < 1, 极差 > 0)
  —— 那时 d 的可分性才第一次变得可测, 再复量。

## 顺带捞到的引擎读数 (不属本票, 已各自记账)

- run 216f30a1 终态 failed 而冻结判据盘上绿 —— 图内 empty-done 拒绝级联把终态压红,
  产物真身完好; 交付缺 commit 步 (#148 侧已立案) 再次出现。
- 「写文件节点 conductor 标成非 agent → 提升 agent」闸在本 run 真拦到一次。
