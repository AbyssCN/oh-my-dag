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

/**
 * 一份 checkpoint 文件 → 它是**第几轮**的(2026-08-06)。
 *
 * 两个来源, 缺一不可:
 *   · 文件名 `<nodeId>.__r<K>.json` —— 覆写前归档的**旧轮**(这条**回溯也成立**, 老记录也有);
 *   · 字段 `round` —— 2026-08-06 起写的**最新那一轮**(纯 `<nodeId>.json` 的文件名说不出轮次)。
 * 两者都没有 = 认不出(顶层节点 / 老的最新份)→ 调用方据此判这一跑进不进可信面。
 */
function roundOf(file: string, field: number | undefined): number | undefined {
  const m = /\.__r(\d+)\.json$/.exec(file);
  if (m) return Number(m[1]);
  return typeof field === 'number' ? field : undefined;
}

const base = join(process.env.OMD_REPO ?? process.cwd(), '.omd', 'continuity');
const stats = { dirs: 0, checkpoints: 0, checkpointsWithPaths: 0 };
const runs: { runId: string; nodes: NodeWindow[]; multiRound: boolean; roundsKnown: boolean }[] = [];

for (const d of readdirSync(base)) {
  let all: string[];
  try {
    all = readdirSync(join(base, d));
  } catch {
    continue; // 不是目录 / 读不了 —— 跳过, 不计进 dirs
  }
  const files = all.filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  stats.dirs++;
  // 这一跑转过第二圈没有 —— 决定它落"可信"还是"不可信"那一面 (见 RetroWriteRace.clean)。
  let multiRound = false;
  for (const f of all.filter((x) => x.startsWith('_loop-'))) {
    try {
      const j = JSON.parse(readFileSync(join(base, d, f), 'utf8')) as { completedRounds?: number };
      if ((j.completedRounds ?? 1) >= 2) multiRound = true;
    } catch {
      // 读不出轮数 → 保守当**多轮**处理 (宁可把它摆进"不可信"那一面, 也不许混进可信面)
      multiRound = true;
    }
  }

  const nodes: NodeWindow[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(base, d, f), 'utf8')) as {
        nodeId?: string; createdAt?: string; durationMs?: number; outputPaths?: string[]; round?: number;
      };
      const end = Date.parse(j.createdAt ?? '');
      if (!Number.isFinite(end) || !j.nodeId) continue;
      const paths = Array.isArray(j.outputPaths) ? j.outputPaths : [];
      stats.checkpoints++;
      if (paths.length) stats.checkpointsWithPaths++;
      nodes.push({ id: j.nodeId, startMs: end - (j.durationMs ?? 0), endMs: end, paths, ...(roundOf(f, j.round) !== undefined ? { round: roundOf(f, j.round) } : {}) });
    } catch {
      // 坏 JSON 不该让整块读数崩; 它不计进 checkpoints, 于是也不假装看过。
    }
  }
  // 子图节点 (`::`) 全都带 round → 跨轮的对已被排掉, 这一跑没有伪影可言。
  const roundsKnown = nodes.every((n) => !n.id.includes('::') || n.round !== undefined);
  if (nodes.length) runs.push({ runId: d, nodes, multiRound, roundsKnown });
}

const r = reconstructWriteRace(runs, stats);
console.log(`continuity 目录 ${r.dirs} 个, 其中 ≥2 个节点 checkpoint 的 ${r.dirsUsable} 个`);
console.log(`节点 checkpoint ${r.checkpoints} 份, 其中报了 outputPaths 的 ${r.checkpointsWithPaths} 份`);
console.log(`\n单轮跑 (数可信)  重叠 ${r.clean.overlaps} · 机会 ${r.clean.pairs} · 撞车 ${r.clean.findings}` +
  `${r.clean.rate === null ? '' : `   [${(r.clean.rate * 100).toFixed(1)}%]`}`);
console.log(`认不出轮次的多轮跑 (不可信)  ${r.ambiguous.runs} 跑 · 重叠 ${r.ambiguous.overlaps} · 机会 ${r.ambiguous.pairs} · 撞车 ${r.ambiguous.findings}`);
console.log('   ⚠ checkpoint 按 nodeId 覆写, 而这些**老记录没记轮次** → 两份可能来自不同的轮, 配对即伪影。');
console.log('     2026-08-06 起 `NodeCheckpoint.round` 有值 → 不同轮的对被直接排除, 多轮跑也进可信面。');
for (const s of r.samples) {
  console.log(`   · ${s.runId.slice(0, 8)} ${s.a} × ${s.b}: ${s.shared.join(', ')}${s.multiRound ? '  ⚠ 认不出轮次的多轮跑, 无法排除伪影' : ''}`);
}
