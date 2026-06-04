/**
 * plan/distill —— 摄取的参考资料**多 lens 并发蒸馏** (the owner: 先分析后截取 + 激发专家分布, 抗中庸)。
 *
 * 抓到的 ref 原文不直接灌 context。经 **N 个并发 lens** (best-of-N 式) 各以不同 **persona + 采样参数**
 * 读原文 → 抽取, 再合并:
 *   - **expert lens** (低 temp/topP): 代入该领域**顶尖专家** (物理→物理学家 / 系统→架构师 …) 忠实抽机制/取舍。
 *   - **challenger lens** (高 temp/topP): 代入对抗式审稿+跨域战略思考, 挖**非显然洞察** (探索专家分布的长尾)。
 *
 * 机制澄清 (Valar): 真正激活专家知识区的是 **persona conditioning** (把概率质量搬向专家 token);
 * temperature/topP 是**调制器** —— 低=取最自信(忠实), 高=探长尾(创造)。二者配合逃离"平庸 token 区"。
 * 这套 persona+采样 steering 是**跨切面模式** (conductor 规划 / executor leaf / grill 同样可用, 见 _NEXT)。
 */
import { z } from 'zod';
import { callModel } from '../../model';

/** 蒸馏默认模型 (cheap + 可靠)。 */
export const DISTILL_DEFAULT_MODEL = 'deepseek:deepseek-v4-flash';

/** 一个蒸馏视角: persona 激活分布, 采样参数调制忠实/探索。 */
export interface DistillLens {
  id: string;
  /** 角色框定 (激活专家/挑战者分布)。 */
  persona: string;
  /** 抽取指令 (忠实提取 vs 挑战拓展)。 */
  instruction: string;
  temperature: number;
  topP?: number;
}

/** 默认两 lens (忠实专家 + 挑战拓展)。可经 opts.lenses 覆盖 (调领域/采样)。 */
export const DEFAULT_LENSES: readonly DistillLens[] = [
  {
    id: 'expert',
    persona:
      '代入这篇资料所属领域的**顶尖专家** (按内容判定领域: 物理→物理学家 / 分布式系统→系统架构师 / ' +
      '数学→数学家 / 商业策略→战略思考者; 是该领域博士/权威级的判断力, 不是泛泛科普者)',
    instruction:
      '忠实抽取与当前规划方向**直接相关**的机制/架构/取舍级关键点 + 可引用的具体原文片段。精确, 不夸张, 不脑补。',
    temperature: 0.25,
    topP: 0.85,
  },
  {
    id: 'challenger',
    persona:
      '代入一个**对抗式审稿人 + 跨域战略思考者** (能看到平均读者看不到的非显然洞察、矛盾、二阶后果)',
    instruction:
      '别复述。挖**非显然洞察**: 这篇挑战了什么常规做法? 隐含的取舍/前提? 对当前方案的二阶影响? ' +
      '有什么"看不见的接缝"? 拉到第一性原理层 —— 但仍须扎根原文, 不空想。',
    temperature: 0.75,
    topP: 0.95,
  },
];

// coerce: 弱模型常把 relevance 当判断返 boolean/number → 强转字符串兜底 (prompt 也明确要句子)。
const LENS_SCHEMA = z.object({
  /** 一句话 (字符串): 这篇 (经此 lens) 为何与当前规划相关。 */
  relevance: z.coerce.string(),
  /** 该 lens 抽出的内容。 */
  extract: z.coerce.string(),
});

export type DistillResult = { relevance: string; extract: string };

/** 蒸馏函数: (原文, 关注点, 来源?) → 合并后的 {relevance, extract}。 */
export type DistillFn = (raw: string, focus: string, source?: string) => Promise<DistillResult>;

export interface DistillerOpts {
  /** 蒸馏模型 'provider:modelId'。默认 deepseek-v4-flash。 */
  model?: string;
  /** 视角集 (best-of-N)。默认 DEFAULT_LENSES (expert+challenger)。给 1 个 = 单发。 */
  lenses?: readonly DistillLens[];
  /** 每 lens extract 字数上限。默认 1000 (合并后 ≈ N×1000, 控注入体量)。 */
  perLensMaxChars?: number;
}

function buildPrompt(lens: DistillLens, raw: string, focus: string, maxChars: number, source?: string): string {
  return `${lens.persona}。
下面是用户**筛选后粘贴**的一篇参考资料原文${source ? ` (来自 ${source})` : ''}。
当前规划方向 / 关注点: ${focus || '(未明确 — 抽取最具架构/机制价值的部分)'}

任务: ${lens.instruction}
≤${maxChars} 字。丢背景/无关/营销/SEO。

用 JSON 输出两个**字符串**字段:
- "relevance": 一句话中文, 说明这篇为何与当前规划相关 (是说明句, **不是** true/false/分数)。
- "extract": 抽取的内容 (字符串)。

原文:
---
${raw}
---`;
}

/**
 * 造多 lens 蒸馏器。lens 并发跑 (best-of-N), 合并各视角。callModelFn 默认真 callModel; 测试注入桩免网络。
 * 全 lens 失败 → 退化截断原文 (honest degradation, 不静默丢)。
 */
export function createDistiller(
  opts: DistillerOpts = {},
  callModelFn: typeof callModel = callModel,
): DistillFn {
  const model = opts.model ?? DISTILL_DEFAULT_MODEL;
  const lenses = opts.lenses ?? DEFAULT_LENSES;
  const perLensMax = opts.perLensMaxChars ?? 1000;

  return async (raw: string, focus: string, source?: string): Promise<DistillResult> => {
    const runLens = async (lens: DistillLens): Promise<{ lens: DistillLens; relevance: string; extract: string } | null> => {
      try {
        const r = await callModelFn({
          messages: [{ role: 'user', content: buildPrompt(lens, raw, focus, perLensMax, source) }],
          model,
          temperature: lens.temperature,
          topP: lens.topP,
          maxTokens: 1500,
          responseSchema: LENS_SCHEMA,
        });
        const p = r.parsed as DistillResult | undefined;
        const extract = (p?.extract ?? r.text).slice(0, perLensMax);
        if (!extract.trim()) return null;
        return { lens, relevance: p?.relevance ?? '(未结构化)', extract };
      } catch {
        return null; // 单 lens 失败不拖垮其它 (best-of-N 容错)
      }
    };

    const results = (await Promise.all(lenses.map(runLens))).filter(
      (x): x is { lens: DistillLens; relevance: string; extract: string } => x !== null,
    );

    // 全失败 → 退化截断原文。
    if (results.length === 0) {
      return { relevance: '(蒸馏失败, 退化为截断原文)', extract: raw.slice(0, perLensMax) };
    }

    // relevance = 首个成功 lens (通常 expert, 最扎实); extract = 各 lens 标签化合并。
    const relevance = results[0]!.relevance;
    const merged =
      results.length === 1
        ? results[0]!.extract
        : results.map((r) => `【${r.lens.id}】\n${r.extract}`).join('\n\n');
    return { relevance, extract: merged };
  };
}
