---
name: omd-rule
description: 裁决 omd pathfinder 前沿票(记录 owner 决策到真相文件),写 ruling 前过终裁判定树(真源三层/灰态三画法/敏感清单)。仅 owner 明确裁决时用。Trigger:/omd-rule、裁决、就这么定、按方案X来。
---

# /omd-rule — 裁决一张票

调 omd MCP `path_rule`(可能带前缀 `mcp__omd__`;未加载先 ToolSearch "path_rule"),参数 `ticketId` + `ruling`(多图带 `slug`)。

裁决怎么落地看后端:md 后端写进 `docs/plan/pathfinder/<slug>.md` 的票 status/ruling;gh 后端写一条 **resolution 评论**(首行约定 `**ruling**: <text>`)并 close 对应 issue。两后端语义等价。

裁决成功后工具还把「<destination>: <票 title> 裁决 = <ruling>」写进 omd 自记忆(`omd.pattern` fact),供 memory_recall / 会话开场检索复用;这步是增益,写失败只 warn(输出里 `⚠ … memory 是增益`)不阻断裁决本身。

## 纪律:裁决权属于 owner

- 只有 owner 明确表达决定("就用 SQLite"、"按方案 B 来"、"/omd-rule t3 …")才调。你的角色是把口头决定**提炼成一句清晰 ruling**——task 票的 ruling 会成为将来 slice 节点的执行目标 goal,要写到弱 executor 也能独立完成。
- owner 表达模糊 → 先复述你理解的裁决让其确认,再落。
- 裁决后工具重算前沿回报解锁/散尽。**区域散尽只是报信**——执行永远等 owner 显式 /omd-deliver,不自作主张接着交付。

## 写 ruling 前过判定树(承终裁手册)

裁一张 task 票 = 一次终裁。这几件事在 ruling 里先判清,别留给弱执行体乱猜:

### 1. 真源三层分离(最重要)
「有没有真源」是三个问题,分开答,别混成一个 defer:

| 层 | 问题 | 缺了怎么写 ruling |
|---|---|---|
| 读面 | 契约/端点/字段存在吗 | 缺 → ruling 含「先建读面」 |
| producer | 有东西往里写吗 | 缺 → **照常实装读面**,注明 producer 是哪张票的活;不算造假 |
| 数据 | 有样本吗 | 缺 → ruling 含「扩 seed,只用真机制造数」 |

错误做法:因 producer 缺就把票裁成 defer(= 静默砍范围)。

### 2. 灰态三种合法画法(上游能力物理不存在时)
外部 API / 定时任务 / 凭证链真不存在 → 灰,只三种画法,ruling 指明哪种:
1. **无源恒缺席**:数据键不出现,前端显 "—"。
2. **断链说明卡**:禁用态 + 断链图标 + 原因句,**零假数据**(方案画了假明细也不渲染)。
3. **灰常量即真值**:管道不存在时状态就是常量,不需要状态端点(端点等上游一起来)。

判别:方案自己画了断链/禁用态 = 灰态确证,不是 defer 借口。

### 3. 有据偏差(唯一合法的偏离)
实装语义比方案**更准**时可偏离,条件 = ruling 写明依据一句话。说不清依据 → 照方案做或标 `?`。

### 4. 敏感判定(哪些不能自裁,标 `?` 等 owner)
**敏感**:签核/审批闸、修改/冲销通道、状态机转移与过账、金额/税率派生公式、契约字段语义变更、DB 层不变量迁移、删既有闸。
**不敏感(可直接裁)**:读面聚合、展示派生(排序/格式)、i18n、seed、灰态卡、前端交互态。
判别:错了会污染账面或绕过审计 = 敏感;错了只是显示难看 = 不敏感。

## 撤销/改判
地图是 `docs/plan/pathfinder/<slug>.md` 人可编辑 markdown,直接改 status/ruling(未知状态词不丢票,进 unrecognized 分组)。

## 与既有 skill 的边界
- omd-rule 只**裁决**(记决定);**执行改文件**是 /omd-deliver 的权力闸,裁完不自动交付。
- 裁前方案未定 → 先 /omd-grill 审问或 /omd-council 择优;裁不动的敏感项标 `?` 升级 owner。
