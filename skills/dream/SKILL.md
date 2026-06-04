---
name: dream
tier: foundation
runtime: on-demand
trigger: mention
description: "手动触发 valinor Dream consolidation: 把 agent 的 raw events 提炼成 L0-L6 记忆 (经 Memory Restraint 3-gate + validateFactWrite)。跑全层, 最大预算 ~10k token。Trigger: /dream / 做梦 / 整理记忆 / consolidate memory / dream run / 跑一次 dream / 记忆整理. Skip: 日常验证 (/verify) / 提交 (/commit) / 历史召回 (/recall)."
metadata:
  source: claude-valinor
  version: "1.0.0-valinor"
  methodology: "D55 Dream service · dream-architecture-2026-05-29.md §7.1 (D1-D8)"
---
# /dream — Manual Dream consolidation (valinor)

> 把一个 agent 自上次 watermark 以来的 raw events 提炼成记忆 facts。
> **设计源**: `docs/knowledge/research/dream-architecture-2026-05-29.md` §3 (7 层矩阵) + §3.5 (Memory Restraint 3-gate)。
> **自动触发**: Conductor 每 tick 查 `valinor_dream_watermarks` — `events_since_last_dream > 50` OR `last_dream_at < now()-4h` 的 agent 自动 dream。`/dream` 是**手动**全量触发。

## Trigger 词

`/dream` · 做梦 · 整理记忆 · consolidate memory · dream run · 跑一次 dream · 记忆整理

## 跑什么 (全层, 最大预算 ~10k token)

一次 manual dream 跑**所有 7 层** (vs heartbeat 只跑 L2):

```
events (id > last_dream_event_id)
  → DreamModel.consolidate()        # 模型矩阵 D60 接线; 当前 unwired → 报错 (不静默假成功)
  → restraintGate (3 关)            # UTILITY / ROUTING SoT / RESTRAINT ban-list (§3.5.1)
  → router (by-layer 分发)          # §3.3
      L0 → client-context 预热 (UPDATE valinor_clients prediction)
      L1 → DEFERRED (无 substrate — log + audit, 不写)
      L2 → MemOS facts (每条必经 validateFactWrite — D54 SAFEGUARD-2 v2)
      L3 → HARD REJECT (business PG SoT — Dream 永不碰)
      L4 → DEFERRED (无 code graph)
      L5 → inbox propose (needs_human_verify, 不直接写 business_relations)
      L6 → ~/vault/<agent>/dreams/<date>.md (per-agent)
  → audit (valinor_events type='dream_run_completed' + <5% ratio 自校验)
```

## 硬约束 (不可绕过)

1. **L2 必经 validateFactWrite** — 没有任何绕过分支。reject 的 fact 落 `valinor_memos_rejects`, 不进 L2。
2. **L3 business PG 完全不碰** — 任何 L3 意图 candidate 直接 hard-reject + log, 永不 INSERT/UPDATE/DELETE。
3. **L1/L4 deferred** — 无 substrate, 走 deferred 分支 (audit 记 `deferred_layers`), **绝不伪造 write 成功**。
4. **Memory Restraint** — SoT (发票/分录/财务数字/文档正文) drop; banned namespace (GDPR/监控/特殊类别) drop; 只留 derived (偏好/模式/教训/承诺/deadline)。
5. **<5% 健康比例** — `facts_extracted / events_processed > 20%` → audit 标 `warn: over-recording, tighten prompt`。

## 当前状态

- **⚠ 两条路径 (2026-06-03 实测校正)**: 上方 routing 图是 **canonical 路径的理想设计** (engine→restraint→router→purify→audit), 全部已建但 `wireDreamRunner`/`setDreamRunner` **零生产调用** → DORMANT, 只 test 可达。**valar 实际 live 跑的是轻路径**: `tui.ts → new LiveDreamModel() → createDreamPump → dream-pump.consolidate → valar.memory.writeFact(validateFactWrite)`, **绕过 engine/restraint/router/purify**。两路同实现 `DreamModel` 接口 (model.ts:66), 但 live 路径不经 canonical 机器。
- **模型 seam (D55/D60)**: `src/dream/model.ts` `DreamModel` 接口。`LiveDreamModel` (model-live.ts) 已是 live 实现 (经 dream-pump); `unwiredDreamModel` 仅作未注入兜底 (throw 不静默假成功)。
- **源**: live `src/dream/model-live.ts` + `src/valar/learning/dream-pump.ts` · canonical(DORMANT) engine `src/dream/engine.ts` · purify `src/dream/purify.ts` (629 行已建) · restraint `src/dream/restraint.ts` · router `src/dream/router.ts` · adapters `src/dream/adapters/*` · audit `src/dream/audit.ts`。
