/**
 * src/harness/goal/accept-baseline —— 取验收命令的**末环**当基线命令 (SDD 片 1)。
 *
 * ## 为什么这个函数可靠
 *
 * 验收命令的形状由 `src/harness/goal/sdd-compile.ts:373-380` 逐字规定为
 * 「各片 verify 去重串联, 末尾接一环去掉路径限定的全量版」, 形式形如
 *   `ugrep -q ... && bun test .../a.test.ts && bun test`
 * 两截职责互斥: 前半给判别力 (活干之前必红, 否则就是空判据), 后半给全量回归 (accept 节点本职)。
 * 末环 = 去掉路径的全量版, 活干之前跑它, 量到的就是这个仓当下真实的存量红。
 *
 * 直通档 (`acceptCommandFromBreakdown` 生成的 `&&` 链) → 切末环, 走纯函数语义。
 * 非直通档 (分类器给的单条命令, 无 `&&`) → 原样返回, 是非直通档零回归的**构造保证**
 * (INV-2: 不靠开关, 由"切不出多段就原样返"这一支成立)。
 *
 * ## 与 `makeBaselineWaiver` 的边界
 *
 * 本模块只产**基线要跑的命令**。赦免语义 (非空 ∧ 子集 → 赦免; 空集 / 新失败 → null)
 * 留在 `run-goal.ts:makeBaselineWaiver`, 一个字不动。本片只让它收到一个**有内容的**基线:
 * 基线真的量不到任何红时, 赦免本来就不该成立 (fail-closed)。
 */
const SEG_SEPARATOR = /\s*&&\s*/;

/**
 * 从验收命令取该跑的基线命令。
 *
 * 规则 (D-2 一句话):
 * - 按 ` && ` 切 (含两侧多空格的形), 取最后一段并 trim。
 * - 切不出多段 (整串不含 `&&`) → **原样返回**, 字节相同。
 *
 * @param acceptCommand 直通档 = `&&` 链; 非直通档 = 单条命令。
 * @returns 该跑以量基线的命令 (纯函数, 无 IO, 无副作用)。
 */
export function baselineCommandOf(acceptCommand: string): string {
  const parts = acceptCommand.split(SEG_SEPARATOR);
  if (parts.length < 2) return acceptCommand; // 无 && → 原样返回 (INV-2)
  return (parts[parts.length - 1] ?? '').trim();
}
