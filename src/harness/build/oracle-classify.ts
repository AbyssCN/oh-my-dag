/**
 * src/harness/build/oracle-classify —— dag-build heal-fixpoint 的**分支谓词** (Phase-2 condition 节点 PATTERN)。
 *
 * 背景: dag-build 的 `while (!green && healed < maxHeal)` 自愈循环**本就是 build 的图外 fixpoint**
 * (轮 = fix-DAG 重规划, judge = tsc/test oracle, 注入错误重跑, maxHeal 有界)。原实现"任何红都盲愈" ——
 * 不区分"在进展 / 卡死 / 编译器级硬错", 会把 heal 预算烧在烧不动的失败上。
 *
 * 本模块 = 该 fixpoint 的 condition 节点谓词: `f(oracle 结果) → branch_key`, **封闭集 + fail-closed**。
 * 抽成纯函数 (无 IO) 的唯一目的: 可单测 + driver 复用。**不是** condition 框架 (无 DSL / 无编译期 validator /
 * 无 DAG 节点原语 —— 那些是 premature; 先在这一个真实落点把 "封闭集 + fail-closed + 路由器" 跑通)。
 *
 * fail-closed 不变量 (load-bearing): 只有 `curr.green===true` 才返回 'green'; 任何不确定/未知一律落到
 * **不出闸**的安全侧分支 (healable 受 maxHeal 有界 / hard_fail / stuck 立即停)。绝不把红静默判成绿。
 */

/** heal fixpoint 的封闭分支集。路由器 (driver) 只在 'healable' 继续烧轮, 其余皆停。 */
export type OracleBranch = 'green' | 'healable' | 'stuck' | 'hard_fail';

/** classifyOracle 需要的 oracle 结果切面 (与 dag-build OracleResult 结构兼容)。 */
export interface OracleSnapshot {
  /** tsc + test 全绿 (零错误)。 */
  green: boolean;
  /** 错误摘要 (逐字节比较判零进展)。 */
  digest: string;
  /** 结构化 tsc 错误行 (匹配编译器/配置级硬错)。 */
  tscErrs: string[];
}

/**
 * 编译器/配置级硬错: 非代码内容缺陷, fix-DAG (改文件内容的 agent) 对其无从下手。
 *  - TS5xxx   : tsconfig 选项错误 (如 TS5023 unknown option)
 *  - TS6053   : File '...' not found
 *  - TS6231   : Could not resolve project reference
 *  - TS6304   : Composite projects 配置错
 *  - TS18002/18003 : tsconfig 的 files/include 为空 / 无输入
 *  - Cannot find type definition file : @types 配置/安装缺失
 *  - Option '...' cannot/can only ... : 编译器选项约束
 */
const HARD_FAIL =
  /error TS(5\d{3}|6053|6231|6304|18002|18003)\b|Cannot find type definition file|Option '[^']*' (?:cannot|can only)/;

/**
 * condition 节点谓词: oracle 结果 → 分支键 (封闭集, fail-closed)。
 *
 * @param curr 本轮 oracle 结果
 * @param prev 上一轮 (首轮传 null) —— 仅用 digest 判零进展
 * @returns
 *  - `green`     : 显式零错误 → 出闸去 review
 *  - `hard_fail` : 编译器/配置级硬错 → 立即 escalate, 不烧 heal 轮
 *  - `stuck`     : 与上一轮 digest 逐字节相同 (零进展) → 提前止损
 *  - `healable`  : 有错但在变化 (或首轮) → 继续 heal
 */
export function classifyOracle(curr: OracleSnapshot, prev: { digest: string } | null): OracleBranch {
  if (curr.green) return 'green';
  if (curr.tscErrs.some((l) => HARD_FAIL.test(l))) return 'hard_fail';
  if (prev && curr.digest === prev.digest) return 'stuck';
  return 'healable';
}
