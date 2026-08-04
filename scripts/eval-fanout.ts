#!/usr/bin/env bun
/**
 * scripts/eval-fanout —— FanOutQA bench 入口(2026-08-04 起,替换手搓的 F2 探针)。
 *
 * 选型理由与全部诚实边界见 `src/eval/tasks/fanoutqa/README.md`。一句话:
 * F2 是我们自己搓的 8 题关键词匹配探针,一整天在它上面查出七个缺陷,学到的几乎全是关于**尺子**
 * 的事。FanOutQA 是公开 benchmark,而且**数据里自带人写的金标 DAG** —— 于是有了一件此前做不到的事:
 * **不跑语料、不用 judge,就能量「引擎自己拆的图 vs 人拆的图」**。
 *
 * 本脚本目前只做**不烧钱的那半**(结构侧),答案侧留给后续:
 *   --stats               金标 DAG 形状分布(选型理由的读数面)
 *   --sample N [--seed S] 确定性抽样 N 题, 打印题面 + 金标宽度(喂两臂用)
 *
 * ⚠ **答案判分刻意不在这里做**:官方 `normalize` 用 spaCy 词形还原 + ftfy,
 * 在 TS 里近似重写会造出一把没人用过的尺子、与排行榜数字不可比 —— 那正是我们批评 FRAMES 的那条。
 * 要判答案就装官方包走 Python(README 有命令)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dagShape, scoringPoints, shapeStats, type FanOutQuestion } from '../src/eval/tasks/fanoutqa/gold-dag';

const DATA_DIR = join(import.meta.dir, '..', 'src', 'eval', 'tasks', 'fanoutqa', 'data');
const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dev = (): FanOutQuestion[] =>
  JSON.parse(readFileSync(join(DATA_DIR, 'fanout-final-dev.json'), 'utf8')) as FanOutQuestion[];

/** 确定性抽样(同 seed 同结果 —— 实验要能复跑,随机抽样不写 seed 等于没抽)。 */
function sample<T>(xs: readonly T[], n: number, seed: number): T[] {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const idx = [...xs.keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, n).map((i) => xs[i]!);
}

if (import.meta.main) {
  if (argv.includes('--stats')) {
    const qs = dev();
    const s = shapeStats(qs);
    const pts = qs.reduce((n, q) => n + scoringPoints(q.answer), 0);
    console.log(`FanOutQA dev: ${s.count} 题`);
    console.log(`  扇出宽度: mean ${s.meanWidth.toFixed(2)} · median ${s.medianWidth} · ≥3 的 ${s.wideAtLeast3} · ≥5 的 ${s.wideAtLeast5}`);
    console.log(`  深度: mean ${s.meanDepth.toFixed(2)}`);
    console.log(`  判分点合计 ${pts} (抽 40 题 ≈ ${Math.round((pts / s.count) * 40)} 点; 对照: 手搓 F2 跑三对仅 24 点)`);
  } else if (argv.includes('--sample')) {
    const n = Number(opt('sample') ?? '10');
    const seed = Number(opt('seed') ?? '20260804');
    for (const q of sample(dev(), n, seed)) {
      const sh = dagShape(q.decomposition ?? []);
      console.log(`[${q.id}] 金标宽 ${sh.width} 深 ${sh.depth} · 判分点 ${scoringPoints(q.answer)}\n  ${q.question}`);
    }
  } else {
    console.error('用法: --stats | --sample N [--seed S]');
    process.exit(2);
  }
}
