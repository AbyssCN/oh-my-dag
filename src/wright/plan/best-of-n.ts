/**
 * plan/best-of-n —— 方案 best-of-N 选择 (G 子系统)。
 *
 * 把规划好的 context 派给 **N 个并发推理 leaf** (deepseek-v4-pro inproc), 各以不同 **persona+视角+采样**
 * 出一个完整方案 → **多视角 judge** (正确性/简洁/风险) 评分对比 → 选最优 + cherry-pick 次优精华合成。
 *
 * 复用 plan mode 的 persona+采样 steering (见 distill.ts / _NEXT 跨切面方向): 不同 lens 激活不同
 * 思考分布 (MVP 务实 / risk SRE / 第一性原理), 比单发"一个平均方案"覆盖更广的解空间。
 */
import { z } from 'zod';
import { callModel } from '../../model';

/** best-of-N 默认生成/judge 模型 (强推理)。 */
export const BESTOFN_DEFAULT_MODEL = 'deepseek:deepseek-v4-pro';

/** 一个方案视角: persona+angle 激活分布, 采样调忠实/探索。 */
export interface PlanLens {
  id: string;
  persona: string;
  angle: string;
  temperature: number;
  topP?: number;
}

/** 默认 3 视角 (可经 opts.lenses 扩到 5 等)。 */
export const DEFAULT_PLAN_LENSES: readonly PlanLens[] = [
  {
    id: 'mvp',
    persona: '代入务实的交付型工程主管',
    angle: 'MVP-first: 最小可行切口, 最快验证闭环, 砍掉一切非核心, 先能跑再加',
    temperature: 0.4,
    topP: 0.85,
  },
  {
    id: 'risk',
    persona: '代入资深 SRE + 安全工程师',
    angle: 'risk-first: 从失败模式/边界/不可逆点倒推, 先堵风险再谈功能',
    temperature: 0.5,
    topP: 0.9,
  },
  {
    id: 'first-principles',
    persona: '代入第一性原理思考者 (物理学家式)',
    angle: '重构问题本质, 质疑既定前提, 找最简结构 — 哪怕推翻常规做法',
    temperature: 0.75,
    topP: 0.95,
  },
];

export interface PlanCandidate {
  lens: string;
  plan: string;
}

export interface BestOfNVerdict {
  /** 最优 lens id。 */
  winner: string;
  /** 为何最优。 */
  rationale: string;
  /** 最终方案 (含从次优 graft 的精华)。 */
  synthesis: string;
}

export interface BestOfNResult {
  candidates: PlanCandidate[];
  verdict: BestOfNVerdict | null;
}

export interface BestOfNOpts {
  /** 生成模型。默认 deepseek-v4-pro。 */
  model?: string;
  /** judge 模型。默认 = 生成模型。 */
  judgeModel?: string;
  /** 视角集 (N = lenses.length)。默认 3 (DEFAULT_PLAN_LENSES)。 */
  lenses?: readonly PlanLens[];
}

const VERDICT_SCHEMA = z.object({
  winner: z.coerce.string(),
  rationale: z.coerce.string(),
  synthesis: z.coerce.string(),
});

function genPrompt(lens: PlanLens, planContext: string): string {
  return `${lens.persona}。
为下面的规划方向产出**一个完整方案** (SDD 骨架, 非散文): Contracts (types+validation+state-machine+验收GWT 钉不变量) + 红测先行清单 + 落点 (文件/接缝)。
你的视角: ${lens.angle}。坚定走这个视角到底, 不要中庸折中 — 我们要的是多个鲜明方案后续对比。

规划方向 / 已积累 context:
---
${planContext}
---`;
}

function judgePrompt(candidates: PlanCandidate[], planContext: string): string {
  const blocks = candidates.map((c) => `### 候选 [${c.lens}]\n${c.plan}`).join('\n\n');
  return `下面是同一规划方向的 ${candidates.length} 个候选方案 (不同视角生成)。
从**正确性 / 简洁 / 风险**三视角评判每个, 选出最优, 并把次优方案里值得保留的好点子 **graft** 进最终方案。

规划方向:
---
${planContext}
---

候选方案:
${blocks}

输出 JSON 三字段 (均字符串): winner (最优 lens id), rationale (为何最优 + 三视角权衡), synthesis (最终方案: 以最优为骨架 + graft 次优精华, SDD 骨架式)。`;
}

/**
 * 跑 best-of-N: N 并发生成 → 多视角 judge → 合成。callModelFn 默认真 callModel; 测试注入桩。
 * 全失败 → {candidates:[], verdict:null}; 仅 1 成功 → 直接用它 (无 judge)。
 */
export async function bestOfNPlan(
  planContext: string,
  opts: BestOfNOpts = {},
  callModelFn: typeof callModel = callModel,
): Promise<BestOfNResult> {
  const model = opts.model ?? BESTOFN_DEFAULT_MODEL;
  const judgeModel = opts.judgeModel ?? model;
  const lenses = opts.lenses ?? DEFAULT_PLAN_LENSES;

  // 1. 并发生成 N 候选 (各 lens persona+采样 → 鲜明方案)。
  const candidates = (
    await Promise.all(
      lenses.map(async (lens): Promise<PlanCandidate | null> => {
        try {
          const r = await callModelFn({
            messages: [{ role: 'user', content: genPrompt(lens, planContext) }],
            model,
            temperature: lens.temperature,
            topP: lens.topP,
            maxTokens: 2500,
          });
          const plan = r.text.trim();
          return plan ? { lens: lens.id, plan } : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((x): x is PlanCandidate => x !== null);

  if (candidates.length === 0) return { candidates: [], verdict: null };
  if (candidates.length === 1) {
    return {
      candidates,
      verdict: { winner: candidates[0]!.lens, rationale: '仅一个候选成功 (其余失败)', synthesis: candidates[0]!.plan },
    };
  }

  // 2. 多视角 judge: 单 judge 看全部 → 评分对比 + cherry-pick 合成。
  try {
    const r = await callModelFn({
      messages: [{ role: 'user', content: judgePrompt(candidates, planContext) }],
      model: judgeModel,
      temperature: 0.3,
      topP: 0.85,
      maxTokens: 3000,
      responseSchema: VERDICT_SCHEMA,
    });
    const v = r.parsed as BestOfNVerdict | undefined;
    if (v?.synthesis) {
      // G2 F3: judge 可能幻觉出非 candidate 的 winner id → 校验, 不在 lens 集则 fallback 首个。
      const winner = candidates.some((c) => c.lens === v.winner) ? v.winner : candidates[0]!.lens;
      return { candidates, verdict: { ...v, winner } };
    }
    return { candidates, verdict: { winner: candidates[0]!.lens, rationale: 'judge 未结构化', synthesis: r.text } };
  } catch (e) {
    return {
      candidates,
      verdict: { winner: candidates[0]!.lens, rationale: `judge 失败: ${(e as Error).message.slice(0, 60)}`, synthesis: candidates[0]!.plan },
    };
  }
}

// ── 深度档 council (researchFanout at scale) ───────────────────────────────────
// /council deep 的底座: 同 council 多视角择优纪律, 但放大成 L lens × V sub-angle →
// per-lens reduce 冠军 → M framing 综合 → K-judge panel + graft。轻量 bestOfNPlan 的"规模版"。

import { researchFanout, type ResearchLens, type ResearchFanoutResult } from '../research/fanout';

/** 深度 council 默认镜头: 3 persona × 2 sub-angle = 6 gen leaf (多样 > 体积)。 */
export const DEFAULT_COUNCIL_DEEP_LENSES: readonly ResearchLens[] = [
  {
    key: 'mvp',
    persona: '代入务实的交付型工程主管',
    subAngles: [
      'MVP-first: 最小可行切口, 最快验证闭环, 砍非核心',
      '交付风险: 哪步最易拖延/返工, 如何前置消除',
    ],
  },
  {
    key: 'risk',
    persona: '代入资深 SRE + 安全工程师',
    subAngles: [
      '失败模式: 从不可逆点/边界倒推, 先堵风险',
      '运维面: 可观测 / 回滚 / 降级如何内建',
    ],
  },
  {
    key: 'first-principles',
    persona: '代入第一性原理思考者 (物理学家式)',
    subAngles: [
      '重构问题本质, 质疑既定前提, 找最简结构',
      '删除优先: 哪些需求/组件其实可以不做',
    ],
  },
];

/** 默认 M 个综合 framing。 */
export const DEFAULT_COUNCIL_DEEP_FRAMINGS = [
  { key: 'integrate', framing: '整合各镜头冠军的最优解 + 嫁接亚军独有亮点, 给一个可落地方案' },
  { key: 'minimal-risk', framing: '在覆盖核心目标前提下选风险最小、最可逆的路径' },
] as const;

/** 默认 K 个 judge 评判维度 (panel)。 */
export const DEFAULT_COUNCIL_DEEP_CRITERIA = [
  { key: 'correctness', criterion: '正确性: 是否真解决问题, 有无逻辑/事实漏洞' },
  { key: 'simplicity', criterion: '简洁性: 是否最小结构, 有无过度设计' },
  { key: 'risk', criterion: '风险: 失败模式/不可逆点/边界是否被覆盖' },
] as const;

export interface CouncilDeepOpts {
  /** sub-angle leaf 模型 (广度, 默认 deepseek flash)。 */
  lensModel?: string;
  /** judge/综合 模型 (推理, 默认 deepseek-v4-pro)。 */
  reasonModel?: string;
  /** 覆写镜头集 (默认 DEFAULT_COUNCIL_DEEP_LENSES)。 */
  lenses?: readonly ResearchLens[];
  /** 注入 researchFanout (测试 fake)。 */
  _researchFanout?: typeof researchFanout;
  onStage?: (stage: string, detail: string) => void;
}

/**
 * 深度 council: 从 plan 审议 context 构造默认 ResearchFanoutConfig → 跑 researchFanout。
 * = council 的"规模版"(L×V + judge panel + graft), 用于 foundational / 难逆决策。
 */
export async function councilDeepPlan(
  planContext: string,
  opts: CouncilDeepOpts = {},
): Promise<ResearchFanoutResult> {
  const run = opts._researchFanout ?? researchFanout;
  return run({
    question: planContext,
    groundTruth: planContext,
    lenses: [...(opts.lenses ?? DEFAULT_COUNCIL_DEEP_LENSES)],
    synthesisFramings: [...DEFAULT_COUNCIL_DEEP_FRAMINGS],
    judgeCriteria: [...DEFAULT_COUNCIL_DEEP_CRITERIA],
    lensModel: opts.lensModel ?? 'deepseek:deepseek-v4-flash',
    reasonModel: opts.reasonModel ?? BESTOFN_DEFAULT_MODEL,
    onStage: opts.onStage,
  });
}
