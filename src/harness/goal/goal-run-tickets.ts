/**
 * src/harness/goal/goal-run-tickets —— **结晶 SDD 票开档**的 goal 侧件
 * (契约 `docs/plan/2026-08-11-control-plane-unification.md` 切片 6)。
 *
 * ## 它补的是哪条缝
 *
 * `dag_goal` 起跑即开任务票 (D-6③「run 天然挂票」): 票是给 map 看的, 让决策地图长出这一趟 run。
 * 已结晶 SDD 直通档 (`sddPath` 给了) 时, 这张票还要把**整张 SDD 的写集并集 + sddPath 本体**
 * 一并带过去 —— 后端 (gh / md) 落盘走两条不同路径 (gh 走 `Write-set:` / `Sdd-path:` body 锚,
 * md 走 StoredTicket), NewTicket 这一跳要的就是**机械拼出来的两样**, 不许在这一步再读一遍
 * 分解表 (那是 `sdd-direct` 的活)。
 *
 * ## 边界
 *
 *  - 不本地解析 Breakdown —— 一旦在这里再写一份表解析, 词表漂移立刻出现两份 (本仓已为这
 *    类漂移付过账, `pathfinder/run-tickets.ts` 头注就是上一条伤口)。所有写集来源都走
 *    `ticketFieldsFromSdd`, 它是闸 C「契约段产物复用」的同一条消费通路。
 *  - 不改**非结晶档**的票语义 —— `sddPath` 缺席时这张票该长什么样还长什么样 (缺席字段不传,
 *    与 NewTicket 的 NULL≠0 契约同款)。这里的改动**只加**, 不动既有的开票路径。
 *  - 不修改其他文件 —— sdd-direct 的 `ticketFieldsFromSdd` 是已有的正确实现, 本文件只是
 *    给它一个 goal 侧的名字, 让 goal-run-tickets.ts 的导入面自洽 (不穿越 sdd-direct 也能
 *    摸到挂票要的两样)。
 *
 * ## 用法
 *
 * 给 `PathBackend.addTicket(cwd, slug, nt: NewTicket)` 拼 NewTicket 时:
 *
 * ```ts
 * const sddFields = sddPath ? ticketFieldsFromSdd(sddPath) : undefined;
 * backend.addTicket(cwd, slug, {
 *   ...,
 *   ...(sddFields ? { writeSet: sddFields.writeSet, sddPath: sddFields.sddPath } : {}),
 * });
 * ```
 *
 * `sddFields` undefined → 两个字段都缺席 (`writeSet === undefined` 表示**不承诺**,
 * 与显式 `[]` 的「承诺但本轮空改」语义严格区分)。
 *
 * `loadSddContract` / `parseBreakdown` 的 fail-loud 性格**继承**: sddPath 给了一段坏契约,
 * 开票直接抛 —— 不静默塞空, 不降级回非结晶档 (NULL≠0)。
 */
export { ticketFieldsFromSdd } from './sdd-direct';
