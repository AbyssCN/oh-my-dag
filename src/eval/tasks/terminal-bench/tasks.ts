/**
 * Terminal-Bench 2.1 —— 任务面 + **难度轴的诚实性检查**(2026-08-05)。
 *
 * ## 为什么引它
 *
 * owner 定的方向(2026-08-05):SWE-bench Verified 的判分 oracle 极好(仓库自己的测试),
 * 但它奖励的是 **code-completion 式编辑**,而且已发表数据里多 agent 系统性输给单 agent
 * (arXiv 2506.17208:Verified 上 G4「scaffold+单 agent」中位 55% vs G5「scaffold+多 agent」40.6%),
 * 加上 SOTA 已近饱和 —— 去跑基本是复现别人的结论。
 * Terminal-Bench 奖励的是**不确定性下的多步推进**(每条命令的输出决定下一步),
 * 那才是编排该赢的形状。
 *
 * 判分同样确定:测试查的是**容器最终状态**,不查 agent 的命令或输出,零 judge。
 *
 * ## ⚠ 它不满足我们「≥200 题」那条硬要求
 *
 * 只有 **89 题**。对**结构探针**(只看 conductor 画的图)绰绰有余;
 * 对 **pass-rate 的统计功效不够** —— 别拿 89 题去读几个百分点的差。
 * 顺带一提:Terminal-Bench 官方排行榜**要求每题至少 5 次 trial** 才收投稿 ——
 * 那是外部独立证据,和本仓交接 23 量到的「n=1 结构读数是噪声」完全一致。
 *
 * ## ⚠⚠ 本模块最要紧的一句:**任务文本几乎不携带"这活有多大"的信息**
 *
 * `expert_time_estimate_min` 跨度 5–2400 分钟(480 倍),而引擎**只读得到 `instruction.md`**。
 * 实测(`spearmanExpertVsInstructionLength`,零模型调用):
 *
 * | | Spearman |
 * |---|---|
 * | 专家估时 vs 初级估时 | **0.850** — 人类难度轴自身自洽 |
 * | 专家估时 vs instruction 字节 | **0.175** — 引擎看得到的信号几乎没有 |
 *
 * 按难度:easy 23 分钟 / 578B → hard 504 分钟 / 1180B。**时间涨 22 倍,文本只涨 2 倍。**
 *
 * → **所以在 Terminal-Bench 上不能问「引擎的图随任务规模长吗」**:量出来的平不是引擎的缺陷,
 * 是它拿到的信息里本来就没有那个量。这与交接 22 §二那两条同族 ——
 * **都是"轴看起来现成,其实量的是别的东西"**,而且都在花钱之前查出来了。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TerminalBenchTask {
  id: string;
  name: string;
  description: string;
  /** easy / medium / hard(贡献者标, 三名评审核过)。 */
  difficulty: string;
  category: string;
  /** 专家完成估时(分钟)。缺席 = null, **不是 0**(仓规第一条)。 */
  expertTimeMin: number | null;
  juniorTimeMin: number | null;
  /** 任务全文 —— **引擎能看到的全部**。 */
  instruction: string;
}

/** 两代数据集。**分开存不合并** —— 合并之后就再也说不清某个读数来自哪一代了。 */
export const DATASETS = {
  'terminal-bench-2.1': 'terminal-bench-2.1.json',
  'frontier-bench': 'frontier-bench.json',
} as const;
export type DatasetId = keyof typeof DATASETS;

export function loadTerminalBenchTasks(dataset: DatasetId = 'terminal-bench-2.1'): TerminalBenchTask[] {
  return JSON.parse(readFileSync(join(import.meta.dir, 'data', DATASETS[dataset]), 'utf8')) as TerminalBenchTask[];
}

// ── 统计小件(与 fanoutqa 侧同口径, 刻意不共用: 那边是 Pearson, 这边必须 Spearman)──

/**
 * 秩,**并列取平均秩**(mid-rank)。
 *
 * ⚠ 初版按"排序后的下标"给秩, 并列由排序稳定性任意决定 —— 而专家估时正是
 * `5/15/30/60/180/480` 这种粗刻度, 并列极多。后果是 `spearman(x, -x)` 算出 **−0.977 而不是 −1**,
 * 也就是这把尺子连"完美反相关"都量不准, 报出去的 0.175/0.234 自然也带着同一份偏差。
 * 是反向自检那条闸把它抓出来的(仓规:每条闸都要证明它真的会红)。
 */
function midRank(vs: readonly number[]): number[] {
  const order = vs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(vs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + j) / 2; // 并列区间 [i, j] 共享平均秩
    for (let k = i; k <= j; k++) r[order[k]![1]] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * Spearman 秩相关。**这里不能用 Pearson**:专家估时是 5..2400 的重尾分布,
 * Pearson 会被 2400 那几个点绑架, 报出一个由三四个样本决定的数。
 */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 3) return Number.NaN;
  const [rx, ry] = [midRank(xs), midRank(ys)];
  const n = rx.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  const cov = rx.reduce((a, x, i) => a + (x - mx) * (ry[i]! - my), 0);
  const sx = Math.sqrt(rx.reduce((a, x) => a + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ry.reduce((a, y) => a + (y - my) ** 2, 0));
  return sx === 0 || sy === 0 ? Number.NaN : cov / (sx * sy);
}

/**
 * 有专家估时的任务。
 *
 * ⚠ **刻意只要 expert, 不连坐 junior**(2026-08-05 修): 初版要求两个估时都在,
 * 而 **Frontier-Bench 的 74 题一个初级估时都没有** —— 于是 FB 侧被静默滤成空集,
 * 相关系数返回 `NaN`、`Math.max` 返回 `-Infinity`。
 * 更糟的是:我先前报出的 FB 读数 0.234 来自一个只要 expert 的临时脚本,
 * **入仓的代码算出来却是 NaN** —— 报告的数与代码的数对不上, 而且没人会发现。
 * 是把这个数钉成测试才抓到的(仓规:静默失效靠另一列分辨, 不靠猜)。
 */
export function withExpertTime(tasks: readonly TerminalBenchTask[]): TerminalBenchTask[] {
  return tasks.filter((t) => t.expertTimeMin !== null);
}

/** 两个估时都在的任务 —— 只有「人类轴自洽度」这一个读数需要它。 */
export function withBothTimeEstimates(tasks: readonly TerminalBenchTask[]): TerminalBenchTask[] {
  return tasks.filter((t) => t.expertTimeMin !== null && t.juniorTimeMin !== null);
}

/**
 * 人类难度轴自身的自洽度(阳性对照的对照)。
 * **数据集没有初级估时时返回 NaN**, 不返回 0 —— 「没有这个读数」与「相关为 0」是两件事。
 */
export function spearmanExpertVsJunior(tasks: readonly TerminalBenchTask[]): number {
  const ok = withBothTimeEstimates(tasks);
  return spearman(ok.map((t) => t.expertTimeMin!), ok.map((t) => t.juniorTimeMin!));
}

/**
 * **引擎看得到多少「这活有多大」的信号** —— 任务规模 vs 任务文本长度。
 * 低 = 规划者从文本里读不出规模, 于是"图不随规模长"不能算它的错。
 */
export function spearmanExpertVsInstructionLength(tasks: readonly TerminalBenchTask[]): number {
  const ok = withExpertTime(tasks);
  return spearman(ok.map((t) => t.expertTimeMin!), ok.map((t) => t.instruction.length));
}
