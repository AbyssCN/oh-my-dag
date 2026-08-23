// L5 串行化源头探针 (图 #8 r1 票): checkpoints 重建节点区间, 三个读数定位源头。
//   ① 真实并发曲线 (max / 时间加权 avg) —— 复核 r2 的「实测 ~4」;
//   ② ready→start 延迟: 依赖全绿到实际起跑的空档 —— 大 = 引擎调度串行化, 小 = 图本身窄;
//   ③ conductor 腿自耗: 腿长 − 子叶区间并集 (任务 #5 同源数据顺手出)。
// 区间口径: end = checkpoint.createdAt (写入磁盘≈终态), start = end − durationMs。重试片各算各的。
// 用法: bun scripts/probes/l5-concurrency-timeline.ts <runId-prefix> [...]
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/nick/repos/oh-my-dag/.omd/continuity';

interface Piece {
  file: string;
  node: string; // 短 id (execute:: 后缀, __rN 剥掉)
  start: number;
  end: number;
  status: string;
}

for (const prefix of process.argv.slice(2)) {
  const dir = readdirSync(ROOT).find((d) => d.startsWith(prefix));
  if (!dir) {
    console.log(`✗ ${prefix}: 无 continuity 目录`);
    continue;
  }
  const base = join(ROOT, dir);
  const dag = await Bun.file(join(base, '_dag.json')).json();
  const deps: Record<string, string[]> = dag.deps ?? {};
  const pieces: Piece[] = [];
  let conductorLeg: Piece | null = null;
  for (const f of readdirSync(base).filter((x) => x.endsWith('.json') && !x.startsWith('_') && !x.endsWith('-deps.json'))) {
    const cp = await Bun.file(join(base, f)).json();
    const dur: number = cp.durationMs ?? 0;
    const end = Date.parse(cp.createdAt);
    if (!Number.isFinite(end) || dur <= 0) continue;
    const bare = f.replace(/\.json$/, '');
    const node = bare.replace(/\.__r\d+$/, ''); // 保留全 id (execute::xxx) —— deps 键就是这形
    const piece: Piece = { file: bare, node, start: end - dur, end, status: cp.status };
    if (bare === 'execute') conductorLeg = piece; // 平铺回落的 conductor 环 (含子叶)
    else pieces.push(piece);
  }
  if (!pieces.length) {
    console.log(`✗ ${dir.slice(0, 8)}: 无可用片`);
    continue;
  }

  // ① 并发曲线 (sweep line, 只算叶片; conductor 腿是壳不算)
  const events: Array<[number, number]> = [];
  for (const p of pieces) {
    events.push([p.start, +1], [p.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let maxC = 0;
  let area = 0; // ∫并发 dt, 只在 cur>0 区间
  let busy = 0; // 并集长度
  let prevT = events[0]![0];
  for (const [t, d] of events) {
    if (cur > 0) {
      area += cur * (t - prevT);
      busy += t - prevT;
    }
    prevT = t;
    cur += d;
    maxC = Math.max(maxC, cur);
  }
  const span = Math.max(...pieces.map((p) => p.end)) - Math.min(...pieces.map((p) => p.start));

  // ② ready→start 延迟: ready(node) = max(依赖各自最后一片 end); 首片 start − ready = 空档。
  //    依赖没有片 (skipped 等) → 该依赖不计 (保守: 只量得到的)。
  const lastEnd = new Map<string, number>();
  const firstStart = new Map<string, number>();
  for (const p of pieces) {
    lastEnd.set(p.node, Math.max(lastEnd.get(p.node) ?? -Infinity, p.end));
    firstStart.set(p.node, Math.min(firstStart.get(p.node) ?? Infinity, p.start));
  }
  const delays: Array<[string, number]> = [];
  for (const [node, st] of firstStart) {
    const ds = (deps[node] ?? []).map((d) => lastEnd.get(d)).filter((x): x is number => x !== undefined);
    if (!ds.length) continue; // 根节点: ready = 腿起点, 单独看
    const ready = Math.max(...ds);
    delays.push([node, st - ready]);
  }
  delays.sort((a, b) => b[1] - a[1]);

  console.log(`\n=== ${dir.slice(0, 8)} · 叶片 ${pieces.length} · 总跨度 ${(span / 60000).toFixed(1)}min · 并集 ${(busy / 60000).toFixed(1)}min`);
  console.log(`  ① 并发: max=${maxC} · 时间加权avg=${(area / busy).toFixed(2)} · 空窗(跨度−并集)=${((span - busy) / 60000).toFixed(1)}min`);
  const pos = delays.filter(([, d]) => d > 5000);
  console.log(`  ② ready→start 空档 >5s 的节点 ${pos.length}/${delays.length}:`);
  for (const [n, d] of pos.slice(0, 8)) console.log(`     ${(d / 1000).toFixed(0).padStart(6)}s  ${n}`);
  if (conductorLeg) {
    // ③ conductor 自耗 = 腿长 − 腿内子叶并集 (只算落在腿区间内的部分)
    let inLegBusy = 0;
    let c2 = 0;
    let pt = conductorLeg.start;
    const ev2 = events.filter(([t]) => t >= conductorLeg!.start && t <= conductorLeg!.end);
    for (const [t, d] of ev2) {
      if (c2 > 0) inLegBusy += t - pt;
      pt = t;
      c2 += d;
    }
    const legMin = (conductorLeg.end - conductorLeg.start) / 60000;
    console.log(`  ③ conductor 腿 ${legMin.toFixed(1)}min · 腿内子叶并集 ${(inLegBusy / 60000).toFixed(1)}min · 自耗(腿−并集) ${(legMin - inLegBusy / 60000).toFixed(1)}min`);
  }
}
