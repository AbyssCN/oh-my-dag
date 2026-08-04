/**
 * FanOutQA 金标 DAG —— 把「人是怎么拆这道题的」变成可比较的结构(2026-08-04)。
 *
 * ## 它为什么值钱
 *
 * FanOutQA 的每道题都带一份**人写的分解**(`decomposition`,子问题 + `depends_on` 边)。
 * 于是我们第一次有了一个**不需要语料、不需要 judge、不需要跑答案**就能回答的问题:
 * **引擎自己拆的图,和人拆的图,像不像?**
 *
 * 这条很要紧,因为端到端读数说不清因果:图输了,可能是分解拆错了,也可能是执行掉链子。
 * 拆一层出来单独量,两种因就分得开了(承 WorFBench 的做法:直接判图结构对不对,
 * 而不是判最终答案对不对)。
 *
 * ## 纪律
 *
 * 本模块**纯结构、零 IO、零模型**。答案判分**不在这里**,而且**不许在 TS 里近似重写** ——
 * 官方 `normalize` 用 spaCy 词形还原 + ftfy,近似重写出来的数与排行榜不可比,
 * 那正是「自己造一把没人用过的尺子」。要判答案就调官方 Python 实现(见 README)。
 */

/** 数据集里一条子问题(原始形状;`depends_on` 指向同题内其它子问题的 id)。 */
export interface FanOutSubQuestion {
  id: string;
  question: string;
  depends_on?: string[];
  answer?: unknown;
  evidence?: unknown;
}

/** dev 集一道题(test 集无 `answer`)。 */
export interface FanOutQuestion {
  id: string;
  question: string;
  categories?: string[];
  decomposition: FanOutSubQuestion[];
  answer?: unknown;
}

/** 一张分解图的形状读数。 */
export interface DagShape {
  /** 子问题数。 */
  nodes: number;
  /** 层数(按 depends_on 拓扑分层;无依赖 = 第 0 层)。 */
  depth: number;
  /** 最宽一层的节点数 —— 「扇出宽度」。 */
  width: number;
  /** 每层宽度,自浅到深。 */
  levelWidths: number[];
  /** 依赖边数。 */
  edges: number;
}

/**
 * 拓扑分层。**指向题外/不存在 id 的依赖按"已满足"处理**(与引擎 `topoLevels` 对幻象 dep
 * 的口径一致 —— 两边口径不同的话,「像不像」这个比较本身就不成立)。
 * 环(数据里不该有,防御性)→ 该节点按已见深度截断,不挂死。
 */
export function dagShape(subs: readonly FanOutSubQuestion[]): DagShape {
  const byId = new Map(subs.map((s) => [s.id, s]));
  const level = new Map<string, number>();
  const depsOf = (s: FanOutSubQuestion): string[] => (s.depends_on ?? []).filter((d) => byId.has(d));

  const levelOf = (id: string, seen: ReadonlySet<string>): number => {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // 环:截断
    const deps = depsOf(byId.get(id)!);
    const v = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => levelOf(d, new Set([...seen, id]))));
    level.set(id, v);
    return v;
  };
  for (const s of subs) levelOf(s.id, new Set());

  const counts = new Map<number, number>();
  for (const v of level.values()) counts.set(v, (counts.get(v) ?? 0) + 1);
  const depth = counts.size;
  const levelWidths = [...Array(depth).keys()].map((i) => counts.get(i) ?? 0);
  return {
    nodes: subs.length,
    depth,
    width: levelWidths.length ? Math.max(...levelWidths) : 0,
    levelWidths,
    edges: subs.reduce((n, s) => n + depsOf(s).length, 0),
  };
}

/** 一批题的形状分布(选题、定基线、以及"引擎拆得像不像"的对照面)。 */
export interface ShapeStats {
  count: number;
  meanWidth: number;
  medianWidth: number;
  meanDepth: number;
  /** 宽度 ≥ k 的题数(k = 3 / 5)。 */
  wideAtLeast3: number;
  wideAtLeast5: number;
}

export function shapeStats(questions: readonly FanOutQuestion[]): ShapeStats {
  const shapes = questions.map((q) => dagShape(q.decomposition ?? []));
  const widths = shapes.map((s) => s.width).sort((a, b) => a - b);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    count: questions.length,
    meanWidth: mean(shapes.map((s) => s.width)),
    medianWidth: widths.length ? widths[Math.floor(widths.length / 2)]! : 0,
    meanDepth: mean(shapes.map((s) => s.depth)),
    wideAtLeast3: shapes.filter((s) => s.width >= 3).length,
    wideAtLeast5: shapes.filter((s) => s.width >= 5).length,
  };
}

/**
 * 答案的**判分点数** —— 这是选 FanOutQA 的核心理由,所以要能算得出来。
 *
 * dict 答案的每个键独立判定 → 一道题贡献 N 个读数点。实测 dev 的 274/310 题是 dict、
 * 平均 5.45 键 → 抽 40 题 ≈ 218 个判分点,而手搓的 F2 跑三对只有 24 个。
 * **样本量小的时候,判分点密度比题数更决定读数能不能穿透噪声。**
 */
export function scoringPoints(answer: unknown): number {
  if (answer === null || answer === undefined) return 0;
  if (Array.isArray(answer)) return answer.length;
  if (typeof answer === 'object') return Object.keys(answer as Record<string, unknown>).length;
  return 1; // str / int / bool = 单点
}
