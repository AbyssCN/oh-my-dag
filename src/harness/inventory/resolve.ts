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
 *
 * C-2 (片 2 增量):
 *   - INV-7: 解析对 `isExcluded` 为真的条目返未命中 + 理由 (D-5: 仅 PROBED_FAIL ∧ APPLICABLE
 *     触发剔除,其余三种组合的剔除判据一律假 → 仍命中)。**理由必须可读** —— 静默剔除与
 *     「本来就没有」在读数上分不开 (验收 #3: 「剔除理由可读」)。
 *   - 不预登记 `reason` 字段给「未找到」分支 (字面 = `{state:'miss'}`, 与 resolve.test.ts
 *     现有 ④ 形状断言兼容);`reason` 只在剔除分支出现,作为判别联合里的可选项。
 */
import type { InventoryEntry } from './inventory';
import { isExcluded } from './health';

/** 与 ./inventory 的 ID_RE 同源 (字面一致); 本模块不复用其 export,
 *  保持 resolve 模块自洽 —— resolve 不应在自身不可用时被 inventory 字面 import 绊住。 */
const ID_RE = /^[A-Za-z0-9_.:-]+:[A-Za-z0-9_.-]+@\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/;

/** 剔除理由字面 (D-5: 仅 `PROBED_FAIL ∧ APPLICABLE` 触发;字面锁死便于断言)。 */
export const EXCLUDE_REASON =
  'excluded:probe_state=PROBED_FAIL ∧ applicability=APPLICABLE';

/** INV-2 resolve 返回 —— 判别联合, plan-critic 消费映射:
 *    state === 'miss'      → PP-T01 tool_unresolved (单值 miss, 即「空集」字面)
 *    state === 'ambiguous' → PP-T02 tool_ambiguous, 列出全部 candidates
 *    state === 'resolved'  → 正常路径, caller 拿 entry 继续
 *  miss 形态可选携带 `reason` —— 仅当条目存在但被 `isExcluded` 剔除时填;未找到/歧义不填。 */
export type ResolveResult =
  | { state: 'resolved'; entry: InventoryEntry }
  | { state: 'ambiguous'; candidates: string[] }
  | { state: 'miss'; reason?: string };

/** INV-2 解析。判定规则:
 *   1. query 匹配 ID_RE 字面 → 全限定 id 直查; hit = resolved, miss = miss (不回退到裸名,
 *      否则「直查命中」语义失效)。
 *   2. 否则 → 裸名扫 entries[i].name; 0 命中 = miss, 1 命中 = resolved (但先过 `isExcluded` 闸),
 *      ≥2 命中 = ambiguous (歧义仍照常返,**不**对单条剔) —— 模糊本身已是拒绝,不再叠 reason。
 *
 *  直查命中分支: 同上, 先过 `isExcluded`, 命中但被剔 → miss + reason (INV-7)。
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
    if (hit === undefined) return { state: 'miss' };
    if (isExcluded(hit)) return { state: 'miss', reason: EXCLUDE_REASON };
    return { state: 'resolved', entry: hit };
  }
  const matches = entries.filter((e) => e.name === query);
  if (matches.length === 0) return { state: 'miss' };
  if (matches.length === 1) {
    // length===1 守卫下 matches[0] 必有; 显式窄化避免 z.infer 类型 + noUncheckedIndexedAccess
    // 在解构时不收敛 (TS2719 「Two different types with this name exist, but they are unrelated」)。
    const only = matches[0] as InventoryEntry;
    if (isExcluded(only)) return { state: 'miss', reason: EXCLUDE_REASON };
    return { state: 'resolved', entry: only };
  }
  return { state: 'ambiguous', candidates: matches.map((e) => e.id) };
}
