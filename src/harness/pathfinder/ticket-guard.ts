/**
 * src/harness/pathfinder/ticket-guard —— **裁决入口的唯一守卫** (INV-BOX-1)。
 *
 * ## 为什么是它
 *
 * 写侧入口 (MCP `path_rule` / `map_confirm`, 以及 TUI 收件箱接线) 对一张票的第一件事是
 * 「把它给的字符串解成盘上真 id, 再判这道动作能不能做」。同一对逻辑 (`#177` / `177`
 * 归一 + suggested 守门) 一旦散落在两个调用方就是两份实现、两处漂的起点。
 *
 * 实测 (2026-08-19, `pathfinder.ts:112-116` 那处漂的原本):
 *   · `path_rule` 的 suggested 守卫走精确匹配 → 传裸 `177` 时 `find` 返回 undefined → 守卫不响;
 *   · `backend.rule` 走 `bareNumber()` 归一 → 裸 `177` 照样命中 → 真去 comment + close。
 *   · `map_confirm` 在 #206 前完全不归一 → 裸 `177` 报「票不存在」。
 *   **同一个 id 在三处三种行为** —— 这片抽出来就是为了把"归一"与"守卫"焊成一件共享的。
 *
 * ## 承诺 (INV-BOX-1)
 *
 *   1. 三个函数**零 IO**, 吃 `PathMap` 吐判定 —— MCP 与 TUI **都**调这一份。
 *   2. `reason` 逐字沿用 MCP 那两条 (`pathfinder.ts:499` / `:504` 的 `err(...)` 字面量)。
 *      两处不同措辞 = 两个真源的开始, 所以此处不改一字符。
 *   3. `reason` 里点的 id = 盘上的真 id (resolveTicketId 解出来那个), 「找不到」分支
 *      例外 —— 用调用方给的原串, 跟 MCP 逐字一致。
 *
 * @see INV-BOX-1 (SDD 片 6)
 */

import type { PathMap } from './types';

/**
 * 把调用方给的票 id 解成**盘上真实的那个 id** (#206, 2026-08-19)。
 *
 * ## 为什么需要它 (这不是人体工学, 是个洞)
 *
 * gh 后端的票 id 是 `#N`, 而工具面历来也收裸 `N` —— 因为**写路**会 `bareNumber()` 归一
 * (`backend-gh.ts`)。但**读路**是精确匹配 (`t.id === ticketId`)。于是同一次调用里同一个字符串
 * 指向两个东西:
 *   · `path_rule` 的 suggested 守卫 (GWT-8 / INV-S1-1「suggested 票不许绕过人确认直接裁」)
 *     走读路 → 传裸 `177` 时 `find` 返回 undefined → **守卫不响**;
 *   · `backend.rule` 走写路 → 裸 `177` 照样命中 → **真去 comment + close 了**。
 * 实测 (2026-08-19): 同一张 suggested 票, `#177` 被守卫拒, `177` 直接裁掉并写了 gh。
 * 而 `map_confirm` 完全不归一 → 裸 `177` 报「票不存在」。**同一个 id 在三处三种行为。**
 *
 * 归一放在**工具层**而不是各后端: 后端的 id 形状是它自己的事 (md 是 `t1`, gh 是 `#N`),
 * 而"用户打的那串指哪张票"是工具面的职责。解出来之后读路写路共用**同一个值**, 漂移无处发生。
 *
 * 抽到 `ticket-guard.ts` 后, 这段头注**保留作为历史**;MCP 原文件 `pathfinder.ts:112-116` 那段
 * 头注会在切片 2 改写为「已修 — 见 ticket-guard.ts」。
 *
 * @returns 盘上的真 id; 认不出 → null (调用方响亮拒, 不猜)。
 */
export function resolveTicketId(map: PathMap | null, raw: string): string | null {
  if (!map) return null;
  const want = raw.trim();
  if (!want) return null;
  const bare = (s: string): string => s.replace(/^#/, '');
  // 精确优先; 再按"去掉 # 之后相等"认 —— 只这两档, 不做模糊前缀匹配 (猜错票比认不出坏得多)。
  return map.tickets.find((t) => t.id === want)?.id ?? map.tickets.find((t) => bare(t.id) === bare(want))?.id ?? null;
}

/** 守卫判定。MCP 与 TUI 拿到的是同一形状, 没有任何一路能把 `ok:true` 跟 `ok:false` 串味。 */
export type GuardResult = { ok: true; id: string } | { ok: false; reason: string };

/**
 * `path_rule` 守卫 (INV-BOX-1): 归一 + suggested 守门。
 *
 *   · 认不出 → `ok: false`, reason 字面照 `pathfinder.ts:499`。
 *   · 认得但 status === 'suggested' → `ok: false`, reason 字面照 `pathfinder.ts:504`
 *     (「先 map_confirm accept/reject」那句**不能改**, 它是给 owner 看的下一步指引)。
 *   · 其余 → `ok: true`, `id` 是盘上真 id。
 */
export function canRule(map: PathMap | null, raw: string): GuardResult {
  const resolved = resolveTicketId(map, raw);
  if (!resolved) {
    return { ok: false, reason: `找不到票 "${raw}" — map_tickets 看现有票 (gh 后端的 id 形如 #206)` };
  }
  const target = map!.tickets.find((t) => t.id === resolved);
  if (target?.status === 'suggested') {
    return { ok: false, reason: `票 "${resolved}" 是机器建议 (suggested) — 先 map_confirm accept/reject, 确认后才可裁决` };
  }
  return { ok: true, id: resolved };
}

/**
 * `map_confirm` 守卫 (INV-BOX-1): 归一 (suggested 票**正**是 confirm 的合法目标, 不挡)。
 *
 *   · 认不出 → `ok: false`, reason 字面同 `path_rule` 的「找不到」分支 (两入口同形同辞)。
 *   · 其余 → `ok: true`, `id` 是盘上真 id。
 *
 * 故意不判 status: 一张 suggested 票**应当**能 confirm, 这是 confirm 的存在意义;
 * suggested 守门只在 `canRule` 里 (INV-S1-1), 不复述到这里。
 */
export function canConfirm(map: PathMap | null, raw: string): GuardResult {
  const resolved = resolveTicketId(map, raw);
  if (!resolved) {
    return { ok: false, reason: `找不到票 "${raw}" — map_tickets 看现有票 (gh 后端的 id 形如 #206)` };
  }
  return { ok: true, id: resolved };
}