/**
 * plan/context-monitor —— context 阶段管理 (F 子系统, 代码驱动非模型自觉)。
 *
 * the owner: context 达阶段主动提议落文档; 但**只要 <70% 就推荐继续保留 context** (别过早 compact 丢上下文),
 * 近/超 70% 才推 crystallize 落 docs/plan/ + compact。pi getContextUsage().percent 是判据 (代码读, 不靠模型估)。
 */

/** crystallize 阈值 (%): 低于 = 保 context 继续; ≥ = 建议落文档 + compact。 */
export const CRYSTALLIZE_THRESHOLD = 70;

/**
 * 传给 pi compact 的 customInstructions —— **与 /handoff skill 对齐** (compact = in-session 版 handoff)。
 * pi compact 有损摘要; 此指令偏向保留 handoff 同款结构化态 (决策/Contracts/refs/下一步), 压掉讨论过程。
 * 配 ledger 每轮重注决策 → session 内不丢价值; 配 session-store 收割 → 跨 session 不丢。
 */
export const COMPACT_PRESERVE_INSTRUCTIONS =
  '保留: 已定决策 / Contracts / ADR delta / 摄取的 refs 及其 relevance / 待解问题 / 下一步。' +
  '可压: 讨论过程 / 推导细节 / 已被结论取代的中间态。目标是像 /handoff 一样留住结构化结论, 丢掉冗长过程。';

export type ContextStage = 'healthy' | 'crystallize';

/** percent → 阶段。null (compaction 后等下条 LLM 回应) → healthy (不催)。 */
export function contextStage(percent: number | null, threshold = CRYSTALLIZE_THRESHOLD): ContextStage {
  if (percent === null) return 'healthy';
  return percent >= threshold ? 'crystallize' : 'healthy';
}

/**
 * 注入 overlay 的 context 阶段提示 (每轮)。空串 = 不注 (percent 未知)。
 * <阈值: 明确"别 compact, 保 context 继续"; ≥阈值: "主动提议 crystallize + compact"。
 */
export function contextStageNote(percent: number | null, threshold = CRYSTALLIZE_THRESHOLD): string {
  if (percent === null) return '';
  const pct = Math.round(percent);
  if (pct >= threshold) {
    return (
      `<context-stage pct="${pct}">context 已达 ${pct}% (≥${threshold}%): **主动提议**用户用 \`/crystallize\` ` +
      `把审议态 (台账/Contracts/决策/refs) 收割进 session 结晶库 + 文档, 它会顺带 compact 释放 context ` +
      `(决策经 ledger 重注不丢)。别硬撑到溢出。</context-stage>`
    );
  }
  return (
    `<context-stage pct="${pct}">context ${pct}% (<${threshold}%, 健康): **不要建议 compact** — 保留已积累的丰富 ` +
    `context 继续推进, 它是审议的资产。到阶段性结论可顺带提 \`/crystallize\` 存档, 但 context 仍保留。</context-stage>`
  );
}
