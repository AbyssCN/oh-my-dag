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
import { z } from 'zod';
import { researchFanout, type ProbeYield, type ResearchFanoutConfig, type ResearchFanoutResult, type ResearchLens } from './fanout';
import { send } from '../../model/gateway';
import { resolveRoleModelConfigured } from '../../model/role-models';
import { authorFanoutSpec } from './author-spec';
import { retrieveWeb, type RetrieveOpts, type RetrieveResult } from '../web/retrieve';
import { CleaningFetchProvider } from '../web/clean';
import { fetchRacing } from '../web/fetch-racing';
import { repoProbe, renderRepoHits } from './repo-probe';
import { normalizeUrl } from '../web/types';
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

/**
 * 跨家族发散池 (owner 2026-07-27): lens gen + synth framing 逐单元轮不同模型族 (「同族 N 单元共享盲点」)。
 *
 * ⚠ **2026-08-05 撤掉 `xiaomi-token-plan-ams:mimo-v2.5-pro`**(原占 50% 权重)。两条理由:
 *   ① 该座实测 `429 quota exhausted`,留着就是让整轮 fanout 有一半概率挂;
 *   ② 路由口径:**mimo 只走 opencode-go,且只用于多模态** —— 这里是纯文本活。
 * 撤掉之后权重表空了 (它当初就只为 mimo 那一条存在),三个 Go 家族均分。
 * 发散本身不是质量瓶颈:2026-07-28 跨家族发散 eval 的结论是「无互补盲点,只有能力排序」
 * (79% vs 81% 在噪声内),所以少一个家族不值得再买一份订阅。
 */
export const LENS_DIVERGENCE_POOL = [
  'opencode-go:qwen3.7-plus',
  'opencode-go:minimax-m3',
  'opencode-go:deepseek-v4-pro',
];
export const LENS_DIVERGENCE_WEIGHTS: Record<string, number> = {};
/** judge panel 跨族池: K 维度逐个轮不同族, 降单模型系统偏见。
 * 2026-07-28: GPT(openai-codex/Codex) 在 research 大输入聚合上反复 "An error occurred processing your
 * request"/context 溢出 → 移出研究判优池 (1M 上下文打头 + glm/kimi 保跨族)。GPT 仍是 dag_run 的 conductor/review。
 *
 * ⚠ 2026-08-05: 打头那位从 `xiaomi-token-plan-ams:mimo-v2.5-pro` 换成 `opencode-go:minimax-m3`
 * (理由同上池)。**换的时候盯的是"1M 上下文"这条约束不是模型名** —— minimax-m3 同为 1M 上下文
 * (`model-caps.ts`),而那正是 mimo 当初被选中打头的原因(大输入聚合会撑爆小窗口)。 */
export const JUDGE_PANEL_POOL = ['opencode-go:minimax-m3', 'opencode-go:glm-5.2', 'kimi-coding:k3'];

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
  /**
   * 附加到**每个综合 framing** 末尾的指令 (默认与 council-authored 都生效)。
   * 用途: pathfinder --children 让终稿按共享契约附 `## children` 段 (opt-in, 不污染通用研究输出)。
   */
  finalExtraInstruction?: string;
  stablePrefix?: string;
  lensModel?: string;
  reasonModel?: string;
  reduceModel?: string;
  judgeModel?: string;
  /** 跨家族发散池覆盖 (省略 → LENS_DIVERGENCE_POOL; 传 [] 或单坐标数组 = 关发散, mono baseline)。 */
  divergePool?: string[];
  divergeWeights?: Record<string, number>;
  /** judge panel 跨族池覆盖 (省略 → JUDGE_PANEL_POOL)。 */
  judgePool?: string[];
  /** fusion 融合分析模型 (省略 → judgeModel = 强)。收敛单发。 */
  fusionModel?: string;
  /** graft 终笔模型 (省略 → judge 座 = 强连贯; 原为 reasonModel=k3)。eval 用它测 v2.5-pro vs sol。 */
  graftModel?: string;
  maxFanout?: number;
  /**
   * research-second-pass 轮数上限 (默认 1 = 单轮)。>1 时自动挂确定性 probe:
   * (冠军引用集 ∪ 缺口点名集) − 已抓集 的缺料补抓, 抓回语料 append 进下一轮。
   */
  rounds?: number;
  /** probe 每轮补抓 URL 上限 (默认 5 —— 轮间抓取成本天花板)。 */
  probeCrawl?: number;
  /**
   * 仓内腿的检索根。给则轮间 probe 除了抓 web, 还把 gap.repoQueries 交确定性检索
   * (研究 leaf 是 inproc 看不见仓库 —— 这是"我们仓里怎么实现的"那类缺口唯一的入口)。
   */
  repoCwd?: string;
  /**
   * 额外种子 query (deep-research 档, 吸收自 xihe-deep-research 的多角度 gather):
   * 每个各跑一轮独立检索, 语料带节头并入 groundTruth (蒸馏各自生效, 不跨 query 重建);
   * 单个种子检索失败跳过留痕不断链。probe 的已抓集含全部种子的 URL。
   */
  seedQueries?: string[];
  /**
   * 锚点文本 (已有设计笔记/契约, 吸收自 xihe-deep-research 的 anchors): 原样进 groundTruth
   * 之首 —— 排最前 = 跨轮字节最稳的段, 对 prompt cache 最友好。
   */
  anchors?: { label: string; text: string }[];
  /**
   * deep 档: seedQueries 未显式给时由模型作者化 3-4 个互补种子 query (authorSeedQueries)。
   * xihe-deep-research 的 config.web[] 是人手写的 gather 清单 —— 自动化它, 一条命令才成管线。
   * fail-open: 作者化失败 → 无种子继续 (单检索 + rounds 仍在)。
   */
  authorSeeds?: boolean;
  onStage?: (stage: string, detail: string) => void;
}

export interface WebFanoutResult {
  question: string;
  /** 检索阶段产物 (含零丢失语料 markdown + needsBrowserHarness)。 */
  retrieval: RetrieveResult;
  /** fanout 综合判优产物 (final / lensChampions / costStats / ...)。 */
  fanout: ResearchFanoutResult;
  /** rounds>1 时 probe 补抓的增量语料 (附录落盘用; 巨源带显式截断标记, 全文经源 URL; 单轮/无补抓 = undefined)。 */
  secondPassCorpus?: string;
  /** seedQueries 的各自检索产物 (fullCorpus 附录落盘用; 未用种子 = undefined)。 */
  seedRetrievals?: RetrieveResult[];
}

/** 种子作者化 schema: 互补角度的检索 query 清单。 */
const SEED_SCHEMA = z.object({ queries: z.array(z.string().min(4)) });

/**
 * deep 档种子作者化: 把一个领域问题拆成 3-4 个**互补角度**的检索 query。
 * 与 query-expand 的分工: expand 是同一 query 的检索友好改写 (召回), 这里是**不同侧面的子领域**
 * (覆盖)。fail-open: 调用/解析失败 → [] (deep 退化为单检索, 不断链)。
 */
export async function authorSeedQueries(
  question: string,
  opts: { model?: string; _call?: typeof send } = {},
): Promise<string[]> {
  const call = opts._call ?? send;
  const model = opts.model ?? resolveRoleModelConfigured('lens').model;
  try {
    const res = await call({
      model,
      messages: [
        {
          role: 'user',
          content:
            `研究问题: ${question}\n\n把它拆成 3-4 个**互补角度**的检索 query —— 不是原题的同义改写, ` +
            `而是覆盖原题不同侧面的子领域 (机制/实践/反面与风险/生态与替代等), 语言按检索效果选。` +
            `只输出 JSON: {"queries":["..."]}`,
        },
      ],
      responseSchema: SEED_SCHEMA,
      maxTokens: 4096, // 种子 query 虽短, 推理族仍需 reasoning 余量
      meta: { role: 'seed-author' },
    });
    const parsed = SEED_SCHEMA.safeParse(res.parsed);
    return parsed.success ? parsed.data.queries.slice(0, 4) : [];
  } catch {
    return [];
  }
}

/**
 * groundTruth 组装 (deep-research 档)。序 = 缓存稳定序: 锚点 (跨轮字节最稳) → 主检索 → 种子检索。
 * 导出纯函数: 锚点/种子是否真进语料必须可单测证伪, 不靠付费真跑肉眼看。
 */
export function assembleGroundTruth(
  anchors: { label: string; text: string }[] | undefined,
  main: string,
  seeds: string[],
): string {
  const anchorBlock = anchors?.length ? anchors.map((a) => `# 锚点: ${a.label}\n\n${a.text}`).join('\n\n') + '\n\n' : '';
  return `${anchorBlock}${main}${seeds.map((s) => `\n\n${s}`).join('')}`;
}

/** 从文本抠 http(s) URL (确定性, probe 下限半边的原料)。尾部标点剥离; 括号内 URL 会被截断 (v1 已知边界)。 */
export function extractCitedUrls(text: string): string[] {
  const m = text.match(/https?:\/\/[^\s<>()[\]{}"'`«»「」,;]+/g) ?? [];
  return [...new Set(m.map((u) => u.replace(/[.,;:!?]+$/, '')))];
}

/**
 * research-second-pass 的确定性探测器 (下限半边, 零 LLM):
 * 「被引用却没抓取过的 URL」 = (冠军文本引用集 ∪ 缺口点名集) − 已抓集, 抓回正文 append 进下一轮语料。
 * 每 URL 只花一次机会 (失败不重试, 同轮去重跨轮持久); 全失败 → 空产出, 不断链 (probe 是增益)。
 * 注: shape 里探测器的另一半「没有出处的结论」无纯确定性判据, 归缺口分析的模型半边。
 */
export function buildSecondPassProbe(
  stack: WebStack,
  alreadyFetched: Iterable<string>,
  opts: {
    probeCrawl?: number;
    minChars?: number;
    /** 每源进语料的字符上限 (默认 12k, 超出截断带标记)。实测不截: 一个论坛长帖 +35 万 chars,
     *  后续每个 stage 都拖着它 —— 语料增长必须有成本闸, 与 retrieveWeb 巨源蒸馏同一门纪律。 */
    maxCharsPerSource?: number;
    signal?: AbortSignal;
    /**
     * **仓内腿** (对称 web 腿): 给则 gap.repoQueries 交确定性检索, 命中并进下一轮语料。
     * 省略 = 只有 web 腿 —— "这个在我们仓里怎么实现的"那类缺口就悬着 (原行为)。
     */
    repoCwd?: string;
    onStage?: (s: string, d: string) => void;
  } = {},
): NonNullable<ResearchFanoutConfig['probe']> {
  const fetchedSet = new Set([...alreadyFetched].map(normalizeUrl));
  const cap = opts.probeCrawl ?? 5;
  const maxChars = opts.maxCharsPerSource ?? 12_000;
  return async ({ round, digest, gaps }): Promise<ProbeYield> => {
    // ── 仓内腿: 模型点名要查的字面串/符号 → 确定性检索 (不过 shell, 命中双封顶)。
    let repoSection = '';
    let repoHits: string[] = [];
    const repoQueries = [...new Set(gaps.flatMap((g) => g.repoQueries ?? []))];
    if (opts.repoCwd && repoQueries.length > 0) {
      const res = repoProbe(repoQueries, { cwd: opts.repoCwd });
      // 留痕含两个面: 行级命中的 file:line + 整读文件的路径 (后者标 (全文))。
      repoHits = [...res.hits.map((h) => h.path), ...res.files.map((f) => `${f.path} (全文)`)];
      repoSection = renderRepoHits(res);
      opts.onStage?.(
        'probe',
        `r${round + 1}: 仓内检索 ${repoQueries.length} 条 query → ${res.hits.length} 命中 + ${res.files.length} 个文件整读`,
      );
    }
    const candidates = [...extractCitedUrls(digest), ...gaps.flatMap((g) => g.urls ?? [])];
    const missing: string[] = [];
    for (const u of candidates) {
      if (missing.length >= cap) break;
      const key = normalizeUrl(u);
      if (fetchedSet.has(key)) continue;
      fetchedSet.add(key);
      missing.push(u);
    }
    // web 腿无缺料但仓内腿有货 → 仍是"有新增" (别让一条腿的空手把另一条腿的收获也扔了)。
    if (missing.length === 0) {
      return repoSection ? { newCorpus: repoSection, repoHits } : {};
    }
    const provs = stack.fetchProviders.map((fp) => new CleaningFetchProvider(fp, stack.cleaner));
    const settled = await Promise.allSettled(
      missing.map((u) => fetchRacing(provs, u, { minChars: opts.minChars ?? 200, signal: opts.signal })),
    );
    const sections: string[] = [];
    const fetchedUrls: string[] = [];
    settled.forEach((s, i) => {
      if (s.status !== 'fulfilled') return;
      const body = s.value.result.text.trim();
      if (!body) return;
      fetchedUrls.push(missing[i]!);
      // 截断带显式标记 (不静默丢): 全文要看的话源 URL 就在节头, 消费方自己 Read。
      const clipped =
        body.length > maxChars ? `${body.slice(0, maxChars)}\n…[probe 截断: 原文 ${body.length} chars, 全文见源 URL]` : body;
      sections.push(`## ${missing[i]}\n\n${clipped}`);
    });
    opts.onStage?.('probe', `r${round + 1}: 补抓 ${fetchedUrls.length}/${missing.length} 缺料 URL`);
    if (sections.length === 0 && !repoSection) return {};
    const corpus = [repoSection, ...sections].filter(Boolean).join('\n\n');
    return { newCorpus: corpus, fetchedUrls, ...(repoHits.length ? { repoHits } : {}) };
  };
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

  // deep 档: 种子未显式给 → 模型作者化 (显式给的优先, 作者化不覆盖人)。
  let seedQueries = opts.seedQueries;
  if (!seedQueries?.length && opts.authorSeeds) {
    seedQueries = await authorSeedQueries(question, { model: opts.lensModel });
    opts.onStage?.(
      'seeds',
      seedQueries.length ? `作者化 ${seedQueries.length} 个种子: ${seedQueries.join(' · ')}` : '种子作者化失败 → 单检索继续 (fail-open)',
    );
  }

  // deep-research 档: 种子 query 各自独立检索 (蒸馏各自生效), 失败跳过留痕不断链。
  const seedRetrievals: RetrieveResult[] = [];
  for (const q of seedQueries ?? []) {
    opts.onStage?.('retrieve', `种子 query "${q}"`);
    try {
      const r = await retrieveWeb(stack, q, opts);
      seedRetrievals.push(r);
      opts.onStage?.('retrieve', `种子命中 ${r.sources.length} · 抓取 ${r.sources.filter((s) => s.body).length}`);
    } catch (e) {
      opts.onStage?.('retrieve', `种子 "${q}" 检索失败 (${(e as Error).message}) → 跳过`);
    }
  }

  const groundTruth = assembleGroundTruth(opts.anchors, retrieval.markdown, seedRetrievals.map((r) => r.markdown));

  const lensModel = opts.lensModel ?? resolveRoleModelConfigured('lens').model;
  // synth/终审默认 ds-pro。reduce/judge 在 fanout 层另有钉死默认, 不受此值牵连。
  const reasonModel = opts.reasonModel ?? resolveRoleModelConfigured('reason').model;

  // lens/framing/judge: 默认通用 3 视角; --council 让 conductor 按问题+语料自动分解 (显式 lenses 优先于 council)。
  let lenses = opts.lenses ?? DEFAULT_WEB_LENSES;
  let synthesisFramings = opts.synthesisFramings ?? DEFAULT_WEB_FRAMINGS;
  let judgeCriteria = opts.judgeCriteria ?? DEFAULT_WEB_JUDGES;
  if (opts.council && !opts.lenses) {
    opts.onStage?.('council', 'conductor 按语料分解 lens...');
    const authored = await authorFanoutSpec({
      goal: question,
      groundTruth, // 含锚点+种子 — lens 分解要看见全部语料面
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

  if (opts.finalExtraInstruction) {
    synthesisFramings = synthesisFramings.map((f) => ({ ...f, framing: `${f.framing}\n${opts.finalExtraInstruction}` }));
  }

  // rounds>1: 挂确定性 probe (下限半边)。wrap 收集补抓语料 → 附录落盘 (与进 prompt 的同份, 巨源带截断标记)。
  const rounds = Math.max(1, Math.trunc(opts.rounds ?? 1));
  const probeSections: string[] = [];
  let probe: ResearchFanoutConfig['probe'];
  if (rounds > 1) {
    const base = buildSecondPassProbe(
      stack,
      [retrieval, ...seedRetrievals].flatMap((r) => r.sources.filter((s) => s.body).map((s) => s.url)),
      {
        probeCrawl: opts.probeCrawl,
        signal: opts.signal,
        // 仓内腿 (给了根才开): 缺口点名的 repoQueries 走确定性检索并进下一轮语料。
        ...(opts.repoCwd ? { repoCwd: opts.repoCwd } : {}),
        onStage: opts.onStage,
      },
    );
    probe = async (a) => {
      const y = await base(a);
      if (y.newCorpus) probeSections.push(y.newCorpus);
      return y;
    };
  }

  const fanout = await researchFanout({
    question,
    stablePrefix: opts.stablePrefix ?? DEFAULT_WEB_STABLE_PREFIX,
    groundTruth, // 锚点 + 主检索 + 种子检索 = 防幻觉事实锚, 注入每 leaf
    lenses,
    synthesisFramings,
    judgeCriteria,
    lensModel,
    reasonModel,
    reduceModel: opts.reduceModel,
    judgeModel: opts.judgeModel,
    // 跨家族发散 (统一 rotateFamilies): lens+synth 走发散池, judge panel 走 judge 池; 终局 fusion/graft 单强不发散。
    divergePool: opts.divergePool ?? LENS_DIVERGENCE_POOL,
    divergeWeights: opts.divergeWeights ?? LENS_DIVERGENCE_WEIGHTS,
    judgePool: opts.judgePool ?? JUDGE_PANEL_POOL,
    fusionModel: opts.fusionModel,
    graftModel: opts.graftModel ?? resolveRoleModelConfigured('judge').model,
    maxFanout: opts.maxFanout,
    rounds,
    probe,
    onStage: opts.onStage,
  });

  return {
    question,
    retrieval,
    fanout,
    ...(probeSections.length ? { secondPassCorpus: probeSections.join('\n\n') } : {}),
    ...(seedRetrievals.length ? { seedRetrievals } : {}),
  };
}
