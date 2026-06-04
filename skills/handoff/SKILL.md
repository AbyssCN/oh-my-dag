---
name: handoff
tier: foundation
runtime: on-demand
trigger: mention
argument-hint: "(optional) 下个 session 的 focus — 据此裁剪 next_3_steps + Suggested Skills"
description: "Session 收尾仪式: 更新 _NEXT.md active plan + 写 session log + memory capture. 跳过 = 下次 session 丢 context. Trigger: 结束 / 收工 / handoff / 交接 / 保存进度 / 今天到这 / session结束. Skip: 提交代码 (/commit) / 开新 session (/start)."
metadata:
  source: claude-skills
  version: "8.0.0"
---
# /handoff — Session Wrap-Up v8 (xihe-real)

> 单一 Fast Path, 目标 ≤ 4 tool calls. Body 精简; 模板/内部原理在 `references/` 按需读.
>
> **v8 (2026-06-01)**: 对齐 xihe 真实 infra — 去掉 a sibling project 移植残留的 6 个不存在脚本
> (`handoff-write-router`/`force-capture`/`gen-sessions-manifest`/`codex-scan`/`append-journal`/`graphify`)
> + abort-on-fail 地雷。`_NEXT.md` 是 prose 块 (非 router_v6 yaml fence) → 直接 Edit 顶部块.
> 唯一存活脚本 = `.claude/memory/scripts/flush.ts`. 见 §Ship History.

## Trigger / Input

`/handoff` 或 `/handoff <focus>`. `<focus>` = 下个 session 重点 → 据此裁剪 next_3_steps + Suggested Skills. 无参 → 从 session 活动 auto-generate.

## 三条贯穿原则 (mattpocock-merge — 直接降 token)

1. **Reference, don't duplicate** — session log / `_NEXT.md` 引用已有 artifact (commit sha / plan path / ADR / diff / 上个 session log) 的 **path/URL**, 绝不内联复制其内容. 写 **why**, git diff 已有 **what**.
2. **Redact** — session log 里遮掉 secrets / API key / token / HMAC / PII (xihe 涉 WeCom/Lark/MiMo key). 命中写 `<redacted:kind>`.
3. **Suggested Skills** — 报告含一段: 下个 agent 该先 invoke 哪些 skill (依 `<focus>` + 当前 gate).

---

## Fast Path (≤ 4 tool calls)

### Step 1: Gather (1 message)

```bash
cd "$(git rev-parse --show-toplevel)" && \
echo "=LOG=" && git log --oneline -5 && \
echo "=STATUS=" && git status --short --branch && \
echo "=DIFF_STAT=" && git diff --stat "$(git rev-parse origin/main 2>/dev/null || echo HEAD~1)"..HEAD
```
\+ Read `_NEXT.md` 顶部块 (worktree 下读 `_NEXT.wt-<slug>.md`). `_NEXT.md` = prose `##` 块按 `---` 分隔, **无 yaml router fence** — 当前态在最上面那块.

### Step 2: Analyze (纯推理, 0 IO)

- **2a Summary**: feature / last_session_summary (1-2 句) / blocked_on / next_3_steps (动词+宾语; 有 `<focus>` 则对齐它)
- **2b Gap**: _NEXT 原 next_3_steps vs 实际 → DONE / PARTIAL / SKIPPED / UNPLANNED
- **2c Wisdom 候选**: 仅扫 session 中显式 `wisdom: <title>` 标记 (命中才记, 默认 0 条; 协议见 references)
- **2d Slug**: feature → 小写连字符

### Step 3: Write (2 calls — _NEXT 先, log 后)

**3a `_NEXT.md` 当前态块 (Edit, 先成功)** — 在文件顶部 (第一个 `## ` 块之上) prepend 一个新块:
```markdown
## {emoji} {date} session ({phase}) — {title} (下次从这读)

> {1-2 句当前态 + commit range}。

**ship 了**: {要点, 引用 commit/path 不复制 diff}
**验收**: tsc {0} / {N} pass / {0} fail / build {绿}
> **下次起手 = {next}**: {依赖序引用 plan §}

---
```
保留下方旧块 (FIFO, 不删历史; 太长时最旧块手动移 `docs/session/_JOURNAL.md`). 应用原则 1+2.

**3b Session Log (Write)** — `.claude/sessions/{date}-{slug}.md`. 模板 (4 必填 + 6 可选) 见 `references/session-log-template.md`. 引用不复制 + redact.

### Step 3.4 Claim-Evidence Gate (纯推理, 不重跑 test, 无脚本)

扫完成声明关键词 (完成/合并/删除/修复/通过 · done/merged/deleted/fixed/passed) 对照 Step 1 git diff-stat. 不匹配 → Step 5 标 `⚠ CLAIM-UNVERIFIED: {claim}`. 无关键词 → 跳过. 规则表见 references.

### Step 4: Memory flush (1 message, background)

```bash
cd "$(git rev-parse --show-toplevel)" && ( npx tsx .claude/memory/scripts/flush.ts > /dev/null 2>&1 & disown )
```
pending 空 = no-op (~50ms). 永不阻断 handoff. (a sibling project 的 force-capture/manifest/graphify 在 xihe 不存在 → 不调.)

### Step 5: Report (≤ 15 行)

```
## Session Handoff — {date}
### {last_session_summary}
### Gap   | # | 目标 | ✅/🔸/⏭️ | 备注 |
### Next  1. … 2. … 3. …
### Suggested Skills   (依 <focus> + gate)
- 下个 session 先: {/start, 然后 X}
### Wisdom (如有) — [{type}] {title}  (xihe 无 append-journal → 手动 Edit error-journal.json 或交下个 session)
### Claim-Evidence (仅 ⚠ unverified)
### {clean / 建议 /commit / /verify / /review}
```
**Gate**: ≥3 src 文件变更 → 建议 `/review --sweep`; ≥5 文件 + 跨层/迁移 → `/review --release-gate`.

---

## Constraints

- Tool calls ≤ 4 (gather 1 + write 2 + flush 1); 报告 ≤ 15 行
- **永远不 auto-commit** — 例外: the owner 本轮显式说 "push"/"提交" 时, 提交 session log (docs commit) 并 push 是 owner 指令, 不算 auto
- Wisdom 仅 session 中显式 `wisdom:` 标记触发, handoff 不主动决定
- Worktree: 只写 `_NEXT.wt-<slug>.md`, 禁碰 master `_NEXT.md`
- Memory flush 永不阻断 (flush.ts 内部处理 pending 空 / embed 失败)
- **无 abort-on-fail**: `_NEXT` Edit 与 log Write 都是原生工具, 失败即报错, 不会留 partial state
- 应用三原则 (reference-not-duplicate / redact / suggested-skills) 是降 token 的核心

---

## References (按需读)

- `references/session-log-template.md` — Step 3b 写 log 时读 (4 必填 + 6 可选 + 判断表)
- `references/handoff-internals.md` — claim-evidence 规则表 / wisdom 协议 / 调试 / ship history
