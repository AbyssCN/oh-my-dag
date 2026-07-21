---
name: omd-dream
description: 记忆巩固(同步):经 omd dream_consolidate 把近期事件窗压缩进 L0–L6 记忆层,带节制三闸 + 层级红线 + 健康比自检,只留 derived 洞察不吞业务真相。Trigger:/omd-dream、记忆整理、巩固记忆、consolidate memory、跑一次 dream。
---

# /omd-dream — 记忆巩固

对应 omd 的 dream 巩固管线。经 omd MCP 的 `dream_consolidate`(可能带 `mcp__omd__` 前缀;未加载先 ToolSearch "dream_consolidate")把近期事件窗口里的洞察归并进七层记忆(L0–L6:durable fact 带 namespace/confidence)。**巩固不是把所有事件都记下来,而是过三道闸、只留少量高价值 derived 洞察。**

## 用法

无参数。适合:长会话收尾、一批任务完成后、owner 说「整理一下记忆」时。`dream_consolidate()` **同步返回**(不走 runId 三段式)但慢(要过模型),调用后耐心等,别超时重发(重复整理 = 重复烧模型)。空窗口不调模型,直接回「无可整理」。

## 节制三闸(只留 derived,不吞真相)

巩固前每条候选洞察过三关,任一不过即丢:

1. **UTILITY** — 是不是**将来用得上**的 derived 洞察(偏好/模式/教训/承诺/deadline)?一次性、无复用价值的丢。
2. **SoT 排除** — 是不是**业务真相源**(发票/分录/财务数字/文档正文/事实数据)?是就丢——真相住它自己的库,记忆层不做副本,复制 = 日后两份打架。
3. **禁忌命名空间** — 落在隐私/敏感类别(个人身份/监控/特殊类别数据)?丢。

留下的应该**很少**:一轮巩固产出几条 fact 是常态,产出几十条是过度记录的信号。

## 层级红线(不可绕过)

- **L3 业务真相层永不碰** — 任何想写 L3(业务关系/事实数据)的候选**直接硬拒 + 记审计**,绝不 INSERT/UPDATE/DELETE。
- **写 fact 必经校验闸** — 每条落 durable 层的 fact 都过校验;被拒的 fact 单独记录,不静默塞进记忆。
- **无载体的层走 deferred** — 某层暂无存储载体时走 deferred 分支并记审计,**绝不伪造「写成功」**。

## 健康比自检

巩固结束看 `facts_extracted / events_processed`:

- 健康 **< 5%**;若 **> 20%** → 过度记录信号,该收紧提炼提示词(在记什么本不该记的?)。
- 转述给 owner 时按层讲「巩固了什么类型的洞察」,有 namespace 冲突或低置信候选提示人工过目。

## 与既有 skill 的边界

- `/omd-dream` = 把近期**事件窗压缩成 durable facts**(写入侧,批量、慢、同步)。
- **不用于**:推理卡住时**主动召回**既有记忆 → `/omd-recall`(读取侧);单条决策/引用**手动记台账** → `/omd-note`。
