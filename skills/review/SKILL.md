---
name: review
tier: capability
runtime: on-demand
trigger: mention
description: "按需审计: 安全 / 覆盖度 / 技术债 / 全量 Gate / PR 代码审查 (派 dream-team specialist + Codex). Phase/Gate milestone, 安全事件后, pre-merge PR review. Trigger: 审计 / audit / 安全扫描 / 全量检查 / Gate检查 / review --security / review --gate / 技术债盘点 / security audit / review PR / code review / 代码审查 / PR审查. Skip: 日常验证 (/verify) / 提交 (/commit)."
metadata:
  source: claude-skills
  version: "5.0.0-xihe"
  methodology: "xihe audit + dream-team specialist + Codex G2/G3"
---

# /review — On-Demand Audit (xihe)

> 按需全量扫描，用于 Phase 完成 / Gate 前 / 安全事件后。日常改动用 `/verify` → `/commit`。
> **xihe 审查模型**: 无 RW feature-team review agent。审查 = **dream-team RO** (Plan 前方法论 lens) + **Codex G2/G3** (post-write cross-model) + **Wright judgment** (裁决, taste 不被 finding 绑架)。真实 check = `bunx tsc --noEmit` / `bun test` / `bun build`。

## Modes

```
--security      → 扫 src/ 信任边界 (验签/认证/注入/fail-open) + dream-team agent-protocol/data-layer lens
--coverage      → bun test --coverage + 缺测识别
--debt          → bunx tsc + error-journal 未修 P0/P1 + TODO/FIXME 扫描 + dream-team review
--zod           → untrusted 入口 (route/callback/inbox) Zod 校验覆盖率审计
--pr            → PR 级审查 (dream-team specialist 并行 + 计划完成度 + scope drift)
--gate          → 上述并行, Gate 前置总检查 (G2)
--release-gate  → Gate 3 交付审核 (compound-strategist 综合扫描)
--with-codex    → modifier (combine with --gate/--release-gate/--pr): 同消息并行加 Codex cross-model
```

## `--with-codex` — Cross-Model Phase Gate (CLAUDE.md §Codex)

`--with-codex` 是 modifier flag。在 dream-team specialist 之外同消息并行加 **Codex** (cross-model GPT independence, 唯一非 Anthropic 模型族)。

**调用** (xihe 用 `/codex:*` slash commands — 无 a sibling project 的 codex-dispatch.mjs/codex-plugin scripts):

| Gate | Codex command | Max 轮 (硬上限) | BLOCK 兜底 |
|---|---|---|---|
| `--gate` (G2 Phase) | `/codex:review --base <last-gate-commit>` | **1** per phase end (CLAUDE.md: fix 顺带下一 phase, 不 spawn r2) | Wright judgment |
| `--release-gate` (G3) | `/codex:review --base main` | **1 + max 1 修复 = 2** | the owner |
| `--pr` | `/codex:adversarial-review` | 1 | Wright |

**anti-slop** (CLAUDE.md): Codex finding ≠ ground truth。必拒 niche/theoretical/telemetry/tests-for-tests/style/doc-completeness; 必接 P0/P1 reproducible bug (file:line+steps) + contract violation + ship-blocker + mechanism-level boundary failure。

**Finding → fix 路由** (xihe 真实 roster — 无 feature-team RW agent):

| Finding 类型 | 路由到 |
|---|---|
| PG schema / migration / temporal / RLS | dream-team **data-layer-architect** (RO 诊断) → **Wright** 主写修 |
| RAG / memory / SAFEGUARD / Dream | **ai-pipeline-reviewer** (RO) → **Wright** 修 |
| Hono API / WS / 类型契约 | **interface-architect** (RO) → **Wright** 修 |
| agent/skill/hook / DAG 节点 / MCP | **agent-protocol-architect** (RO) → **Wright** 修 |
| daemon 架构 / 性能 | **stack-architect** (RO) → **Wright** 修 |
| Type error / typo (≤3 行) | **Wright** 主线直接修 |

> xihe 是 daemon, execution 走 Wright Hybrid 主写 (pet 模式); dream-team 只给 RO 诊断, 不 write。

---

## Trigger

`/review --<mode>` or `/review --gate`

## Security Mode (--security)

派 dream-team **agent-protocol-architect** + **data-layer-architect** (RO) 或 Wright 直扫:
- 扫描范围: `src/routes/` + `src/ws/` + `src/integrations/` + `sql/`
- 检查: 信任边界验签 (HMAC/timingSafeEqual, 标杆 `src/routes/inbox.ts`) / 认证 gap / 注入 / fail-open (`catch { return null }` 吞错) / GET 只读 / 无存在性泄露 / 输入 Zod 校验 / RLS deny-all
- 输出: P0/P1/P2 + verdict (PASS/BLOCK)

## Coverage Mode (--coverage)

1. `bun test --coverage` — 覆盖率
2. 对比 `git diff` 变更文件: 新增/改动无对应 `test/*.test.ts` → 警告
3. 识别 gap: 0-test 重灾区 (历史: DAG/memory scaffold)

## Debt Mode (--debt)

1. `bunx tsc --noEmit` — 类型债
2. 读 `.claude/knowledge/error-journal.json` — 未修 P0/P1
3. Grep TODO/FIXME/HACK + `_NEXT.md` secondary_tracks (已知 backlog: DAG v0.2/v0.3 dead config / Leiden 未部署 / inbox WS broadcast TODO)

## Zod Mode (--zod)

扫 untrusted 入口 (`src/routes/*` body / channel callback / `src/routes/inbox.ts`):
- PROTECTED: 有 Zod safeParse | UNPROTECTED: 接受外部输入但无 Zod
- 注: `z.string().uuid()` 对 a sibling project UUID 太严 → hex regex (已知 gotcha)
- 输出: 覆盖率表 + 未保护入口 + 建议 schema

## Gate Mode (--gate)

**Phase 完成 / Gate 前。** 并行:

| Lens/Check | 对应 |
|---|---|
| dream-team specialist (按 diff 路由 data-layer/ai-pipeline/interface/agent-protocol) | 方法论审查 |
| `bunx tsc --noEmit` + `bun test` | 类型 + 测试 |
| Codex `/codex:review` (若 --with-codex) | cross-model |

合成: All green → GATE PASS | Any P1 → NEEDS-CHANGE | Any P0 → GATE BLOCK

### Step 0: Read 统一 G2 内核

dispatch 前先 Read `.claude/skills/_modules/quality-gates/EXECUTION-REVIEW.md` (Mandatory Reads: INV-1..3 + project-canon + error-journal + 角色定向必读) — 注入每个 specialist prompt 顶部。

### Agent Prompt 注入

```text
读取 .claude/skills/_modules/quality-gates/EXECUTION-REVIEW.md 获取审查指令 + Mandatory Reads。
按清单读完后开始评审。你的 lens: {data-layer | ai-pipeline | interface | agent-protocol | stack}
审查作用域: git diff $(git merge-base HEAD main)..HEAD
二元 PASS/FAIL + xihe 特化检查项 (Bun/Hono/Drizzle/temporal/SAFEGUARD)。
```

---

## PR Review Mode (--pr)

> PR 级代码审查。G2 Layer 3 入口，模板共用 EXECUTION-REVIEW.md。

### Step 1: Branch Diff

```bash
git diff main...HEAD --stat && git log main..HEAD --oneline
```
无 diff → "Nothing to review" 终止。

### Step 2: Plan Completion Audit

读 `_NEXT.md` `active_plan` + 承诺项 → 对比 diff: DONE / PARTIAL / NOT DONE / EXTRA(scope creep)。

### Step 3: Critical Pass

扫 diff 高风险模式: SQL 注入 (`IN` 替 `= ANY`)、竞态 (tick 无 CAS, DAG-R1)、LLM trust boundary (memory 写未走 validateFactWrite D54)、认证 gap、enum 完整性 (switch 无 default)。每 finding 附 confidence 1-10 (1-3 抑制 / 4-6 标 low / 7-10 显示)。

### Step 4: Specialist Dispatch（并行 dream-team RO）

按 diff 路由 (同消息并行):

| lens | 条件 | 检查 |
|------|------|------|
| **data-layer** | 含 `sql/` / `src/schema.ts` | schema 安全 + RLS + 索引 + temporal IMMUTABLE |
| **ai-pipeline** | 含 `src/rag/` / `src/memory/` | RAG/memory + D54 validateFactWrite + confidence 命名 |
| **interface** | 含 `src/routes/` / `src/ws/` | 幂等 + 验签 + 错误形状 + 类型契约 |
| **agent-protocol** | 含 `.claude/` / `src/dag/` | agent/skill/hook + DAG 节点契约 |
| **stack** | 含 `src/dispatcher/` / `src/index.ts` | loop 阻塞 + tick CAS + WS 生命周期 |

每 lens RO 只看 diff + 上下文，输出 findings (criterion + verdict + confidence + evidence + fix)。

### Step 5: Synthesis

去重 (多 lens 报同一 → 合并提升 confidence) → 分级 P0/P1/P2 → 2+ lens 报同一 P1 → 升 P0。

### Output

```
## PR Review — {branch} → main
### Plan Completion / ### Scope Check (CLEAN/DRIFT/MISSING)
### Findings ({N}: {P0} P0, {P1} P1, {P2} P2)
| # | Severity | File:Line | Finding | Confidence | Source |
### Verdict: APPROVE / NEEDS-CHANGE / BLOCK
```

---

## Release Gate Mode (--release-gate)

> Gate 3: 最终交付审核。/handoff 在显著变更时推荐。

1. Read `.claude/skills/_modules/quality-gates/RELEASE-GATE.md`
2. 派 **compound-strategist** (RO)，注入模板
3. 扫本 session 变更，输出交付检查 + VERDICT → `docs/reports/release-gate-{date}.md`

### /handoff 推荐触发

| 条件 | 推荐 |
| --- | --- |
| 本 session 修改 ≥5 文件 + 跨层 | `/review --release-gate` |
| 本 session 有新 migration (`sql/`) | `/review --release-gate` |
| 本 session 改 schema / SAFEGUARD / DAG 编排 | `/review --release-gate` |
| 以上都不满足 | 静默跳过 |

---

## Fix-First Protocol（所有 mode 通用）

- **AUTO-FIX**: 机械问题 (命名/格式/import/死代码/typo) → 直接修
- **ASK**: 需判断 (架构/性能权衡/安全决策) → AskUserQuestion

执行: 分类 → 批量 AUTO-FIX (每个一行 `[AUTO-FIXED] file:line Problem → done`) → 剩 ASK ≤3 逐个问 / >3 批量。

## Scope Drift Detection（--gate / --release-gate 自动）

读 `_NEXT.md` active_plan (stated) vs `git diff --stat` (delivered) → SCOPE CREEP (范围外文件) / MISSING (承诺未现) → `Scope Check: [CLEAN / DRIFT / MISSING]` (INFORMATIONAL, 不阻塞)。

## Doc Staleness Check（末尾自动）

diff 对 `docs/` 影响: 代码变但文档没更 → flag (INFORMATIONAL)。

## Constraints

- **Fix-First 下可改代码** — AUTO-FIX 直接修, ASK 需确认
- 每个 mode 独立可用; --gate 全部并行; --release-gate 交付审核
- 频率: Phase 完成 / Gate 前 / 安全事件后 (非日常)
- 输出 `docs/reports/audit-report-{date}.md` 或 `release-gate-{date}.md`
- **不引用 a sibling project 死 infra**: `scripts/codex-dispatch.mjs` / `.claude/codex-plugin/` / `harness-ingest-review-finding.mjs` / `graphify-probe.py` / `check:*` / dead feature-team agent — xihe 全无
