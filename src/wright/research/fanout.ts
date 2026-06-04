/**
 * src/wright/research/fanout.ts — 参数化深度研究 fan-out (best-of-N at scale, 复用 harness)。
 *
 * 结构 (the owner 2026-06-03 锁): L lens × V sub-angle 变体 → per-lens judge reduce 成冠军 →
 * M framing 综合 → K-judge panel + graft → 最终方案。每 leaf 注入 persona + 领域抽象块 + groundTruth。
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
import { callModel as defaultCallModel } from '../../model';
import type { ContentPart, ModelMessage } from '../../model';
import type { ModelUsage } from '../../model/types';
import { computeCost } from '../../model/cost-ledger';
import { parallel } from '../../orchestration/primitives';

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
  /** K 个 judge 评判维度 (panel, 降单 judge 偏见)。 */
  judgeCriteria: { key: string; criterion: string }[];
  /** sub-angle leaf 模型 (广度, 默认 deepseek flash)。 */
  lensModel: string;
  /** judge/综合 模型 (推理, 默认 deepseek pro)。 */
  reasonModel: string;
  /**
   * per-lens reduce (镜头内 V→1 冠军合成) 模型。默认 = reasonModel。
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
  /** 并发上限 (默认 env XIHE_MAX_FANOUT 或 256)。 */
  maxFanout?: number;
  /**
   * 多模态腿: data-URI / http 图片, 挂到**每个 gen-stage leaf** 的 user 消息
   * (reduce/synth/judge 是纯文本归并, 不带图)。需 lensModel 是 vision 模型
   * (如 mimo:mimo-v2.5)。空/省略 = 纯文本 fanout (原行为)。
   */
  images?: string[];
  /** gen-stage leaf 的 thinkingLevel (如 mimo 只到 'high')。省略 = 模型默认。 */
  leafThinking?: 'high' | 'xhigh';
  /** 注入 callModel (测试 fake)。 */
  _callModel?: typeof defaultCallModel;
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
  /** 实际跑的 leaf 总数 (L×V + L reduce + M synth + K judge + 1 graft)。 */
  leafCount: number;
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
 * 跑一轮深度研究 fan-out。leafCount = ΣV (gen) + L (per-lens reduce) + M (synth) + K (judge) + 1 (graft)。
 */
export async function researchFanout(cfg: ResearchFanoutConfig): Promise<ResearchFanoutResult> {
  const call = cfg._callModel ?? defaultCallModel;
  const concurrency = cfg.maxFanout ?? (Number(process.env.XIHE_MAX_FANOUT) || 256);
  const conc = { concurrency };
  const stage = (s: string, d: string): void => cfg.onStage?.(s, d);
  const reduceModel = cfg.reduceModel ?? cfg.reasonModel;
  const judgeModel = cfg.judgeModel ?? cfg.reasonModel;
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

  // ── Stage 1: L×V sub-angle 变体 (flash, 全并行)。每 leaf = persona + 抽象 + groundTruth + sub-angle。
  const genJobs: (() => Promise<{ lens: string; angleIdx: number; text: string }>)[] = [];
  for (const lens of cfg.lenses) {
    for (let i = 0; i < lens.subAngles.length; i++) {
      const angle = lens.subAngles[i]!;
      genJobs.push(async () => {
        const abstraction = lens.abstraction ? `\n<domain-abstraction>${lens.abstraction}</domain-abstraction>` : '';
        const prompt = `${head}\n\n<persona>${lens.persona}</persona>${abstraction}\n\n研究问题: ${cfg.question}\n\n本 leaf 的具体 sub-angle: ${angle}\n\n用 ground-truth 里的真实模块名推理 (禁造)。结构化、具体、可落地、只答这个 sub-angle。`;
        const text = await track(
          cfg.lensModel,
          call({ model: cfg.lensModel, messages: userMsg(prompt, cfg.images), thinkingLevel: cfg.leafThinking }),
        );
        return { lens: lens.key, angleIdx: i, text };
      });
    }
  }
  leafCount += genJobs.length;
  const genResults = (await parallel(genJobs, conc)).filter(Boolean) as { lens: string; angleIdx: number; text: string }[];
  stage('gen', `${genResults.length}/${genJobs.length} sub-angle leaf`);

  // ── Stage 2: per-lens judge reduce → 冠军 + 摘碎片 (pro, L 并行)。
  const reduceJobs = cfg.lenses.map((lens) => async () => {
    const variants = genResults.filter((g) => g.lens === lens.key).sort((a, b) => a.angleIdx - b.angleIdx);
    const body = variants.map((v, i) => `### sub-angle ${i + 1}\n${v.text}`).join('\n\n');
    const prompt = `${head}\n\n镜头[${lens.key}] 的 ${variants.length} 个 sub-angle 产出:\n${body}\n\n你是该镜头的首席 judge。合成这镜头的**冠军答案**: 取最强骨架 + 嫁接各 sub-angle 的最佳碎片, 去冗余去弱点。直接给冠军答案。`;
    const text = await track(reduceModel, call({ model: reduceModel, messages: msg(prompt) }));
    return { key: lens.key, text };
  });
  leafCount += reduceJobs.length;
  // reduce 各 lens body 互不相同, 但全部共享 head (stablePrefix+groundTruth) 这个大前缀, 且 reduce 是**首个 pro 阶段**。
  // warm-then-fanout: 串行暖 1 个写 head 到缓存 → reduce 2..L + 下游 synth/judge/graft 全继承命中 (L×head miss → 1×head miss)。
  const lensChampions = (await warmParallel(reduceJobs, conc, warm)).filter(Boolean) as { key: string; text: string }[];
  stage('reduce', `${lensChampions.length} lens 冠军`);

  const championsDigest = lensChampions.map((c) => `## 镜头冠军[${c.key}]\n${c.text}`).join('\n\n');

  // ── Stage 3: M framing 综合候选 (pro, 并行)。
  const synthJobs = cfg.synthesisFramings.map((fr) => async () => {
    const prompt = `${head}\n\n各镜头冠军:\n${championsDigest}\n\n<framing>${fr.framing}</framing>\n\n按此 framing 综合成一份完整方案 (具体到模块/文件/接点, 用真实模块名)。`;
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
    const prompt = `${head}\n\n${candDigest}\n\n你是评判维度【${j.criterion}】的 judge。按此维度评 ${synthCandidates.length} 个候选: 各自强弱 + 哪个最优 + 该嫁接谁的哪段。只从你这个维度评。`;
    const text = await track(judgeModel, call({ model: judgeModel, messages: msg(prompt) }));
    return { key: j.key, text };
  });
  leafCount += judgeJobs.length;
  // judge 全读同一 candDigest → warm-then-fanout; 且与下方 graft 共享 `groundTruth+candDigest` 前缀。
  const judgeCritiques = (await warmParallel(judgeJobs, conc, warm)).filter(Boolean) as { key: string; text: string }[];
  stage('judge', `${judgeCritiques.length} judge 维度`);

  // ── Stage 5: 终审 graft (pro, 1 发) → 据 panel 评判合成最终方案。
  leafCount += 1;
  const critDigest = judgeCritiques.map((c) => `### judge[${c.key}]\n${c.text}`).join('\n\n');
  // 前缀与 judge 字节对齐 (`head\n\n${candDigest}`) → 复用 judge 已暖的 head+candDigest 缓存。
  const finalPrompt = `${head}\n\n${candDigest}\n\nK-judge panel 多维评判:\n${critDigest}\n\n你是首席架构师。据 panel 多维评判**合成唯一最终方案**: 选最强骨架 + 嫁接各候选/各维度认可的更优局部。直接给最终方案, 不要元评论。`;
  const finalText = await track(cfg.reasonModel, call({ model: cfg.reasonModel, messages: msg(finalPrompt) }));

  return { final: finalText, lensChampions, synthCandidates, judgeCritiques, leafCount, costStats: buildCostStats(usageLog) };
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
