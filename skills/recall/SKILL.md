---
name: recall
tier: capability
runtime: on-demand
trigger: mention
description: "Memory layer 主动召回: 推理/写作/决策卡住时 Valar 主动查 8734 chunks 库, 不靠 hook 触发. 补 R1-R3 被动消费的盲点. Trigger: /recall / 查历史 / 翻一下记忆 / recall / 以前怎么做的 / there should be precedent. Skip: 文件 grep (Grep) / 调用链 (/graph) / 库文档 (mcp__context7) / git 历史 (git log)."
metadata:
  source: memory-layer-routing
  version: "1.0.0"
  routing: R10
---

# /recall — Memory Layer 主动召回

> Phase 1 Memory Layer Routing R10 — 主动消费,补 hook 被动触发盲点。

## When to use

R10 触发时机(主动型,非 hook 触发):
- **写 plan/PRD 中卡住** — 想"以前类似怎么决策的"
- **设计抉择** — "该用 X 还是 Y" 想看历史依据
- **跨模块复用** — "以前哪个模块解决过类似问题"
- **方法论查询** — "我们的标准是什么"
- **历史教训查询** — "这个坑以前踩过吗"

不用于:
- 文件内字面量搜索 → Grep
- 函数调用链 → /graph what-uses / refs
- 第三方库文档 → mcp__context7
- git 提交历史 → git log

## Input

```
/recall <topic>
/recall <topic> --k 5            # default k=5, 高于 hook 路由的 3
/recall <topic> --kind decision  # filter sourceKind
/recall <topic> --path docs/plan # path filter (R13)
```

`<topic>` 可以是:
- 自然语言 query: `RLS policy auth.uid 跨租户隔离`
- 关键词: `Procountor 报表 G3`
- 文件名 + 关键词: `dashboard-overview.ts feature flag`

## Workflow

### Step 1 — 选 K 和 filter

K 默认 5(高于 hook 路由的 3 — 主动召回时 Valar 想看更全)。

如果 `<topic>` 涉及:
- 决策/方案 → 加 `--kind decision`
- 标准/规范 → 加 `--kind standards`
- 失败/坑 → 加 `--kind error,journal`
- 文件历史 → 加 `--path <prefix>`

### Step 2 — 调 retrieve.ts CLI

```bash
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing
```

如有 `--kind` filter:
```bash
# retrieve.ts 不支持 sourceKind filter 但支持 path filter
# sourceKind=decision 一般在 docs/plan/ 或 docs/prd/
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing --path-filter "docs/(plan|prd)/"
```

如有 `--path` filter:
```bash
npx tsx .claude/memory/scripts/retrieve.ts "<topic>" --k 5 --format briefing --path-filter "<regex>"
```

### Step 3 — 展示 + 自评

输出 retrieve briefing 给 the owner 看 (top-5 sourcePath + breadcrumb + 100 字 preview)。

然后 Valar **自评相关性**:
- 哪条直接回答 topic
- 哪条只是边角相关
- 哪条无关 (R14 反馈: 响应内附 [Memory-Echo-Ack: applied|irrelevant|ignore])

## 输出格式

```
### 💾 Relevant Memory (top-5)

1. **[decision]** PLAN-stage2-dashboard-overview-materials.md — Stage 2 dashboard overview RPC...
   `docs/plan/PLAN-stage2-dashboard-overview-materials.md` · 0d old

2. **[standards]** ACCOUNTING-ENGINEERING-STANDARD.md — 会计级业务不变量 + 状态机...
   `docs/standards/ACCOUNTING-ENGINEERING-STANDARD.md` · 7d old

...

[Memory-Echo-Ack: applied|irrelevant|ignore]
(本次召回是否用上, 写到响应末尾, R14 反馈学习)
```

## R5 Domain-First 自检

Memory layer 是 meta-layer 不是 domain。`/recall` 用法限制:
- ✅ Plan/PRD 写作前/中: 高价值, 防重复造轮子
- ✅ 决策时刻: 历史决策依据
- ⚠️ 不要用于探索性闲查 — 8 秒 retrieve 不省比 grep
- ❌ 不要做 /retro 替代 — /retro 看 git 不看 chunks

## 与其他 R 路由的关系

| 路由 | 触发 | Query | K |
|---|---|---|---|
| R1 failure-recovery | 命令失败 (hook) | tool + stderr | 3 |
| R2 patch-detector | Edit 文件 (hook) | file path + context | 3 |
| R3 cognitive-trigger | 挫败关键词 (hook) | feature + recent calls | 3 |
| R8 pre-plan-write | 写 plan (hook) | filename + feature | 5 |
| R9 pre-prd-write | 写 PRD (hook) | filename + feature | 5 |
| R10 /recall | **主动调** (本 skill) | 任意 topic | 5 |
| R11 pre-dispatch-gate | dispatch agent (hook) | subagent + feature | 3 |

R10 是补 R1-R3 被动 + R8/R9 写文档前 + R11 agent dispatch 之外的**主动消费**盲点。
