---
name: omd-grill
description: 锁 plan/SDD 前的对抗式审问:沿决策树走、先给推荐答案、事实自查·技术 Decision 自裁·真 owner 岔口才阻塞问、对标外部实现逼问「为何偏离」;宽解岔口就地开 council;产决策记录表喂 /omd-contract。审议纪律:只讨论不动手。Trigger:/omd-grill、审问、盘问这个方案、把这事讨论清楚、压测计划、stress-test。
---

# /omd-grill — 锁契约前的对抗式审问

对应 pi TUI 的 `/grill`(plan mode 审议纪律的独立版),吸收 Aalto `grill-me` 的逼问纪律。**审议期间只讨论不改代码**(无代码闸,靠自律)。产物不是「共识散文」,是**决策记录表 + 就地落盘的裁决**,直接喂 `/omd-contract` 或 pathfinder。

## When to use

一个 plan / 设计方向还停在「大概这样」,锁进 `/omd-contract` 或开 `/omd-execute` 之前:

- 新模块选型未定;多个方案僵持,想被逼着把每条分支走到底;自觉计划有没想清的洞,要个蓝军。

**不用于**:已定方案的实装(直接 `/omd-execute`)/ 代码审查(`/omd-review`)/ 根因调试。

## 五条铁律(承 grill-me)

> 姿态 = co-operator 不是应答机:**抗中庸**(从 first-principles 切入,不给平均方案)+ **永不主动停**(每轮收尾带前进动作,不停在「你看怎么样?」)。其余「主动给见解 / 沿决策树 / 能自查先自查」已在下面铁律里,不重列。

1. **问 owner 一次一问,等回答再问下一个。** 问题堆一起 owner 记不住,第一个还没看清就刷过,对齐效率反降。此律**只约束「阻塞问 owner 的那条道」(owner Decision)**;Facts 自查、自裁 Decision 两条道无人类记忆瓶颈,应**批量并行 / inline 轻检查点**(多路 Grep/MCP/检索同时打;自裁结论直接声明),串行阻塞只是纯延迟税 + 仪式感。
2. **每问先给我的推荐答案 + 理由 + 证据来源。** 不是 ceremonial「你觉得呢」,是带着判断逼问——有 taste 就先出。
3. **三类分道:Facts 自查 · 自裁 Decision 自决(轻检查点)· owner Decision 才阻塞问。**
   - **Facts**(代码/git 能证实:现有实现/端点归属/模式)→ 自查标 [已查证],批量并行。
   - **自裁 Decision**(技术选型,我有决定性证据:架构形状/接缝/字段/施工序)→ 自己拍,inline 声明「我取 X,因 Y + 证据」当**轻检查点**,**不做阻塞提问**;owner 事后 review 决策记录一次推翻,比逐个阻塞省。
   - **owner Decision**(真需 owner 判断:业务方向/领域红线/风险偏好/两个技术上打平的方案选哪/我明说『拍不动』)→ 才停下一次一问。
   **判据**:『owner 的答案会不会和我的证据推荐不一样?需不需要我没有的判断(业务/风险/偏好/红线)?』否 → 自裁;是 → 问。**把自裁得了的 Decision 做成阻塞提问 = 仪式感,本 skill 要防的正是它**——反例证据:owner 驳回浅推荐的最佳案例往往发生在**普通推荐流程、非 grill**,故 asking 不独占该价值,默认自裁 + 轻检查点。
4. **沿决策树走,先解依赖再解叶子。** 上游决策(数据模型/状态机/边界)没定之前不问下游(字段命名/UI token)。
5. **对标外部实现,逼问「为何偏离」。** 有外部标杆(同类 repo/论文/框架最佳实践)就 **live 拉来当对抗基准**(runtime 原生 web / `dag_research` 检索版 / `context7` MCP):「标准做法是 X,我们做 Y——偏离是 first-principles 的选择还是无知?理由站得住吗?」`first principles > stackoverflow`,但**偏离要能自证**,不是没看过别人怎么做就拍脑袋。

## 宽解岔口 → 就地开 council

grill 是**纵向掘深**:HITL 交互、串行、单视角,把一条决策线盘到底。遇到岔口是**宽解空间 + 拿不准**(多个合理方案、领域红线、架构选型),别自己拍平均答案 → **就地 fire `/omd-council`**(`dag_research` council 模式):多 persona 并行出方案 + judge 择优 + 嫁接亚军亮点 → 把冠军作为「我的推荐答案」带回 grill 继续逼问。

```
grill 沿决策树走
  ├─ 岔口是 Facts / 窄解 ── grill 自己拍(先给推荐答案 + 证据)
  └─ 岔口是宽解 + 拿不准 ── /omd-council 多 lens 并行 → judge 冠军 + 嫁接亚军
                              → 冠军回填「我的推荐」→ grill 继续逼问 → owner 裁
```

**正交两轴**:grill = 纵向掘深(一条线到底),council = 横向铺宽(N 视角并行择优)。窄解/Facts 自己拍,宽解岔口才下探 council。反向也成立:council 出了冠军 → 用 grill 对抗压测那个冠军再锁契约(择优 + 证伪双闸)。

## 流程

### 1. 画决策树
从当前 plan 抽出待定决策,按依赖排序。根 = 改变全局的抉择(存储模型/进程边界/状态机形状),叶 = 局部细节。先根后叶。

### 2. 逐问下钻
每个决策一问,格式:
```
[决策 N/总数] <问题>
  我的推荐: <答案> — <一句理由 + 证据来源(file:line / 召回 / council 冠军)>
  影响: <这个选择锁死/解锁了哪些下游决策>
```
能自答的先自答并标 `[已查证: …]`,只在需 owner 拍板处停下等回复。宽解岔口先 council 再带回。

### 3. 边问边落(不堆到最后)
决策一旦定型,**当场记下它落到哪**:
- 小事 / 一句话决策 → `/omd-note`(记进 `docs/plan/NOTES.md` 台账,供 `/omd-contract` 收割);
- 成体系的活 → 开 pathfinder 票 `map_add` 并当场 `/omd-rule` 裁决落盘;
- 命中将来的**验收标准 / 接口契约** → 记进它该落的 SDD 章节(留给 `/omd-contract`)。

### 4. 收尾输出「决策记录」
审问结束给一张表,**不是散文**:

| # | 决策 | 定论 | 落点(/omd-note · pathfinder 票 · SDD 章节) | 证据 |
|---|------|------|--------------------------------------------|------|

未解项单列「待 owner / 待实测」。这张表直接喂后续 `/omd-contract` 结晶或 `/omd-execute`。

> **不设 ceremonial 确认闸,但决策权不下放**(owner 全自决 + anti-ceremonial):决策记录表直接喂 SDD,不停下等「OK 吗?」。mattpocock 原版第 5 行「confirm 前不动手」的本义是**决策权转移**(人类=建筑师,拍板权归人),不是弱模型护栏——我们移除的只是那层 ceremonial「OK?」,决策权经 Facts/Decisions 分道保留:Decisions(需 owner 业务判断的)一律停下问 owner,authority 没丢。

## 与既有 skill 的边界

- `/omd-grill` 在 **plan 之前** 把方案问透;`/omd-review` 在 **实装之后** 审代码。
- 宽解岔口 → `/omd-council`;定型结论 → `/omd-note` 或 `map_rule` 落盘;审议收敛 → `/omd-contract` 结晶成文档。
- 审议对象是 pathfinder 票时:**轮次落票 + 三通道带宽路由(本地/手机/GitHub评论)见 `/omd-path`**(已泛化,任何票通用,不再 grill 专属);裁决后 `map_rule` 落盘。
- 审问产出的契约由后续 `/omd-contract` 主写进文档,不在本 skill 内写实现。
