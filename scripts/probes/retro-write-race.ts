/**
 * scripts/probes/retro-write-race —— **回溯写竞争的独立探针**(2026-08-06)。
 *
 * ## 它和读数板 ⑧.7 是**同一份计算**
 *
 * 判据、配对、父子守卫**一个字都不在这里** —— 全部走
 * `reconstructWriteRace` → `overlapPairsFromWindows` → `detectRuntimeWriteRace`,
 * 与读数板 ⑧.7 调的是同一条链。**两处各算一份必漂**,而这条正是它要避开的。
 *
 * 那为什么还留着它:⑧.7 混在一整页读数里,而这一面**跑得慢**(要读几百份 JSON)
 * 且常常是单独想看的那一格 —— 探针给一条不用把整块板算一遍的路。
 *
 * ## 首次跑到的数(2026-08-06)
 *
 * 69 个 continuity 目录 · 733 份节点 checkpoint → **重叠 1648 · 机会 30 · 真撞车 1**。
 * 那 1 条是真的:两个 `execute::` 兄弟都碰了 `src/harness/goal/acceptance.ts` ——
 * **并发写竞争在生产上确实发生,不是理论风险。**
 *
 * ⚠ **父子守卫不是可选项**:不带它"撞车"是 46 条,其中 45 条是 `execute × execute::<hash>`
 *   这种父子对(父节点的 `outputPaths` 是子树并集,它自己一个字都没写)。
 *   守卫住在 `detectRuntimeWriteRace` 里,所以这里白拿。
 *
 * 用法:`bun run scripts/probes/retro-write-race.ts`(`OMD_REPO` 可指定仓根)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeWindow } from '../../src/harness/plan/observers';
import { reconstructWriteRace } from '../omd-readout';

const base = join(process.env.OMD_REPO ?? process.cwd(), '.omd', 'continuity');
const stats = { dirs: 0, checkpoints: 0, checkpointsWithPaths: 0 };
const runs: { runId: string; nodes: NodeWindow[] }[] = [];

for (const d of readdirSync(base)) {
  let files: string[];
  try {
    files = readdirSync(join(base, d)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    continue; // 不是目录 / 读不了 —— 跳过, 不计进 dirs
  }
  stats.dirs++;
  const nodes: NodeWindow[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(base, d, f), 'utf8')) as {
        nodeId?: string; createdAt?: string; durationMs?: number; outputPaths?: string[];
      };
      const end = Date.parse(j.createdAt ?? '');
      if (!Number.isFinite(end) || !j.nodeId) continue;
      const paths = Array.isArray(j.outputPaths) ? j.outputPaths : [];
      stats.checkpoints++;
      if (paths.length) stats.checkpointsWithPaths++;
      nodes.push({ id: j.nodeId, startMs: end - (j.durationMs ?? 0), endMs: end, paths });
    } catch {
      // 坏 JSON 不该让整块读数崩; 它不计进 checkpoints, 于是也不假装看过。
    }
  }
  if (nodes.length) runs.push({ runId: d, nodes });
}

const r = reconstructWriteRace(runs, stats);
console.log(`continuity 目录 ${r.dirs} 个, 其中 ≥2 个节点 checkpoint 的 ${r.dirsUsable} 个`);
console.log(`节点 checkpoint ${r.checkpoints} 份, 其中报了 outputPaths 的 ${r.checkpointsWithPaths} 份`);
console.log(`\n重叠对  ${r.overlaps}   ← **已滤掉父子对** (守卫在 detectRuntimeWriteRace 里)`);
console.log(`机会对  ${r.pairs}   ← 两侧都报了 outputPaths`);
console.log(`真撞车  ${r.findings}${r.rate === null ? '' : `   [${(r.rate * 100).toFixed(1)}%]`}`);
for (const s of r.samples) console.log(`   · ${s.runId.slice(0, 8)} ${s.a} × ${s.b}: ${s.shared.join(', ')}`);
