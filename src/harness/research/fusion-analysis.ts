/**
 * src/harness/research/fusion-analysis.ts — Fusion 融合分析 schema (judge 结构化产物)。
 *
 * 来源 (2026-06-16 `/last30days` 调研 OpenRouter Fusion, openrouter.ai/blog/announcements/fusion-beats-frontier):
 *   Fusion = panel(模型并发) + judge(裁判) 封装成单次调用。judge 读所有 panel 响应,
 *   产出**结构化分析: consensus / contradictions / partial coverage / unique insights /
 *   blind spots**, calling model 据此 ground 写终稿。实证: 终稿 lift 的 ~3/4 来自 synthesis
 *   质量 (judge 这一步), ~1/4 来自 diversity —— 同模型自融合 (Opus+Opus by Opus) 也涨近 7 分。
 *
 * 我们与 Fusion 的差异 (维一保留, 别拉平):
 *   - Fusion judge = 单 judge。我们上游是 **K-judge 多维 panel** (adversarial, 更对抗)。
 *   - 本 schema 用在 K-panel **之后、graft 之前**: 把散在 K 份 prose critique 里的跨候选信号
 *     收敛成 5 个**显式字段**, 让终审 graft ground 在结构上而非 prose blob 上。
 *   → "把 synthesis 的输入结构化" = 直接抬升 fanout 终稿质量的最高杠杆 (Fusion 实证)。
 *
 * 注: `call` 通道只回文本 (无 responseSchema 强解析), 下游 graft 也是 LLM 读文本 —— 与 Fusion
 *     "judge 文本分析 → calling model grounded 终稿" 同形, 故不强制 JSON parse。schema 在此作
 *     **prompt 单一真理源** (prompt 从字段 + .describe() 派生, 防 prompt↔schema 漂移), 并供
 *     未来遥测/严格校验复用 (`FUSION_ANALYSIS_SCHEMA.parse`)。
 */
import { z } from 'zod';

export const FUSION_ANALYSIS_SCHEMA = z.object({
  consensus: z.array(z.string()).describe('跨候选的共识点: 多数候选都收敛到的结论'),
  contradictions: z.array(z.string()).describe('候选间的直接矛盾: 谁主张 A、谁主张非 A, 标出对立双方'),
  partialCoverage: z.array(z.string()).describe('只被部分候选覆盖、其余漏掉的要点 (覆盖缺口)'),
  uniqueInsights: z.array(z.string()).describe('仅单一候选提出、但有价值、值得嫁接进终稿的洞察'),
  blindSpots: z.array(z.string()).describe('所有候选都没碰、但问题真正需要的盲点'),
});

export type FusionAnalysis = z.infer<typeof FUSION_ANALYSIS_SCHEMA>;

/** schema 字段 → 中文 section 标题, 单一真理源 (prompt 从此 + .describe() 派生)。 */
const SECTION_LABELS: Record<keyof FusionAnalysis, string> = {
  consensus: '共识点 (consensus)',
  contradictions: '矛盾点 (contradictions)',
  partialCoverage: '覆盖缺口 (partial coverage)',
  uniqueInsights: '独特洞察 (unique insights)',
  blindSpots: '盲点 (blind spots)',
};

/**
 * 据 schema 生成融合分析 judge 的指令段: 5 节必出, 与 schema 字段一一对应。
 * prompt 从 schema.shape + .describe() 派生 → 字段增删改时 prompt 自动跟随, 不会漂移。
 */
export function buildFusionAnalysisPrompt(): string {
  const keys = Object.keys(SECTION_LABELS) as (keyof FusionAnalysis)[];
  const sections = keys
    .map((k, i) => `${i + 1}. **${SECTION_LABELS[k]}** — ${FUSION_ANALYSIS_SCHEMA.shape[k].description ?? ''}`)
    .join('\n');
  return [
    '你是融合分析裁判 (不写终稿, 只产出结构化分析)。逐候选交叉对比, 严格按以下 5 节输出',
    '(每节用 markdown 列表; 某节确无内容写"无", 禁编造):',
    sections,
  ].join('\n');
}
