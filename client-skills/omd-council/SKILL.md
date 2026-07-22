---
name: omd-council
description: 多视角专家议会:宽解空间的设计/决策问题,经 omd dag_research(council 模式)并行多 persona 出方案 + 多 lens 择优;领域岔口走接地档(反 happy-path)。Trigger:/omd-council、开会审议、多方案对比、给我几个选项、拿不准选哪个。
---

# /omd-council — 多视角议会

宽解空间(多个合理方案、拿不准)别给平均答案——调 omd MCP `dag_research`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dag_research"),`council: true`。解空间宽时一次性答案落在概率分布的**平庸中心**;多样 persona 把生成拉进不同专家区,多 lens judge 抵单评判偏见。**diversity > volume**,不是重采样 N 遍。

## 用法

- `question` = 问题 + 你整理的上下文(现状/约束/已知选项);`council: true`;深题加 `super: true`(全 framing × 全评判维度)。
- 返回 `{runId, reportPath, summary}`——summary 进对话,**全文在 reportPath**(.omd/research/),关键决策 Read 报告看各 lens 冠军 + 评审细节,别只看 summary。
- 转述:冠军 + 为何胜 + 从亚军**嫁接**了什么(不是 N 选 1 裸结论)+ 你自己的判断(你有议会没有的对话上下文)。

## 三个 default lens(persona conditioning)

| lens | persona | angle |
|---|---|---|
| mvp | 务实交付型工程主管 | 最小可行切口,最快验证闭环,砍非核心 |
| risk | 资深 SRE + 安全工程师 | 从失败模式/边界/不可逆点倒推,先堵风险 |
| first-principles | 第一性原理思考者 | 重构问题本质,质疑前提,找最简结构 |

## 接地档(领域岔口 · 反 happy-path)

领域正确性岔口(会计/法务/运营)+ 真实世界脏乱 + 选错难逆 → 默认 lens 太泛,换四步:

1. **市场先验(别假设)**:先用 `dag_research`(普通检索版,不开 council)查竞品/实务真实做法,当 persona 的硬证据基线。query 要短(长 query 检索零结果 → 拆焦点词)。
2. **领域角色 persona**:换题目真实角色——每天干这活的操作者 / 合规审计 / 自动化第一性 / 生命周期末端(如年底关账)。各角色独立并行判、不互看,都喂步骤 1 的硬证据(从事实吵不从 vibe)。
3. **判据轴 = 反 happy-path 场景**:明令用脏数据 · 并发 · 部分失败 · 跨边界 · 生命周期末端 · 量级膨胀去判每个选项(「auto-X 在年底会不会滚成噩梦」),否则 persona 也按 happy-path 答。
4. **judge 择优 + 嫁接**:看**共识**(全票同向 = 强信号);冠军 + 嫁接正交亮点(最优解常是让争论变小,非选一项)。**领域红线不下放**(council 作输入,owner 终裁);收敛 owner 直觉的对内核,不硬否。

## 与既有 skill 的边界
- omd-council = 宽解空间**横向铺宽**多方案择优。**纵向掘深单条决策线** → /omd-grill(岔口可 fire council);**审已写代码** → /omd-review;**根因调试** → /omd-debug。
- 单一明确解直接做;定型结论走 /omd-note 或 path_rule(/omd-rule)落盘。
