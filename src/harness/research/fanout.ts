/**
 * src/harness/research/fanout.ts — 参数化深度研究 fan-out (best-of-N at scale, 复用 harness)。
 *
 * 结构 (Nick 2026-06-03 锁): L lens × V sub-angle 变体 → per-lens judge reduce 成冠军 →
 * M framing 综合 → K-judge panel + graft → 最终方案。每 leaf 注入 persona + 领域抽象块 + groundTruth。
 *
 * rounds (research-second-pass, 2026-07-26): gen+reduce 可迭代多轮 —— 轮间由 [模型缺口分析 (上限) +
 * 注入式确定性 probe (下限)] 决定增量, **无新增即停、轮数上限, 全归引擎计数, 不问模型"够了吗"**;
 * 二轮起换 challenger lens 只挖缺口不重答原题。synth/judge/fusion/graft 终局一次, 吃全部轮的冠军。
 * 语料 append-only 增长 → 每轮 prompt 同一前缀开头, 已暖缓存跨轮命中。shape: research-second-pass。
 *
 * 核心纪律 (为什么这么设计):
 *  - **多样性 > 体积**: lens 内是 V 个**不同 sub-angle**, 不是同一 prompt 重采样 V 遍 (后者边际递减)。
 *  - **抽象注入**: 每 leaf 注 persona + 高阶领域框架 (Build Systems à la Carte 等) → 把弱模型从通用
 *    拉进专家区 (persona conditioning 搬概率质量, 逃平庸 token 区)。
 *  - **多 judge panel**: foundational 决策单 judge 有系统偏见 → K 个不同评判维度 (adversarial-verify)。
 *  - **量任务驱动**: L=真实专家视角数, V=该 lens 真实 sub-angle 数 (超过即重采样递减), 不是魔法常数。
 *
 * 全注入 callModel (默认真 callModel; 测试传 fake) → 无网络可测 staging 结构。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { makeBudgetedCall } from '../../model/gateway';
import { send } from '../../model/gateway';
import { resolveRoleModelConfigured } from '../../model/role-models';
import { withGoFallback } from '../../model/gateway';
import type { ContentPart, ModelMessage } from '../../model/gateway';
import type { ModelUsage, ModelRequest, ModelResponse } from '../../model/gateway';
import { computeCost } from '../../model/gateway';
import { parallel } from '../primitives';
import { buildFusionAnalysisPrompt } from './fusion-analysis';
import { rotateFamilies } from '../../model/family-rotate';

/** research-second-pass 缺口条目 (模型上限半边的结构化产出)。 */
const GAP_SCHEMA = z.object({
  gaps: z.array(
    z.object({
      key: z.string(),
      /** 下一轮要挖的具体问题 (增量, 不是原题重述)。 */
      question: z.string(),
      why: z.string(),
      /** 该缺口点名要读的 URL (被引用未抓取 / 该查证的出处) —— 喂确定性 probe 的 web 腿。 */
      urls: z.array(z.string()).optional(),
      /**
       * 该缺口点名要**在本仓查**的字面串/符号名 —— 喂确定性 probe 的**仓内腿**。
       *
       * 为什么要这条: 缺口分析常问"这个断言在**我们仓里**是怎么实现的", 而 web 腿只会去抓 URL,
       * 接不住。研究 leaf 是 inproc 看不见仓库, 于是这类缺口永远悬着 —— 补上这条腿, 上限
       * (模型说缺什么) 与下限 (确定性检索去取) 才在两个方向上都对称。
       */
      repoQueries: z.array(z.string()).optional(),
    }),
  ),
});
export type ResearchGap = z.infer<typeof GAP_SCHEMA>['gaps'][number];

/** 每轮缺口上限 —— 超过就不是"增量"而是重开题 (引擎钳制, 不与模型商量)。 */
const MAX_GAPS = 6;

/** 确定性探测器 (下限半边) 的产出。全空 = 这半边无新增。 */
export interface ProbeYield {
  /** 缺料抓回来的增量语料 (append 进下一轮 groundTruth, 零丢失由调用方留档)。 */
  newCorpus?: string;
  /** 本次真抓到正文的 URL (留痕进 secondPass)。 */
  fetchedUrls?: string[];
  /**
   * 本次仓内检索命中的文件路径 (留痕进 secondPass)。
   * **与 fetchedUrls 分开**: 后者是 INV-GOAL-2 的"真 web 抓取痕迹"证据面, 掺进本地路径就废了。
   */
  repoHits?: string[];
}

/** 一个研究镜头 = 一个专家视角 + 它内部的 V 个不同 sub-angle 变体。 */
export interface ResearchLens {
  key: string;
  /** persona conditioning (拔高到专家区)。 */
  persona: string;
  /** V 个**不同** sub-angle (非重采样)。每个一个 leaf。 */
  subAngles: string[];
  /** 该 lens 注入的高阶领域抽象框架 (可选, 如 "Build Systems à la Carte: applicative vs monadic")。 */
  abstraction?: string;
}

export interface ResearchFanoutConfig {
  /** 研究问题。 */
  question: string;
  /**
   * 跨轮稳定的领域专家 / 方法论 / 角色框架前缀。逐字节冻结 (禁插值/时间戳/per-lens 变体),
   * 排在 groundTruth **之前** → DeepSeek 在 TTL 内跨所有轮缓存它 (轴 B: cross-run cache)。
   * 这是把 pro cacheHit 推过 80% 的主杠杆 —— stable 内容必须在前缀, run-specific 的 groundTruth 在后。
   * 省略 = 退化为原行为 (仅 groundTruth 作前缀, 只有轴 A 轮内 warm)。
   */
  stablePrefix?: string;
  /** 代码库/事实 ground-truth, 注入每个 leaf 防幻觉。 */
  groundTruth: string;
  /** L 个镜头, 每个含 V 个 sub-angle。 */
  lenses: ResearchLens[];
  /** M 个综合 framing (不同立场合成候选)。 */
  synthesisFramings: { key: string; framing: string }[];
  /**
   * K 个 judge 评判维度 (panel, 降单 judge 偏见)。
   * 可选 `model`: 该维度用指定模型 (跨族 panel — 不同模型族评不同维度 = diversity 最强形态);
   * 省略 → 用全局 judgeModel。GO 下推荐 glm-5/kimi-k2.6/minimax-m2.7 + deepseek-v4-pro 四族分派。
   */
  judgeCriteria: { key: string; criterion: string; model?: string }[];
  /** sub-angle leaf 模型 (广度, 默认 deepseek flash)。 */
  lensModel: string;
  /** judge/综合 模型 (推理, 默认 deepseek pro)。 */
  reasonModel: string;
  /**
   * per-lens reduce (镜头内 V→1 冠军合成) 模型。默认 = env OMD_REDUCE_MODEL → ds-flash (多调用阶段, 不继承 reasonModel)。
   * 成本旋钮: reduce 是**最大的不可缓存 pro 消费** (每 lens 全读 V 个 sub-angle body, 永远 unique),
   * 且是镜头内机械合并 → 下沉 flash 是单刀最大降本。质量权衡由调用方按遥测决定。
   */
  reduceModel?: string;
  /** K-judge panel 模型。默认 = reasonModel。评判判别性更吃推理, 下沉前看遥测。 */
  judgeModel?: string;
  /**
   * 跨家族发散池 (统一 rotateFamilies): 设则 **lens gen 与 synth framing** 逐单元轮到不同模型族
   * (本仓铁律「同族 N 单元共享盲点」)。省略 → lens 全用 lensModel、synth 全用 reasonModel (原单族行为)。
   * divergeWeights: coord→权重, 表达「N% 走某坐标」的经济约束 (如 mimo-v2.5-pro:3 → 该坐标占 50%,
   * 另 50% 由池内其余家族分)。缺省全 1 = 均匀跨族。
   */
  divergePool?: string[];
  divergeWeights?: Record<string, number>;
  /**
   * synth framing 专用发散池 (与 lens 解耦): 设则 synth 的 M framing 走这个池, lens 仍走 divergePool/lensModel。
   * 省略 → 回落 divergePool (lens 与 synth 共池, 原行为)。用途: lens 留廉价单族、只在 synth 花多家族。
   */
  synthPool?: string[];
  /** judge panel 跨族池: 设则逐维度轮到不同族 (仅在该维度未显式 judgeCriteria[].model 时)。省略 → judgeModel。 */
  judgePool?: string[];
  /** fusion 融合分析模型 (1 发终局分析)。默认 = judgeModel。收敛单发, 不发散。 */
  fusionModel?: string;
  /** graft 终审合成模型 (1 发终笔)。默认 = reasonModel。收敛单发, 用单一强连贯模型。 */
  graftModel?: string;
  /**
   * warm-then-fanout: synth/judge 波先串行暖 1 个调用写入共享前缀 (championsDigest / candDigest),
   * 再并行其余 → 把同时并发波的"全 miss"转成"1 miss + N-1 hit"。默认 true (零输出影响, 纯降本)。
   */
  warmCache?: boolean;
  /** 并发上限 (默认 env OMD_MAX_FANOUT 或 256)。 */
  maxFanout?: number;
  /**
   * 多模态腿: data-URI / http 图片, 挂到**每个 gen-stage leaf** 的 user 消息
   * (reduce/synth/judge 是纯文本归并, 不带图)。需 lensModel 是 vision 模型
   * (如 mimo:mimo-v2.5)。空/省略 = 纯文本 fanout (原行为)。
   */
  images?: string[];
  /** gen-stage leaf 的 thinkingLevel (如 mimo 只到 'high')。省略 = 模型默认。 */
  leafThinking?: 'high' | 'xhigh';
  /**
   * research-second-pass 轮数上限 (默认 1 = 单轮原行为)。每轮 = gen+reduce; 轮间由
   * [模型缺口分析 (上限) + 注入 probe (下限)] 决定增量, **无新增即停 —— 停由引擎计数,
   * 不问模型"够了吗"** (shape: research-second-pass)。synth/judge/fusion/graft 终局一次。
   */
  rounds?: number;
  /**
   * 确定性探测器 (web 层注入, 零 LLM): 读本轮冠军全文 + 缺口点名的 urls, 抓「被引用却
   * 没抓过」的缺料回增量语料。省略 = 纯模型路径 (challenger 只重蒸已有料, 不抓网)。
   * 失败不断链 (probe 是增益): 抛错 → 只剩模型半边。
   */
  probe?: (args: { round: number; digest: string; gaps: ResearchGap[] }) => Promise<ProbeYield>;
  /**
   * 调用方在**进 fanout 之前**已经发生的模型调用 (conductor 分解 / 种子作者化) 的 usage,
   * 并进同一本账 → `costStats` 覆盖整次研究而非只覆盖 fanout 内部。
   * `usageLog` 是本函数的局部量, 作用域外的调用**结构上**进不来, 只能这样递进来。
   */
  priorUsage?: readonly { model: string; usage: ModelUsage }[];
  /** 注入 callModel (测试 fake)。结构化签名 (不 import callModel 值 → 不绕 gateway, 守 INV-1)。 */
  _callModel?: (req: ModelRequest) => Promise<ModelResponse>;
  /** 进度回调 (可选)。 */
  onStage?: (stage: string, detail: string) => void;
}

/** 单模型的 token/缓存/成本聚合 (V2-ECON 账本)。 */
export interface FanoutModelStat {
  calls: number;
  in: number;
  out: number;
  cacheHit: number;
  /** cacheHit / in (该模型整轮的 prompt-cache 命中率)。 */
  cacheHitRate: number;
  costUsd: number;
}

export interface FanoutCostStats {
  perModel: Record<string, FanoutModelStat>;
  totalUsd: number;
  /** 缓存相对全 miss 省下的钱 (cacheHit·(inputRate-cacheHitRate))。 */
  totalSavingsUsd: number;
}

export interface ResearchFanoutResult {
  final: string;
  lensChampions: { key: string; text: string }[];
  synthCandidates: { key: string; text: string }[];
  judgeCritiques: { key: string; text: string }[];
  /** Fusion 融合分析 (5-tuple 文本: 共识/矛盾/覆盖缺口/独特洞察/盲点), graft 据此 ground。见 fusion-analysis.ts。 */
  fusionAnalysis: string;
  /** 实际跑的 leaf 总数 (Σ轮(gen+reduce) + 轮间 gap 分析 + M synth + K judge + 1 fusion + 1 graft)。 */
  leafCount: number;
  /** 实际跑的轮数 (rounds>1 时可能因"无新增"早停; 单轮 = 1)。 */
  roundsRun: number;
  /** 轮间留痕: 每个后续轮的缺口清单 + probe 补抓到正文的 URL (单轮 = [])。 */
  secondPass: { round: number; gaps: ResearchGap[]; probedUrls: string[]; repoHits?: string[] }[];
  /** 整轮 token/缓存/成本遥测 (M6: 测量缓存命中而非靠账单猜)。 */
  costStats: FanoutCostStats;
}

const msg = (content: string): ModelMessage[] => [{ role: 'user', content }];

/** user 消息, 可选挂图 (多模态腿)。无图 = 退化为纯文本 string content。 */
const userMsg = (text: string, images?: string[]): ModelMessage[] => {
  if (!images || images.length === 0) return [{ role: 'user', content: text }];
  const parts: ContentPart[] = [
    { type: 'text', text },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];
  return [{ role: 'user', content: parts }];
};

/** warm-then-fanout: 先串行暖 1 个写共享前缀, 再并行其余, 保序返回。warm=false 退化为纯 parallel。 */
async function warmParallel<T>(
  jobs: (() => Promise<T>)[],
  conc: { concurrency: number },
  warm: boolean,
): Promise<(T | null)[]> {
  if (!warm || jobs.length <= 1) return parallel(jobs, conc);
  let first: T | null = null;
  try {
    first = await jobs[0]!();
  } catch {
    first = null;
  }
  const rest = await parallel(jobs.slice(1), conc);
  return [first, ...rest];
}

/**
 * 跑一波 leaf, 并钉住一条闸:**这一波有效样本为 0 → 当场抛, 永不放行**。
 *
 * `parallel` 对单个 leaf fail-open (抛错 → null, INV-6) 是对的 —— 一个 sub-angle 挂掉只该丢它自己。
 * 但**整波全挂**是另一件事: 2026-08-09 单 provider 周配额耗尽, gen 波打出 `r1: 0/26`,
 * 引擎当没事一样又跑了两轮缺口补抓 (+92k 字符) 才崩。那 26 个的正确含义是 **26 个 invalid**
 * (压根没到模型), 不是"26 次跑了没做成"。0 有效样本的产出不是"研究得浅",
 * 是**什么都没量到** —— 后面的 reduce/synth/judge 全在对空气综合, 而报告长得和真的一模一样。
 *
 * 同族的闸在检索侧早就立着 (`researchWebFanout`: 检索零结果 → 抛)。这里补的是模型侧那一半。
 * (jcode `DISCOVERY_RATE_BENCHMARK` 独立同构:「没有任何有效 trial 的跑永远不算通过」。)
 *
 * 顺带守本仓第二条坑规 —— fail-open 可以吞异常, 不许吞证据: `parallel` 把 leaf 的抛错吃成 null,
 * 于是这里先把每条错话记下来, 整波塌了才分得清是配额、认证还是超时。
 */
async function runWave<T>(
  label: string,
  jobs: (() => Promise<T>)[],
  conc: { concurrency: number },
  warm: boolean,
): Promise<T[]> {
  const errs: string[] = [];
  const watched = jobs.map((job) => async (): Promise<T> => {
    try {
      return await job();
    } catch (e) {
      errs.push((e as Error).message);
      throw e;
    }
  });
  const out = (await warmParallel(watched, conc, warm)).filter((x): x is T => x !== null);
  if (out.length === 0) {
    const uniq = [...new Set(errs)];
    throw new Error(
      `researchFanout: ${label} 波 0/${jobs.length} 有效样本 —— **0 有效样本 ≠ 通过**, 这一跑作废` +
        ` (invalid: 没量到任何东西, 不是"结果不好")。\n` +
        `  leaf 报错 ${errs.length} 条 / ${uniq.length} 种: ` +
        (uniq.slice(0, 3).join(' | ') || '(一条都没有 —— 这一波压根没有 leaf, 看 lenses/framings/criteria 配置)'),
    );
  }
  return out;
}

/**
 * 跑深度研究 fan-out (rounds 轮, 默认 1)。
 * leafCount = Σ轮(ΣV gen + L reduce) + (轮间 gap 分析 ×(roundsRun-1 或早停轮)) + M (synth) + K (judge) + 1 (fusion) + 1 (graft)。
 */
export async function researchFanout(cfg: ResearchFanoutConfig): Promise<ResearchFanoutResult> {
  // 调用通道 (B2 预算下沉):
  //  - 生产 (无 _callModel): 经 gateway send() → 自动 Langfuse trace + 复用 gateway 单一 budgetedCall
  //    (priority 角色: mimo 满 cap 排队, 与原 makeBudgetedCall 无 overflow 语义一致, 无双重预算)。
  //  - 测试 (有 _callModel): 直走注入 fake + 本地 budget 闸 (零网络, 不经 gateway, 可单测)。
  // sessionId 把本轮全部 leaf trace 归到同一 Langfuse session。
  const sessionId = randomUUID();
  type CallFn = (req: {
    model: string;
    messages: ModelMessage[];
    thinkingLevel?: 'high' | 'xhigh';
    maxTokens?: number;
    responseSchema?: z.ZodTypeAny;
  }) => Promise<{ text: string; usage?: ModelUsage; parsed?: unknown }>;
  // 输出兜底。**8192 是 2026-07-28 修掉的 bug**: 那个数来自一句没验过的注释 ("deepseek 系硬顶 ~8k 会 400"),
  // 实测推翻 —— 同一条 opencode-go 渠道 cap=32000 下 minimax-m3 自然写到 out=21309、kimi-k3 写到 13874, 都正常收尾,
  // 没有 400。8k 顶反而让长综合被静默腰斩 (推理族更惨: reasoning 与正文共用这份预算, 思考吃完正文只剩几百字)。
  // 模型写完就停, cap 只在它还想写时才咬 → 抬高不增加常态成本, 只是不再人为切断。
  const SYNTH_MAX = Number(process.env.OMD_SYNTH_MAX_TOKENS) || 32_768;
  const rawCall: CallFn = cfg._callModel
    ? makeBudgetedCall(cfg._callModel)
    : (req) =>
        send({
          model: req.model,
          messages: req.messages,
          thinkingLevel: req.thinkingLevel,
          maxTokens: req.maxTokens,
          responseSchema: req.responseSchema,
          meta: { role: 'fanout-leaf', sessionId },
        });
  // 单点包装: maxTokens 兜底 + GO 溢出回退 ds-v4-pro (A② fallback chain), 全 stage (gen/reduce/synth/judge/graft) 继承。
  const call: CallFn = (req) => {
    const r = { ...req, maxTokens: req.maxTokens ?? SYNTH_MAX };
    return withGoFallback(r.model, (m) => rawCall({ ...r, model: m }));
  };
  const concurrency = cfg.maxFanout ?? (Number(process.env.OMD_MAX_FANOUT) || 256);
  const conc = { concurrency };
  const stage = (s: string, d: string): void => cfg.onStage?.(s, d);
  // 角色默认钉死, 不再静默继承 reasonModel (模型分配 v3, Nick 2026-06-11):
  // reduce = 多调用阶段 (×L lens) — 绝不能继承慢/贵的 reason 模型 (mimo-pro 24s×L 实测爆超时的机制化防呆);
  // judge = 判别吃推理 → ds-pro (单价低 + K panel 并行, 背景任务可承受 ~50s/call)。
  const reduceModel = cfg.reduceModel ?? resolveRoleModelConfigured('reduce').model;
  const judgeModel = cfg.judgeModel ?? resolveRoleModelConfigured('judge').model;
  const warm = cfg.warmCache ?? true;
  let leafCount = 0;

  // 缓存前缀分层 (轴 B): [stablePrefix 跨轮稳定] + [groundTruth run-specific]。
  // 所有 stage (gen/reduce/synth/judge/graft) 共用同一 head → 最大化公共前缀, stablePrefix 段跨轮命中。
  const head = cfg.stablePrefix ? `${cfg.stablePrefix}\n\n${cfg.groundTruth}` : cfg.groundTruth;

  // ── 遥测累加: 每个 leaf 调用后记 (model, usage) → 整轮 cache 命中率 + 成本 (M6, 不靠账单猜)。
  const usageLog: { model: string; usage: ModelUsage }[] = [...(cfg.priorUsage ?? [])];
  const track = async (model: string, p: Promise<{ text: string; usage?: ModelUsage }>): Promise<string> => {
    const r = await p;
    usageLog.push({ model, usage: r.usage ?? { in: 0, out: 0 } });
    return r.text;
  };

  // ── Stage 1+2 按轮迭代 (research-second-pass)。语料 append-only: 每轮 prompt 以同一 head
  // 开头 → 已暖前缀缓存跨轮命中; 单轮时 corpus === head, 与原行为逐字节一致。
  const maxRounds = Math.max(1, Math.trunc(cfg.rounds ?? 1));
  let corpus = head;
  let roundLenses: readonly ResearchLens[] = cfg.lenses;
  const lensChampions: { key: string; text: string }[] = [];
  const secondPass: { round: number; gaps: ResearchGap[]; probedUrls: string[]; repoHits?: string[] }[] = [];
  let roundsRun = 0;

  /** 模型上限半边: 通读冠军全文提缺口。fail-open: 解析/调用失败 → 空缺口 (增益不是链路)。 */
  const analyzeGaps = async (round: number, digest: string): Promise<ResearchGap[]> => {
    leafCount += 1;
    const prompt = `${corpus}\n\n各镜头冠军 (截至第 ${round} 轮):\n${digest}\n\n你是 research-second-pass 的缺口分析器。通读以上全部, 提出下一轮**只做增量**该挖什么: 没有出处的关键断言、被引用/被点名却没读过的来源 (urls 给完整链接)、有料没挖透的角度。\n\n缺口有两个方向, 分开填:\n- urls: 该读的**外部**来源 (完整链接);\n- repoQueries: 该在**本仓**查证的字面串/符号名 (函数名/类型名/常量/配置键/错误文案)。凡是"我们仓里是怎么做的 / 有没有现成的"这类缺口都填这里 —— 会有确定性检索去取, 你不要凭印象回答。\n\n已答好的部分不要重复提。没有值得挖的就返回空 gaps —— 不要硬凑。只输出 JSON: {"gaps":[{"key":"...","question":"...","why":"...","urls":["..."],"repoQueries":["..."]}]}`;
    try {
      const res = await call({ model: cfg.reasonModel, messages: msg(prompt), responseSchema: GAP_SCHEMA });
      usageLog.push({ model: cfg.reasonModel, usage: res.usage ?? { in: 0, out: 0 } });
      const parsed = GAP_SCHEMA.safeParse(res.parsed ?? lenientJson(res.text));
      return parsed.success ? parsed.data.gaps.slice(0, MAX_GAPS) : [];
    } catch (e) {
      stage('gap', `r${round}: 缺口分析失败 (${(e as Error).message}) → fail-open 空缺口`);
      return [];
    }
  };

  for (let round = 1; ; round++) {
    roundsRun = round;
    // 二轮起: 不重答原题, 只挖缺口 (challenger lens 的 sub-angle 就是缺口本身)。
    const roundNote =
      round === 1
        ? ''
        : `\n第 ${round} 轮增量 (research-second-pass): 主体答案已在上一轮产出 —— 不重答原题, 只挖本 sub-angle 指向的缺口。`;

    // ── Stage 1: L×V sub-angle 变体 (flash, 全并行)。每 leaf = persona + 抽象 + groundTruth + sub-angle。
    // 跨家族发散: 设 divergePool 则每个镜头轮到不同模型族 (镜头=视角, 家族=思路; V 变体同族深挖)。
    const lensModels = cfg.divergePool?.length
      ? rotateFamilies(cfg.divergePool, roundLenses.length, { weights: cfg.divergeWeights })
      : null;
    const genJobs: (() => Promise<{ lens: string; angleIdx: number; text: string }>)[] = [];
    roundLenses.forEach((lens, li) => {
      const lensModel = lensModels?.[li] ?? cfg.lensModel;
      for (let i = 0; i < lens.subAngles.length; i++) {
        const angle = lens.subAngles[i]!;
        genJobs.push(async () => {
          const abstraction = lens.abstraction ? `\n<domain-abstraction>${lens.abstraction}</domain-abstraction>` : '';
          const prompt = `${corpus}\n\n<persona>${lens.persona}</persona>${abstraction}\n\n研究问题: ${cfg.question}${roundNote}\n\n本 leaf 的具体 sub-angle: ${angle}\n\n用 ground-truth 里的真实模块名推理 (禁造)。结构化、具体、可落地、只答这个 sub-angle。`;
          const text = await track(
            lensModel,
            call({ model: lensModel, messages: userMsg(prompt, cfg.images), thinkingLevel: cfg.leafThinking }),
          );
          return { lens: lens.key, angleIdx: i, text };
        });
      }
    });
    leafCount += genJobs.length;
    // gen 波也共享 head 大前缀 (persona/sub-angle 在 head 之后) → warm-then-fanout:
    // 串行暖 1 个写 head 到缓存, 其余 L×V-1 个 leaf 命中 head 段 (冷并发 = 每 leaf 全 miss head)。
    const genResults = await runWave(`gen r${round}`, genJobs, conc, warm);
    stage('gen', `r${round}: ${genResults.length}/${genJobs.length} sub-angle leaf`);

    // ── Stage 2: per-lens judge reduce → 冠军 + 摘碎片 (pro, L 并行)。
    const reduceJobs = roundLenses.map((lens) => async () => {
      const variants = genResults.filter((g) => g.lens === lens.key).sort((a, b) => a.angleIdx - b.angleIdx);
      const body = variants.map((v, i) => `### sub-angle ${i + 1}\n${v.text}`).join('\n\n');
      const prompt = `${corpus}\n\n镜头[${lens.key}] 的 ${variants.length} 个 sub-angle 产出:\n${body}\n\n你是该镜头的首席 judge。合成这镜头的**冠军答案**: 取最强骨架 + 嫁接各 sub-angle 的最佳碎片, 去冗余去弱点。直接给冠军答案。`;
      const text = await track(reduceModel, call({ model: reduceModel, messages: msg(prompt) }));
      return { key: lens.key, text };
    });
    leafCount += reduceJobs.length;
    // reduce 各 lens body 互不相同, 但全部共享 head (stablePrefix+groundTruth) 这个大前缀, 且 reduce 是**首个 pro 阶段**。
    // warm-then-fanout: 串行暖 1 个写 head 到缓存 → reduce 2..L + 下游 synth/judge/graft 全继承命中 (L×head miss → 1×head miss)。
    const champions = await runWave(`reduce r${round}`, reduceJobs, conc, warm);
    lensChampions.push(...champions);
    stage('reduce', `r${round}: ${champions.length} lens 冠军`);

    if (round >= maxRounds) break;

    // ── 轮间 (research-second-pass): 模型缺口分析 (上限) + 注入确定性 probe (下限)。
    const digest = lensChampions.map((c) => `## 镜头冠军[${c.key}]\n${c.text}`).join('\n\n');
    const gaps = await analyzeGaps(round, digest);
    let probeYield: ProbeYield = {};
    if (cfg.probe) {
      try {
        probeYield = await cfg.probe({ round, digest, gaps });
      } catch (e) {
        stage('probe', `r${round}: probe 失败 (${(e as Error).message}) → 只剩模型半边`);
      }
    }
    const newCorpus = probeYield.newCorpus?.trim() ?? '';
    // 无新增即停: 两个半边都空 → 再来一轮只会重述 (shape whenNot: 重复的不是信息是噪声)。引擎判, 不问模型。
    if (gaps.length === 0 && !newCorpus) {
      stage('second-pass', `r${round}: 无新增 (0 缺口, 0 新语料) → 停`);
      break;
    }
    secondPass.push({ round: round + 1, gaps, probedUrls: probeYield.fetchedUrls ?? [], ...(probeYield.repoHits?.length ? { repoHits: probeYield.repoHits } : {}) });
    if (newCorpus) corpus += `\n\n<second-pass-corpus round="${round + 1}">\n${newCorpus}\n</second-pass-corpus>`;
    roundLenses = [secondPassLens(round + 1, gaps)];
    stage('second-pass', `r${round + 1}: ${gaps.length} 缺口, +${newCorpus.length} chars 补抓语料`);
  }

  const championsDigest = lensChampions.map((c) => `## 镜头冠军[${c.key}]\n${c.text}`).join('\n\n');

  // ── Stage 3: M framing 综合候选 (pro, 并行)。synth 是 M 路发散 (不同立场各出一版) → 跨家族。
  // synthPool 与 lens 解耦: 省略则回落 divergePool (共池); 设则 synth 独立发散 (如 lens 廉价单族 + synth 多族)。
  const synthPool = cfg.synthPool ?? cfg.divergePool;
  const synthModels = synthPool?.length
    ? rotateFamilies(synthPool, cfg.synthesisFramings.length, { weights: cfg.divergeWeights })
    : null;
  const synthJobs = cfg.synthesisFramings.map((fr, mi) => async () => {
    const sm = synthModels?.[mi] ?? cfg.reasonModel;
    const prompt = `${corpus}\n\n各镜头冠军:\n${championsDigest}\n\n<framing>${fr.framing}</framing>\n\n按此 framing 综合成一份完整方案 (具体到模块/文件/接点, 用真实模块名)。`;
    const text = await track(sm, call({ model: sm, messages: msg(prompt) }));
    return { key: fr.key, text };
  });
  leafCount += synthJobs.length;
  // synth 全读同一 championsDigest(~6k tok) → warm-then-fanout: 暖 1 个写前缀, 其余 hit。
  const synthCandidates = await runWave('synth', synthJobs, conc, warm);
  stage('synth', `${synthCandidates.length} 综合候选`);

  const candDigest = synthCandidates.map((s) => `## 候选[${s.key}]\n${s.text}`).join('\n\n');

  // ── Stage 4: K-judge panel (pro, 并行) → 各维度评判。评判是 K 路独立评判 → 跨家族降单模型系统偏见。
  const judgePanelModels = cfg.judgePool?.length
    ? rotateFamilies(cfg.judgePool, cfg.judgeCriteria.length)
    : null;
  const judgeJobs = cfg.judgeCriteria.map((j, ki) => async () => {
    const jm = j.model ?? judgePanelModels?.[ki] ?? judgeModel; // 显式 model > judgePool 轮转 > 全局 judgeModel
    const prompt = `${corpus}\n\n${candDigest}\n\n你是评判维度【${j.criterion}】的 judge。按此维度评 ${synthCandidates.length} 个候选: 各自强弱 + 哪个最优 + 该嫁接谁的哪段。只从你这个维度评。`;
    const text = await track(jm, call({ model: jm, messages: msg(prompt) }));
    return { key: j.key, text };
  });
  leafCount += judgeJobs.length;
  // judge 全读同一 candDigest → warm-then-fanout; 且与下方 graft 共享 `groundTruth+candDigest` 前缀。
  const judgeCritiques = await runWave('judge', judgeJobs, conc, warm);
  stage('judge', `${judgeCritiques.length} judge 维度`);

  const critDigest = judgeCritiques.map((c) => `### judge[${c.key}]\n${c.text}`).join('\n\n');

  // ── Stage 4.5: Fusion 融合分析 (judge model, 1 发) → 把 K-panel 多维 prose critique
  // 收敛成结构化 5-tuple (共识/矛盾/覆盖缺口/独特洞察/盲点)。copy 自 OpenRouter Fusion
  // (last30days 2026-06-16: synthesis 质量 ~3/4 of lift)。前缀 `head\n\n${candDigest}` 与
  // judge/graft 字节对齐 → 复用已暖缓存。
  leafCount += 1;
  const fusionModel = cfg.fusionModel ?? judgeModel; // 收敛单发, 不发散
  const fusionPrompt = `${corpus}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\n${buildFusionAnalysisPrompt()}`;
  const fusionAnalysis = await track(fusionModel, call({ model: fusionModel, messages: msg(fusionPrompt) }));
  stage('fusion', 'fusion 融合分析 (5-tuple)');

  // ── Stage 5: 终审 graft (pro, 1 发) → 据 panel 评判 + fusion 5-tuple 合成最终方案。
  leafCount += 1;
  // 前缀与 fusion 字节对齐 (`head\n\n${candDigest}`) → 复用 judge/fusion 已暖的 head+candDigest 缓存。
  const finalPrompt = `${corpus}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\nFusion 融合分析 (结构化):\n${fusionAnalysis}\n\n你是首席架构师。据 panel 多维评判 + fusion 融合分析**合成唯一最终方案**: 选最强骨架, 嫁接共识与独特洞察, 显式消解矛盾点、补齐覆盖缺口与盲点。直接给最终方案, 不要元评论。`;
  const graftModel = cfg.graftModel ?? cfg.reasonModel; // 收敛终笔, 单一强连贯模型
  const finalText = await track(graftModel, call({ model: graftModel, messages: msg(finalPrompt) }));

  // 收尾遥测: per-model 缓存命中率 + 成本 (M6: 测量命中率而非靠账单倒猜)。经 onStage 流到所有 driver 的 stderr。
  const costStats = buildCostStats(usageLog);
  const perModelLine = Object.entries(costStats.perModel)
    .map(([m, s]) => `${m} ${(s.cacheHitRate * 100).toFixed(1)}%hit $${s.costUsd.toFixed(4)} (${s.calls} call, ${s.out} out)`)
    .join(' | ');
  stage('cost', `$${costStats.totalUsd.toFixed(4)} · cache saved $${costStats.totalSavingsUsd.toFixed(4)} · ${perModelLine}`);

  return { final: finalText, lensChampions, synthCandidates, judgeCritiques, fusionAnalysis, leafCount, roundsRun, secondPass, costStats };
}

/** 二轮 challenger persona (温度对偶承 distill-challenger: 主体答案已有, 只挖缺口不重述)。 */
const SECOND_PASS_PERSONA =
  '你是对抗式深挖研究员 (challenger lens): 主体答案已经有了, 你只负责挖它没覆盖/没证实的部分 —— ' +
  '未言明前提、没有出处的关键断言、新增语料里的关键事实与冲突。宁可少而尖, 不重述已有答案。';

/** 轮间构造下一轮的单一 challenger lens: 缺口 → sub-angle; 无缺口 (纯 probe 新料) → 泛化挖矿角。 */
function secondPassLens(round: number, gaps: ResearchGap[]): ResearchLens {
  const subAngles = gaps.length
    ? gaps.map((g) => `缺口[${g.key}] ${g.question} (why: ${g.why})`)
    : ['新增语料 (second-pass-corpus) 里与原题相关的新事实、与上一轮结论的冲突、被证实/证伪的断言'];
  return { key: `second-pass-r${round}`, persona: SECOND_PASS_PERSONA, subAngles };
}

/** 从自由文本里抠第一个 JSON 对象 (fake/无 schema 路径的兜底解析)。失败 → undefined。 */
function lenientJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

/** usageLog → per-model token/缓存/成本聚合。未定价模型 costUsd=0 (computeCost fail-open)。 */
function buildCostStats(log: { model: string; usage: ModelUsage }[]): FanoutCostStats {
  const perModel: Record<string, FanoutModelStat> = {};
  let totalUsd = 0;
  let totalSavingsUsd = 0;
  for (const { model, usage } of log) {
    const m = (perModel[model] ??= { calls: 0, in: 0, out: 0, cacheHit: 0, cacheHitRate: 0, costUsd: 0 });
    m.calls += 1;
    m.in += usage.in;
    m.out += usage.out;
    m.cacheHit += usage.cacheHit ?? 0;
    const cb = computeCost(usage, model);
    m.costUsd += cb.costUsd ?? 0; // 订阅通道 → 0 USD 计入合计
    totalUsd += cb.costUsd ?? 0;
    totalSavingsUsd += cb.cacheSavingsUsd ?? 0;
  }
  for (const m of Object.values(perModel)) m.cacheHitRate = m.in > 0 ? m.cacheHit / m.in : 0;
  return { perModel, totalUsd, totalSavingsUsd };
}
