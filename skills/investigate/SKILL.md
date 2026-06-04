---
name: investigate
tier: capability
runtime: on-demand
trigger: mention
description: "系统化 debug 根因调查: 8 阶段 history search / reproduce / scope lock / pattern match / hypothesis test / fix / verify / report. Iron Law: 无根因不修. Trigger: 调查 / debug / 排查 / 为什么挂了 / 这个bug / investigate / 根因分析 / 错误报错 / 500 / stack trace / 昨天还好的. Skip: 通用代码审查 (/review) / 验证 (/verify) / 计划重构 (/implement)."
metadata:
  source: claude-skills
  version: "1.0.0"
---
# /investigate -- 系统化调试

> ⚠️ **`$B snapshot` 引用 deprecated**（2026-05-01, 2 处轻依赖）
>
> 行 49 / 254 的 `$B snapshot -i` UI bug 截图引用 — `$B` daemon 已删，调用时改用 `/e2e-testing --browser` 截图或 Chrome CDP. 主流程不受影响（investigate 8 phases 不依赖浏览器）。
>
> Migration spec: `docs/plan/PLAN-2026-05-01-b1-dollar-B-chrome-cdp-migration.md`
>
> ---
>
> **铁律: 无根因不修复。** 修症状 = 打地鼠。找到根因再动手。
>
> 来源: core-rules-full.md §10.1 Bugfix 流程 + gstack investigate 模式

## 输入

- 必须: bug 描述（错误信息/截图/复现步骤）
- 可选: `--skip-history` 跳过历史搜索（确认是新问题时）
- 可选: `--module <dir>` 预设 scope lock 目录

---

## Phase 1: 历史搜索（先查后调）

> core-rules-full.md §1: "遇到失败先搜 sessions Dead Ends -> 再搜 error-journal -> 最后从零调查"

**在同一消息中并行发出 3 个调用:**

| # | 工具 | 目标 | 提取 |
|---|------|------|------|
| 1 | Read | `.claude/knowledge/error-journal.json` (limit=200) | 已知 P0/P1 问题 + 已有修复 |
| 2 | Grep | `.claude/sessions/*.md` 搜索 "Dead End" + 错误关键词 | 历史死胡同 |
| 3 | Bash | `git log --oneline -20 -- <affected-files>` | 近期变更 |

**匹配规则:**
- error-journal 有相同 pattern -> 直接引用已知修复，跳到 Phase 6
- session 有 Dead End 匹配 -> 标记 "已知死路"，避免重复尝试
- 无匹配 -> 继续 Phase 2

`--skip-history` 时跳过此阶段。

---

## Phase 2: 复现

确认 bug 存在，捕获证据。

1. **收集症状**: 错误信息、堆栈、复现步骤。信息不足时用 AskUserQuestion 逐个追问（每次只问一个）
2. **复现**: 能否确定性触发？不能 -> 收集更多证据再继续
3. **证据快照**: 保存错误输出/截图。UI bug 用 `$B snapshot -i` 捕获

**输出**: `## 症状确认` -- 简述现象 + 复现方式

---

## Phase 3: Scope Lock（K8 Iron Law · 2026-04-27 §S2.9 强化）

识别受影响模块，限制编辑范围防止范围蔓延。

> **协议**: 见 `.claude/skills/_modules/scope-lock/MODULE.md`（K8 内核 · S2.8 落地）。
> 本 Phase 是 scope-lock MODULE 的消费方，遵守 Iron Law: investigate 期间不改 scope 外代码。

1. 从症状追溯代码路径，确定最窄受影响目录
2. 声明 scope lock:

```
SCOPE LOCK: src/dag/dispatcher.ts + src/dag/
原因: bug 在 DAG 派发模块，不涉及其他区域
锁定时长: 30min auto-timeout (与 scope-lock MODULE §Step 3 一致)
```

3. **此后所有 Edit/Write 必须在 scope 内**。需要修改 scope 外文件 -> 先向 the owner 确认
4. `--module <dir>` 预设时直接使用
5. **mode 联动**（scope-lock MODULE §与 cognitive-modes 联动）:
   - M1 rca / M3 subtraction → scope lock 默认 ON
   - 其他 mode → scope lock 默认 OFF

**跨模块 bug**: scope 不明确时注明原因，不锁定，但每次编辑前自检是否必要。

**违反 Iron Law 信号**（出现立即停 + 重新评估）:
- "顺手修个相关问题" → 不顺手，记 _NEXT.md 留 follow-up
- "既然在改这个文件不如重构一下" → 不重构，本 bug fix 完再评估
- "scope 外文件影响这个 bug 看起来" → 不假设，回 Phase 1 重新追溯

**关联 §5 frame**:
- FR-9 Focus subtraction（"什么不做"）— Scope Lock 是该 frame 的硬实施
- FR-2 Blast radius instinct — 限制本次 fix 的 blast radius 到最窄 dir

---

## Phase 4: 模式匹配

<!-- reasoning-tool: step-back (docs/standards/PROMPT-STRUCTURE-STANDARD.md §4.4) -->

在对照具体模式之前，先自问:
> "**这类症状**（{症状类别: 数据不一致/超时/类型错误/重复派发/权限问题}）在 Bun/Hono daemon + 自托管 PG + DAG/memory 架构下通常由什么层级的问题引起？"

建立宏观诊断框架后，再用框架缩小具体模式匹配范围。这避免了直接跳到最"像"的模式而忽略更深层原因。

对照 8 种已知 bug 模式（core-rules-full.md §10.4 的 6 种 + 2 种 valinor PG/daemon 特有）:

| # | 模式 | 特征 | 排查方向 |
|---|------|------|----------|
| 1 | 竞态 | 间歇性、时序依赖 | DAG tick 并发无 CAS (DAG-R1)、Promise.all 顺序、loop fire-and-forget |
| 2 | Nil | TypeError, undefined | 可选值缺少守卫、`?.` 链断裂 |
| 3 | 状态损坏 | 数据不一致、部分更新 | 事务缺失、event cursor 漏行 (timestamp 而非 bigserial id) |
| 4 | 集成 | 超时、意外响应 | WeCom/Lark callback、postgres-js pool、RAG cross-db、RC client WS 超时 |
| 5 | 配置漂移 | 本地 OK / NAS 挂 | env 变量、`.env`、NAS docker compose、feature flag |
| 6 | 缓存 | 旧数据、刷新后正常 | client-context LRU=5、dispatcher in-flight guard、WS pub/sub stale |
| 7 | **RLS / tenant 泄漏** | 租户数据串门、权限异常 | RLS deny-all 缺失、tenant/scope 过滤缺失、multi-app router 误路由 |
| 8 | **Drizzle schema 漂移** | 类型不匹配、迁移失败 | `sql/` ↔ `src/schema.ts` 不同步、migration 顺序错、temporal generated 列非 IMMUTABLE (TKG-1)、`z.string().uuid()` 拒 the sibling project UUID |

**匹配流程:**
1. 症状与模式特征对照，匹配 1-2 个最可能模式
2. 按模式排查方向聚焦调查

### Phase 4.5: 领域陷阱匹配（Layer A-Express，轻量注入）

Read `.claude/hooks/prompt-library.json`
→ keyword 匹配当前 scope lock 的模块名（如 "billing" / "work" / "ai"）
→ 仅提取匹配 fragment 的 `pitfalls`（≤3 条），不提取 constraints
→ 作为额外假设候选加入 Phase 5 假设追踪表
→ 如果 pitfall 与当前症状直接吻合（如 "pgvector search_path" + RPC 500 错误）→ 标注 "已知领域陷阱" + 跳过 Phase 5 直接进 Phase 6 修复

### Phase 4.6: 认知模式激活（cognitive-modes 调用）

> 执行共享模块 `.claude/skills/_modules/cognitive-modes/MODULE.md` 的匹配逻辑。
> 输入: task_description="debug symptom" + task_type="bugfix"。
> depth: standard。
>
> **默认激活 M1 RCA**（根因追溯）— 5-Why + 蓝军自检 + 流程固化。
> **输出注入**: 3 条行为约束（5-Why 追溯 / 蓝军视角 / 修完扫同类） + 2 条自检（方法固化？反方攻击过？）。
>
> Phase 5 假设验证时，每个假设必须通过 M1 的"蓝军自检"才进入 Phase 6 修复。

**额外检查:**
- `git log` 同区域历史修复 -- **同文件反复修 bug = 架构问题**，不是巧合
- Supabase bug: `npm run check:migration-safety` + 检查 `src/types/supabase.ts` 是否最新

---

## Phase 5: 假设验证

最多 3 个假设，逐个验证。

### 假设追踪表

<!-- reasoning-tool: cot (docs/standards/PROMPT-STRUCTURE-STANDARD.md §4.1) -->

对每个假设，完成三步推导再填入追踪表:
1. **观察**: 我在代码/日志/症状中看到了什么（引用 file:line）
2. **推论**: 如果这个假设成立，那么应该还能观察到什么
3. **验证**: 设计一个能区分"假设成立"和"假设不成立"的实验

```
| # | 假设 | 验证方法 | 结果 |
|---|------|----------|------|
| 1 | [具体可测试的声明] | [如何验证] | CONFIRMED / REJECTED |
| 2 | ... | ... | ... |
| 3 | ... | ... | ... |
```

### 验证规则

1. **先验证再修**: 在可疑根因处加临时 log/断言，跑复现，看证据是否吻合
2. **假设错误时**: 不猜。回到 Phase 2 收集更多证据
3. **三振出局**: 3 个假设全失败 -> **STOP**，用 AskUserQuestion 问 the owner:

```
3 个假设均未命中。可能是架构层问题而非简单 bug。

A) 继续调查 -- 我有新假设: [描述]
B) 升级人工审查 -- 需要熟悉系统的人介入
C) 加日志观察 -- 埋点后等下次触发
```

### 危险信号（看到就减速）

- "先临时修一下" -> 没有临时修。修对或升级
- 还没追踪数据流就提修复方案 -> 在猜
- 每次修完又冒新问题 -> 层级错了，不是代码错了

---

## Phase 5.5: Stuck Protocol（3 个假设都失败时）

> 来源: core-rules-full.md §10.8 卡住清单 + PUA v3 L3 协议
> 触发: Phase 5 三振出局但 the owner 选择"继续调查"（选项 A）时必跑

**7 项检查清单**（逐项过完才能继续，未过的项标 ❌，全 ✅ 才算穷尽）:

- [ ] 逐字读完失败信号了吗？（不是扫一眼 title —— 整条 stack trace / 完整 error body）
- [ ] 用工具搜索过核心问题了吗？（`.claude/knowledge/error-journal.json` → sessions dead-ends → WebSearch 错误原文）
- [ ] 读过失败位置的原始上下文 50 行了吗？（`Read` 原始源码，不是读 README 或摘要）
- [ ] 所有假设都用工具确认了吗？（`Grep`/`Bash` 验证，不是脑补 —— 对照 §10.5 反合理化表第 4 条 "可能是环境问题"）
- [ ] 试过完全相反的假设吗？（原假设"问题在 A" → 反向假设"问题不在 A"）
- [ ] 能在最小范围内复现问题吗？（如能复现但不能最小化 → 继续缩小 scope）
- [ ] 换过工具/方法/角度/技术栈吗？（Grep 换 WebSearch；Bash 换 MCP；静态分析换动态 log）

### 认知模式切换（切换链来自 cognitive-modes/MODULE.md）

如果上面 7 项全 ✅ 仍无解，**强制切换认知模式**：

| 当前卡住症状 | 切换链（从左到右依次尝试） |
|------------|-------------------------|
| 反复调试同一处不改思路 | M2 第一性原理 → M3 减法 → M1 RCA |
| "建议 the owner 手动处理" 类念头 | M6 证据驱动 → M1 RCA → M2 第一性原理 |
| 未用工具就下结论 | M4 搜索优先 → M5 用户倒推 → M6 证据驱动 |

切换前 Read 对应 `modes/*.md` 获取完整行为约束。

### 体面退出（全部穷尽仍无解）

输出 core-rules §10.7 **结构化失败报告**:

```
[FAILURE-REPORT]
已验证事实: [含证据]
已排除可能: [含排除依据]
尝试的方法论: [M1/M2/M4 等尝试结果]
缩小后的问题边界: [具体到函数/行]
建议 the owner 决策的 3 个选项: [含代价]
```

---

## Phase 6: 修复

根因确认后，最小改动修复。

1. **修根因不修症状**: 最少文件、最少行数。不顺手重构相邻代码
2. **回归测试**: 写测试 -- 不修时 FAIL，修后 PASS
3. **跑测试套件**: `npx vitest run` 粘贴输出。不允许回归
4. **Blast Radius Gate**: 修改 >5 文件时用 AskUserQuestion:

```
此修复涉及 N 个文件。对于 bugfix 来说爆炸半径偏大。

A) 继续 -- 根因确实跨这些文件
B) 拆分 -- 先修关键路径，其余延后
C) 重新思考 -- 可能有更精准的方案
```

5. **Supabase migration**: 走 `/data-pipeline`，不在本 skill 内直接写 SQL
6. **原子提交**: 修复 = 一个 commit，message 格式 `fix(scope): 中文描述`

---

## Phase 7: 验证闭环

> 验证 > 信任。不验证不提交。

1. **复现原始场景**: 确认 bug 已修
2. **自动验证**: 调用 `/verify --smart` 运行变更相关 check
3. **UI bug 额外**: `$B snapshot -i` 截图确认视觉正确
4. **RLS bug 额外**: `npm run check:tenant` + `npm run check:rls`
5. **更新 error-journal**: Phase 1 匹配了已知问题时，更新其状态为 resolved

---

## Phase 8: 调试报告

```
DEBUG REPORT
========================================
症状:       [用户观察到什么]
根因:       [实际出了什么问题 + 为什么]
模式:       [匹配的 bug 模式编号 + 名称]
修复:       [改了什么，file:line 引用]
证据:       [测试输出 / 复现结果]
回归测试:   [测试文件:行号]
历史关联:   [error-journal 条目 / session Dead End / 同区域历史 bug]
Scope Lock: [锁定范围 + 是否突破]
爆炸半径:   [N files changed]
状态:       DONE | DONE_WITH_CONCERNS | BLOCKED
========================================
```

**状态定义:**
- **DONE** -- 根因找到 + 修复 + 回归测试 + 全部测试通过
- **DONE_WITH_CONCERNS** -- 已修但无法完全验证（间歇 bug / 需线上确认）
- **BLOCKED** -- 无法继续。说明阻塞原因 + 已尝试 + 建议 the owner 下一步

---

## Phase 8.5: 同类扫描（修完一个，扫一片）

> 来源: core-rules-full.md §10.1 "一个问题进来，一类问题出去"
> cognitive-modes M1 RCA 的"修完扫同类"行为约束
> 触发: Phase 8 状态 = DONE 之后、关闭任务之前**必须**执行

修完 bug 后，不是 DONE 就走人。用根因反推同类问题：

1. **Grep 同 pattern**
   ```
   对根因中的关键 API/函数/pattern，全仓 Grep:
   - 如果根因是 "缺少 tenant/scope 过滤" → Grep drizzle 查询 (`.select`/`.where`) 找所有 db 访问点
   - 如果根因是 "未校验 zod" → Grep route/callback handler 找所有 untrusted 入口
   - 如果根因是 "tick 无 CAS" → Grep `setInterval`/`status='ready'` 找所有派发点
   ```

2. **同模块扫描**
   ```
   在当前 scope lock 的目录内，用 Grep 查找相同代码 pattern。
   例: scope=src/dag/，Grep 该目录下所有 handler 是否有同类缺陷。
   ```

3. **上下游波及**
   ```
   用 dependency-explorer agent 查:
   - 本次修改的函数被谁调用？调用方是否也受影响？
   - 如果修了 schema，哪些 action 读这个字段？需要同步改吗？
   ```

4. **输出同类扫描报告**
   ```
   同类扫描结果:
   - 扫描 pattern: [Grep 查询]
   - 命中文件数: N
   - 疑似同类问题: [文件:行, ≤5 条]
   - 本次处理: [直接修 / 记录技术债到 error-journal / 留给 the owner 决策]
   ```

**原则**: 如果同类问题 >5 处 → 不一次性全修（避免 scope creep）；
→ 选最重要的 1-2 处修，其余记录到 `error-journal.json` 作为 pattern entry；
→ 下次 domain-inject 会自动注入这些 pitfall。

---

## 约束

- **铁律**: 不找到根因不写修复代码。诊断阶段禁止提修复方案
- **三振**: 3 次假设失败 -> STOP 问 the owner
- **Scope Lock**: 编辑必须在声明范围内，越界需确认
- **Blast Radius**: >5 文件必须问 the owner
- **不说 "应该能修好"**: 验证并证明。跑测试
- **历史优先**: 先查 error-journal + sessions，不从零开始
- **Migration 不直接写**: Supabase migration 走 `/data-pipeline`
- **输出中文，代码 English**
