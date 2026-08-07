/**
 * review/criteria —— 跨模型对抗审查的 anti-slop 准则 (SDD §11 Codex-in-the-loop)。
 *
 * 哲学 (CLAUDE.md Codex 节, 锁进 omd): 审查模型 (Codex/GLM/任一 cross-lens) 的
 * finding **≠ ground truth**。它是 cross-model 视角工具, 不是 verify 工具。omd 用
 * judgment override finding 不是越权而是 taste。这套准则的作用 = ① 喂进审查 prompt 告诉
 * 审查者"只报什么、绝不报什么"(收窄输出, GP-5) ② 事后 screenFinding 软筛疑似 slop。
 *
 * 真分类靠审查者 + omd judgment, 不靠正则。screenFinding 只是 advisory 软信号。
 */

/** 必拒的 finding 类型 (anti-slop 防 AI slop drift)。喂进 prompt 的"不要报"清单。 */
export const REJECT_CRITERIA: readonly string[] = [
  'niche / 理论 / "could be useful at scale" 的优化',
  'telemetry / cohort analytics / cross-engine attribution (我们 <20 finding/年)',
  'tests for tests / evidence-of-evidence / coverage-of-coverage',
  '"add monitoring/dashboard for X" 类提案',
  'style / 个人偏好 (无客观正误)',
  '无 reproducer 的假设性 race',
  '文档完整性 / 文档建议凑数',
  '"先跑起来再说"的妥协建议',
];

/** 必接的 finding 类型。喂进 prompt 的"只报这些"清单。 */
export const ACCEPT_CRITERIA: readonly string[] = [
  'P0/P1 可复现 bug (file:line + 复现步骤 + 预期 vs 实际)',
  'Contract 违反的具体证据',
  '真 ship-blocker',
  'mechanism-level 边界失败 (e.g. transport↔mode binding 静默丢)',
];

/**
 * G 闸轮数硬上限 (防"verify 一下没坏处"的 slop 心态; 第 2 轮起 ROI ↘↘)。
 *
 * ⚠ 分档轴 = **blast radius**, 不是行数、不是成本档、不是生命周期阶段 (真源
 * `harness/docs/GATES.md`; 运行时同一套在 harness-prompts.ts CONDUCTOR_HARNESS_CORE
 * <gates> 与 scripts/dag-review.ts)。此前本注释按 Plan/Phase/Release 命名 = 第三套轴,
 * 已消歧 —— 三处说 G2 必须指同一件事, 否则 conductor 同时吃到两套会精分。
 *   G1 骨架 (新模块脚手架/签名/接线)            — 1 轮固定
 *   G2 常规逻辑 (普通业务码/带行为测试的重构)   — 1 轮固定
 *   G3 敏感: schema · 认证 · 安全边界 · 不可逆  — 1 轮 + max 1 修复 cycle = 2 轮上限
 * G0 (文档/机械) 不在此表: 它是**免审短路**, 不发模型 —— 见 scripts/dag-review.ts 的 G0 分支。
 */
export const ROUND_CAPS = { G1: 1, G2: 1, G3: 2 } as const;
export type ReviewGate = keyof typeof ROUND_CAPS;

/** screenFinding 的软 slop 关键词 (advisory, 非裁决)。 */
const SLOP_SIGNALS: readonly RegExp[] = [
  /\b(at scale|in the future|could be useful|nice to have)\b/i,
  /\b(monitoring|dashboard|telemetry|observability)\b/i,
  /\b(consider adding|might want to|it would be (nice|good))\b/i,
  /(coverage of coverage|test.{0,12}test|evidence of evidence)/i,
];

/** P0/P1 真 finding 的硬信号 (有 file:line + 复现)。 */
const REAL_SIGNALS: readonly RegExp[] = [
  /[\w./-]+\.\w+:\d+/, // file.ext:line
  /\b(repro|复现|reproduc)/i,
  /\b(P0|P1)\b/,
];

export interface ScreenResult {
  /** 疑似 slop (软信号命中且无真信号) — advisory, omd 仍可保留。 */
  likelySlop: boolean;
  /** 命中的 slop 信号片段。 */
  slopMatches: string[];
  /** 是否带 file:line / repro / P0|P1 硬信号。 */
  hasRealSignal: boolean;
}

/**
 * 软筛一条 finding 文本: 命中 slop 信号且无 file:line/repro/P-level → likelySlop。
 * 这只是 advisory —— 最终 accept/reject 是 omd judgment (finding ≠ ground truth)。
 */
export function screenFinding(text: string): ScreenResult {
  const slopMatches: string[] = [];
  for (const re of SLOP_SIGNALS) {
    const m = text.match(re);
    if (m) slopMatches.push(m[0]);
  }
  const hasRealSignal = REAL_SIGNALS.some((re) => re.test(text));
  return {
    likelySlop: slopMatches.length > 0 && !hasRealSignal,
    slopMatches,
    hasRealSignal,
  };
}
