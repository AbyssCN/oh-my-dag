# SDD — Pathfinder Mode（渐进散雾式规划）

> 状态：已实装（`a44accd` feat + `5e23e0c` review 修复批，2026-07-19）。本文档保留为设计记录；
> 数据模型 `delivered` 终态由 D-14 追认（2026-07-20）。
> 说明：本该用 pathfinder 自己画地图（dogfood），但 pathfinder 尚不存在，且经过多轮对话
> 迷雾已散尽（决策全部裁决 = 见 D-numbers），故直接落为 SDD spec 而非决策地图。

## 问题陈述

大而模糊、跨 session、上下文装不下的功能，用一次性 plan mode → /sdd → /execute 有两个病：
① 一次性假设"第一天就能做对全部决策"，复杂项目该假设本身错；② plan mode 把已想清的结构压成
散文 SDD，/execute 的 conductor 再从散文重推 DAG = lossy 交接税。Pathfinder 用**渐进发现**
替代一次性规划，用**决策 DAG 直接编译 slice** 消除交接税。

## 目标

`shift+tab` 进 pathfinder 模式 → 持久决策地图（跨 session）→ 前沿票按类型自动分派
（grill=HITL 只读审议 / research=AFK 后台车队 / prototype=沙盒 spike）→ 区域散尽直接编译
成 slice → /execute。小活保持"正常聊天 + plan 技能 slash 命令"直连，不背模式税。

## 决策记录（D-numbers）

| # | 决策 | 理由 / 被否替代 |
|---|---|---|
| D-1 | 名 **pathfinder**，命令 `omd path`，`shift+tab` 进 pathfinder 模式。**plan mode 完全移除**（不共存），其零件(ledger/overlay/best-of-n)搬进 pathfinder，技能解绑为 slash | 探索树被否（决策是 DAG 非树）；wayfinder 撞 Matt；单一 toggle 语义 |
| D-2 | 区域产物 = **slice**；spec=大计划 / slice=原子施工单元 | 复用 bluebell 已有 SLICE-TEMPLATE 词汇，不造新词 |
| D-3 | 存储 = **markdown-in-git 真相源**（`docs/plan/pathfinder/<dest-slug>.md`）+ `.omd/pathfinder.db` 本地索引（可从 md 重建） | `.omd/` gitignore 本地态；耐久跨机真相必须进 git |
| D-4 | 两路一脊：小活正常聊天+plan 技能解绑为 slash；大活 shift+tab；都汇到 slice→/execute | 全塞 pathfinder = 小活背编排税（ponytail 违规） |
| D-5 | **开放 src，pathfinder 无硬只读闸**。deliberate/build 边界从"src 写闸"**迁到更高接缝**：slice→/execute→G3 审查→owner 签字 + prototype worktree 隔离。硬闸只留 dangerous-cmd | 接缝取最高位；pathfinder 是工作台非上锁座舱 |
| D-13 | **prototype 票在 git 分支 worktree 隔离**跑（试验码不污染主树，弃用即删 worktree） | 复用引擎 worktree 隔离原语；试验的意义是可弃 |
| D-6 | AFK research 票=后台 agent，HITL grill 票=交互；完成回流更新地图+通知，前沿重算 | ready-set 前沿 = HITL/AFK 并发的载体 |
| D-7 | conductor 三分离：拆"廉价模型从散文重推"步；**ConductorPlan schema = 接缝**保留；adapter B = 票编译器(零 LLM)+runtime 定稿；执行机器不变 | 契约=可靠性在模型外，不能拆；接缝下游零感知 |
| D-8 | **conductor 模型默认 = runtime 模型**，廉价 conductor 角色拆除；超大区域可配兜底 | 廉价 conductor 重推=交接税；runtime 有全上下文 |
| D-9 | 票类型 = research/grill/prototype/task；票带 `executorKind` 字段（裁票时定） | 类型驱动分派，人不再手排 grill/research 顺序 |
| D-10 | 票自我展开：research 票用 **map 节点**原语运行时发现子票 | 引擎原生，Matt 原版无此 |
| D-11 | 出口：区域散尽→票编译 slice→/execute；填不出契约=有票没解=回地图（升级阀 `?`） | 只组装不发明，防地图偏移 |
| D-12 | `/sdd`(spec,小活) 与 pathfinder(大活) 并存不合并；plan mode 零件(gate/ledger/overlay/best-of-n)搬进 pathfinder 复用 | 各尺度合身入口，非单一入口 |
| D-14 | `TicketStatus` 增 **`delivered`** 终态（slice 已交付；实装先行，owner 2026-07-20 追认） | `/deliver` 交付闭环需要终态，承 D-11 区域 delivered 语义；原四值模型漏列 |

## 架构

```
需求 → 判断规模
  ├─ 小活：正常聊天 + /grill /council(slash, 解绑)→ /sdd(spec) ─┐
  │                                                             ▼
  └─ 大活：shift+tab 进 pathfinder ──→ 地图散雾 ──→ 区域清 ──→ slice → /execute → 验收
        grill 票=只读审议 / research 票=AFK 后台 / prototype 票=沙盒 spike
        research 票可 map-node 自展开子票；完成回流更新地图+通知，前沿重算

接缝 = ConductorPlan：
  adapter A（小活）= runtime 从 spec 拆（原 conductor 步，模型=runtime）
  adapter B（大活）= 票编译器(零 LLM) + runtime 定稿
  下游执行机器（ready-set/叶子/verify/升级）两路共用，零改动
```

## 数据模型

```ts
type TicketType = 'research' | 'grill' | 'prototype' | 'task';
type TicketStatus = 'open' | 'blocked' | 'ruled' | 'delivered' | 'escalated'; // delivered = slice 已交付终态(D-14); escalated = ? 上报 owner
interface Ticket {
  id: string;              // 稳定 id
  type: TicketType;
  title: string;           // 待决问题
  blockedBy: string[];     // 前置票 id → 编译时成 depends_on
  status: TicketStatus;
  ruling?: string;         // 裁决内容（ruled 时）
  executorKind?: 'command'|'inproc'|'agent'|'map'|'primitive'; // task 票用，喂 slice 编译器
  children?: string[];     // 自展开子票（research map-node）
  dNumber?: string;        // 溯源到决策记录
}
interface PathMap {
  destination: string; slug: string;   // 稳定 key = slug（一 repo 多图）
  tickets: Ticket[];
  decisionsLog: { ticketId: string; gist: string }[]; // 索引非存储
}
// 前沿 = tickets.filter(t => t.status!=='ruled' && t.blockedBy.every(id => ruled(id)))
```

## 组件

1. **map-store**：markdown ↔ SQLite 双向同步；md 为真相，db 为前沿快查，可从 md 重建。
2. **frontier**：ready-set 查询前沿票。
3. **ticket-dispatch**：按 type 分派 — grill→只读审议(plan 零件)/research→后台 dag-research agent/prototype→沙盒 spike/task→待编译。
4. **afk-hook**：后台 agent 完成 → 更新票 → 重算前沿 → 通知。
5. **slice-compiler**（零 LLM）：散尽区域 task 票 + blockedBy 边 → 草稿 ConductorPlan。
6. **execute 预构造入口**：`runExecutorDag` 加接受预构造 plan、跳过 conductor 步的口子。
7. **runtime-finalize**（可开关）：runtime review 草稿 plan（补叶子细节/verify/宽深检查）。
8. **mode-toggle**：`shift+tab` 改绑 pathfinder（原 plan mode 零件复用）。
9. **scoped-gate**：作用域只读闸（D-5）。
10. **omd path CLI**：无参列本 repo 开放地图；`<dest>` 开/建；`/start` 开局 surface 未收敛图。

## 测试接缝（Seams）— ⚠️ 需 owner 确认

理想接缝：**ConductorPlan schema**（已存在，adapter A/B 都对着它测）+ **map-store 的 md↔db 往返**
（纯函数，property test：任意 map → 写 md → 重建 db → 等价）+ **frontier 纯函数**（给 tickets 算前沿）+
**slice-compiler 纯函数**（给 ruled 票 → ConductorPlan，对照 Zod 校验）。UI/后台 agent 用注入替身。
新接缝仅 map-store 一处，取最高位（整个 pathfinder 对外只经 ConductorPlan 和 md 文件两个面）。

## 先红纪律

先在上述纯函数接缝写红测试：frontier 算法（阻塞/解锁/自展开）、slice-compiler（票→plan 边映射 + 无环）、
map-store 往返等价、scoped-gate 判定（src 封/规划放行/沙盒）。红→绿→重构。

## Oracle-cmd

```bash
bun run typecheck && bun test
```

## Allowed files

```
src/harness/pathfinder/**          (新目录: map-store, frontier, dispatch, slice-compiler, afk-hook)
src/harness/pathfinder-extension.ts (新: mode-toggle 改绑 + 组件装配)
src/harness/executor-dag.ts        (仅加"预构造 plan"入口, 不改执行逻辑)
src/harness/plan/mode.ts           (shift+tab 改绑 pathfinder)
src/harness/plan/readonly-gate.ts  (全封 → 作用域闸)
src/harness/plan/plan-extension.ts (技能解绑为 slash / 不再 mode-gate)
src/harness/execute-extension.ts   (接受 slice 预构造 plan)
scripts/omd-path.ts                (新 CLI, 或并入 tui)
src/harness/tui.ts                 (装配 pathfinder-extension)
src/harness/identity.ts            (交接协议补 pathfinder 段)
docs/loop/**                       (方法论文档补 pathfinder)
+ 各自 *.test.ts
```

## Forbidden files

```
src/harness/conductor-plan.ts      (ConductorPlan schema = 接缝, 不动)
src/harness/executor-dag-types.ts  (plan 类型契约不动)
src/harness/{verifier,primitives,primitive-registry}.ts  (执行下游不动)
src/harness/dag-record.ts continuity/**  (存储机制复用不改)
src/harness/init/**  review/**  multimodal*.ts  tier-advisory*.ts  (system v1 已冻)
src/model/**         (模型层不动)
```

## Review Gate

**G3**（触及 shift+tab 模式改绑 + executor-dag 入口 + 只读闸语义变更 = 交互与安全边界）：
双轴审查 + Spec 轴对照本 SDD + **owner 终审接缝与 gate 变更**。

## 分阶段实施

- **P0 纯核心**（红先行）：数据模型 + frontier + slice-compiler + map-store（md↔db）。零 UI 零后台，全单测。
- **P1 引擎接缝**：executor-dag 预构造 plan 入口 + execute-extension 接 slice + runtime-finalize（开关）。
- **P2 模式装配**：shift+tab 改绑 + 作用域闸 + plan 技能解绑 slash + omd path CLI + /start surface。
- **P3 分派与回流**：ticket-dispatch（research→后台 agent）+ afk-hook 回流 + 通知。
- **P4 文档+身份**：identity 交接协议 + docs/loop pathfinder 段。

## `?` 升级阀

接缝确认（尤其 shift+tab 改绑是否破坏现有 plan mode 用户习惯、作用域闸的 src 边界定义）
= 无法单方裁决，标 `?` 上报 owner。
