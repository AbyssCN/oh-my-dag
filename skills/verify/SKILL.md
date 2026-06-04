---
name: verify
tier: foundation
runtime: on-demand
trigger: mention
description: "统一验证 gate: 按改动文件跑 tsc/test/build. 5 modes: --smart (default diff-based) / --quick (仅 tsc) / --full (push 前全套) / --all (everything) / --health (复合质量分 + 趋势). Trigger: 验证 / 跑测试 / 检查一下 / verify / run tests / 预检 / 提交前检查 / 健康度 / health check / 代码质量. Skip: 代码 review 反馈 (/review) / 提交 (/commit)."
metadata:
  source: claude-skills
  version: "5.0.0-valinor"
  methodology: "valinor verify (Bun) + composite scoring"
---
# /verify — 验证统一入口 (valinor)

> **Zone→Check 映射**: 见 `_shared/CHECK-ROUTING.md`（与 /commit 共享）。
> **valinor 验证三件套** (真实, 无 a sibling project npm script): `bunx tsc --noEmit` + `bun test` + `bun build src/index.ts`。无 eslint (无 config) / 无 vitest (用 `bun test`) / 无 `check:*` / `gen:*` 脚本 (那些是 a sibling project)。`bun test` 走 **HAS_DB gate** — 无 valinor PG 的 dev box 优雅 skip DB 测试。

## 模式

```
--quick (最快)     → 仅 bunx tsc --noEmit（单命令，最快反馈）
--smart (默认)     → 按 git diff 选最小 check 子集并行执行
--full  (push前)   → tsc + bun test (全量) + bun build
--all              → tsc + bun test + bun build (everything)
--health           → 复合健康分 0-10 + 趋势追踪 + 退化检测
```

---

## Smart 模式（默认）

按 `git diff --name-only HEAD` 分析变更文件，自动选择最小检查子集并行执行。

### Step 1: 分析变更文件

| File Pattern | Required Checks | 说明 |
|-------------|----------------|------|
| `sql/*.sql` | `bunx tsc --noEmit` + 对照 `src/schema.ts` 同步 | migration 安全人工核 (无 check 脚本): RLS / FK 索引 / CONCURRENTLY / temporal IMMUTABLE |
| `src/schema.ts` | `bunx tsc --noEmit` + `bun test` (全量) | schema 改动牵连广 → 跑全量 |
| `src/**/*.ts` | `bunx tsc --noEmit` + `bun test <related>` | 按模块跑相关 test (如 `src/dag/*` → `test/dag.test.ts`) |
| `test/**/*.test.ts` | `bun test <该文件>` | — |
| `.claude/**`, `docs/**` | — | docs/harness 配置, 无 check |

> **权威来源**: 此表与 `_shared/CHECK-ROUTING.md` 同步。冲突以 CHECK-ROUTING.md 为准。

Build union of all required checks from matched zones. Do NOT add checks beyond the zone table.

### Step 0: 前置检查

`git diff --name-only HEAD` 为空 → "No changes detected." 终止。
变更仅在 `docs/` / `.claude/` (无 check zone) → "Changed files: {N} (docs/config only) — no checks required." 终止。

### Step 2: 并行执行

所有 check 在同一消息中并行发出（tsc / bun test 互不冲突）。捕获 stdout+stderr、exit code、时间。

### Step 3: 解析结果 + Fix-First

每个 check: PASS/FAIL → 提取前 3 个最关键 finding（file:line）→ 分级 BLOCK / WARN / INFO。

**Fix-First Heuristic**（仅 `--smart`）:
- **AUTO-FIX**（直接改）: unused import、import 顺序、trailing whitespace、可推断的 `any`
- **ASK**（AskUserQuestion）: 命名争议、架构选择、逻辑修改、类型断言
- **REPORT**（仅报告）: 测试失败、build 错误、migration safety

AUTO-FIX 后自动重跑该 check。报告标注 `[auto-fixed]`。

### Step 4: 统一报告

```
## Smart Check Report — {date}
Changed files: {N} | Checks selected: {M}

| Check | Status | Time | Findings | Severity |
|-------|--------|------|----------|----------|

**Overall: ✅ PASS / 🛑 {N} BLOCKS / ⚠️ {M} WARNINGS**
🛑 Blocking: [{check}] {file}:{line} — {description}
```

### valinor 真实 check 参考

| Command | Verifies |
|---------|----------|
| `bunx tsc --noEmit` | TypeScript 类型 (含跨模块契约, Drizzle 推断类型) |
| `bun test` | 全量 bun:test (203 pass, HAS_DB gate) — DAO / DAG CAS / memory SAFEGUARD / temporal / route |
| `bun test <file>` | 单测试文件 (diff-based 子集) |
| `bun build src/index.ts` | 打包 (module resolution / 入口完整性) |

> migration 安全 / RLS / 不变量 = **人工核 + dream-team review** (data-layer-architect), valinor 无 a sibling project 的 `check:rls`/`check:migration-safety`/`check:invariants` 自动脚本。

---

## Quick 模式 (--quick)

仅 TypeScript 类型检查:

`bunx tsc --noEmit`

单命令，最快反馈。适合编辑间隙快速验证。

```
## Quick Check — {date}
| Check | Result | Details | Time |
| TypeScript | ✅/❌ | {N errors in M files} | {Ns} |
**Result: ✅ PASS / 🛑 {N} type errors**
```

---

## Full 模式 (--full)

Pre-push 验证。

### Steps 1-2: 验证（tsc + test 并行）

**同一消息发出 2 个并行 Bash**:

| # | 命令 | 超时 |
|---|------|------|
| 1 | `bunx tsc --noEmit` | 60s |
| 2 | `bun test 2>&1 \| tail -20` | 180s |

解析: tsc → 按文件分组错误 | bun test → pass/fail/skip 计数

### Step 3: Build Check

`bun build src/index.ts`（依赖 tsc 通过；tsc FAIL → skip build）。失败分类: module resolution / import / other。

### Step 4: Staged Files Audit

`git diff --cached --name-only` + `git diff --name-only`:
- 与当前功能无关的 staged 文件？
- `.env*` / credentials / secrets？
- 生成文件 (`.claude/memory/index/*`, `bun.lockb` 视情况) 不该提交？

### Step 5: Known Failures Check

读 `.claude/knowledge/error-journal.json` 未解决 P0/P1。有则 BLOCK。

```
## Preflight Report — {timestamp}
| Step | Check | Result | Details | Time |
| 1 | TypeScript | ✅/❌ | {N errors} | {Ns} |
| 2 | bun test | ✅/❌ | {P pass, F fail, S skip} | {Ns} |
| 3 | Build | ✅/❌/⏭️ | {error summary} | {Ns} |
| 4 | Staged Files | ✅/⚠️ | {suspicious} | — |
| 5 | Known Issues | ✅/🛑 | {blocking} | — |
**Decision: ✅ GO / 🛑 STOP**
```

---

## All 模式 (--all)

tsc + bun test + bun build 全跑，跳过智能选择。

---

## Health 模式 (`--health`)

> 复合质量仪表盘。不修代码，只诊断+评分+追踪趋势。

### Step 1: 检查套件（并行）

| # | 类别 | 命令 | 权重 |
|---|------|------|------|
| 1 | TypeScript | `bunx tsc --noEmit` | 35% |
| 2 | Tests | `bun test` | 45% |
| 3 | Build | `bun build src/index.ts` | 20% |

### Step 2: 评分 (每类 0-10)

| 分数 | 标准 |
|------|------|
| 10 | 零 error |
| 7 | 1-3 warnings / 1 minor error |
| 4 | 3-10 errors 或 failures |
| 0 | 10+ errors 或无法运行 |

**复合分** = Σ(类别分 × 权重)。某类不可用 → 权重按比例重分配。

### Step 3: 趋势追踪

保存到 `.claude/telemetry/health-history.jsonl`:
```json
{"date": "2026-05-29", "composite": 9.4, "types": 10, "tests": 10, "build": 8, "details": {...}}
```

### Step 4: 退化检测

对比最近 10 次: 某类下降 ≥2 → 🔴; 上升 ≥2 → 🟢; 连续 3 次下降 → ⚠️ 趋势告警。

```
## Health Dashboard — {date}
| Category | Score | Δ | Status | Details |
| TypeScript | 10/10 | — | 🟢 | 0 errors |
| Tests | 10/10 | — | 🟢 | 203 pass, 0 fail |
| Build | 10/10 | — | 🟢 | clean |
**Composite: 9.x/10**
```

---

## Constraints

- **Full 模式 tsc + bun test 并行**: 同一条消息发出（--quick 仅 tsc）
- Build 依赖 tsc 通过（串行在后）
- tsc / bun test 并行无冲突
- Never auto-fix — only diagnose（smart 模式 Fix-First 除外）
- 报告含并行节省时间统计
- **Health 模式**: 纯诊断，不改文件（除 health-history.jsonl）
- **不引用 a sibling project npm script** (check:*, gen:*, eslint, vitest, npm run build) — valinor 不存在
