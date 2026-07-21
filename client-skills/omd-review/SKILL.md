---
name: omd-review
description: 对一批 diff 做对抗式多维 DAG 审查(正确性/契约),gate 阶梯控深度,产 findings 报告;finding≠真理,按误报裁决程序证伪后再定性。Trigger:/omd-review、审查这批改动、代码审查、review diff、release 闸。
---

# /omd-review — 对抗式改动审查

经 omd MCP `dag_review`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_review")对一批改动派多维度对抗审查 DAG。

## 用法(异步三段式)

- `gate`:`G0` 浅扫(快/便宜)· `G1` 轻量 · `G2` 默认(branch diff 全维度)· `G3` release 闸(spec 轴强制对照 SDD)。不给 = G2。
- `scope`:收窄审查范围(路径/模块);不给 = 当前 branch diff 全量。

1. `dag_review(gate?, scope?)` → `runId`;
2. `dag_status(runId)` 轮询(跑几分钟,别重复发起);
3. `dag_result(runId)` → **报告落盘路径**,自己 `Read` 再转述(按严重度先讲 top 项)。

## 误报裁决程序(承终裁手册:finding ≠ ground truth)

车队产出是**候选**,你终裁。每条 finding:
1. **定位代码事实——必须看 diff 视野外**(审查器只看 diff,这是误报主源)。
2. **oracle 证伪**:typecheck / 测试 / 活库实测 / 既有测试钉。
3. 证伪成立 → 驳,**记驳的依据**;证伪不了 → 修;拿不准 → `?` 升级 owner。

**已知误报模式(直接警惕)**:
- 「X 未导出/未定义」而 X 是 diff 外既有代码(ugrep 确认真身,build 绿即证伪)。
- 「缺权限守卫」而守卫以 JOIN/EXISTS 已在查询里(空集测试即证伪)。
- 用「可能/如果内部没校验」推测行为——去读那个函数,不接受推测性 P0。

## gate 分档:插在 ROI 高处,别铺满(承终裁手册)

审核 ROI = P(缺陷) × 逃逸代价 ÷ 成本。
- **P(缺陷)高** = 机械铺量 / 敏感接缝(会计写·状态机·迁移)/ 大 diff。
- **逃逸代价高** = 账面污染 / 绕审计——错了是灾难,再贵也审(上 G3)。
- 小改 + 自己写 + typecheck/test 全绿 → G0/G1 够,别 G3。
- 0 P0/P1 ≠ 白审,可能是"插错位置"信号:过程审(写码前判定)> 结果审(post-code gate)。

## 与既有 skill 的边界
- omd-review = 对 diff 的**通用正确性**审查。**专项安全**(信任边界/注入/fail-open)→ /omd-audit;**确定性 semgrep** → /omd-sast;**只找过度工程** → /omd-slim;**某失败的根因** → /omd-investigate。
