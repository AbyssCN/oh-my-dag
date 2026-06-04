---
name: council
tier: capability
runtime: on-demand
trigger: mention
description: "多视角并行生成 + 评判择优 (一组专家'开会'审议出冠军): 面对宽解空间的设计/决策, 派 N 个不同 persona+angle 并行出方案 → 多 lens judge → 择优合成 (嫁接亚军亮点), 而非一次性给平均答案. Trigger: 多个方案 / 对比方案 / best of n / bestof / fanout / council / 并行探索 / 多视角 / 给我几个选项 / 哪种方案好 / 方案对比 / explore options / 拿不准选哪个. Skip: 单一明确解 (直接做) / 纯执行无需择优 / 代码审查 (/review) / 根因调试 (/investigate)."
metadata:
  source: valar (plan/best-of-n + research/fanout)
  version: "1.0.0"
  methodology: "diversity>volume + persona conditioning + multi-judge panel + graft runners-up"
---

# /council — 多视角并行生成 + 评判择优

> 解空间宽时,一次性答案 = 落在概率分布的**平庸中心**。fanout 用**多样化 persona** 把生成拉进不同专家区,**多 lens judge** 抵单评判者偏见,**择优 + 嫁接**取各方案精华。
> 这不是"重采样 N 遍"——那是边际递减的体积堆叠。fanout 的核心是 **diversity > volume**。

## 何时用

- **架构/设计抉择**: 多个站得住的方向,取舍真实(性能 vs 简洁 vs 可逆)。
- **难逆决策**: 选错代价高,值得多视角对抗后再定。
- **方案对比请求**: 用户明说"给我几个选项 / 哪种好 / 拿不准"。
- **深度研究**: 一个问题需多专家视角 + 子角度覆盖(用深度档)。

## 何时不用 (anti-slop)

- 单一明确解 → 直接做,别为仪式感 fan out。
- 纯执行(已定方案的实装)→ execute,不择优。
- 代码审查 → `/review`;根因调试 → `/investigate`。

## 两档机制 (valar 已实装)

### 轻量档 — `/council` (plan mode, 底层 best-of-N)
plan mode 内 `/council`: 当前审议 context → **3 个 default lens** 并行出方案 → 多视角 judge 评分 → cherry-pick 合成注入下轮。适合**一次设计抉择**。(底层算法 = `bestOfNPlan`。)

3 个 default lens(`DEFAULT_PLAN_LENSES`,每个 = persona + angle + 采样调制):
| lens | persona | angle | temp/topP |
|---|---|---|---|
| `mvp` | 务实交付型工程主管 | 最小可行切口, 最快验证闭环, 砍非核心 | 0.4 / 0.85 |
| `risk` | 资深 SRE + 安全工程师 | 从失败模式/边界/不可逆点倒推, 先堵风险 | 0.5 / 0.9 |
| `first-principles` | 第一性原理思考者 | 重构问题本质, 质疑前提, 找最简结构 | 0.75 / 0.95 |

### 深度档 — `researchFanout` (at scale)
`src/valar/research/fanout.ts`: **L lens × V sub-angle 变体** → per-lens judge reduce 成冠军 → M framing 综合 → **K-judge panel + graft** → 最终方案。每 leaf 注 persona + 高阶领域抽象框架 + groundTruth。适合 foundational 决策 / 深度调研(量任务驱动,L=真实专家视角数,V=该 lens 真实 sub-angle 数)。

## 核心纪律 (照搬这 4 条,无 code path 时手动 fan out 也守)

1. **多样性 > 体积**: lens 内是 V 个**不同 sub-angle**,不是同一 prompt 重采样 V 遍(后者边际递减)。
2. **persona conditioning**: 每 leaf 注一行 ROLE + 视角/第一性 lens,把(弱)模型从通用区搬进专家区——搬概率质量逃平庸。低 temp = 忠实,高 temp = 探长尾。
3. **多 judge panel**: foundational 决策单 judge 有系统偏见 → K 个**不同评判维度**(正确性/简洁/风险)各评一遍,adversarial-verify。
4. **嫁接亚军 (graft)**: 不是选一个丢其余——从冠军合成,但把亚军的亮点 cherry-pick 进来。

## 手动 fan out (无 plan mode / 大规模时)

1. 定 N 个**真正不同**的视角(默认 mvp/risk/first-principles,或按任务定专家角色)。
2. 每视角注 persona + angle,**并行**各出一个完整方案(独立, 不互看)。
3. 用 ≥2 个不同 lens 各 judge 一遍(别用单一标准)。
4. 从最高分合成,嫁接其余方案的独特优点 → 一个最终方案 + 取舍理由。

> 收尾必给:**冠军方案 + 为何胜 + 从亚军嫁接了什么**(不是 N 选 1 的裸结论)。
