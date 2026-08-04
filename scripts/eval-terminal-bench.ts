#!/usr/bin/env bun
/**
 * eval-terminal-bench —— Terminal-Bench 2.1 / Frontier-Bench 的**任务面读数**(2026-08-05)。
 *
 * 现在只做**零成本的那一半**(不打模型、不要 Docker):任务分布 + **难度轴的诚实性检查**。
 * 选型经过与全部诚实边界见 `src/eval/tasks/terminal-bench/README.md`。
 *
 * 它回答的那个问题,是花钱之前必须先问的:
 * **引擎只读得到 `instruction.md` —— 那段文字里到底有没有「这活有多大」的信息?**
 * 没有的话,「引擎的图不随任务规模长」这种读数就不能算引擎的缺陷,
 * 而这个结论零模型调用就能拿到(本仓 2026-08-05 一天内靠同一招拦下三个坏实验)。
 *
 * 跑: bun run scripts/eval-terminal-bench.ts [--dataset terminal-bench-2.1|frontier-bench]
 */
import {
  loadTerminalBenchTasks,
  spearmanExpertVsInstructionLength,
  spearmanExpertVsJunior,
  withExpertTime,
  DATASETS,
  type DatasetId,
  type TerminalBenchTask,
} from '../src/eval/tasks/terminal-bench/tasks';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const tally = (xs: string[]): string =>
  Object.entries(xs.reduce<Record<string, number>>((a, x) => ({ ...a, [x || '(空)']: (a[x || '(空)'] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
const q = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
/** NaN 印成 `—` 并说明为什么没有,**不印 0** —— 「没这个读数」与「相关为 0」是两件事。 */
const fmt = (v: number, absent: string): string => (Number.isNaN(v) ? `— (${absent})` : v.toFixed(3));

function report(id: DatasetId, tasks: TerminalBenchTask[]): void {
  const ok = withExpertTime(tasks);
  const e = ok.map((t) => t.expertTimeMin!).sort((a, b) => a - b);
  const il = tasks.map((t) => t.instruction.length).sort((a, b) => a - b);
  console.log(`\n## ${id} — ${tasks.length} 题(有专家估时 ${ok.length})`);
  if (tasks[0]?.difficulty) console.log(`难度  ${tally(tasks.map((t) => t.difficulty))}`);
  console.log(`类别  ${tally(tasks.map((t) => t.category))}`);
  console.log(`专家估时(分钟): min ${e[0]} · p25 ${q(e, 0.25)} · median ${q(e, 0.5)} · p75 ${q(e, 0.75)} · max ${e[e.length - 1]}`);
  console.log(`instruction 字符: median ${q(il, 0.5)} · max ${il[il.length - 1]}`);
  console.log('');
  console.log(`  spearman(专家估时, 初级估时)      = ${fmt(spearmanExpertVsJunior(tasks), '本数据集无初级估时')}   ← 人类轴自洽度`);
  const sig = spearmanExpertVsInstructionLength(tasks);
  console.log(`  spearman(专家估时, instruction 长度) = ${fmt(sig, '无估时')}   ← **引擎看得到的信号**`);
  if (!Number.isNaN(sig) && sig < 0.4) {
    console.log('  ⚠ 弱 —— 任务文本几乎不携带"这活有多大"。**别在本数据集上问「引擎的图随任务规模长吗」**:');
    console.log('     量出来的平不是引擎的缺陷, 是它拿到的信息里本来就没有那个量(README 有分档表)。');
  }
  // 分档表 —— 相关系数是标量, 掩得住非单调; 分档能看出 Frontier-Bench 最难那档文本反而更短。
  console.log('\n  按估时分档看文本长度:');
  for (const [lo, hi, lab] of [[0, 120, '≤2h'], [121, 480, '2-8h'], [481, Number.MAX_SAFE_INTEGER, '>8h']] as const) {
    const g = ok.filter((t) => t.expertTimeMin! >= lo && t.expertTimeMin! <= hi);
    if (!g.length) continue;
    const mean = (xs: number[]): string => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0);
    console.log(`    ${lab.padEnd(5)} n=${String(g.length).padStart(2)} · 估时 mean ${mean(g.map((t) => t.expertTimeMin!)).padStart(4)}min · instruction mean ${mean(g.map((t) => t.instruction.length))} 字符`);
  }
}

const only = opt('dataset') as DatasetId | undefined;
for (const id of Object.keys(DATASETS) as DatasetId[]) {
  if (only && id !== only) continue;
  report(id, loadTerminalBenchTasks(id));
}
