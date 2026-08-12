/**
 * 叶级研磨看门狗 (task-leaf-grind-watchdog) 的**校准尺**。
 *
 * ## 为什么是尺子而不是闸
 *
 * ruling 把主信号从「纯墙钟」改判成**双条件闸**(墙钟 > T **且** 停滞窗口 W 内 `touched`
 * 零新增), 并明写:
 *
 * > 初值待实测校准: T=10min(≈p95) / W=5min 是**暂定**, 因为 `touched` 的时间分布今天没落盘
 * > → 这两个数还不是量出来的。
 *
 * 于是先落 S1 埋点 (`5a2d905`, 2026-08-12 09:03Z) 把 `touchTimelineMs` 写进 checkpoint。
 * **本脚本是读它的那一头** —— 没有它, 埋点攒的数据没人算, T/W 永远停在"暂定"。
 * 先修尺子再量: 拿没量过的 T/W 去实装硬截停, 误杀的正是 done 率 100% 的那批长叶。
 *
 * ## 两半分开报 (刻意)
 *
 * - **墙钟半**: `durationMs` 历史上一直有 → 今天就能回测, 且能复核 ruling 引用的那两个数
 *   (纯墙钟 ≥15min 命中 25 条其中 24 条是高产叶 / 「≥15min 且零产物」只命中 2)。
 * - **停滞半**: `touchTimelineMs` 只有埋点之后的叶子才有 → **n 可能是 0**。
 *   n=0 就印 n=0, **不印 0 分位数** —— 「没量到」与「量到的是 0」是两件事 (本仓坑 #1: NULL ≠ 0)。
 *
 * ## 用法
 *
 *   bun run scripts/probes/watchdog-calibration.ts [continuityRoot]
 *
 * 默认读 `.omd/continuity`。只读, 零写, 零模型调用。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** checkpoint 的真实字段名以盘上为准 (`leafKind` 不是 `kind` —— 这里踩过一次)。 */
interface NodeCheckpointLike {
  nodeId?: string;
  leafKind?: string;
  status?: string;
  durationMs?: number;
  outputPaths?: string[];
  watchdog?: {
    stalled?: boolean;
    timedOut?: boolean;
    touchTimelineMs?: number[];
    toolTimelineMs?: number[];
  };
}

export interface LeafRow {
  runId: string;
  nodeId: string;
  status: string;
  wallMin: number;
  artifacts: number;
  /** undefined = 该叶子没有 watchdog 记录 (埋点之前的老叶 / 非 agent), **不是 0**。 */
  maxIdleMin?: number;
  stalled?: boolean;
  timedOut?: boolean;
}

const MIN = 60_000;

export function collect(root: string): { leaves: LeafRow[]; scanned: number; nonAgent: number } {
  const leaves: LeafRow[] = [];
  let scanned = 0;
  let nonAgent = 0;
  let runDirs: string[];
  try {
    runDirs = readdirSync(root);
  } catch (e) {
    console.error(`读不到 ${root}: ${(e as Error).message}`);
    return { leaves, scanned, nonAgent };
  }
  for (const run of runDirs) {
    const dir = join(root, run);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dir)) {
      // `_dag.json` / `spec.json` 是 run 级元数据; 其余 `*.json` 才是节点结果。
      // `.__r1` 是**归档的旧轮**(重跑时旧文件改名) —— 它也是一次真执行, 计入。
      if (!f.endsWith('.json') || f.startsWith('_') || f === 'spec.json') continue;
      let j: NodeCheckpointLike;
      try {
        j = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as NodeCheckpointLike;
      } catch {
        continue; // 半成品/损坏 → 跳过 (fail-open, 但下面 scanned 不计它, 别把它算进分母)
      }
      scanned += 1;
      if (j.leafKind !== 'agent') {
        nonAgent += 1;
        continue;
      }
      const t = j.watchdog?.touchTimelineMs;
      leaves.push({
        runId: run.slice(0, 8),
        nodeId: j.nodeId ?? f.replace(/\.json$/, ''),
        status: j.status ?? '?',
        wallMin: (j.durationMs ?? 0) / MIN,
        artifacts: j.outputPaths?.length ?? 0,
        // 停滞窗口 = 相邻两次 `touched` 新增之间的最大间隔; 末段 (最后一次 touch → 叶结束)
        // 也算一段, 否则"最后 20 分钟一个文件没碰"会被漏掉 —— 那正是研磨的典型形状。
        ...(t
          ? {
              maxIdleMin: maxGapMin(t, j.durationMs ?? 0),
              stalled: j.watchdog?.stalled,
              timedOut: j.watchdog?.timedOut,
            }
          : {}),
      });
    }
  }
  return { leaves, scanned, nonAgent };
}

/** 相邻 touch 间隔的最大值 (含 0→首次 与 末次→结束 两段), 分钟。 */
export function maxGapMin(touchMs: number[], durationMs: number): number {
  const pts = [0, ...touchMs, durationMs].sort((a, b) => a - b);
  let max = 0;
  for (let i = 1; i < pts.length; i++) max = Math.max(max, pts[i]! - pts[i - 1]!);
  return max / MIN;
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');

function main(): void {
  const root = process.argv[2] ?? '.omd/continuity';
  const { leaves, scanned, nonAgent } = collect(root);

  console.log(`# 叶级看门狗校准读数  (root=${root})\n`);
  console.log(`扫到节点 checkpoint ${scanned} 条 · 非 agent 叶 ${nonAgent} 条 · **agent 叶 ${leaves.length} 条**`);

  if (leaves.length === 0) {
    console.log('\n没有 agent 叶记录 —— 无从校准。');
    return;
  }

  // ── 墙钟半 (历史一直有) ─────────────────────────────────────────────
  const walls = leaves.map((l) => l.wallMin);
  console.log('\n## 墙钟分布 (min)');
  console.log(
    `p50=${f1(pct(walls, 50))} p75=${f1(pct(walls, 75))} p90=${f1(pct(walls, 90))} ` +
      `p95=${f1(pct(walls, 95))} p99=${f1(pct(walls, 99))} max=${f1(Math.max(...walls))}`,
  );

  console.log('\n## 纯墙钟闸回测 —— 为什么 ruling 否掉了它');
  console.log('| T (min) | 命中 | 其中 done | 其中非 done | 误杀比 |');
  console.log('|---|---|---|---|---|');
  for (const T of [10, 15, 20, 30]) {
    const hit = leaves.filter((l) => l.wallMin >= T);
    const done = hit.filter((l) => l.status === 'done').length;
    const bad = hit.length - done;
    console.log(`| ${T} | ${hit.length} | ${done} | ${bad} | ${bad ? `${done}:${bad}` : `${done}:0`} |`);
  }

  console.log('\n## 加「零产物」第二条件 (双条件闸里今天就能算的那一半)');
  console.log('| T (min) | 命中 (≥T 且零产物) | 其中 done | 其中非 done |');
  console.log('|---|---|---|---|');
  for (const T of [10, 15, 20, 30]) {
    const hit = leaves.filter((l) => l.wallMin >= T && l.artifacts === 0);
    const done = hit.filter((l) => l.status === 'done').length;
    console.log(`| ${T} | ${hit.length} | ${done} | ${hit.length - done} |`);
  }

  // ── 停滞半 (只有埋点之后的叶子才有) ─────────────────────────────────
  const withWd = leaves.filter((l) => l.maxIdleMin !== undefined);
  console.log('\n## 停滞窗口 (touched 相邻间隔的最大值)');
  console.log(
    `带 watchdog 记录的 agent 叶: **${withWd.length} / ${leaves.length}** ` +
      `(其余是 S1 埋点 \`5a2d905\` 之前的叶子 —— 缺席 ≠ 停滞 0)`,
  );
  if (withWd.length === 0) {
    console.log('\n**n = 0 → W 今天量不出来。** 不印分位数: 「没量到」不是「量到 0」。');
    console.log('这不是 bug —— 埋点 2026-08-12 09:03Z 才进 git, 在那之后还没有 agent 叶跑过。');
    console.log('攒够样本后重跑本脚本, 下面这张 T×W 表才有数。');
    return;
  }
  const idles = withWd.map((l) => l.maxIdleMin!);
  console.log(
    `p50=${f1(pct(idles, 50))} p75=${f1(pct(idles, 75))} p90=${f1(pct(idles, 90))} ` +
      `p95=${f1(pct(idles, 95))} max=${f1(Math.max(...idles))}`,
  );
  console.log(`其中 stalled=${withWd.filter((l) => l.stalled).length} · timedOut=${withWd.filter((l) => l.timedOut).length}`);

  console.log('\n## 双条件闸网格 (墙钟 ≥ T **且** 停滞 ≥ W) —— T/W 该从这张表上挑');
  console.log('| T\\W | ' + [3, 5, 8, 10].map((w) => `${w}min`).join(' | ') + ' |');
  console.log('|---|' + [3, 5, 8, 10].map(() => '---').join('|') + '|');
  for (const T of [10, 15, 20, 30]) {
    const cells = [3, 5, 8, 10].map((W) => {
      const hit = withWd.filter((l) => l.wallMin >= T && l.maxIdleMin! >= W);
      const done = hit.filter((l) => l.status === 'done').length;
      return `${hit.length} (done ${done})`;
    });
    console.log(`| ${T}min | ${cells.join(' | ')} |`);
  }
  console.log('\n挑法: **`done` 那一列是误杀**。选 done 尽量小、命中非 done 尽量全的格。');
}

if (import.meta.main) main();
