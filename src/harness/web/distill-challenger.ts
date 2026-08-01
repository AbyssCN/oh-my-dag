/**
 * src/harness/web/distill-challenger —— 蒸馏的**另一半 lens** (2026-07-26)。
 *
 * 既有的 distill-source 是 **expert 档**: 低 temp (0.25) / topP 0.85, 代入领域顶尖专家,
 * **忠实**抽机制与取舍。它擅长的是"这篇说了什么"。
 *
 * 但忠实抽取抽不出**非显然的东西** —— 低温采样按定义就是往高概率 token 走, 而洞察住在长尾。
 * 所以补一个对偶的 challenger 档: 高 temp, 代入对抗式审稿人 + 跨域战略视角, 专挖
 * 「作者没说但成立的」「与主流叙事冲突的」「换个领域看会怎样」。
 *
 * 纹理承 xihe-distill (fusang/scripts/xihe-distill.ts) 的双 lens 设计 —— 那套在 Aalto 派活里
 * 跑了很久, 温度对偶是它的核心变量, 而 omd 这边一直只有 expert 那一半。
 *
 * 红线与 expert 档一致:
 *   - 蒸馏是**增益不是链路**: 失败照抛, 上层退回全文, 绝不断链也绝不静默丢内容。
 *   - 注入接缝: _callModel 可替身 → 单测永不真调模型。
 *   - **不许脑补事实**: 挖的是原文支持得住的推论, 不是编新的事实 (下面 system 里第一条就是它)。
 */
import { send as defaultCallModel } from '../../model/gateway';
import { resolveSeatModel } from '../../model/role-models';
import { DISTILL_DEFAULT_MAX_CHARS, buildDistillPrompt, type SourceDistillInput, type SourceDistillResult, type SourceDistiller } from './distill-source';
import { z } from 'zod';

/** 与 expert 档同 schema —— 两个 lens 的产物可以直接并排喂给同一个综合层。 */
const CHALLENGER_SCHEMA = z.object({ relevance: z.string(), extract: z.string() });

export const CHALLENGER_SYSTEM = `你是**对抗式审稿人 + 跨域战略分析师**。别人读这篇资料是为了知道它说了什么; 你读它是为了找出**它没说、但成立**的东西。

铁律 (第一条最重: 违反它这份蒸馏就是有害的):
1. **不许脑补事实**。你挖的每一条都必须由原文文字支持得住 —— 推论可以走远, 事实不许新造。拿不准的写"原文未明说, 但 X 暗示 Y"。
2. 专挖这四类, 别写摘要 (摘要有别人做):
   - **未言明的前提**: 作者的结论依赖哪些没写出来的假设? 假设不成立会怎样?
   - **与主流叙事的冲突**: 这篇的哪个说法和领域共识相左? 谁更可能对?
   - **跨域迁移**: 这个机制在另一个领域是什么? 那边踩过的坑这里会不会重演?
   - **二阶效应**: 如果这篇说的成真, 接下来会发生什么是作者没提的?
3. **宁可少而尖, 不要多而平**。三条真洞察胜过十条正确的废话。没挖到就说没挖到。
4. 只输出 JSON 两个字符串字段:
   - "relevance": 一句话说明这篇最值得挑战/延伸的点在哪。
   - "extract": 你的洞察 (每条注明它由原文哪句支持)。`;

/**
 * 造 challenger 蒸馏器。与 expert 档的唯一结构差别是 **system + 采样温度**。
 * @param opts.temperature 默认 0.9 (expert 档是 0.25 —— 这个差就是对偶本身)。
 */
export function createChallengerDistiller(
  opts: { model?: string; maxChars?: number; temperature?: number; _callModel?: typeof defaultCallModel } = {},
): SourceDistiller {
  const call = opts._callModel ?? defaultCallModel;
  const model = resolveSeatModel('distill', { ...(opts.model ? { explicit: opts.model } : {}) }).model;
  const maxChars = opts.maxChars ?? DISTILL_DEFAULT_MAX_CHARS;
  // 高温是这一档的**机制**不是调味: 低温采样按定义往高概率 token 走, 而非显然的东西住在长尾。
  const temperature = opts.temperature ?? 0.9;
  return async (input: SourceDistillInput, signal?: AbortSignal) => {
    const res = await call({
      model,
      messages: [
        { role: 'system', content: CHALLENGER_SYSTEM },
        { role: 'user', content: buildDistillPrompt(input, maxChars) },
      ],
      temperature,
      topP: 0.95,
      maxTokens: 16_384,
      responseSchema: CHALLENGER_SCHEMA,
      ...(signal ? { signal } : {}),
    });
    const p = res.parsed as SourceDistillResult | undefined;
    const extract = (p?.extract ?? res.text).slice(0, maxChars).trim();
    if (!extract) {
      // 与 expert 档同款: 空 extract 视作失败 → 抛, 上层退回全文, 绝不静默丢内容。
      throw new Error('challenger 蒸馏产出空 extract');
    }
    return { relevance: p?.relevance ?? '(未给)', extract };
  };
}
