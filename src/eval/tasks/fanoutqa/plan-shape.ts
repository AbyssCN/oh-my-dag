/**
 * 引擎自己画的图 vs 人写的金标 DAG —— **规划期结构探针**(2026-08-05)。
 *
 * ## 这一步为什么值得单独做
 *
 * 端到端读数说不清因果:图输了,可能是**拆错了**,也可能是**执行掉链子**。
 * FanOutQA 每题自带人写的分解(`decomposition` + `depends_on`),于是拆解那一层可以
 * 单独量 —— **不跑语料、不用 judge、不跑答案**,只打 conductor 那一发。
 *
 * ## ⚠ 头号陷阱:金标 DAG 是**事后图**,引擎画的是**事前图**
 *
 * 金标那 5 个并行子问题长这样:
 * ```
 *   [列出 1998 MLB draft 前五顺位]  ← level 0
 *      ├─ [Pat Burrell 的击球手别?]  ← level 1, 5 个并行
 *      ├─ [Mark Mulder 的击球手别?]
 *      └─ …
 * ```
 * **人是知道那五个名字之后才写得出这五个节点的。** 引擎在规划期不知道,也不该知道。
 *
 * → **所以「宽度对不对」不能直接比**。静态宽度 1(一个 lister + 一个运行时扇出节点)
 * 可能比静态宽度 5(规划期就把五个名字编出来)**更对**。照搬宽度当分数,
 * 会把唯一正确的做法判成最差的那个 —— 这正是本仓「代理指标不是它本身」那条的翻版。
 *
 * 能诚实比较的是**「引擎认没认出这里的清单要跑出来才知道」**,即它有没有选
 * `executor:'map'`(模板扇 N 份)或 `executor:'conductor'`(现场重画子图)。
 * 这两个 executor 存在的**全部理由**就是这个形状,所以这条探针同时也在问:
 * 我们造的那两个运行时扇出件,conductor 在最该用的时候用不用得上。
 *
 * ## 纪律
 *
 * 纯结构、零 IO、零模型、零词法启发(不看 goal 文本猜实体名 —— 那种判据自己就带噪声)。
 * 分类只读 `executor` 与 `depends_on` 拓扑,同一张 plan 判两次必同一格。
 * 反向自检见 `plan-shape.test.ts`:每一格都有一个已知样本证明它会亮。
 */
import type { ConductorPlan } from '../../../harness/conductor-plan';
import { dagShape, type DagShape } from './gold-dag';

/**
 * 算"扇出"的最小宽度。3 = 金标 dev 集 289/310 题的宽度下界(README 已核),
 * 也就是"这题真吃得到并行红利"的那条线;宽 2 只是两件事,不叫扇出。
 */
export const FANOUT_MIN_WIDTH = 3;

/** 运行时扇出 executor —— 规划期不知道清单时,唯二能表达"跑出来再展开"的两个。 */
const RUNTIME_FANOUT_EXECUTORS = new Set(['map', 'conductor']);

/**
 * 一张 plan 对「清单在规划期未知」这件事的**应对方式**。互斥且穷尽。
 *
 * - `runtime-fanout`   ∃ map/conductor 节点 → 认出了清单要跑出来才知道。**期望格**。
 * - `static-parallel-bound`   最宽层 ≥3 且在 level ≥1 → 并行**挂在上游节点之后**(拿得到清单),
 *   但份数在规划期就写死了。N 猜错就漏实体/空跑, 是"形状对了、数字靠运气"。
 * - `static-parallel-unbound` 最宽层 ≥3 且就在 level 0 → 并行**不依赖任何上游产出**,
 *   整批活在规划期就定死了。
 * - `chain`     节点 ≥3 但最宽层 ≤2 → 串成一条线, 并行红利放弃。
 * - `collapsed` 节点 ≤2 且无运行时扇出 → 基本没分解(等价于单 agent 多跑了一跳)。
 *
 * ## ⚠ `static-parallel-unbound` 这一格**同时装着两种完全不同的东西**(2026-08-05 读样本发现)
 *
 * 这一格最初叫 `static-parallel-guessed`,写着"规划期直接把实体名编出来了"。
 * 读第一个真样本就发现那是**过度声称**:那三个 level-0 并行节点是
 * 「赛事清单 / 人口清单 / 独立复核」**三个不同视角**,一个实体名都没编。
 *
 * 结构上这两种一模一样(都是 level 0 的 N 路并行、都不依赖上游):
 * ① 规划期编出 N 个实体名(危险:答案建在幻觉清单上);
 * ② N 路不同角度的独立调研再汇总(正当,而且是本引擎常见形状)。
 *
 * **靠结构分不开它们**,要分只能读 goal 文本(词法/LLM,都自带噪声)。
 * 所以这一格现在只声称它真正量到的那件事 —— **"并行不挂在任何上游产出之后"**。
 * 要判是哪一种:原始 plan 逐题落在 `.omd/eval/fanout-plan-shape/<id>.json`,人读一眼即可。
 */
export type PlanShapeClass =
  | 'runtime-fanout'
  | 'static-parallel-bound'
  | 'static-parallel-unbound'
  | 'chain'
  | 'collapsed';

export interface PlanShapeVerdict {
  cls: PlanShapeClass;
  /** 引擎这张图的形状(与金标同一把 `dagShape` 尺, 口径必须一致才谈得上"像不像")。 */
  shape: DagShape;
  /** 用了运行时扇出的节点 id(空 = 一个都没用)。 */
  runtimeFanoutNodes: string[];
  /** 最宽那一层的层号(0 起)。`static-parallel-*` 两格全靠它区分。 */
  widestLevelIndex: number;
}

/** plan 节点 → 与金标同形的 `{id, depends_on}`,好让两边共用同一个 `dagShape`。 */
function planTopology(plan: ConductorPlan): Array<{ id: string; question: string; depends_on?: string[] }> {
  return Object.entries(plan.nodes).map(([id, n]) => ({
    id,
    question: n.goal ?? '',
    ...(n.depends_on ? { depends_on: n.depends_on } : {}),
  }));
}

export function classifyPlanShape(plan: ConductorPlan): PlanShapeVerdict {
  const shape = dagShape(planTopology(plan));
  const runtimeFanoutNodes = Object.entries(plan.nodes)
    .filter(([, n]) => n.executor !== undefined && RUNTIME_FANOUT_EXECUTORS.has(n.executor))
    .map(([id]) => id);
  // 最宽层取**第一个**达到最大宽度的层 —— 并列时取浅的那个(浅层并行才是"规划期就定死"的证据)。
  const widestLevelIndex = shape.levelWidths.indexOf(shape.width);
  const base = { shape, runtimeFanoutNodes, widestLevelIndex };

  // 顺序有意义: 运行时扇出优先于宽度 —— 一张 [lister → map] 的 2 节点图, 按节点数是 `collapsed`,
  // 按语义却是唯一正确的答案。先判它, 别让节点数把它误杀。
  if (runtimeFanoutNodes.length > 0) return { ...base, cls: 'runtime-fanout' };
  if (shape.width >= FANOUT_MIN_WIDTH) {
    return { ...base, cls: widestLevelIndex === 0 ? 'static-parallel-unbound' : 'static-parallel-bound' };
  }
  if (shape.nodes <= 2) return { ...base, cls: 'collapsed' };
  return { ...base, cls: 'chain' };
}

/** 一批判决的分布(报告面)。 */
export type ShapeTally = Record<PlanShapeClass, number>;

export const EMPTY_TALLY: Readonly<ShapeTally> = Object.freeze({
  'runtime-fanout': 0,
  'static-parallel-bound': 0,
  'static-parallel-unbound': 0,
  chain: 0,
  collapsed: 0,
});

/** 只吃 `cls`(报告侧常常只留了这一列), 别逼调用方为了数个数把整个 verdict 背回来。 */
export function tally(verdicts: readonly Pick<PlanShapeVerdict, 'cls'>[]): ShapeTally {
  const t: ShapeTally = { ...EMPTY_TALLY };
  for (const v of verdicts) t[v.cls]++;
  return t;
}

/**
 * 扇出需求分档(轴 = `fanoutDemand` = max(金标宽, 答案键数),定义与两条反例见 gold-dag.ts)。
 *
 * ## ⚠ 一条我自己先踩了的坑,写在这里免得下一个人再踩
 *
 * 本来想拿**金标宽度**当梯度轴,理由是"FanOutQA 自己内部就有宽 1..45 的梯度,免费"。
 * 跑第一题就露馅:那题金标宽 1,而它的答案有 5 个键 —— **金标宽度量的是人写得多细**。
 * 换成 `fanoutDemand` 之后再看全集,得到本档真正该知道的一句:
 *
 * > **FanOutQA dev 里 `fanoutDemand ≤ 2` 的题只有 3 道,≤3 的只有 9 道(310 题中)。**
 * > 也就是说 **FanOutQA 内部根本没有"窄"的那一端**,拿它自己做梯度是自欺。
 *
 * → 交接 21 §五之三那条「窄档用 2Wiki `comparison`(宽 2)」**不是可选项而是必需品**:
 *   窄端只能从别的数据集来。本模块保留 `≤2` 那一档并**在报告里始终打印(哪怕 0 题)**,
 *   让"这里是空的"成为读得见的证据,而不是一行不存在的表格(NULL ≠ 0)。
 */
export const DEMAND_BUCKETS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: '需求 ≤2 (窄端: dev 仅 3 题, 只能靠 2Wiki 补)', lo: 0, hi: 2 },
  { label: '需求 3-4', lo: 3, hi: 4 },
  { label: '需求 5-7 (dev 主峰)', lo: 5, hi: 7 },
  { label: '需求 ≥8', lo: 8, hi: Number.MAX_SAFE_INTEGER },
];

export function bucketOf(demand: number): string {
  return DEMAND_BUCKETS.find((b) => demand >= b.lo && demand <= b.hi)?.label ?? DEMAND_BUCKETS[0]!.label;
}
