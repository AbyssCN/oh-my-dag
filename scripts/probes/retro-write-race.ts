/**
 * scripts/probes/retro-write-race —— **从 checkpoint 回溯重建运行时写竞争**(2026-08-06)。
 *
 * ## 为什么它存在
 *
 * ⑧.6 的两档口径(严格 / 推断)都要等新跑攒够。而 `.omd/continuity/<runId>/<nodeId>.json`
 * 里其实一直有 **`createdAt` + `durationMs`**(还原得出执行窗口)与 **`outputPaths`**
 * (= `filesTouched` 相对化到该 run 的根)—— **历史上的重叠/机会/撞车是可以重建的**。
 *
 * 2026-08-06 首次跑它:69 个目录 · 730 份 checkpoint → **重叠 1648 · 机会 30 · 真撞车 1**。
 * 那 1 条是真的(两个 `execute::` 兄弟都碰了 `src/harness/goal/acceptance.ts`)——
 * **并发写竞争在生产上确实发生,不是理论风险。**
 *
 * ## ⚠ 父子守卫不是可选项
 *
 * 不带它的话"撞车"是 **46** 条,其中 **45 条是 `execute × execute::<hash>` 这种父子对** ——
 * conductor/map 父节点的 `outputPaths` 是**子树并集**,它自己一个字都没写。
 * 拿父亲的聚合写去配子节点的写等于把同一次写数两遍。
 *
 * ## ⚠ 它与读数板 ⑧.6 那两档**不是同一个仪器**,别把数混着读
 *
 * · 窗口来源不同:这里是 `createdAt - durationMs`(整个节点的执行时长),⑧.6 是调度器实时记的;
 * · 路径基准不同:这里是**相对该 run 的根**(同一 runId 内可比,**跨 run 不可比**);
 * · 覆盖不同:这里只覆盖**开了 continuity 的跑**,且目录被清掉就没了。
 *
 * 要把它接成常驻读数面,得像 ⑨/⑫ 那样**先标口径**再合页 —— 别直接加进 ⑧.6 的分母。
 *
 * 用法:`bun run scripts/probes/retro-write-race.ts`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const root = join(process.env.OMD_REPO ?? process.cwd(), '.omd', 'continuity');
let dirs = 0, dirsWith2 = 0, totalOverlaps = 0, totalPairs = 0, totalFindings = 0, nodesWithPaths = 0, nodesTotal = 0;
const findingSamples: string[] = [];
for (const d of readdirSync(root)) {
  let files: string[] = [];
  try { if (!statSync(join(root, d)).isDirectory()) continue; files = readdirSync(join(root, d)).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { continue; }
  dirs++;
  const nodes: { id: string; s: number; e: number; paths: string[] }[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(root, d, f), 'utf8'));
      const end = Date.parse(j.createdAt); const dur = j.durationMs ?? 0;
      if (!Number.isFinite(end)) continue;
      const paths: string[] = Array.isArray(j.outputPaths) ? j.outputPaths : [];
      nodes.push({ id: j.nodeId ?? f, s: end - dur, e: end, paths });
      nodesTotal++; if (paths.length) nodesWithPaths++;
    } catch { }
  }
  if (nodes.length < 2) continue;
  dirsWith2++;
  for (let i = 0; i < nodes.length; i++) for (let k = i + 1; k < nodes.length; k++) {
    const a = nodes[i]!, b = nodes[k]!;
    if (a.id.startsWith(b.id + '::') || b.id.startsWith(a.id + '::')) continue; // 父子不算一对
    if (!(a.s < b.e && b.s < a.e)) continue; // 窗口不重叠
    totalOverlaps++;
    if (!a.paths.length || !b.paths.length) continue;
    totalPairs++;
    const shared = a.paths.filter((p) => b.paths.includes(p));
    if (shared.length) { totalFindings++; if (findingSamples.length < 4) findingSamples.push(`${d.slice(0,8)} ${a.id} × ${b.id}: ${shared.slice(0,2).join(', ')}`); }
  }
}
console.log(`continuity 目录 ${dirs} 个, 其中 ≥2 个节点 checkpoint 的 ${dirsWith2} 个`);
console.log(`节点 checkpoint ${nodesTotal} 份, 其中报了 outputPaths 的 ${nodesWithPaths} 份`);
console.log(`\n重叠对  ${totalOverlaps}`);
console.log(`机会对  ${totalPairs}   ← 两侧都报了 outputPaths`);
console.log(`真撞车  ${totalFindings}`);
for (const s of findingSamples) console.log(`   · ${s}`);
