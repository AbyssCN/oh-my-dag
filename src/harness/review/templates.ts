/**
 * review/templates —— 跨模型对抗审查的 prompt 模版 (SDD §11)。
 *
 * 把"手写一次性审查 prompt"系统化成可复用 builder: 同一套 anti-slop 准则 (criteria.ts)
 * + 维度聚焦 + G 闸框架, 产出结构化对抗审查 prompt。设计要点 (实战校准, 见 V2-MEM/WEAK
 * 那两次 review):
 *   - 对抗框架: 审查者被要求**证伪**, 不是"看一遍". 默认怀疑, 找 confirmed P0/P1。
 *   - 硬证据契约: 每条必带 file:line + 复现输入 + 预期 vs 实际 + 为何是真问题。
 *   - anti-slop 内嵌: REJECT_CRITERIA 直接列进 prompt ("这些一律不报")。
 *   - finding ≠ ground truth: prompt 末尾声明, 收 caller 的判断权。
 */
import { ACCEPT_CRITERIA, REJECT_CRITERIA, ROUND_CAPS, type ReviewGate } from './criteria';

/** 审查维度 —— 每个给审查者一个不同的"证伪镜头"(perspective-diverse 比冗余强)。 */
export type ReviewDimension =
  | 'correctness' // 逻辑 / 边界 / off-by-one / 状态机
  | 'security' // fail-closed / 注入 / 权限 / 不可逆破坏
  | 'boundary' // 接缝 / transport↔mode / 跨层契约静默丢
  | 'coverage' // 测试是否真覆盖高风险接缝 (非覆盖率数字)
  | 'perf' // 真实热路径 / N+1 / 大 O (有度量才报)
  | 'contract' // 实现 vs Contract 不变量是否一致
  | 'spec'; // Spec 轴: diff vs 当前 SDD 契约/验收条款 (Matt Pocock 双轴之"是否做了该做的事")

const DIMENSION_FOCUS: Record<ReviewDimension, string> = {
  correctness: '逻辑正确性: 边界条件 / off-by-one / null 处理 / 状态机非法转移 / 并发 TOCTOU (单写者下不可达的不报)',
  security: 'fail-closed 契约: 有无路径在该拒时放行 (fail-open) / 注入逃逸 / 权限越界 / 不可逆破坏未拦',
  boundary: '接缝完整性: transport↔mode binding 静默丢 / 跨层契约不一致 / seam 两实现行为分叉 / 错误吞掉',
  coverage: '测试是否真触达高风险接缝 (不是覆盖率数字): 哪条 essential 路径无红测 / 哪个边界没反例',
  perf: '真实热路径的 N+1 / 大 O 退化 / 不必要全表扫 —— 必须有度量或明确热点, 无据不报',
  contract: '实现 vs Contract 不变量: 命名的不变量有没有被 impl 违反, 给具体 file:line + 反例',
  spec: 'Spec 对照: diff vs 当前 SDD 契约/验收条款 — 未兑现的承诺 / 超范围改动 / 与决策记录冲突 (用 buildSpecReviewPrompt 注入 SDD 原文)',
};

export interface ReviewPromptOpts {
  /** 证伪镜头。 */
  dimension: ReviewDimension;
  /** 审查范围 (文件路径列表 / commit hash / 模块描述)。 */
  scope: string;
  /** 可选 G 闸 (附轮数上限 framing)。 */
  gate?: ReviewGate;
  /** 额外聚焦点 (本次特别要对抗的接缝, 逐条列)。 */
  extraFocus?: readonly string[];
}

/** 造一条对抗审查 prompt (喂 Codex/任一 cross-lens 模型, 或 review subagent)。 */
export function buildReviewPrompt(opts: ReviewPromptOpts): string {
  const { dimension, scope, gate, extraFocus } = opts;
  const gateLine = gate
    ? `\n[G 闸] ${gate} — 轮数硬上限 ${ROUND_CAPS[gate]} (不复审刷轮, 第 2 轮起 ROI ↘↘)。`
    : '';
  const focusBlock = extraFocus?.length
    ? `\n重点对抗这些接缝:\n${extraFocus.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : '';
  return `对抗式审查 [${dimension}] —— 只读, 不改文件。${gateLine}
范围: ${scope}

镜头: ${DIMENSION_FOCUS[dimension]}

目标: 找 **confirmed P0/P1 真 bug**。默认怀疑 / 证伪导向, 不是"看一遍说没问题"。
每条必带: file:line + 具体复现输入 + 预期 vs 实际 + 为何是真问题。
${focusBlock}

只报 (ACCEPT):
${ACCEPT_CRITERIA.map((c) => `  - ${c}`).join('\n')}

一律不报 (REJECT, anti-slop):
${REJECT_CRITERIA.map((c) => `  - ${c}`).join('\n')}

输出: P0/P1 清单 (每条 文件:行 + 反例 + 修复方向)。实测排除的怀疑点也列 (避免重复挖)。
没有真 bug 就明说没有 —— 不硬凑 finding。
注: 你的 finding ≠ ground truth, 是 cross-lens 视角; 最终 accept/reject 由 omd judgment 定。`;
}

/**
 * G 闸场景便捷构造: 按 gate 选默认维度组 (release 全维度, phase 聚焦改动面)。
 * 返回多条 prompt (每维度一条), caller 同消息并行发 (Strict mode 不串行)。
 */
export function buildGateReview(
  gate: ReviewGate,
  scope: string,
  extraFocus?: readonly string[],
): string[] {
  const dims: ReviewDimension[] =
    gate === 'G3'
      ? ['correctness', 'security', 'boundary', 'contract']
      : gate === 'G2'
        ? ['correctness', 'security', 'boundary']
        : ['contract', 'boundary']; // G1 plan: 契约 + 接缝设计
  return dims.map((dimension) => buildReviewPrompt({ dimension, scope, gate, extraFocus }));
}

export interface SpecReviewPromptOpts {
  /** 审查范围 (文件路径列表 / commit hash / 模块描述)。 */
  scope: string;
  /** 可选 G 闸 (附轮数上限 framing)。 */
  gate?: ReviewGate;
  /** 本次对照的 SDD 文件路径 (报告溯源用)。 */
  sddPath: string;
  /** SDD 原文 (全文注入, 逐条对照的依据)。 */
  sddText: string;
  /** 额外聚焦点。 */
  extraFocus?: readonly string[];
}

/**
 * Spec 轴 prompt (Matt Pocock 双轴的第二轴): Standards 轴问"代码写得对不对",
 * Spec 轴问"做的是不是该做的事" —— diff 逐条对照当前 SDD 的契约/验收条款。
 * 与 buildReviewPrompt 分开: 需要注入 SDD 原文, 且偏离类型 (承诺/范围/决策) 与 P0/P1 bug 不同类。
 */
export function buildSpecReviewPrompt(opts: SpecReviewPromptOpts): string {
  const { scope, gate, sddPath, sddText, extraFocus } = opts;
  const gateLine = gate
    ? `\n[G 闸] ${gate} — 轮数硬上限 ${ROUND_CAPS[gate]} (不复审刷轮, 第 2 轮起 ROI ↘↘)。`
    : '';
  const focusBlock = extraFocus?.length
    ? `\n重点对照这些接缝:\n${extraFocus.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : '';
  return `对抗式审查 [spec] —— 只读, 不改文件。${gateLine}
范围: ${scope}

镜头: diff 逐条对照下方 SDD 的**契约与验收条款** (含 Oracle-cmd / Allowed-Forbidden files /
接缝 / D-number 决策记录, 若存在), 找 diff 与 spec 的偏离。三类偏离逐类扫:
  1. **未兑现的承诺**: SDD 承诺/验收条款在 diff 里没做或只做了半截 (逐条打钩, 缺的列出);
  2. **超范围改动**: diff 碰了 SDD Forbidden files / 明确圈定范围之外的文件 (违约逐个点名);
  3. **与决策记录冲突**: diff 的做法与 SDD 的 D-number / 决策记录相悖 (引 D 号 + 冲突点)。
${focusBlock}
每条必带: SDD 条款原文引用 (或 D 号) + diff 侧 file:line/hunk + 偏离类型 + 为何是真偏离。
SDD 里没写的东西不算偏离 (spec 轴只审"对照", 代码质量归 Standards 轴, 不重复报)。
逐条核过且无偏离 → 明说"逐条对照无偏离", 不硬凑 finding。

一律不报 (REJECT, anti-slop):
${REJECT_CRITERIA.map((c) => `  - ${c}`).join('\n')}

===== SDD (${sddPath}) =====
${sddText}
===== SDD 结束 =====

输出: 偏离清单 (每条 SDD 条款引用 + diff file:line + 偏离类型 + 修复方向)。
注: 你的 finding ≠ ground truth, 是 cross-lens 视角; 最终 accept/reject 由 omd judgment 定。`;
}
