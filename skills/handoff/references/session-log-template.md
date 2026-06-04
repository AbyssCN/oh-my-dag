# Session Log Template (v6 弹性版本)

> 4 必填 + 6 可选 by judgment. 模型按 session 性质选保留哪些 evidence anchor.
> **核心原则 (mattpocock-merge)**: 不重复已有 artifact (PRD/plan/ADR/commit/diff/_NEXT.md) — 引用 path/URL, 不内联复制. 写 **why**, 不写 **what** (git diff 已有 what).

## 必填 4 段 (任何 session)

```yaml
---
date: YYYY-MM-DD
session_id: s-YYYY-MM-DD-<slug>
feature: <slug>
parent_plan: <docs/plan/... or null>
keywords: [<5-10 召回锚词 — frontmatter array 在 BM25 直接 boost>]
commits: [<sha1>, <sha2>, ...]
---

# Session: <feature>

## Why (必填)
1-3 段, 每决策的 why + 拒绝备选 + 触发证据. 不写 what, 写 why (语义召回杠杆).

## Dead Ends + Rewind (必填; 无则写"无")
- {走错路径 1 句}
  - Root cause: {真正问题}
  - rewind_target: {下次跳到哪里直接出答案}

## Wisdom (必填; 无则"无")
- ej-<id> [type] — <title>

## Open Threads (必填)
- {next_3_steps 的语义层补充, 不重复 _NEXT.md 当前态}
```

## 可选 6 段 (by judgment)

```markdown
## (optional) Evidence          — harness/standards/复杂调试: file:line / commit / test stdout 关键数字
## (optional) Files Produced    — 重大架构改动 (≥10 文件) 列产出 + 行数
## (optional) Plan Status Table — 多 phase plan 的 phase × commit × 状态表
## (optional) Test Outputs      — 验证密集 (RAG eval / E2E / benchmark) 引用 stdout 关键数字
## (optional) Drift Events      — A real_drift 出现时引用 rewind anchor + 失败分类
## (optional) Valar 教训        — 反思密集 session 抽象层教训 (跨 session 复用价值高)
```

## 判断规则

| Session 性质 | 必加可选段 | 预期总行数 |
|---|---|---|
| 普通 feature dev | 仅 4 必填 | 30-50 |
| harness / standards / cognitive-arch | + Evidence + Valar 教训 | 80-120 |
| 多 phase 大重构 | + Plan Status + Files Produced | 100-150 |
| 验证 / RAG eval / benchmark | + Test Outputs | 60-100 |
| 全要素 sprint 收尾 | 全 10 段 | 150-200 |
