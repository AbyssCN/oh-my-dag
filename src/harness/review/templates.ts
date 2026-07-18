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
  | 'contract'; // 实现 vs Contract 不变量是否一致

const DIMENSION_FOCUS: Record<ReviewDimension, string> = {
  correctness: '逻辑正确性: 边界条件 / off-by-one / null 处理 / 状态机非法转移 / 并发 TOCTOU (单写者下不可达的不报)',
  security: 'fail-closed 契约: 有无路径在该拒时放行 (fail-open) / 注入逃逸 / 权限越界 / 不可逆破坏未拦',
  boundary: '接缝完整性: transport↔mode binding 静默丢 / 跨层契约不一致 / seam 两实现行为分叉 / 错误吞掉',
  coverage: '测试是否真触达高风险接缝 (不是覆盖率数字): 哪条 essential 路径无红测 / 哪个边界没反例',
  perf: '真实热路径的 N+1 / 大 O 退化 / 不必要全表扫 —— 必须有度量或明确热点, 无据不报',
  contract: '实现 vs Contract 不变量: 命名的不变量有没有被 impl 违反, 给具体 file:line + 反例',
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
