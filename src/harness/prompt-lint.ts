/**
 * src/harness/prompt-lint —— conductor 组合判定教化段的**编译期闸** (INV-8 / D8)
 *
 * 起因 (S1 契约 §C-2 D8, 2026-08-24): conductor 在无预设组合方案的任务里, ①不主动 fanout+judge,
 * ②幻觉工具路径, ③skill 散文禁令不内化 —— 三者同根是「没有可查询的世界 + 没有结构化判定位」。
 * 治法 = 把"组合判定四分支"逐字写进 conductor 提示词的 L2 教化段, 给上限 (≤350 Unicode 字符) 强制
 * 函数: 防纪律回流散文的**编译期闸**, 不是省 token。
 *
 * **不变量 (INV-8 / D8)**:
 * - 教化段 Unicode 字符数 (Array.from(text).length) ≤ LINT_MAX_DECISION_EDUCATION_CHARS
 * - 超限 = **编译期拒** (模块顶层 throw, 任何 import 触发), **永不运行期截断**
 * - lint 函数只覆盖**教化段**: PLAN-1 冻结提示 (TRUST_FENCE_RULE 等) 与 inventory 渲染段**不受**
 *   此限 (调用方决定哪段送进来; 测试在 prompt-lint.test.ts 与 conductor-prompt-snapshot.test.ts
 *   双重锁死)
 *
 * owner 可调: LINT_MAX_DECISION_EDUCATION_CHARS (本文件顶层常量, 改值 = 闸放宽/收紧)。
 */

/** owner 可调配置常量 (D8: 数值入 owner 可调配置; 默认 350 = S1 契约钉死)。 */
export const LINT_MAX_DECISION_EDUCATION_CHARS = 350;

/**
 * L2 组合判定教化段 canonical 文本 (S1 契约 §C-2 / D8 钉死, 逐字 —— 见
 * docs/plan/2026-08-24-conductor-s1-五闸与清单-执行契约.md:104-110)。任何修改必须保持
 * "≤350 Unicode 字符", 否则 import 期 throw。
 *
 * 当前 290 字符 (留 60 headroom 供后续微调)。
 */
export const DECISION_EDUCATION_CANONICAL = `你产 DAG。能力 = 引擎原语(常驻) + ext/skill(用 ToolSearch 发现)。
组合判定四分支——廉价 oracle 过滤 / 视觉产出接 render / 宽解空间 persona fanout+judge /
缺工具则 bootstrap 自建或声明缺口——请在 ConductorPlan 字段里显式表达:
oracleKind、whyNoFanout、toolRefs、budgetBasis。
plan-critic 在编译期做 schema 校验,缺字段直接打回,不接受自然语言申辩。
不要臆造工具路径:ToolSearch 未命中即视为不存在。`;

/** canonical 文本的 Unicode 字符数 (固定导出, 测试用, 也是 compile-time 闸的事实值)。 */
export const DECISION_EDUCATION_CANONICAL_CHARS = Array.from(DECISION_EDUCATION_CANONICAL).length;

// ── compile-time 闸 (D8): 模块顶层 throw = 任何 import 触发 ──
//
// **永不运行期截断**: 这里 throw 不是 catch 得住的"运行时校验", 是模块加载期 fail-fast。
// 任何让 canonical 文本膨胀的改动 = import 触发 throw = 编译红线, 改回才能进。比"运行期再 lint"
// 安全: 运行期出错还有 fallback (被静默吞), 加载期出错连 fallback 都没有 —— conductor-plan.ts
// 只是该 canonical 的搬运工, 一旦膨胀就装不进 prompt, 装配直接挂。
const _codes = Array.from(DECISION_EDUCATION_CANONICAL).length;
if (_codes > LINT_MAX_DECISION_EDUCATION_CHARS) {
  throw new Error(
    `[prompt-lint] DECISION_EDUCATION_CANONICAL is ${_codes} Unicode chars, ` +
      `exceeds LINT_MAX_DECISION_EDUCATION_CHARS=${LINT_MAX_DECISION_EDUCATION_CHARS} ` +
      `(INV-8/D8 fail-fast — never runtime truncate)`,
  );
}

/**
 * 检查一段文本是否符合"组合判定教化段"的字符上限 (INV-8/D8)。
 *
 * **作用域**: 只管教化段 —— 函数本身不分类别 (它拿到啥就量啥), 分类由**调用方**负责:
 * - conductor-plan.ts 的 conductorSystemPrompt 只把 DECISION_EDUCATION_CANONICAL 这一段喂进来
 * - PLAN-1 冻结提示 / inventory 渲染段 / shapes 段 走各自链路, 不被本函数门检
 * - 测试在 prompt-lint.test.ts 用「full conductor prompt 远超 350 + bare 也 >350」反向证明
 *
 * **永不运行期截断**: 超限返回 `{ok:false, reason}`, 调用方必须**拒** (不截断)。返回值里
 * `length` = 原文字符数 (原文未动), `reason` 含可读诊断 (含上限值, 不含 "truncated" 字眼)。
 *
 * 字数用 `Array.from(text).length` (Unicode 代码点, 不是 UTF-16 单位, 也不是字节) —— 与 SDD D8
 * "≤350 Unicode 字符" 一致。
 */
export function lintDecisionEducation(
  text: string,
): { ok: true } | { ok: false; reason: string; length: number; limit: number } {
  const len = Array.from(text).length;
  if (len > LINT_MAX_DECISION_EDUCATION_CHARS) {
    return {
      ok: false,
      reason: `decision education segment is ${len} Unicode chars; limit is ${LINT_MAX_DECISION_EDUCATION_CHARS} (INV-8/D8 — never runtime truncate)`,
      length: len,
      limit: LINT_MAX_DECISION_EDUCATION_CHARS,
    };
  }
  return { ok: true };
}