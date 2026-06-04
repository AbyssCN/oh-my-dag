---
name: commit
tier: foundation
runtime: on-demand
trigger: mention
description: "智能 git commit: 分析改动 + zone 检查 (tsc/test/build) + 中文 conventional message + git commit. --ship mode: merge base + full tests + PR. Trigger: 提交 / commit / 保存变更 / git commit / 提交代码 / 帮我提交 / ship / 发布 / 创建PR / ship it. Skip: 仅验证不提交 (/verify) / 代码质量 review (/review)."
metadata:
  source: claude-skills
  version: "3.0.0-xihe"
  methodology: "xihe commit (Bun) + ship release pipeline"
---
# /commit — Smart Commit & Ship (xihe)

> 智能提交：根据变更类型自动选择检查项，生成规范 commit message。
> **`--ship` 模式**: 一条龙 — 合并 base → 全量验证 → PR 创建。
> **Zone→Check 映射**: 见 `_shared/CHECK-ROUTING.md`（与 /verify 共享）。
> **xihe 验证** (真实): `bunx tsc --noEmit` + `bun test` + `bun build src/index.ts`。**无 eslint / vitest / check:* / gen:* npm script** (那些是 a sibling project)。

## Trigger

`/commit` or `/commit <message hint>` or `/commit --ship` or `/commit --amend`

## Workflow

### Step 0: Scope Drift Check（在 check 之前）

1. 读 `_NEXT.md` 的 `active_plan` 字段
2. `git diff --stat` 查看改动文件
3. 改动文件在 active_plan 范围外 → 警告（不阻塞）: `⚠️ Scope drift: {file} 不在 [{plan}] 范围内`
4. 无 active_plan 或 `_NEXT.md` 缺失 → 静默跳过

### Step 1: Analyze Changes

**1 个 Bash 合并调用**:
```bash
echo "=== STATUS ===" && git status -s && echo "=== STAGED ===" && git diff --cached --name-only && echo "=== UNSTAGED ===" && git diff --name-only
```

Categorize ALL changed files into zones:

| Zone | Pattern | Required Checks |
|------|---------|-----------------|
| 📦 `src` | `src/**/*.ts` | `bunx tsc --noEmit` + `bun test <related>` |
| 🗃️ `schema/migration` | `src/schema.ts`, `sql/**` | `bunx tsc --noEmit` + `bun test` (全量) + 人工核 migration 安全 |
| 🧪 `test` | `test/**/*.test.ts` | `bun test <该文件>` |
| 📄 `docs` | `docs/**`, `.claude/**` | _(none)_ |
| ⚙️ `config` | `package.json`, `tsconfig.json`, `drizzle.config.ts`, Dockerfile | `bunx tsc --noEmit` |
| 🔀 `mixed` | src + anything else | Union of all applicable checks |

### Step 2: Run Checks (并行)

Based on zone detection, **在同一消息中并行发出所有 Bash 调用**:

| Zone 包含 | 需要的 check | 并行? |
|-----------|-------------|-------|
| `src` / `config` / `schema` | `bunx tsc --noEmit` | ✓ |
| `src` (改 `.ts`) | `bun test <related test>` (如 `src/dag/*` → `test/dag.test.ts`) | ✓ |
| `src/schema.ts` / `sql/**` | `bun test` (全量, schema 牵连广) | ✓ |
| `docs` / `.claude` only | 无 — 跳过 | — |

**短路规则** (减少重复 `bun test`): 若同一 conversation 内最近一次 `/verify` 在 5 分钟内 PASS + 之后无新源文件改动 + 覆盖本次 zone → **跳过 Step 2 的 bun test** (tsc 仍跑)。任一不满足 → 全量跑。安全默认: 跑全量。

**If ANY check fails → 🛑 STOP.** 进入 Violation 归因:

#### Step 2.1: Violation 归因（check fail 时）

1. 收集失败输出中的文件路径（如 `[FAIL] test/dag.test.ts → CAS 二次 claim 返空`）
2. 对比 `git diff --name-only`（本次变更）
3. 分类:
```
🔴 本次变更引入 (must fix before commit): [FAIL] src/dag/dispatcher.ts → CAS race
🟡 历史遗留 (not from this session, still blocking): [FAIL] test/foo.test.ts — pre-existing
```
4. **两类都必须修**（不降级）。历史遗留 → 额外记 `.claude/knowledge/error-journal.json` 标 `[pre-existing]`，下次 `/start` 提醒。

### Step 3: Stage Files

- 用户指定文件 → stage those；否则 stage all modified/untracked
- **NEVER stage**: `.env*`, `node_modules/`, `.claude/memory/index/**`, `.claude/traces/**`, `.claude/worktrees/**`
- **WARN + confirm** before staging: `.claude/settings.json`, `drizzle.config.ts`

### Step 4: Generate Commit Message

Format: `type(scope): 中文描述`

**Type**: 新文件→`feat` / 改现有→`fix`/`refactor`/`chore` / schema·migration→`feat(db)`·`fix(db)` / docs→`docs` / harness 配置→`chore(harness)`
**Scope**: `src/routes/**`→`routes` / `src/dag/**`→`dag` / `src/memory/**`→`memory` / `src/integrations/**`→channel 名 / `sql/**`·`src/schema.ts`→`db` / `docs/**`→`docs` / `.claude/**`→`harness` / 多 scope→最重要的

Append co-author:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

### Step 5: Commit

```bash
git commit -F- <<'EOF'
type(scope): message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```
`--amend`（仅当用户显式传）: `git commit --amend -F-` 同上。

### Step 6: Post-Commit

- `git log -1 --oneline` 确认
- xihe **无** `gen:index`/`gen:doc-nav` 自动索引脚本 (那是 a sibling project)。DOC_NAV 若存在为手维护; 索引真相 = `src/schema.ts` + Glob。

## Examples

```
User: /commit
→ Detects: sql/ migration + src/schema.ts
→ Runs: bunx tsc --noEmit + bun test (全量)
→ Message: "feat(db): xihe_inbox 表 + HMAC 幂等 schema"

User: /commit 修复 DAG 重复派发
→ Detects: src/dag/dispatcher.ts + test/dag.test.ts
→ Runs: bunx tsc --noEmit + bun test test/dag.test.ts
→ Message: "fix(dag): ready→running CAS 原子抢占防双派发"

User: /commit
→ Detects: docs/ only
→ Skips checks → Message: "docs(plan): ..." → commits directly
```

## Safety Rules

1. **NEVER commit** `.env`, credentials, secrets, `.claude/memory/index/**`
2. **NEVER amend** unless user says `--amend`
3. **NEVER force push** — only local commit (push 须 the owner 在场或显式要求, 见 CLAUDE.md 物理破坏底线)
4. If checks fail, report + STOP — do not retry automatically

---

## Ship 模式 (`--ship`)

> 完整发布流水线。从 commit 到 PR 一条龙。

### Ship Step 0: Pre-flight

1. 当前分支是 `main` → AskUserQuestion 确认 (xihe 1-dev 常直接 main; 真要 PR 流程才分支)
2. `git status` — 有未提交变更 → 先走 Step 0-6
3. Readiness Dashboard: `Branch | Base: main | Commits: N | Files: M | tsc ✅/❌ | tests ✅/❌`

### Ship Step 1: Merge Base

```bash
git fetch origin main && git merge origin/main --no-edit
```
冲突 → 报告冲突文件 → AskUserQuestion (解决/中止)

### Ship Step 2: Full Verify（并行）

| # | 命令 | 超时 |
|---|------|------|
| 1 | `bunx tsc --noEmit` | 60s |
| 2 | `bun test 2>&1 \| tail -20` | 180s |
| 3 | `bun build src/index.ts` | 60s |

**Failure Ownership Triage**: `git diff main...HEAD --name-only` → 本分支引入=必修 STOP; base 已存在=标 `[pre-existing]` 记 error-journal, 不阻塞。

### Ship Step 3: Test Coverage Audit

`bun test --coverage` → 提取覆盖率。对比 `git diff main...HEAD` 变更文件: 新增/改动无对应 test → 警告（不阻塞，仅报告）。

### Ship Step 4: Plan Completion Audit

读 `_NEXT.md` `active_plan` 承诺 vs `git diff main...HEAD` 实际交付: DONE / PARTIAL / NOT DONE / EXTRA。NOT DONE → AskUserQuestion（继续/下次/取消 ship）。

### Ship Step 5: Push & PR

```bash
git push -u origin HEAD
gh pr create --title "type(scope): 中文描述" --body "$(cat <<'EOF'
## Summary
{git log main..HEAD 摘要, 中文}
## Changes
{按文件分组}
## Verify
tsc ✅ · bun test {P pass} · build ✅
## Plan Completion
{完成度}

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
输出 PR URL。

### Ship Output

```
## Ship Report — {date}
| Step | Status | Details |
| Merge Base | ✅ | No conflicts |
| Verify | ✅ | tsc 0, 203 pass, build clean |
| Coverage | ⚠️ | {N} new files without tests |
| Plan Audit | ✅ | {n}/{m} DONE |
| PR | ✅ | #N created |
→ PR: {url}
```
