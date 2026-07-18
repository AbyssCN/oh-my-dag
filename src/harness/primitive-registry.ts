/**
 * core/primitive-registry —— 编排原语的**约束选择菜单**(SDD 0013 S1 · G1)。
 *
 * 现状:conductor 吐**自由 node-graph**,已建的 5 个 capped 原语(primitives.ts:
 * parallel/pipeline/loopUntil/adversarialVerify/judgePanel)只是库函数,靠调用方在外面包,
 * conductor **选不了**。本件把它们注册成 typed 菜单 —— conductor/Router 只输出 `{primitive, params}`,
 * 控制流逻辑(循环/分支/终止/解析)全封装在各原语的 `compile` 模板代码里(SEL-3),LLM 不碰。
 *
 * 不变量(SDD 0013 §2):
 *  SEL-1 约束选择:primitive ∈ REGISTRY 且 params 过 paramsSchema,否则 fail-closed(承 PLAN-2)。
 *  SEL-2 静态定界:compile 前由 params 编译期可算 maxUnits ≤ PRIMITIVE_UNIT_CAP(承 INV-1/INV-7)。
 *  SEL-3 控制流封装:LLM/Router 只给 {primitive, params};循环/终止只在 compile + primitives.ts。
 *  反幻觉:paramsSchema `.strict()` 拒未知键(conductor 塞 model 进 params → 拒;模型路由归 config)。
 */
import { z } from 'zod';
import type { ModelUsage } from '../model/gateway';
import type { ComplexitySignals } from './plan/complexity';
import { parallel, pipeline, loopUntil, adversarialVerify, judgePanel, type Verdict } from './primitives';
import { runDiscoveryLoop } from './plan/discovery';
import { runFixpoint } from './plan/fixpoint';

// S1 = parallel/pipeline/loop-until/verify/judge; S2 = discovery/iterate; S4 = tournament/router/race/escalation。
export type PrimitiveId =
  | 'parallel'
  | 'pipeline'
  | 'loop-until'
  | 'verify'
  | 'judge'
  | 'discovery'
  | 'iterate'
  | 'tournament'
  | 'router'
  | 'race'
  | 'escalation'
  | 'saga'
  | 'escape-hatch';

/** 静态定界硬顶(SEL-2):任何原语编译期 maxUnits 超此 → fail-closed。各 paramsSchema 已把参数收在此下。 */
export const PRIMITIVE_UNIT_CAP = 512;

/**
 * Router 的路由信号(承 plan/complexity.ts ComplexitySignals + 原语相关正交轴)。
 * 缺省全 false → Router 无匹配返 null → 降级 LLM Planner → 自由 node-graph(SEL-5 兜底)。
 */
export interface TaskSignals extends ComplexitySignals {
  /** 多个**独立**调查/子任务可并行无 handoff → parallel。 */
  parallelizableInvestigations?: boolean;
  /** 多个**同类条目**各需**多步**顺序处理 → pipeline。 */
  uniformMultiStepItems?: boolean;
  /** 累积产出到一个**目标数/阈值**才停 → loop-until。 */
  accumulateToTarget?: boolean;
  /** 有一个**待证伪的断言**需对抗校验 → verify。 */
  claimToRefute?: boolean;
  /** **宽解空间**多方案需 taste-judge 择优 → judge。 */
  wideSolutionSpace?: boolean;
  /** 发现物**总量/位置未知**,要穷尽召回(连续 K 轮无新增才停)→ discovery。 */
  unknownScaleRecall?: boolean;
  /** 单一产物需**反复打磨到达标**(judge 判收敛)→ iterate。 */
  refineUntilConverged?: boolean;
  /** **大候选池**需递归淘汰出冠军(bracket)→ tournament。 */
  largeCandidatePool?: boolean;
  /** 先**分类**再路由到对应子流 → router。 */
  needsClassificationRouting?: boolean;
  /** 多冗余备选,要**最快成功**的那个(投机)→ race。 */
  needsFastestOfAlternatives?: boolean;
  /** 廉价方案先试、不达标**逐级升级回退** → escalation。 */
  needsConditionalFallback?: boolean;
  /** 多步中途失败要**反向补偿回滚**(distributed-tx / saga)→ saga。 */
  needsCompensatingRollback?: boolean;
}

/** compile 拿到的执行上下文:leaf 工厂(单发模型调用,内部累加 usage)+ 上游依赖 + 并发默认。 */
export interface PrimitiveCtx {
  /** 跑一个单发 leaf(inproc 模型调用);返回文本,usage 内部累加。上游 dep 上下文由 executor 环境自动注入。 */
  leaf(req: { goal: string; persona?: string }): Promise<string>;
  /** 读累加的 usage(原语内部 parallel/judge 吞掉 usage,故经此侧信道回收)。 */
  usage(): ModelUsage;
  /** 本原语扇出并发上限(缺省继承 config.maxFanout / primitives 默认)。 */
  maxFanout?: number;
}

/** compile 的产物:静态上界 + 可执行闭包。 */
export interface PrimitiveInvocation {
  /** 编译期可算的最坏 leaf 执行次数(SEL-2)。 */
  maxUnits: number;
  /** 执行:跑原语,返回聚合输出 + usage。 */
  run(): Promise<{ output: string; usage: ModelUsage }>;
}

/** 一个参数化、可静态定界、compile 成子流的原语模板。 */
export interface PrimitiveTemplate<P> {
  id: PrimitiveId;
  /** Rule Router 谓词(确定性, 0 模型)。true = 此任务形状适配本原语。 */
  when(signals: TaskSignals): boolean;
  /** 参数 schema(必含硬上限;`.strict()` 拒未知键 = 反幻觉禁 model 字段)。 */
  paramsSchema: z.ZodType<P>;
  /**
   * 可选准入闸(compile 前跑)。返回非空字符串 = 拒用本原语并给理由(fail-closed)。
   * 用于 gated 原语(如逃生舱默认关)。缺省 = 恒可用。
   */
  gate?: () => string | null;
  /** 编译成可执行 invocation(控制流封装在此)。params 已过 schema。 */
  compile(params: P, ctx: PrimitiveCtx): PrimitiveInvocation;
}

// ── 解析 helper(把 leaf 文本解成原语要的结构;控制流/容错在模板代码,SEL-3)──

/** 从 leaf 文本剥出首个 JSON 对象(容 code fence + 前后散文)。失败返 null。 */
function extractJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const s = stripped.indexOf('{');
  const e = stripped.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(stripped.slice(s, e + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** verify verdict 解析:解不出 → refuted:true(承 primitives 契约"不确定即 refuted",crashed skeptic 不放行)。 */
function parseVerdict(text: string): Verdict {
  const j = extractJson(text);
  if (j && typeof j.refuted === 'boolean')
    return { refuted: j.refuted, reason: typeof j.reason === 'string' ? j.reason : undefined };
  return { refuted: true, reason: 'verdict 解析失败 → 保守判 refuted' };
}

/** judge 分数解析:解不出 → null(judgePanel 视 null 为最差,不误选)。 */
function parseScore(text: string): number {
  const j = extractJson(text);
  const v = j?.score;
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

/** 点路径取值(discovery keyBy 用):getPath({a:{b:1}}, 'a.b') → 1。 */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 从 leaf 文本剥出数组:优先 over 键 → 否则首个 JSON 数组。解不出 → [](本轮零发现,不 crash)。 */
function extractArray(text: string, over?: string): unknown[] {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  if (over) {
    const j = extractJson(stripped);
    const arr = j?.[over];
    if (Array.isArray(arr)) return arr;
  }
  const s = stripped.indexOf('[');
  const e = stripped.lastIndexOf(']');
  if (s >= 0 && e > s) {
    try {
      const arr = JSON.parse(stripped.slice(s, e + 1));
      if (Array.isArray(arr)) return arr;
    } catch {
      /* 落 [] */
    }
  }
  return [];
}

// ── 5 原语模板(零新原语:compile 全复用 primitives.ts)──────────────────────

interface ParallelParams {
  goals: string[];
  persona?: string;
}
const parallelTemplate: PrimitiveTemplate<ParallelParams> = {
  id: 'parallel',
  when: (s) => !!s.parallelizableInvestigations || (s.independentDomains ?? 0) >= 2 || !!s.trueParallelNoHandoff,
  paramsSchema: z
    .object({
      goals: z.array(z.string().min(1)).min(2, '至少 2 个并行子目标').max(64),
      persona: z.string().optional(),
    })
    .strict(),
  compile(params, ctx) {
    return {
      maxUnits: params.goals.length,
      run: async () => {
        const outs = await parallel(
          params.goals.map((g) => () => ctx.leaf({ goal: g, persona: params.persona })),
          { concurrency: ctx.maxFanout },
        );
        const output = JSON.stringify(outs.map((o, i) => ({ goal: params.goals[i], output: o ?? '[failed]' })));
        return { output, usage: ctx.usage() };
      },
    };
  },
};

interface PipelineParams {
  items: string[];
  stages: { goal: string }[];
}
const pipelineTemplate: PrimitiveTemplate<PipelineParams> = {
  id: 'pipeline',
  when: (s) => !!s.uniformMultiStepItems,
  paramsSchema: z
    .object({
      items: z.array(z.string().min(1)).min(1).max(32),
      stages: z.array(z.object({ goal: z.string().min(1) }).strict()).min(2, '至少 2 个阶段(单阶段用 parallel)').max(8),
    })
    .strict(),
  compile(params, ctx) {
    return {
      maxUnits: params.items.length * params.stages.length,
      run: async () => {
        const stageFns = params.stages.map((st) => async (prev: unknown, item: unknown) => {
          const ctxLine = prev === item ? '' : `\n\n<upstream>\n${String(prev)}\n</upstream>`;
          return ctx.leaf({ goal: `${st.goal}\n\n<item>${String(item)}</item>${ctxLine}` });
        });
        const outs = await pipeline(params.items, ...stageFns);
        const output = JSON.stringify(outs.map((o, i) => ({ item: params.items[i], output: o ?? '[failed]' })));
        return { output, usage: ctx.usage() };
      },
    };
  },
};

interface LoopUntilParams {
  stepGoal: string;
  /** 累积到此条数即停(done 谓词,控制流在模板)。 */
  target: number;
  /** well-founded 硬顶(承 INV-7)。缺省 100。 */
  maxIterations?: number;
}
const loopUntilTemplate: PrimitiveTemplate<LoopUntilParams> = {
  id: 'loop-until',
  when: (s) => !!s.accumulateToTarget,
  paramsSchema: z
    .object({
      stepGoal: z.string().min(1),
      target: z.number().int().positive().max(64),
      maxIterations: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  compile(params, ctx) {
    const maxIter = params.maxIterations ?? 100;
    return {
      maxUnits: Math.min(params.target, maxIter),
      run: async () => {
        const items = await loopUntil(
          () => ctx.leaf({ goal: params.stepGoal }),
          (acc) => acc.length >= params.target,
          { maxIterations: maxIter },
        );
        return { output: JSON.stringify(items), usage: ctx.usage() };
      },
    };
  },
};

interface VerifyParams {
  claim: string;
  /** 对抗校验者数(不同 lens);奇数利于多数决。缺省 3(给 lenses 时 = lenses 数)。 */
  n?: number;
  /** 显式攻击镜头(研究侧深化,S3):每个 lens 一个不同角度;缺省轮转内置 correctness/security/… */
  lenses?: string[];
}
const verifyTemplate: PrimitiveTemplate<VerifyParams> = {
  id: 'verify',
  when: (s) => !!s.claimToRefute || !!s.touchesSecurity,
  paramsSchema: z
    .object({
      claim: z.string().min(1),
      n: z.number().int().min(1).max(9).optional(),
      lenses: z.array(z.string().min(1)).min(1).max(9).optional(),
    })
    .strict(),
  compile(params, ctx) {
    const n = params.n ?? params.lenses?.length ?? 3;
    return {
      maxUnits: n,
      run: async () => {
        const survived = await adversarialVerify(
          params.claim,
          n,
          (lens) => async () =>
            parseVerdict(
              await ctx.leaf({
                goal: `以「${lens}」视角**尝试证伪**这个断言(不确定就判 refuted):\n${params.claim}\n\n只回 JSON: {"refuted": boolean, "reason": string}`,
              }),
            ),
          params.lenses,
        );
        return { output: JSON.stringify({ claim: params.claim, survived, verifiers: n }), usage: ctx.usage() };
      },
    };
  },
};

interface JudgeParams {
  attempts: number;
  attemptGoal: string;
  /** 单准则(向后兼容);给 criteria 时忽略。 */
  scoreCriterion?: string;
  /** 多准则(研究侧深化,S3):每候选按每准则各打一分求均,降单 judge 偏见(= research judgeCriteria)。 */
  criteria?: string[];
}
const judgeTemplate: PrimitiveTemplate<JudgeParams> = {
  id: 'judge',
  when: (s) => !!s.wideSolutionSpace,
  paramsSchema: z
    .object({
      attempts: z.number().int().min(2, '至少 2 个候选才需 judge').max(8),
      attemptGoal: z.string().min(1),
      scoreCriterion: z.string().min(1).optional(),
      criteria: z.array(z.string().min(1)).min(1).max(5).optional(),
    })
    .strict()
    .refine((p) => p.scoreCriterion || (p.criteria && p.criteria.length > 0), {
      message: 'judge 需 scoreCriterion 或 criteria 至少其一',
    }),
  compile(params, ctx) {
    const criteria = params.criteria ?? [params.scoreCriterion!];
    return {
      // attempts 产候选 + 每候选 criteria 数次评分(多准则去偏)。
      maxUnits: params.attempts + params.attempts * criteria.length,
      run: async () => {
        const attemptFns = Array.from({ length: params.attempts }, (_, i) => () =>
          ctx.leaf({ goal: `${params.attemptGoal}\n\n(独立第 ${i + 1} 稿,与其它稿走不同角度)` }),
        );
        const best = await judgePanel(attemptFns, (candidate) => async () => {
          // 多准则:各准则一发,求均(某准则解析失败 → 该准则 -inf 拉低,不静默忽略)。
          const scores = await Promise.all(
            criteria.map((c) =>
              ctx
                .leaf({ goal: `按标准「${c}」给下面候选打分(0-100):\n<candidate>${candidate}</candidate>\n\n只回 JSON: {"score": number}` })
                .then(parseScore),
            ),
          );
          const finite = scores.filter((v) => Number.isFinite(v));
          return finite.length ? finite.reduce((a, b) => a + b, 0) / criteria.length : Number.NEGATIVE_INFINITY;
        });
        return { output: JSON.stringify({ best, criteria }), usage: ctx.usage() };
      },
    };
  },
};

// ── S2:discovery + iterate(复用 runDiscoveryLoop / runFixpoint 控制流核)────

interface DiscoveryParams {
  roundGoal: string;
  /** lister 输出的数组键(缺省 = 直接吐 JSON 数组)。 */
  over?: string;
  /** 发现物身份键路径(去重用;缺省 = 元素归一化文本)。 */
  keyBy?: string;
  /** 连续 dry 轮数达此值 → 收敛。缺省 2。 */
  dryThreshold?: number;
  /** well-founded 硬顶。 */
  maxRounds: number;
}
const discoveryTemplate: PrimitiveTemplate<DiscoveryParams> = {
  id: 'discovery',
  when: (s) => !!s.unknownScaleRecall,
  paramsSchema: z
    .object({
      roundGoal: z.string().min(1),
      over: z.string().optional(),
      keyBy: z.string().optional(),
      dryThreshold: z.number().int().min(1).max(5).optional(),
      maxRounds: z.number().int().positive().max(20),
    })
    .strict(),
  compile(params, ctx) {
    return {
      maxUnits: params.maxRounds,
      run: async () => {
        const result = await runDiscoveryLoop<unknown>({
          input: params.roundGoal,
          maxRounds: params.maxRounds,
          dryThreshold: params.dryThreshold ?? 2,
          keyOf: (item) => {
            if (params.keyBy && item && typeof item === 'object') {
              const v = getPath(item, params.keyBy);
              if (v !== undefined && v !== null) return String(v).toLowerCase().replace(/\s+/g, '');
            }
            return (typeof item === 'string' ? item : JSON.stringify(item)).toLowerCase().replace(/\s+/g, '');
          },
          roundRunner: async (input) => {
            const text = await ctx.leaf({
              goal: `${input}\n\n只回 JSON${params.over ? `(含数组键 "${params.over}")` : ' 数组'},列出本轮发现项。`,
            });
            return extractArray(text, params.over);
          },
        });
        return {
          output: JSON.stringify({ items: result.items, status: result.status, converged: result.converged, rounds: result.rounds.length }),
          usage: ctx.usage(),
        };
      },
    };
  },
};

interface IterateParams {
  stepGoal: string;
  /** judge 收敛标准(达标即停)。 */
  convergeCriterion: string;
  /** well-founded 硬顶。缺省 3。 */
  maxRounds?: number;
}
const iterateTemplate: PrimitiveTemplate<IterateParams> = {
  id: 'iterate',
  when: (s) => !!s.refineUntilConverged,
  paramsSchema: z
    .object({
      stepGoal: z.string().min(1),
      convergeCriterion: z.string().min(1),
      maxRounds: z.number().int().positive().max(10).optional(),
    })
    .strict(),
  compile(params, ctx) {
    const maxRounds = params.maxRounds ?? 3;
    return {
      // 每轮 = 1 step leaf + 1 judge leaf。
      maxUnits: maxRounds * 2,
      run: async () => {
        const res = await runFixpoint<string>(
          params.stepGoal,
          async (input) => ctx.leaf({ goal: input }),
          async (result) => {
            const text = await ctx.leaf({
              goal: `按标准「${params.convergeCriterion}」判断下面结果是否已达标(收敛):\n<result>${result}</result>\n\n只回 JSON: {"converged": boolean, "failureReason": string}`,
            });
            const j = extractJson(text);
            return {
              converged: j?.converged === true,
              failureReason: typeof j?.failureReason === 'string' ? j.failureReason : undefined,
            };
          },
          { maxRounds },
        );
        return {
          output: JSON.stringify({ final: res.finalRound?.result ?? null, status: res.status, converged: res.converged, rounds: res.rounds.length }),
          usage: ctx.usage(),
        };
      },
    };
  },
};

// ── S4:新控制流原语 tournament / router / race / escalation ──────────────────

interface TournamentParams {
  attempts: number;
  attemptGoal: string;
  scoreCriterion: string;
  /** 每组淘汰赛的组大小(默认 3)。 */
  bracketSize?: number;
}
const tournamentTemplate: PrimitiveTemplate<TournamentParams> = {
  id: 'tournament',
  when: (s) => !!s.largeCandidatePool,
  paramsSchema: z
    .object({
      attempts: z.number().int().min(3, '<3 候选用 judge').max(32),
      attemptGoal: z.string().min(1),
      scoreCriterion: z.string().min(1),
      bracketSize: z.number().int().min(2).max(8).optional(),
    })
    .strict(),
  compile(params, ctx) {
    const k = params.bracketSize ?? 3;
    const rounds = Math.ceil(Math.log(params.attempts) / Math.log(k));
    return {
      // attempts 产候选 + 每轮至多 attempts 次评分(递归淘汰 rounds 轮)。
      maxUnits: params.attempts + params.attempts * rounds,
      run: async () => {
        // 1. 产候选。
        const produced = await parallel(
          Array.from({ length: params.attempts }, (_, i) => () =>
            ctx.leaf({ goal: `${params.attemptGoal}\n\n(独立第 ${i + 1} 稿,走不同角度)` }),
          ),
          { concurrency: ctx.maxFanout },
        );
        let bracket = produced.filter((c): c is string => c !== null);
        if (bracket.length === 0) return { output: JSON.stringify({ champion: null, note: '全候选失败' }), usage: ctx.usage() };
        // 2. 分组淘汰:每组 judgePanel 选冠 → 收winners → 直到剩 1(控制流在此)。
        while (bracket.length > 1) {
          const winners: string[] = [];
          for (let i = 0; i < bracket.length; i += k) {
            const group = bracket.slice(i, i + k);
            const win = await judgePanel(
              group.map((cand) => () => Promise.resolve(cand)),
              (candidate) => async () =>
                parseScore(await ctx.leaf({ goal: `按标准「${params.scoreCriterion}」给候选打分(0-100):\n<candidate>${candidate}</candidate>\n\n只回 JSON: {"score": number}` })),
            );
            winners.push(win);
          }
          bracket = winners;
        }
        return { output: JSON.stringify({ champion: bracket[0] }), usage: ctx.usage() };
      },
    };
  },
};

interface RouterParams {
  classifyGoal: string;
  branches: { label: string; goal: string }[];
}
const routerTemplate: PrimitiveTemplate<RouterParams> = {
  id: 'router',
  when: (s) => !!s.needsClassificationRouting,
  paramsSchema: z
    .object({
      classifyGoal: z.string().min(1),
      branches: z.array(z.object({ label: z.string().min(1), goal: z.string().min(1) }).strict()).min(2).max(8),
    })
    .strict(),
  compile(params, ctx) {
    return {
      maxUnits: 2, // 1 classify + 1 选中分支(其余分支不跑)。
      run: async () => {
        const labels = params.branches.map((b) => b.label);
        const clsText = await ctx.leaf({
          goal: `把任务分类到以下之一并只回该 label:${labels.join(' / ')}\n\n${params.classifyGoal}\n\n只回一个 label,别的不要。`,
        });
        const norm = clsText.trim().toLowerCase();
        const picked = params.branches.find((b) => norm.includes(b.label.toLowerCase()));
        if (!picked)
          // SEL-1 精神:分类落空 fail-closed(不静默乱选一支)。
          throw new Error(`router 分类未匹配任何分支 (返回='${clsText.slice(0, 60)}', labels=${labels.join('|')})`);
        const out = await ctx.leaf({ goal: picked.goal });
        return { output: JSON.stringify({ branch: picked.label, output: out }), usage: ctx.usage() };
      },
    };
  },
};

interface RaceParams {
  goals: string[];
}
const raceTemplate: PrimitiveTemplate<RaceParams> = {
  id: 'race',
  when: (s) => !!s.needsFastestOfAlternatives,
  paramsSchema: z
    .object({
      goals: z.array(z.string().min(1)).min(2, '至少 2 个备选').max(8),
    })
    .strict(),
  compile(params, ctx) {
    return {
      // 无真取消:全备选都会跑完(JS 不可 cancel),但只取首个成功者。上界 = goals 数。
      maxUnits: params.goals.length,
      run: async () => {
        try {
          const winner = await Promise.any(params.goals.map((g) => ctx.leaf({ goal: g })));
          return { output: JSON.stringify({ winner }), usage: ctx.usage() };
        } catch {
          throw new Error('race: 全部备选失败');
        }
      },
    };
  },
};

interface EscalationParams {
  /** 由廉价到强:逐级尝试的 goal(不含 model —— 模型路由归 config)。 */
  levels: { goal: string }[];
  acceptCriterion: string;
}
const escalationTemplate: PrimitiveTemplate<EscalationParams> = {
  id: 'escalation',
  when: (s) => !!s.needsConditionalFallback,
  paramsSchema: z
    .object({
      levels: z.array(z.object({ goal: z.string().min(1) }).strict()).min(2, '至少 2 级').max(6),
      acceptCriterion: z.string().min(1),
    })
    .strict(),
  compile(params, ctx) {
    return {
      // 每级 = 1 产出 leaf + 1 验收 judge leaf(最坏全跑)。
      maxUnits: params.levels.length * 2,
      run: async () => {
        let last = '';
        for (let i = 0; i < params.levels.length; i++) {
          last = await ctx.leaf({ goal: params.levels[i]!.goal });
          const verdict = await ctx.leaf({
            goal: `按标准「${params.acceptCriterion}」判断下面结果是否验收通过:\n<result>${last}</result>\n\n只回 JSON: {"accepted": boolean}`,
          });
          if (extractJson(verdict)?.accepted === true)
            return { output: JSON.stringify({ level: i + 1, accepted: true, output: last }), usage: ctx.usage() };
        }
        // 全级不达标:返回末级 best-effort(显式 accepted:false,不假报通过)。
        return { output: JSON.stringify({ level: params.levels.length, accepted: false, output: last }), usage: ctx.usage() };
      },
    };
  },
};

// ── S5:Saga / Compensation(通用补偿回滚控制流)──────────────────────────────
//
// ⚠️ 维二红线(D-SAGA-1,Nick 2026-07-11 grill 裁定 A):这是纯**非-statutory** 通用 distributed-tx
// 补偿编排(外部集成/开通/agent 副作用的逆序回滚),**不含会计语义、不碰 KPL/command、不用于会计过账**。
// 每步给 {goal, compensateGoal};中途失败 → 已完成步的 compensateGoal **反向**逐个跑。
// 会计多步事务性/回滚全留领域 command(reverseWageBatch/reverseMaksuperusteVatOnCredit/korvaava ilmoitus);
// 会计修改走 proposal→verifier→command(KPL append-only 改错靠冲销不靠 DELETE),agent 输出不直接成 statutory truth。

interface SagaStep {
  goal: string;
  /** 本步失败回滚时跑的补偿意图(维二场景:冲销,非删除)。 */
  compensateGoal: string;
}
interface SagaParams {
  steps: SagaStep[];
}
const sagaTemplate: PrimitiveTemplate<SagaParams> = {
  id: 'saga',
  when: (s) => !!s.needsCompensatingRollback,
  paramsSchema: z
    .object({
      steps: z
        .array(z.object({ goal: z.string().min(1), compensateGoal: z.string().min(1) }).strict())
        .min(2, 'saga 至少 2 步(单步无需补偿)')
        .max(16),
    })
    .strict(),
  compile(params, ctx) {
    return {
      // 最坏:全 N 步前向 + 全 N 步补偿。
      maxUnits: params.steps.length * 2,
      run: async () => {
        const outputs: { step: number; ok: boolean; output: string }[] = [];
        const done: number[] = [];
        let failedAt = -1;
        // 前向:每步自报 {ok, output};遇 !ok(或抛)即停并触发回滚。
        for (let i = 0; i < params.steps.length; i++) {
          let ok = false;
          let output = '';
          try {
            const text = await ctx.leaf({ goal: `${params.steps[i]!.goal}\n\n只回 JSON: {"ok": boolean, "output": string}` });
            const j = extractJson(text);
            ok = j?.ok === true;
            output = typeof j?.output === 'string' ? j.output : text;
          } catch (e) {
            ok = false;
            output = `[step 抛错: ${e instanceof Error ? e.message : String(e)}]`;
          }
          outputs.push({ step: i + 1, ok, output });
          if (!ok) {
            failedAt = i;
            break;
          }
          done.push(i);
        }
        // 补偿:已完成步**反向**逐个跑 compensateGoal(顺序即回滚正确性)。
        const compensated: { step: number; output: string }[] = [];
        if (failedAt >= 0) {
          for (const i of [...done].reverse()) {
            const c = await ctx.leaf({ goal: params.steps[i]!.compensateGoal });
            compensated.push({ step: i + 1, output: c });
          }
        }
        return {
          output: JSON.stringify({ outputs, failedAt: failedAt >= 0 ? failedAt + 1 : null, compensated, rolledBack: failedAt >= 0 }),
          usage: ctx.usage(),
        };
      },
    };
  },
};

// ── S6:capped 逃生舱(gated 默认关,last-resort 硬 backstop)──────────────────

/** 逃生舱开关 env。默认关 —— 结构原语选不出时的最后手段,不做易走的路(D61-2)。 */
export const ESCAPE_HATCH_ENV = 'OMD_ESCAPE_HATCH';
function escapeHatchEnabled(): boolean {
  const v = process.env[ESCAPE_HATCH_ENV];
  return v === '1' || v === 'true';
}

interface EscapeHatchParams {
  /** 有界命令式步序(每步一个 leaf,可读前序累积)。 */
  steps: { goal: string }[];
  /** 为何结构原语不够用(审计,强制说明)。 */
  reason: string;
}
const escapeHatchTemplate: PrimitiveTemplate<EscapeHatchParams> = {
  id: 'escape-hatch',
  // Router **永不**自动选(gated 硬 backstop,只显式 conductor/Aalto 选)。
  when: () => false,
  gate: () => (escapeHatchEnabled() ? null : `逃生舱默认关,需 env ${ESCAPE_HATCH_ENV}=1 显式开启`),
  paramsSchema: z
    .object({
      steps: z.array(z.object({ goal: z.string().min(1) }).strict()).min(1).max(12), // capped 步数
      reason: z.string().min(1, '逃生舱须说明为何结构原语不够'),
    })
    .strict(),
  compile(params, ctx) {
    return {
      maxUnits: params.steps.length,
      run: async () => {
        // 命令式顺序:每步看前序累积输出(共享 accumulator);capped 步数,well-founded。
        const outputs: string[] = [];
        for (let i = 0; i < params.steps.length; i++) {
          const prior = outputs.length ? `\n\n<prior-steps>\n${outputs.map((o, k) => `[step ${k + 1}]\n${o}`).join('\n\n')}\n</prior-steps>` : '';
          outputs.push(await ctx.leaf({ goal: `${params.steps[i]!.goal}${prior}` }));
        }
        return { output: JSON.stringify({ reason: params.reason, steps: outputs }), usage: ctx.usage() };
      },
    };
  },
};

/**
 * 注册的原语菜单。Router `when` 优先级 = 此数组顺序(首命中即选)。
 * S1 = parallel/pipeline/loop-until/verify/judge;S2 = discovery/iterate;S4 = tournament/router/race/escalation;
 * S6 = escape-hatch(gated 默认关,when 恒 false 不自动路由)。
 * map 是运行时动态扇出,已 first-class(`executor:'map'` 节点,见 conductor-plan)—— 不重复注册。
 */
export const PRIMITIVE_TEMPLATES: readonly PrimitiveTemplate<never>[] = [
  parallelTemplate,
  pipelineTemplate,
  loopUntilTemplate,
  verifyTemplate,
  judgeTemplate,
  discoveryTemplate,
  iterateTemplate,
  tournamentTemplate,
  routerTemplate,
  raceTemplate,
  escalationTemplate,
  sagaTemplate,
  escapeHatchTemplate,
] as unknown as readonly PrimitiveTemplate<never>[];

export const PRIMITIVE_REGISTRY: Record<PrimitiveId, PrimitiveTemplate<never>> = {
  parallel: parallelTemplate as unknown as PrimitiveTemplate<never>,
  pipeline: pipelineTemplate as unknown as PrimitiveTemplate<never>,
  'loop-until': loopUntilTemplate as unknown as PrimitiveTemplate<never>,
  verify: verifyTemplate as unknown as PrimitiveTemplate<never>,
  judge: judgeTemplate as unknown as PrimitiveTemplate<never>,
  discovery: discoveryTemplate as unknown as PrimitiveTemplate<never>,
  iterate: iterateTemplate as unknown as PrimitiveTemplate<never>,
  tournament: tournamentTemplate as unknown as PrimitiveTemplate<never>,
  router: routerTemplate as unknown as PrimitiveTemplate<never>,
  race: raceTemplate as unknown as PrimitiveTemplate<never>,
  escalation: escalationTemplate as unknown as PrimitiveTemplate<never>,
  saga: sagaTemplate as unknown as PrimitiveTemplate<never>,
  'escape-hatch': escapeHatchTemplate as unknown as PrimitiveTemplate<never>,
};

export const PRIMITIVE_IDS = Object.keys(PRIMITIVE_REGISTRY) as PrimitiveId[];

/**
 * 校验 + 编译一个 primitive 节点(SEL-1 fail-closed + SEL-2 静态定界)。
 * @returns ok:invocation | error:原因(executor 据此 fail-closed,不静默降范围)。
 */
export function compilePrimitive(
  primitive: string,
  params: unknown,
  ctx: PrimitiveCtx,
): { ok: true; invocation: PrimitiveInvocation } | { ok: false; error: string } {
  const tmpl = PRIMITIVE_REGISTRY[primitive as PrimitiveId];
  if (!tmpl) return { ok: false, error: `未知原语 '${primitive}'(∉ ${PRIMITIVE_IDS.join('|')})` };
  // gated 原语准入闸(如逃生舱默认关):拒则 fail-closed。
  const gateReason = tmpl.gate?.();
  if (gateReason) return { ok: false, error: `原语 '${primitive}' 被闸拒: ${gateReason}` };
  const parsed = tmpl.paramsSchema.safeParse(params);
  if (!parsed.success)
    return { ok: false, error: `原语 '${primitive}' params 非法: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  const invocation = tmpl.compile(parsed.data as never, ctx);
  if (invocation.maxUnits > PRIMITIVE_UNIT_CAP)
    return { ok: false, error: `原语 '${primitive}' 静态定界 ${invocation.maxUnits} > 硬顶 ${PRIMITIVE_UNIT_CAP}(SEL-2)` };
  return { ok: true, invocation };
}
