/**
 * src/harness/web/distill-source —— per-source **expert 蒸馏** (巨源精简视图, 增益非链路)。
 *
 * 动机: 检索命中的单源清洗后正文偶有离群巨页 (68k+), 全量灌进喂 lens 的 groundTruth 语料
 *   既撑爆 context 又淹没信号。加一次 flash 档 expert 蒸馏: 代入该领域**顶尖专家**忠实抽机制/
 *   取舍 + 保留可引用原文片段与 url/引用行 → 精简视图供 lens **优先读**。
 *
 * 红线 (最高):
 *   - 蒸馏是**加一个精简视图, 绝不替代/删除原文**: 原文永远全量留在 --out 语料附录 (retrieve.ts
 *     的 fullCorpus, 零丢失不变量)。此处只产 lens 语料里那份精简 extract。
 *   - 蒸馏是**增益不是链路**: 调用失败 → 照抛, 交上层 (retrieve.ts) warn + 该源退回全文, 不断链。
 *   - 注入接缝: distiller 是纯函数, 测试注入替身 → **永不真调模型** (照 query-expand 纹理)。
 *
 * persona+采样 steering (Aalto): persona conditioning 把概率质量搬向专家 token, 低 temp/topP
 *   取最自信 (忠实抽取, 抗脑补) —— 与 fusang plan/distill 的 expert lens 同参 (0.25/0.85)。
 */
import { z } from 'zod';
import { send as defaultCallModel } from '../../model/gateway';

/** 蒸馏默认模型 (cheap + 可靠, 与 query 扩展同档)。 */
export const DISTILL_DEFAULT_MODEL = 'deepseek:deepseek-v4-flash';
/** 蒸馏 extract 默认字数上限 (远小于 30k 触发阈值, 但够留机制 + 可引用片段)。 */
export const DISTILL_DEFAULT_MAX_CHARS = 2500;

/** 蒸馏一个源的输入 (清洗后正文 + 溯源信息 + 研究问题当关注点)。 */
export interface SourceDistillInput {
  /** 清洗后全文 (蒸馏对象; 原文另有全量留存, 见 retrieve fullCorpus)。 */
  body: string;
  title: string;
  url: string;
  /** 研究问题 = 抽取关注点 (只抽与之相关的机制/取舍)。 */
  question: string;
}

/** 蒸馏产物: 一句相关性说明 + 精简 extract (供 lens 优先读)。 */
export interface SourceDistillResult {
  relevance: string;
  extract: string;
}

/** 蒸馏器: 纯函数接缝, 测试注入替身。失败照抛 (上层退回全文)。 */
export type SourceDistiller = (
  input: SourceDistillInput,
  signal?: AbortSignal,
) => Promise<SourceDistillResult>;

// coerce: 弱模型偶把 relevance 当判断返 boolean/number → 强转字符串兜底 (prompt 也明确要句子)。
const DISTILL_SCHEMA = z.object({
  /** 一句话 (字符串): 这篇为何与研究问题相关。 */
  relevance: z.coerce.string(),
  /** 蒸馏抽出的精简正文。 */
  extract: z.coerce.string(),
});

/** expert 蒸馏 system prompt (全文亦见任务报告)。 */
export const DISTILL_SYSTEM = `你是这篇资料所属领域的**顶尖专家** (按内容判定领域: 物理→物理学家 / 分布式系统→系统架构师 / 数学→数学家 / 商业策略→战略思考者; 是该领域博士/权威级判断力, 不是泛泛科普者)。

给你一篇很长的检索正文, 任务是蒸馏出**供研究综合优先阅读的精简视图** (原文全文另有留存, 你不必复述全文)。

规则:
1. 忠实抽取与研究问题**直接相关**的机制/架构/数据/取舍级关键点。精确, 不夸张, 不脑补, 不加原文没有的结论。
2. **保留可引用的具体原文片段** (关键定义、数字、断言、结论) —— 用引号或引用行原样保留, 供综合层直接引用溯源。
3. 丢背景铺垫 / 无关跑题 / 营销 / SEO / 导航样板。
4. 只输出 JSON 两个**字符串**字段:
   - "relevance": 一句话中文, 说明这篇为何与研究问题相关 (是说明句, **不是** true/false/分数)。
   - "extract": 蒸馏的精简正文 (字符串, 含保留的可引用片段)。`;

/** 拼 user prompt (溯源信息 + 关注点 + 字数上限 + 原文)。 */
export function buildDistillPrompt(input: SourceDistillInput, maxChars: number): string {
  return `研究问题 / 关注点: ${input.question || '(未明确 — 抽取最具机制/数据价值的部分)'}
源标题: ${input.title}
源 URL: ${input.url}

任务: 按 system 规则蒸馏。extract ≤${maxChars} 字。

原文:
---
${input.body}
---`;
}

/**
 * 造 expert 蒸馏器。一次 flash 档模型调用 (低 temp/topP 忠实抽取)。
 * @param opts.model 蒸馏模型 (默认 env OMD_DISTILL_MODEL → deepseek-v4-flash)。
 * @param opts.maxChars extract 字数上限 (默认 2500)。
 * @param opts._callModel 测试注入替身 (省略 = gateway send)。
 * 失败 (调用抛错 / extract 空) → **照抛**, 交上层 retrieve.ts 兜底降级 (warn + 退回全文)。
 */
export function createModelSourceDistiller(
  opts: { model?: string; maxChars?: number; _callModel?: typeof defaultCallModel } = {},
): SourceDistiller {
  const call = opts._callModel ?? defaultCallModel;
  const model = opts.model ?? process.env.OMD_DISTILL_MODEL ?? DISTILL_DEFAULT_MODEL;
  const maxChars = opts.maxChars ?? DISTILL_DEFAULT_MAX_CHARS;
  return async (input, signal) => {
    const res = await call({
      model,
      messages: [
        { role: 'system', content: DISTILL_SYSTEM },
        { role: 'user', content: buildDistillPrompt(input, maxChars) },
      ],
      temperature: 0.25,
      topP: 0.85,
      maxTokens: 4096,
      responseSchema: DISTILL_SCHEMA,
      signal,
    });
    const p = res.parsed as SourceDistillResult | undefined;
    const extract = (p?.extract ?? res.text).slice(0, maxChars).trim();
    // 空 extract 视作蒸馏失败 → 抛 (上层退回全文, 绝不静默丢内容)。
    if (!extract) throw new Error('蒸馏 extract 为空');
    const relevance = (p?.relevance ?? '').trim() || '(未结构化)';
    return { relevance, extract };
  };
}
