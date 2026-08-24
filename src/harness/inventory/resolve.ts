/**
 * src/harness/inventory/resolve —— INV-2 解析器 (片 1 公共出口, 供 plan-critic)。
 *
 * 与 ./inventory 内置 `resolve` 的语义差:
 *  - inventory.resolve: 工作集直查 full id, 二态 (IN_WORKING_SET / NOT_IN_WORKING_SET)。
 *    由 INV-1 工作集层消费, 形状只对得上 working-set 字面查。
 *  - 本模块 resolve: 接受 full id **或**裸名, 三态判别联合
 *    (resolved / ambiguous / miss), 供 plan-critic 直接消费成
 *    PP-T01 tool_unresolved (state='miss') 与 PP-T02 tool_ambiguous (state='ambiguous')。
 *
 * INV-2 (字面照搬, 不引申):
 *   - 全限定 id 直查命中;
 *   - 裸名 **全局唯一才许 resolve**;
 *   - ≥2 候选时返回 **全部候选的全限定 id**, 绝不按 source / version / 注册顺序 /
 *     owner_pinned / oracle_bearing 等任何优先级静默选边;
 *   - 未命中一律返回 **空集**, 绝不返回近似 / 模糊候选。
 */
import type { InventoryEntry } from './inventory';

/** 与 ./inventory 的 ID_RE 同源 (字面一致); 本模块不复用其 export,
 *  保持 resolve 模块自洽 —— resolve 不应在自身不可用时被 inventory 字面 import 绊住。 */
const ID_RE = /^[A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+@\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/;

/** INV-2 resolve 返回 —— 判别联合, plan-critic 消费映射:
 *    state === 'miss'      → PP-T01 tool_unresolved (单值 miss, 即「空集」字面)
 *    state === 'ambiguous' → PP-T02 tool_ambiguous, 列出全部 candidates
 *    state === 'resolved'  → 正常路径, caller 拿 entry 继续 */
export type ResolveResult =
  | { state: 'resolved'; entry: InventoryEntry }
  | { state: 'ambiguous'; candidates: string[] }
  | { state: 'miss' };

/** INV-2 解析。判定规则:
 *   1. query 匹配 ID_RE 字面 → 全限定 id 直查; hit = resolved, miss = miss (不回退到裸名,
 *      否则「直查命中」语义失效)。
 *   2. 否则 → 裸名扫 entries[i].name; 0 命中 = miss, 1 命中 = resolved, ≥2 命中 = ambiguous,
 *      ambiguous 必返回全部命中条目的 **全限定 id** (e.id), 长度≥2 时绝不简化。
 *
 *  字面比较, 绝不近似 / 模糊 / Levenshtein / 子串 —— 「未命中」即空集。
 *
 *  @param query    引用字面 (full id 或裸名)
 *  @param entries  候选条目表 (典型: inventory working-set 快照, 由 caller 注入)
 */
export function resolve(
  query: string,
  entries: ReadonlyArray<InventoryEntry>,
): ResolveResult {
  if (ID_RE.test(query)) {
    const hit = entries.find((e) => e.id === query);
    if (hit !== undefined) return { state: 'resolved', entry: hit };
    return { state: 'miss' };
  }
  const matches = entries.filter((e) => e.name === query);
  if (matches.length === 0) return { state: 'miss' };
  if (matches.length === 1) {
    // length===1 守卫下 matches[0] 必有; 显式窄化避免 z.infer 类型 + noUncheckedIndexedAccess
    // 在解构时不收敛 (TS2719 「Two different types with this name exist, but they are unrelated」)。
    const only = matches[0] as InventoryEntry;
    return { state: 'resolved', entry: only };
  }
  return { state: 'ambiguous', candidates: matches.map((e) => e.id) };
}