# Handoff Internals (按需读 — body 不常载)

## Three-Layer Architecture (handoff 该做什么)

```
认知层 (即时校验)  — handoff 不做, hook 已扛 (drift-class-check Stop hook / dangerous-cmd / stop-verify-check)
学习层 (显式抽取)  — handoff 仅"已识别即写": session 中显式 `wisdom: <title>` → 手动记 (xihe 无 append-journal.mjs)
记忆层 (沉淀全量)  — handoff 主战场: Write session log → background flush.ts (memory-capture hook 已在前序自动 enqueue)
```

> **xihe infra 现实 (v8)**: a sibling project 的 router_v6 yaml + 6 个 handoff-*/graphify/manifest 脚本在 xihe **不存在**.
> `_NEXT.md` = prose 块 (直接 Edit), 唯一存活脚本 = `.claude/memory/scripts/flush.ts`. 不要再引用那些脚本.

## Step 3.4 Claim-Evidence Gate (极简 ~10 行, 不重跑 test)

> Codex F2: drift-class hook 只验 response 标签不验 claim 内容; docs/harness handoff 不走 /commit 无兜底.

扫 session Wright 完成声明关键词 (中: 完成/合并/删除/修复/通过/已修/已加; 英: done/merged/deleted/fixed/passed/added), 提 `{subject,action}` 对照 Step 1 `git diff-stat`/`status`:

| Claim | Evidence | 规则 |
|---|---|---|
| 合并 X→Y | git diff X deletions + Y additions | X -N + Y +N |
| 删除 X | status `D` / log `--diff-filter=D` | 确认删除 |
| 修复 bug X | 测试文件 diff (引用 /verify, **不重跑**) | ≥1 test 文件 diff |
| N/M 通过 | 引用最近 /verify or /commit stdout | 数字匹配 |
| 加 X feature | grep symbol | 能 grep 到 |

不匹配 → Step 5 报 `⚠ CLAIM-UNVERIFIED: {claim}`. 无 claim 关键词 → 跳过.

## Wisdom 触发协议

不让模型 handoff 时"思考要不要写". session 中识别到立刻标一行 `wisdom: <title>`; handoff Step 2c 仅扫 keyword → 抽 type/title/body.
- ✅ 标: pattern/decision/lesson 抽象层 + 跨 session 复用价值高
- ❌ 不标: 一次性 / 太具体 / memory recall 已命中
- **落地 (xihe)**: 无 `append-journal.mjs` → 命中时**手动 Edit `.claude/knowledge/error-journal.json`** (追一条 `{id,type,title,body,keywords}`) 或在 session log `## Wisdom` 段记下交下个 session. 频率低, 不值得为它造脚本 (GP-9).

## `_NEXT.md` 顶部块 (Step 3a, 直接 Edit 非脚本)

prose `##` 块, 新块 prepend 到第一个 `## ` 之上. 当前态全在最上块; 旧块 FIFO 保留 (历史 audit), 文件过长时最旧块手动移 `docs/session/_JOURNAL.md`. 失败即 Edit 报错 (无 partial state, 无 abort-on-fail 地雷).

## 调试

| 症状 | 排查 |
|---|---|
| pending.jsonl 不增长 | settings.json memory-capture hook 注册? |
| flush "pending empty" | hook 没触发 or 全 EXCLUDE 文件 (正常, no-op) |
| `_NEXT.md` Edit old_string 不唯一 | 顶部块 marker 选更长的唯一锚 (含 date+title) |
| session log 写了但没召回 | frontmatter `keywords` array 是否填 (BM25 boost 锚词) |

## Ship History

- **v8 (2026-06-01)**: 对齐 xihe 真实 infra. a sibling project 移植残留的 6 个脚本 (handoff-write-router/force-capture/gen-sessions-manifest/handoff-codex-scan/append-journal/graphify) 在 xihe **全不存在** → 删除引用 + abort-on-fail 地雷 (原 3a 脚本失败会整个 abort 不写 log). router_v6 yaml → prose `_NEXT.md` 直接 Edit. 唯一存活脚本 = flush.ts. 4 calls.
- **v7 (2026-05-29)**: progressive disclosure (body 435→~150 行, template/internals 移 references/) + mattpocock-merge (reference-not-duplicate 强化 / Suggested Skills 段 / redaction / arg=next-focus). 降 token.
- v6 (2026-05-01): Codex 6 finding 整合 + capture.ts 启用 + router-first abort + 弹性 log 模板
- v5 (2026-04-29): cognitive 字段砍, hook 接管 drift
- v4 (2026-04-22): Critical Index Deletion Guard
- v3 (2026-04-19): Claim vs Evidence 门
- v2 (2026-03-29): Wisdom + 双轨写入
