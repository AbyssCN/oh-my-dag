/**
 * src/harness/research/web-fanout —— **原生 web 研究路径**: 检索调研做成一等能力。
 *
 * 管道: retrieveWeb (确定性搜+爬+清洗, 零丢失语料) → 把 .markdown 当 groundTruth 喂 researchFanout
 *       (L lens × V sub-angle → per-lens 判优 → M 综合 → K-judge panel → graft 终稿)。
 *
 * 为什么这样接 (不把 web 工具塞进每个 leaf):
 *   - researchFanout 的 groundTruth 本就是"注入每 leaf 防幻觉"的事实锚 ("必须先实搜喂 groundTruth")。
 *     检索语料天然就是 groundTruth → 一次检索喂全部 leaf, 而非 L×V 次重复抓 (省钱 + 一致)。
 *   - 检索保持确定性零丢失 (语料全文留存), 综合判优是加在上面的 LLM 层 → 两全。
 *   - 模型不知训练截止后的事实 → 默认 grounding 纪律 (stablePrefix) + grounded judge 维度兜底臆造。
 *
 * 默认 lens/framing/judge 面向通用 web 研究; 调用方可整体覆盖 (领域研究传专家 lens)。
 */
import { researchFanout, type ResearchFanoutResult, type ResearchLens } from './fanout';
import { authorFanoutSpec } from './author-spec';
import { retrieveWeb, type RetrieveOpts, type RetrieveResult } from '../web/retrieve';
import type { WebStack } from '../web';

/** 通用 web 研究 lens (证据/批判/实践三视角, 各 3 sub-angle)。领域研究覆盖之。 */
export const DEFAULT_WEB_LENSES: ResearchLens[] = [
  {
    key: 'evidence',
    persona: '你是严谨的事实核查研究员, 只信 groundTruth 语料里有来源支撑的陈述',
    subAngles: [
      '核心事实与关键数字 (每条标来源 URL)',
      '来源可信度: 一手 vs 二手, 官方 vs 转述',
      '语料内部的矛盾、过时信息与不一致',
    ],
  },
  {
    key: 'critical',
    persona: '你是怀疑论批判分析师, 专找反方论据与被忽略的盲区',
    subAngles: ['反方观点与争议焦点', '局限 / 风险 / 适用边界', '语料未覆盖但对结论重要的角度'],
  },
  {
    key: 'practical',
    persona: '你是落地导向的实践者, 把研究转成可执行结论',
    subAngles: ['具体怎么用 (步骤 / 示例)', '权衡取舍与决策建议', '与现状 / 替代方案的对比'],
  },
];

export const DEFAULT_WEB_FRAMINGS = [
  { key: 'brief', framing: '综合成带来源引用的研究简报: 结论先行 → 支撑证据(标 URL) → 不确定性与缺口' },
  { key: 'decision', framing: '综合成面向决策的答案: 推荐 + 理由 + 风险 + 何时不适用' },
];

export const DEFAULT_WEB_JUDGES = [
  { key: 'grounded', criterion: '证据扎实度: 每个关键断言能否在 groundTruth 语料找到来源? 无源/臆造数字判负' },
  { key: 'complete', criterion: '完整度: 是否覆盖问题主要方面, 有无遗漏关键角度' },
  { key: 'actionable', criterion: '可操作性: 结论是否清晰、具体、可执行' },
];

/** 跨轮冻结的研究纪律前缀 (缓存命中 + 防幻觉)。 */
export const DEFAULT_WEB_STABLE_PREFIX =
  '你是一个 web 研究合成系统的一员。硬纪律: ' +
  '(1) 只用下面 groundTruth 语料里的事实推理, 禁用训练记忆补未给出的具体数字/事件/版本/价格; ' +
  '(2) 关键断言后标来源 URL; ' +
  '(3) 语料不足以回答的部分明说"语料未覆盖", 不要编。';

export interface WebFanoutOpts extends RetrieveOpts {
  /** true → conductor (authorFanoutSpec) 按问题+语料自动分解 lens/framing/judge, 替代默认 3 视角。 */
  council?: boolean;
  /** council 分解器模型 (默认 deepseek-v4-pro; 仅 1 次调用, pro 值得)。 */
  conductorModel?: string;
  /** council 建议镜头数 (默认让 conductor 自定)。 */
  lensCount?: number;
  lenses?: ResearchLens[];
  synthesisFramings?: { key: string; framing: string }[];
  judgeCriteria?: { key: string; criterion: string }[];
  stablePrefix?: string;
  lensModel?: string;
  reasonModel?: string;
  reduceModel?: string;
  judgeModel?: string;
  maxFanout?: number;
  onStage?: (stage: string, detail: string) => void;
}

export interface WebFanoutResult {
  question: string;
  /** 检索阶段产物 (含零丢失语料 markdown + needsBrowserHarness)。 */
  retrieval: RetrieveResult;
  /** fanout 综合判优产物 (final / lensChampions / costStats / ...)。 */
  fanout: ResearchFanoutResult;
}

/**
 * web 研究一条龙。检索零结果 → 抛 (无语料无从研究)。
 * 模型默认全 flash (reason 用 pro 慢但推理厚; 覆盖走 opts/env)。
 */
export async function researchWebFanout(
  stack: WebStack,
  question: string,
  opts: WebFanoutOpts = {},
): Promise<WebFanoutResult> {
  opts.onStage?.('retrieve', `检索 "${question}" (mode=${opts.mode ?? 'rotate'})`);
  const retrieval = await retrieveWeb(stack, question, opts);
  if (retrieval.sources.length === 0) throw new Error('researchWebFanout: 检索零结果, 无语料可研究');
  opts.onStage?.('retrieve', `命中 ${retrieval.sources.length} · 抓取 ${retrieval.sources.filter((s) => s.body).length} · 语料 ${retrieval.markdown.length} chars`);

  const lensModel = opts.lensModel ?? process.env.OMD_LENS_MODEL ?? 'deepseek:deepseek-v4-flash';
  // synth/终审默认 ds-pro。reduce/judge 在 fanout 层另有钉死默认, 不受此值牵连。
  const reasonModel = opts.reasonModel ?? process.env.OMD_REASON_MODEL ?? 'deepseek:deepseek-v4-pro';

  // lens/framing/judge: 默认通用 3 视角; --council 让 conductor 按问题+语料自动分解 (显式 lenses 优先于 council)。
  let lenses = opts.lenses ?? DEFAULT_WEB_LENSES;
  let synthesisFramings = opts.synthesisFramings ?? DEFAULT_WEB_FRAMINGS;
  let judgeCriteria = opts.judgeCriteria ?? DEFAULT_WEB_JUDGES;
  if (opts.council && !opts.lenses) {
    opts.onStage?.('council', 'conductor 按语料分解 lens...');
    const authored = await authorFanoutSpec({
      goal: question,
      groundTruth: retrieval.markdown,
      conductorModel: opts.conductorModel,
      lensCount: opts.lensCount,
      lensModel,
      reasonModel,
    });
    lenses = authored.lenses;
    synthesisFramings = authored.synthesisFramings;
    judgeCriteria = authored.judgeCriteria;
    opts.onStage?.('council', `authored ${lenses.length} lenses: ${lenses.map((l) => l.key).join(', ')}`);
  }

  const fanout = await researchFanout({
    question,
    stablePrefix: opts.stablePrefix ?? DEFAULT_WEB_STABLE_PREFIX,
    groundTruth: retrieval.markdown, // 检索语料 = 防幻觉事实锚, 注入每 leaf
    lenses,
    synthesisFramings,
    judgeCriteria,
    lensModel,
    reasonModel,
    reduceModel: opts.reduceModel,
    judgeModel: opts.judgeModel,
    maxFanout: opts.maxFanout,
    onStage: opts.onStage,
  });

  return { question, retrieval, fanout };
}
