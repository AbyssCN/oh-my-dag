#!/usr/bin/env bun
/**
 * scripts/concurrency-curve —— 从 continuity checkpoint 重建一次 DAG run 的并发曲线(r1 测量)。
 *
 * 用法: bun run scripts/concurrency-curve.ts --run .omd/continuity/<runId>
 *
 * 数据源与已知失真(读数解释要带着这条):
 *   - 每节点一个 `<nodeId>.json` checkpoint;`createdAt` 是**结束**时刻,
 *     `start = createdAt − durationMs` 是重建值,不是引擎记录的真起跑。
 *   - durationMs 可能只覆盖最后一次尝试(L0 重试时),重建 start 会整体后移。
 *   - map 父节点 durationMs 恒 0(checkpoint 写入磁盘时写死),start==end,不占并发。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const i = argv.indexOf('--run');
const dir = i >= 0 ? argv[i + 1] : undefined;
if (!dir || !existsSync(dir)) {
  console.error('用法: bun run scripts/concurrency-curve.ts --run <continuity目录>');
  process.exit(2);
}

interface Ckpt {
  nodeId: string;
  leafKind: string;
  status: string;
  durationMs: number;
  createdAt: string;
  tokenUsage: { in: number; out: number; cacheHit?: number } | null;
  [k: string]: unknown;
}

const nodes: Ckpt[] = [];
const keyUnion = new Set<string>();
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json') || f === '_dag.json') continue;
  let j: Ckpt;
  try {
    j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Ckpt;
  } catch (e) {
    console.error(`[跳过] ${f}: 解析失败 ${e instanceof Error ? e.message : e}`);
    continue;
  }
  if (typeof j.nodeId !== 'string' || typeof j.createdAt !== 'string') {
    console.error(`[跳过] ${f}: 缺 nodeId/createdAt`);
    continue;
  }
  for (const k of Object.keys(j)) keyUnion.add(k);
  nodes.push(j);
}
if (nodes.length === 0) {
  console.error(`[空] ${dir} 下无可解析节点 json`);
  process.exit(1);
}

const endOf = (n: Ckpt): number => Date.parse(n.createdAt);
const startOf = (n: Ckpt): number => endOf(n) - (Number.isFinite(n.durationMs) ? n.durationMs : 0);
const t0 = Math.min(...nodes.map(startOf));
const tEnd = Math.max(...nodes.map(endOf));
const rel = (ms: number): string => ((ms - t0) / 1000).toFixed(1).padStart(7);

console.log(`== ${dir}`);
console.log(`节点 json: ${nodes.length} · 字段并集: ${[...keyUnion].sort().join(', ')}`);
console.log(`墙钟(最早 start → 最晚 end): ${((tEnd - t0) / 1000).toFixed(1)}s · Σ durationMs: ${(nodes.reduce((a, n) => a + (n.durationMs || 0), 0) / 1000).toFixed(1)}s`);
console.log('');
console.log('start(s)  end(s)   dur(s)  kind     status   nodeId');
for (const n of [...nodes].sort((a, b) => startOf(a) - startOf(b))) {
  console.log(
    `${rel(startOf(n))} ${rel(endOf(n))} ${((n.durationMs || 0) / 1000).toFixed(1).padStart(7)}  ${(n.leafKind ?? '?').padEnd(8)} ${(n.status ?? '?').padEnd(8)} ${n.nodeId.slice(0, 60)}`,
  );
}

// ── 并发曲线: 事件扫描(start:+1, end:−1),打印每次变化 + per-kind 峰值 + 空洞 ──
type Ev = { t: number; d: number; kind: string; id: string };
const evs: Ev[] = [];
for (const n of nodes) {
  if ((n.durationMs || 0) <= 0) continue; // 零时长不占并发(map 父节点)
  evs.push({ t: startOf(n), d: +1, kind: n.leafKind ?? '?', id: n.nodeId });
  evs.push({ t: endOf(n), d: -1, kind: n.leafKind ?? '?', id: n.nodeId });
}
evs.sort((a, b) => a.t - b.t || b.d - a.d); // 同刻先 +1(避免假空洞)
let cur = 0;
const curByKind = new Map<string, number>();
let maxAll = 0;
const maxByKind = new Map<string, number>();
const gaps: { from: number; to: number; next: string }[] = [];
let gapStart: number | null = null;
console.log('\n并发变化(t 相对秒 · 总并发 · agent并发 · 事件):');
for (const e of evs) {
  if (cur === 0 && e.d > 0 && gapStart != null && e.t - gapStart >= 2000) {
    gaps.push({ from: gapStart, to: e.t, next: e.id });
  }
  cur += e.d;
  curByKind.set(e.kind, (curByKind.get(e.kind) ?? 0) + e.d);
  maxAll = Math.max(maxAll, cur);
  maxByKind.set(e.kind, Math.max(maxByKind.get(e.kind) ?? 0, curByKind.get(e.kind) ?? 0));
  if (cur === 0) gapStart = e.t;
  console.log(
    `t=${rel(e.t)}  n=${String(cur).padStart(2)}  agent=${String(curByKind.get('agent') ?? 0).padStart(2)}  ${e.d > 0 ? '+' : '−'}${e.id.slice(0, 55)}`,
  );
}
console.log(`\n峰值并发: 总=${maxAll} · ${[...maxByKind].map(([k, v]) => `${k}=${v}`).join(' · ')}`);
if (gaps.length) {
  console.log('空洞(并发=0, ≥2s):');
  for (const g of gaps) console.log(`  [${rel(g.from)} → ${rel(g.to)}] ${((g.to - g.from) / 1000).toFixed(1)}s → 下一个起跑: ${g.next.slice(0, 60)}`);
} else {
  console.log('空洞: 无(≥2s)');
}

// ── _dag.json: deps + runtimeNodes 简表 ──
const dagPath = join(dir, '_dag.json');
if (existsSync(dagPath)) {
  const dag = JSON.parse(readFileSync(dagPath, 'utf8')) as {
    nodeIds?: string[];
    deps?: Record<string, string[]>;
    runtimeNodes?: { id: string; parent: string; kind: string; deps: string[] }[];
  };
  console.log(`\n_dag.json: 静态节点 ${dag.nodeIds?.length ?? '?'} · runtimeNodes ${dag.runtimeNodes?.length ?? 0}`);
  if (dag.deps) {
    console.log('deps:');
    for (const [id, ds] of Object.entries(dag.deps)) {
      if (ds.length) console.log(`  ${id.slice(0, 50)} ← ${ds.map((d) => d.slice(0, 50)).join(', ')}`);
    }
  }
  for (const rn of dag.runtimeNodes ?? []) {
    console.log(`  [runtime] ${rn.id.slice(0, 60)} (parent=${rn.parent}, kind=${rn.kind})`);
  }
} else {
  console.log('\n_dag.json: 缺席');
}
console.log(`\n[尺子注意] start=createdAt−durationMs 是重建值;L0 重试节点的 durationMs 只覆盖最后一次尝试,start 偏晚。`);
