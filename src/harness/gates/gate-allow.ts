/**
 * src/harness/gates/gate-allow —— 引用语境豁免标记(2026-08-26)。
 *
 * ## 它解决什么
 *
 * 模式型的闸(词表匹配 / 字面坐标 / 同句配对)只看字面, **不区分「使用」与「引用」**。
 * 而「说明某个写法不该出现」这件事本身就要把那个写法写出来 —— 于是解释禁止项的注释
 * 被自己解释的闸判红。本 session 撞到五次, owner 与 leaf 各中, 五次全靠改述绕开。
 *
 * 改述能过闸, 代价是把「为什么不这么写」的反面教材一并磨掉, 下一个人于是再写一遍。
 * 这个标记给出第三条路: **留着原文, 说清理由, 让闸放行这一行**。
 *
 * ## 用法
 *
 *     // gate-allow(seat-coordinate): 这里是前缀哨兵判断, 不是要用某个坐标
 *
 * 两条硬要求:
 *   - **闸 id 必须对上** —— 给 seat 闸的豁免不顺带豁免 coord-check。一行一闸, 不搞通配。
 *   - **理由必须非空** —— 空标记不生效。豁免是要留证据的动作, 不是消音开关;
 *     没有这一格, `gate-allow(x):` 就成了万能静音, 那比闸误报更坏。
 *
 * ## 它不是什么
 *
 * 不是白名单的替代。白名单登记的是「这个**违例**暂时留着」(存量债);
 * 本标记声明的是「这一行**根本不是违例**, 闸看错了」。两者的举证责任不同:
 * 白名单要 owner 裁, 这个只要写清为什么它不是违例 —— 因为它就在被判的那一行旁边,
 * 读代码的人和判它的闸看到的是同一句话。
 */

/** `gate-allow(<id>): <理由>`。理由捕获到行尾。 */
const GATE_ALLOW_RE = /gate-allow\(([a-z0-9-]+)\)\s*:(.*)$/;

/**
 * 这一行有没有针对 `gateId` 的豁免标记。
 *
 * @returns 理由原文(已 trim);无标记 / 闸 id 不符 / 理由为空 → `null`。
 */
export function gateAllowReason(lineText: string, gateId: string): string | null {
  const m = GATE_ALLOW_RE.exec(lineText);
  if (!m) return null;
  if (m[1] !== gateId) return null;
  const reason = (m[2] ?? '').trim();
  return reason.length > 0 ? reason : null;
}
