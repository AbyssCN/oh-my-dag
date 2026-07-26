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

/** research-second-pass 缺口条目 (模型上限半边的结构化产出)。 */
const GAP_SCHEMA = z.object({
  gaps: z.array(
    z.object({
      key: z.string(),
      /** 下一轮要挖的具体问题 (增量, 不是原题重述)。 */
      question: z.string(),
      why: z.string(),
      /** 该缺口点名要读的 URL (被引用未抓取 / 该查证的出处) —— 喂确定性 probe。 */
      urls: z.array(z.string()).optional(),
    }),
  ),
});
export type ResearchGap = z.infer<typeof GAP_SCHEMA>['gaps'][number];

/** 每轮缺口上限 —— 超过就不是"增量"而是重开题 (引擎钳制, 不与模型商量)。 */
const MAX_GAPS = 6;

/**
 * 脊柱语料瘦身 (owner 2026-07-27 裁决): 语料索引 = 结构骨架 (标题行 + 去重来源 URL + 规模),
 * 供 post-reduce 脊柱 stage (synth/judge/fusion/graft) 替代全文 —— 它们消费的是冠军/候选 digest,
 * 全文在那里只剩延迟与账单 (实测 --deep 32 min 的大头 = 脊柱 ~20 万 token prompt × 慢推理座)。
 * gen/reduce/gap 仍持全文: 抽取与缺口判定需要正文。
 */
export function buildCorpusIndex(corpus: string, maxChars = 8_000): string {
  const heads: string[] = [];
  for (const raw of corpus.split('\n')) {
    const t = raw.trim();
    if (/^#{1,4} /.test(t) || /^<\/?second-pass-corpus/.test(t)) heads.push(t);
  }
  const urls = [
    ...new Set((corpus.match(/https?:\/\/[^\s<>()[\]{}"'`,;）)]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''))),
  ];
  const body =
    `<corpus-index chars="${corpus.length}">\n` +
    `(脊柱瘦身: 全文语料已被镜头冠军/候选消化, 此处只留骨架; 事实与引用以冠军/候选内嵌者为准)\n` +
    `${heads.join('\n')}\n\n来源 URL (${urls.length}):\n${urls.join('\n')}\n</corpus-index>`;
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n…[索引截断]\n</corpus-index>` : body;
}

/** 确定性探测器 (下限半边) 的产出。全空 = 这半边无新增。 */
export interface ProbeYield {
  /** 缺料抓回来的增量语料 (append 进下一轮 groundTruth, 零丢失由调用方留档)。 */
  newCorpus?: string;
  /** 本次真抓到正文的 URL (留痕进 secondPass)。 */
  fetchedUrls?: string[];
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
  secondPass: { round: number; gaps: ResearchGap[]; probedUrls: string[] }[];
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
  // ponytail: 输出兜底 8192 (默认 4096 截断 synth/final 综合长文)。per-model 更高经 env 调 —
  //   200k 仅 minimax 两端点验过, deepseek 系硬顶 ~8k 会 400, 故不硬编码高值。upgrade: 某模型验过更高 → 调 env。
  const SYNTH_MAX = Number(process.env.OMD_SYNTH_MAX_TOKENS) || 8192;
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
  const usageLog: { model: string; usage: ModelUsage }[] = [];
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
  const secondPass: { round: number; gaps: ResearchGap[]; probedUrls: string[] }[] = [];
  let roundsRun = 0;

  /** 模型上限半边: 通读冠军全文提缺口。fail-open: 解析/调用失败 → 空缺口 (增益不是链路)。 */
  const analyzeGaps = async (round: number, digest: string): Promise<ResearchGap[]> => {
    leafCount += 1;
    const prompt = `${corpus}\n\n各镜头冠军 (截至第 ${round} 轮):\n${digest}\n\n你是 research-second-pass 的缺口分析器。通读以上全部, 提出下一轮**只做增量**该挖什么: 没有出处的关键断言、被引用/被点名却没读过的来源 (urls 给完整链接)、有料没挖透的角度。已答好的部分不要重复提。没有值得挖的就返回空 gaps —— 不要硬凑。只输出 JSON: {"gaps":[{"key":"...","question":"...","why":"...","urls":["..."]}]}`;
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
    const genJobs: (() => Promise<{ lens: string; angleIdx: number; text: string }>)[] = [];
    for (const lens of roundLenses) {
      for (let i = 0; i < lens.subAngles.length; i++) {
        const angle = lens.subAngles[i]!;
        genJobs.push(async () => {
          const abstraction = lens.abstraction ? `\n<domain-abstraction>${lens.abstraction}</domain-abstraction>` : '';
          const prompt = `${corpus}\n\n<persona>${lens.persona}</persona>${abstraction}\n\n研究问题: ${cfg.question}${roundNote}\n\n本 leaf 的具体 sub-angle: ${angle}\n\n用 ground-truth 里的真实模块名推理 (禁造)。结构化、具体、可落地、只答这个 sub-angle。`;
          const text = await track(
            cfg.lensModel,
            call({ model: cfg.lensModel, messages: userMsg(prompt, cfg.images), thinkingLevel: cfg.leafThinking }),
          );
          return { lens: lens.key, angleIdx: i, text };
        });
      }
    }
    leafCount += genJobs.length;
    // gen 波也共享 head 大前缀 (persona/sub-angle 在 head 之后) → warm-then-fanout:
    // 串行暖 1 个写 head 到缓存, 其余 L×V-1 个 leaf 命中 head 段 (冷并发 = 每 leaf 全 miss head)。
    const genResults = (await warmParallel(genJobs, conc, warm)).filter(Boolean) as { lens: string; angleIdx: number; text: string }[];
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
    const champions = (await warmParallel(reduceJobs, conc, warm)).filter(Boolean) as { key: string; text: string }[];
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
    secondPass.push({ round: round + 1, gaps, probedUrls: probeYield.fetchedUrls ?? [] });
    if (newCorpus) corpus += `\n\n<second-pass-corpus round="${round + 1}">\n${newCorpus}\n</second-pass-corpus>`;
    roundLenses = [secondPassLens(round + 1, gaps)];
    stage('second-pass', `r${round + 1}: ${gaps.length} 缺口, +${newCorpus.length} chars 补抓语料`);
  }

  const championsDigest = lensChampions.map((c) => `## 镜头冠军[${c.key}]\n${c.text}`).join('\n\n');

  // 脊柱瘦身: post-reduce 脊柱共用 [stablePrefix + 语料索引] 前缀 (互相之间仍缓存对齐, 且小一个量级)。
  const spineHead = cfg.stablePrefix ? `${cfg.stablePrefix}\n\n${buildCorpusIndex(corpus)}` : buildCorpusIndex(corpus);

  // ── Stage 3: M framing 综合候选 (pro, 并行)。
  const synthJobs = cfg.synthesisFramings.map((fr) => async () => {
    const prompt = `${spineHead}\n\n各镜头冠军:\n${championsDigest}\n\n<framing>${fr.framing}</framing>\n\n按此 framing 综合成一份完整方案 (具体到模块/文件/接点, 用真实模块名)。`;
    const text = await track(cfg.reasonModel, call({ model: cfg.reasonModel, messages: msg(prompt) }));
    return { key: fr.key, text };
  });
  leafCount += synthJobs.length;
  // synth 全读同一 championsDigest(~6k tok) → warm-then-fanout: 暖 1 个写前缀, 其余 hit。
  const synthCandidates = (await warmParallel(synthJobs, conc, warm)).filter(Boolean) as { key: string; text: string }[];
  stage('synth', `${synthCandidates.length} 综合候选`);

  const candDigest = synthCandidates.map((s) => `## 候选[${s.key}]\n${s.text}`).join('\n\n');

  // ── Stage 4: K-judge panel (pro, 并行) → 各维度评判。
  const judgeJobs = cfg.judgeCriteria.map((j) => async () => {
    const jm = j.model ?? judgeModel; // 跨族 panel: 该维度指定模型, 否则全局 judgeModel
    const prompt = `${spineHead}\n\n${candDigest}\n\n你是评判维度【${j.criterion}】的 judge。按此维度评 ${synthCandidates.length} 个候选: 各自强弱 + 哪个最优 + 该嫁接谁的哪段。只从你这个维度评。`;
    const text = await track(jm, call({ model: jm, messages: msg(prompt) }));
    return { key: j.key, text };
  });
  leafCount += judgeJobs.length;
  // judge 全读同一 candDigest → warm-then-fanout; 且与下方 graft 共享 `groundTruth+candDigest` 前缀。
  const judgeCritiques = (await warmParallel(judgeJobs, conc, warm)).filter(Boolean) as { key: string; text: string }[];
  stage('judge', `${judgeCritiques.length} judge 维度`);

  const critDigest = judgeCritiques.map((c) => `### judge[${c.key}]\n${c.text}`).join('\n\n');

  // ── Stage 4.5: Fusion 融合分析 (judge model, 1 发) → 把 K-panel 多维 prose critique
  // 收敛成结构化 5-tuple (共识/矛盾/覆盖缺口/独特洞察/盲点)。copy 自 OpenRouter Fusion
  // (last30days 2026-06-16: synthesis 质量 ~3/4 of lift)。前缀 `head\n\n${candDigest}` 与
  // judge/graft 字节对齐 → 复用已暖缓存。
  leafCount += 1;
  const fusionPrompt = `${spineHead}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\n${buildFusionAnalysisPrompt()}`;
  const fusionAnalysis = await track(judgeModel, call({ model: judgeModel, messages: msg(fusionPrompt) }));
  stage('fusion', 'fusion 融合分析 (5-tuple)');

  // ── Stage 5: 终审 graft (pro, 1 发) → 据 panel 评判 + fusion 5-tuple 合成最终方案。
  leafCount += 1;
  // 前缀与 fusion 字节对齐 (`head\n\n${candDigest}`) → 复用 judge/fusion 已暖的 head+candDigest 缓存。
  const finalPrompt = `${spineHead}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\nFusion 融合分析 (结构化):\n${fusionAnalysis}\n\n你是首席架构师。据 panel 多维评判 + fusion 融合分析**合成唯一最终方案**: 选最强骨架, 嫁接共识与独特洞察, 显式消解矛盾点、补齐覆盖缺口与盲点。直接给最终方案, 不要元评论。`;
  const finalText = await track(cfg.reasonModel, call({ model: cfg.reasonModel, messages: msg(finalPrompt) }));

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
    m.costUsd += cb.costUsd;
    totalUsd += cb.costUsd;
    totalSavingsUsd += cb.cacheSavingsUsd ?? 0;
  }
  for (const m of Object.values(perModel)) m.cacheHitRate = m.in > 0 ? m.cacheHit / m.in : 0;
  return { perModel, totalUsd, totalSavingsUsd };
}
