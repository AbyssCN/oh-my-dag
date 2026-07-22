---
name: omd-debug
description: 系统化根因调试:历史搜索→复现→scope lock→模式匹配→假设验证→修复→验证→报告 + 修完扫同类。铁律:无根因不修。Trigger:/omd-debug、debug、调查、排查、为什么挂了、这个bug、根因分析、investigate、stack trace、昨天还好的。
---

# /omd-debug — 系统化根因调试

> **铁律:无根因不修。** 修症状 = 打地鼠。找到根因再动手,诊断阶段禁提修复方案。

方法论 skill:单线程串行用 runtime 原生 Grep/Read/git 走完 8 阶段;**假设验证需并发多路时派 omd `dag_debug`**(一假设一 leaf + skeptic 跨模型证伪 + codegraph 锁范围 + 三振纪律,见 Phase 5)。

## Phase 1 — 历史搜索(先查后调)
同一消息并行发:`git log --oneline -20 -- <相关文件>`(近期变更)+ Grep 既有 `docs/plan/`·NOTES·error 记录搜错误关键词(有先例走 /omd-recall 先召回)。命中已知修复 → 直接引用,跳到修复。

## Phase 2 — 复现
确定性触发 + 存证据(错误信息/堆栈/复现步骤)。信息不足 → 逐个追问(一次一问)。不能稳定复现 → 收集更多证据再继续,别猜。

## Phase 3 — Scope Lock
从症状追到最窄受影响目录,声明范围;此后 Edit 只在范围内,越界先问 owner。危险信号立即停:「顺手修个相关的」(不顺手,记 follow-up)、「既然在改不如重构」(不重构,本 bug 修完再评估)。

## Phase 4 — 模式匹配
先 step-back 自问:这类症状(数据不一致/超时/类型错/竞态/权限泄漏/schema 漂移)在本技术栈通常由哪层引起?建宏观诊断框架再缩范围,别直接跳到最"像"的模式。**同文件反复修 bug = 架构问题,不是巧合**。

## Phase 5 — 假设验证(最多 3 个)
每假设三步推导:**观察**(引 file:line 我看到什么)→ **推论**(若成立还应看到什么)→ **验证**(设计能区分成立/不成立的实验)。追踪表标 CONFIRMED/REJECTED。先验证再修(可疑根因处加临时 log/断言,跑复现看证据是否吻合)。**三振出局**:3 个假设全败 → STOP 问 owner(A 继续有新假设 / B 升级人工 / C 埋点观察)。危险信号:还没追数据流就提修复 = 在猜。

> **并发扇出 → 派 `dag_debug`**:假设多、想并行验(一假设一 leaf + skeptic 证伪 + judge 收敛)而非单线程串行时,派 omd `dag_debug`(failure 必填,`repro`/`oracleCmd` 可选)。它把本阶段的假设验证 DAG 化,同守本 skill 铁律(无根因不修 / 默认只提议不改文件 / 三振停升 owner)。复现拿 red + codegraph 锁范围由引擎代跑;finding≠ground truth,回来仍你终裁。

## Phase 6 — 修复
根因确认后最小改动:最少文件、最少行,不顺手重构相邻代码。写回归测试(不修 FAIL、修后 PASS),跑测试套件贴输出。改 >5 文件 → 问 owner(bugfix 爆炸半径偏大:继续 / 拆分 / 重想)。

## Phase 7 — 验证闭环
复现原始场景确认已修 + 跑变更相关验证。不说"应该能修好",验证并证明。

## Phase 8 — 报告 + 扫同类
报告:症状 / 根因(为什么)/ 模式 / 修复(file:line)/ 证据 / 回归测试 / 状态(DONE · DONE_WITH_CONCERNS · BLOCKED)。**修完扫一片**:用根因反推同类——Grep 同 pattern(根因是"缺 scope 过滤" → 全仓找所有 db 访问点;"未校验入参" → 找所有 untrusted 入口)。>5 处别一次全修,修 1-2 关键,其余记 NOTES 留 follow-up。

## 与既有 skill 的边界
- omd-debug = 某**失败**的**根因**调查。**审一批 diff 找 bug** → /omd-review;**扫安全漏洞** → /omd-audit;**找过度工程** → /omd-slim。修复方案涉及大改前可用 /omd-grill 审。
