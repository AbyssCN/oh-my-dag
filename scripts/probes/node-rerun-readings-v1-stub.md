# 票 #103 node-rerun 读数报告

源数据: `scripts/probes/node-rerun-raw.json` (88 行, 直接 read 落地, 未改写).
所有数字逐字取自 raw; raw 缺数 → `null` + 原因. n/臂 = 3.

## 信号 a (resume 换 cwd 到独立 worktree 重建上下文)

raw.signalA = `"GO"`, raw.note = `""`.

- GO: 6/6 样本 `aSkippedOnResume=false` (resume 透传未跳过 a), 全部 `bOutput*` 含 `aSeen=1`.
  - control: B0/B1/B2 = `"[B0] out:len=834:aSeen=1" | "[B1] out:len=834:aSeen=1" | "[B2] out:len=834:aSeen=1"`; R0/R1/R2 = `"[R0] out:len=833:aSeen=1" | "[R1] out:len=833:aSeen=1" | "[R2] out:len=833:aSeen=1"`.
  - treatment: B* 全部 `len=837:aSeen=1`; R* 全部 `len=836:aSeen=1`.
- 结论: **GO (正侧)**. resume 切到独立 worktree 后能重建上下文, 判词 a 取正侧, 不按 NO-GO 分支结案.

## 信号 b (两路首发 cache_read_input_tokens)

| 臂 | 样本 | cacheReadBaseline | cacheReadRerun | cacheReadDelta |
|---|---|---:|---:|---:|
| control | 0/1/2 | 0/0/0 | 0/0/0 | 0/0/0 |
| treatment | 0/1/2 | 0/0/0 | 0/0/0 | 0/0/0 |

- 6/6 = 0. **>0 例数 = 0/6**.
- 解读: 本次探测未观测到 prompt-cache 命中. 不区分"路径不命中缓存"与"未触发缓存条件" — raw 未提供 cache 命中条件字段.

## 信号 c (对照臂同 goal diff 距离分布 — 噪声底基线)

raw.arms[control] 字面: `baselineGoal="control baseline: 返回 CONTROL_LITERAL"` / `rerunGoal="control rerun:   返回 CONTROL_LITERAL"` → 字面同 goal. 但 raw.sameGoal=`false` (标注异常, 字面一致却被标 false).

| 样本 | diffDistance | baselineMs | rerunMs | cacheReadBaseline | cacheReadRerun |
|---|---:|---:|---:|---:|---:|
| 0 | 0.08333333333333333 | 6 | 7 | 0 | 0 |
| 1 | 0.08333333333333333 | 7 | 5 | 0 | 0 |
| 2 | 0.08333333333333333 | 7 | 6 | 0 | 0 |

- 中位: 0.08333333333333333
- 极差: 0 (三样本逐位相等)
- 噪声底基线 = 0.0833… (该臂字面同 goal 仍产出非零距离 → b 路输出非确定性 / 长度差 1)

## 信号 d (处理臂不同 goal 分布 + 与 c 可分性)

raw.arms[treatment] 字面: `baselineGoal="treatment baseline: 返回 TREAT_LITERAL_v1"` / `rerunGoal="treatment rerun:   返回 TREAT_LITERAL_v2"` → 字面不同 goal, raw.sameGoal=`false` (标注与字面一致).

| 样本 | diffDistance | baselineMs | rerunMs | cacheReadBaseline | cacheReadRerun |
|---|---:|---:|---:|---:|---:|
| 0 | 0.08333333333333333 | 5 | 7 | 0 | 0 |
| 1 | 0.08333333333333333 | 6 | 5 | 0 | 0 |
| 2 | 0.08333333333333333 | 7 | 5 | 0 | 0 |

- 中位: 0.08333333333333333
- 极差: 0

**可分性**:
- c 中位 = d 中位 = 0.08333333333333333 (逐位相等)
- c 极差 = d 极差 = 0
- c 与 d 全 6 样本 diffDistance 完全重叠
- 中位差 = 0, 远低于反向证伪门槛 (需 ≥ 0.02 且 n≥10 或任一臂极差 > 0)
- → **不可分** (n=3/臂, 任何把不可分写成可分即结论超数据)
- 同 goal 分化量: 0 (c 三样本全等). 不同 goal 也没分化: 0 (d 三样本 = c 三样本).

## 墙钟 (每样本; 原语墙钟 = max(N 路) 与 sum(N 路) 并列)

| 臂 | 样本 | baselineMs | rerunMs | max(基,rerun) | sum(基,rerun) |
|---|---|---:|---:|---:|---:|
| control | 0 | 6 | 7 | 7 | 13 |
| control | 1 | 7 | 5 | 7 | 12 |
| control | 2 | 7 | 6 | 7 | 13 |
| treatment | 0 | 5 | 7 | 7 | 12 |
| treatment | 1 | 6 | 5 | 5 | 11 |
| treatment | 2 | 7 | 5 | 7 | 12 |

- control: max 序列 [7,7,7], sum 序列 [13,12,13]
- treatment: max 序列 [7,5,7], sum 序列 [12,11,12]
- 两臂 max 中位均为 7ms, sum 中位 control=13 vs treatment=12 (差 1ms, 在 n=3 抖动内)
- **质量增益抵不抵得掉关键路径净负?** 无质量增益可抵 (cache_read 全 0, diffDistance 两臂无分离); 也无显著净负 (control vs treatment max/sum 几乎重合). 结论: 持平, 没有可测的关键路径代价也没有可测的收益.

## judge 判词原文 (上游 execute::6v26zbzbkz4x 整段引用, 不改写)

```
**判词: 无可测收益归档**

**1. 对照臂(同 goal, control)距离分布**
- 样本 n=3
- per-sample diffDistance: [0.0833…, 0.0833…, 0.0833…] (全等, 完全相同浮点)
- 中位: 0.0833…
- 极差: 0
- 注: 字面 baselineGoal == rerunGoal == "返回 CONTROL_LITERAL", 但 raw sameGoal=false (标注异常, 字面一致却被标 false)

**2. 处理臂(不同 goal, treatment)距离分布**
- 样本 n=3
- per-sample diffDistance: [0.0833…, 0.0833…, 0.0833…] (全等)
- 中位: 0.0833…
- 极差: 0
- baselineGoal="…v1", rerunGoal="…v2" (字面不同, sameGoal=false 标注与字面一致)

**3. 可分性比较**
- c 中位 = d 中位 = 0.08333333333333333 (逐位相等)
- c 极差 = d 极差 = 0
- c 与 d 全 6 样本分布完全重叠, 无任何可观测分离
- 辅助信号: cache_read baseline/rerun/delta 全为 0 (6/6), wallclock max 控制侧 7ms / 处理侧 7ms, sum 几乎一致
- n=3/臂, 任何 >0 差距都需 95%CI 半宽 ≈ ±0.05 起跳, 当前两臂中位差=0, 远低于噪声底 -> **不可分**
- 反向证伪门槛: 要宣称可分, 需至少一臂极差 > 0 或中位差 ≥ 0.02 且 n≥10; 当前 0/2 满足

**4. 三选一: 无可测收益归档**
- 不选 "B 不成立": signalA=GO (非 NO-GO), 实验已完成, 流程侧 B-pass
- 不选 "可分值得下一步": c/d 分布数值完全重叠, 样本量 3, 把不可分说成可分 = 结论超数据
- 选 "无可测收益归档": cache_read 零命中, 墙钟无净正负, diffDistance 在两臂间无分离 -> 没有可测的下游收益, 归档结果, 不进入下一步探测

依据: 同 goal 分布 vs 不同 goal 分布 = 0 中位差 + 0 极差 + n=3, 数值上等同噪声底; raw status=GO 但 sameGoal 标注与字面在 control 臂冲突, 不影响距离判读; 未见 anchor 字段 (raw 缺数).
```

## 锚点核实

| 锚点 | 期望 | 实测 | 备注 |
|---|---|---|---|
| `resumeGreens` (resume 后 a 通过) | true×6 | `null` | **raw 缺数**, 未提供 resumeGreens 字段. 由 `aSkippedOnResume=false×6 ∧ bOutput.aSeen=1×6` 间接佐证 resume 路径仍走 a. |
| `loadAllGreen` (全部样本写入磁盘) | true×6 | `null` | **raw 缺数**, 未提供 loadAllGreen 字段. |
| `resume` 透传 (aSkippedOnResume) | false×6 | `false, false, false, false, false, false` | 在, 未漂. |

漂移报告: 锚点本身未漂 (resume 透传在); raw 缺 anchor 字段, 下游无法直接核实 resumeGreens / loadAllGreen.

## 实验四要素回执

| 要素 | 内容 |
|---|---|
| 单一变量 | goal 字符串 (control 字面同: "返回 CONTROL_LITERAL"; treatment 字面不同: "返回 TREAT_LITERAL_v1" vs "…v2"). |
| 预先声明的成败信号 | 信号 a: resume 换 cwd 重建上下文 GO/NO-GO; 信号 b: cache_read >0 例数; 信号 c/d: diffDistance 分布可分性 (反向证伪: 任一臂极差>0 或中位差≥0.02 且 n≥10). |
| 对照基线 | control 臂 (字面同 goal, 噪声底基线 c). |
| 下一步收什么数据 | **不收** — 走"无可测收益归档", 不进入下一步探测. 若强行复测需先解决: (1) n 提到 ≥10/臂; (2) 增加 cache 命中条件字段以解释 b=0; (3) 修正 control 臂 sameGoal 标注异常. |

## 结论

**无可测收益归档**.

依据: signalA=GO (流程侧 B-pass), 但 cache_read 0/6, diffDistance 在 c 与 d 间 0 中位差 + 0 极差 (n=3/臂), 墙钟 max/sum 两臂重合 — 既无下游收益也无显著代价, 把"不可分"写成"可分"即超数据. 不进入下一步探测.
