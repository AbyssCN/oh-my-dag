/**
 * plan/complexity —— 复杂度路由的**代码化** (替代 WRIGHT_IDENTITY prose, identity.ts:70-77)。
 *
 * 这是 plan mode "模型外加固"的具体交付: 复杂度分级 + spawn_agent_when 阈值从自然语言文本
 * 抽成确定性函数 (弱模型读 prose 会漂, 代码不漂)。P1 驱动审议深度 + grill offer 阈值 (P2)。
 */

export type ComplexityLevel = 'vibe' | 'lite' | 'full';

/** 分级输入信号 (调用方按任务填; 缺省 = 0/false 保守)。 */
export interface ComplexitySignals {
  /** 涉及文件数。 */
  fileCount?: number;
  /** 跨 2+ 层 (route/service/db 等)。 */
  crossLayer?: boolean;
  /** 新模块。 */
  newModule?: boolean;
  /** 触及安全边界 (auth/闸/密钥/RLS)。 */
  touchesSecurity?: boolean;
  /** 触及 DB schema / 共享表。 */
  touchesDbSchema?: boolean;
  /** 跨独立域数 (scope 互不重叠)。 */
  independentDomains?: number;
  /** 真并行无 handoff 依赖。 */
  trueParallelNoHandoff?: boolean;
  /** 主调度 context 已 >50%。 */
  contextPctOver50?: boolean;
}

/**
 * 复杂度路由 (identity.ts:70-71 code 化):
 *   Full — 跨层 / 新模块 / 安全 / >5 文件 → 走 SDD 全流程
 *   Lite — 2-5 文件 或 DB schema/共享表 → 直写+verify
 *   Vibe — 其余 (单文件/注释/配置) → 直接做+verify
 */
export function classifyTaskComplexity(s: ComplexitySignals): ComplexityLevel {
  const files = s.fileCount ?? 0;
  if (s.crossLayer || s.newModule || s.touchesSecurity || files > 5) return 'full';
  if (files >= 2 || s.touchesDbSchema) return 'lite';
  return 'vibe';
}

/**
 * spawn_agent_when (identity.ts:76-77 code 化): 跨 3+ 独立域 / 真并行无 handoff / context>50%
 * 任一命中 → 派子 agent; 否则 Wright/wright 直做 (默认 Hybrid)。
 */
export function shouldSpawnAgents(s: ComplexitySignals): boolean {
  return (s.independentDomains ?? 0) >= 3 || !!s.trueParallelNoHandoff || !!s.contextPctOver50;
}

/** grill-with-docs (P2) 激活阈值: Full 级才 **offer** (非自动激活)。 */
export function grillOfferThreshold(level: ComplexityLevel): boolean {
  return level === 'full';
}
