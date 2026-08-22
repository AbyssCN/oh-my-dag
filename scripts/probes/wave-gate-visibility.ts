/**
 * scripts/probes/wave-gate-visibility —— 波级闸预研的那把尺子(零 LLM, 纯读账本)。
 *
 *   bun run scripts/probes/wave-gate-visibility.ts [--db <path>]
 *
 * 问题(owner 2026-08-14):gate 下沉到波级能省掉多少「注定失败轮」的后续叶子消耗?
 * 判据拆成四个数,**每个数单独可证伪**:
 *   ① 召回   —— 被判没达成的多波图里, 第一波就已有 failed 节点的比例;
 *   ② 精度   —— 第一波有 failed 节点的图里最后其实成功了的比例(= 误杀率);
 *   ③ 真省   —— 命中图里, 第一波之后**真跑了**(status=done)的节点数。
 *                ⚠ 与 `skipped` 分开算: 被依赖 quorum 跳过的那些今天就没烧, 闸省不到它们。
 *   ④ 孤儿   —— failed 节点不在任何 level 里(replan 增删)→ 波级闸按定义看不见。
 *
 * 结论与解读见 `docs/plan/2026-08-14-wave-gate-预研.md`。
 */
import { Database } from 'bun:sqlite';
import { ledgerPath } from '../../src/harness/dag/dag-record';

const argv = process.argv.slice(2);
const dbPath = argv.includes('--db') ? argv[argv.indexOf('--db') + 1]! : ledgerPath();

/** 判为「没达成」的终态。infra-error / cancelled 不进分母 —— 它们不是判出来的。 */
const REJECT = new Set(['not-converged', 'blocked', 'missing-capability']);

interface Row { outcome: string | null; levels: string; nodes: string }
const db = new Database(dbPath, { readonly: true });
const rows = db.query(`SELECT outcome, levels, nodes FROM omd_dag_runs`).all() as Row[];

interface Graph { oc: string; waves: number; n: number; w0: boolean; doneAfter: number; skipAfter: number; orphan: number }
const pop: Graph[] = [];
for (const r of rows) {
  let levels: string[][], nodes: { id: string; status?: string }[];
  try {
    levels = JSON.parse(r.levels);
    nodes = JSON.parse(r.nodes);
  } catch {
    continue;
  }
  if (levels.length < 2 || !r.outcome) continue;
  if (!REJECT.has(r.outcome) && r.outcome !== 'success') continue;
  const waveOf = new Map<string, number>();
  levels.forEach((lvl, w) => lvl.forEach((id) => waveOf.set(id, w)));
  const failed = nodes.filter((n) => n.status === 'failed');
  pop.push({
    oc: r.outcome,
    waves: levels.length,
    n: nodes.length,
    w0: failed.some((f) => waveOf.get(f.id) === 0),
    doneAfter: nodes.filter((n) => (waveOf.get(n.id) ?? 99) > 0 && n.status === 'done').length,
    skipAfter: nodes.filter((n) => (waveOf.get(n.id) ?? 99) > 0 && n.status === 'skipped').length,
    orphan: failed.filter((f) => !waveOf.has(f.id)).length,
  });
}
db.close();

const rej = pop.filter((p) => REJECT.has(p.oc));
const hit = rej.filter((p) => p.w0);
const allW0 = pop.filter((p) => p.w0);
const sucW0 = allW0.filter((p) => p.oc === 'success');
const sucAny = pop.filter((p) => p.oc === 'success');
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
const pct = (a: number, b: number): string => (b === 0 ? 'n/a (分母 0)' : `${((a / b) * 100).toFixed(0)}%`);

console.log(`账本: ${dbPath}`);
console.log(`分母: 多波(≥2) ∧ 判出来的终态图 ${pop.length} 张 (rejected ${rej.length} / success ${sucAny.length})\n`);
console.log(`① 召回: ${hit.length}/${rej.length} = ${pct(hit.length, rej.length)} 的 rejected 图, 第一波就已有 failed 节点`);
console.log(`② 误杀: ${sucW0.length}/${allW0.length} = ${pct(sucW0.length, allW0.length)} 的「第一波有 failed」图最终其实成功`);
console.log(`   ⚠ 先看这个数再读上一行: 全体多波 success 图 ${sucAny.length} 张里, 含**任何** failed 节点的有 ${countSuccWithFailed()} 张。`);
console.log(`      若为 0, 则「精度」是账本语义的恒等式(failed ⟺ 图没成功), **不是**闸不会误杀的证据。`);
console.log(`③ 真省: 命中图第一波之后 done ${sum(hit.map((p) => p.doneAfter))} 节点 (中位 ${median(hit.map((p) => p.doneAfter))}, ${hit.filter((p) => p.doneAfter === 0).length}/${hit.length} 张省 0)`);
console.log(`   同期被依赖 quorum 跳过的 ${sum(hit.map((p) => p.skipAfter))} 节点今天就没烧 —— 闸省不到它们`);
console.log(`④ 孤儿: ${pop.filter((p) => p.orphan > 0).length}/${pop.length} 张图有不在任何 level 里的 failed 节点 (波级闸看不见)`);

/** success 图里到底有没有 failed 节点 —— ② 那一行的读法全看它。 */
function countSuccWithFailed(): number {
  const d = new Database(dbPath, { readonly: true });
  const rs = d.query(`SELECT outcome, levels, nodes FROM omd_dag_runs WHERE outcome = 'success'`).all() as Row[];
  d.close();
  let k = 0;
  for (const r of rs) {
    try {
      if (JSON.parse(r.levels).length < 2) continue;
      if ((JSON.parse(r.nodes) as { status?: string }[]).some((n) => n.status === 'failed')) k += 1;
    } catch {
      /* 坏行跳过 */
    }
  }
  return k;
}
