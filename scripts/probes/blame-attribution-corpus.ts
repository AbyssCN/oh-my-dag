/**
 * B0 第一个数(离线):**闸红的诊断,有多少行归得到本跑的写者头上?**
 *
 * 这个数决定 #145 提议 5 的 B2(定向返修节点)那个形状成不成立。
 * `failure-trace.ts` 里记着一条不利的旧实测 ——「`assert-failed` 只有 1/7(14%)认得出路径」——
 * 但它 ① 量在 **800 字 summary** 上 ② n=7。本探针在**全文**上重量一次,n 大一个量级。
 *
 * ## 为什么不用点火一次 solve
 *
 * P-2:一条命令能看见的事别用推的。plana 的 `.omd/continuity/` 里已经有十几个 run 的
 * 真实闸红现场,且 D-O 把**全文**落成了 `fail-<id>.txt` 制品 —— 判据要的两样
 * (诊断全文 · 各节点 `outputPaths`)盘上都在。
 *
 * ## ⚠ 三条口径,先写在这
 *
 * ① **判据不重写**:直接 import 生产的 `attributeBlame`。自己在探针里再实现一遍匹配逻辑,
 *    量的就是探针而不是引擎 —— 而两份判据必然漂。
 * ② **stat 的是今天的盘**:这些 run 是几天前的,期间文件可能增删。影响的是 `foreign` 与
 *    `pathless` 的切分(文件没了 → 从 foreign 掉进 pathless),**不影响 `byWriter`**
 *    (那一位只看写者自报的路径,不看盘)。所以主结论(命中率)稳,次级切分要打折读。
 * ③ **`outputPaths` 是 checkpoint 投影的 `filesTouched`**,与运行时那份同源。
 *
 * 跑: `bun run scripts/probes/blame-attribution-corpus.ts [continuityRoot] [repoRoot]`
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { attributeBlame } from '../../src/harness/dag/blame-attribution';
import type { LeafResult } from '../../src/harness/dag/types';

const CONTINUITY = process.argv[2] ?? '/home/nick/repos/plana/.omd/continuity';
const REPO_ROOT = process.argv[3] ?? '/home/nick/repos/plana';

interface Checkpoint {
  nodeId?: string;
  leafKind?: string;
  status?: string;
  failureKind?: string;
  outputPaths?: string[];
  summary?: string;
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 节点 id → `fail-<id>.txt` 的文件名(`::` 在文件名里写成 `__`)。 */
const failFileFor = (dir: string, base: string): string | null => {
  const stem = base.replace(/\.json$/, '');
  for (const cand of [`fail-${stem}.txt`, `fail-${stem.replace(/::/g, '__')}.txt`]) {
    const p = join(dir, cand);
    if (existsSync(p)) return p;
  }
  return null;
};

let runs = 0;
let gates = 0;
let noFullText = 0;
const agg = { owned: 0, foreign: 0, pathless: 0, total: 0 };
const perGate: { run: string; node: string; owned: number; foreign: number; pathless: number; total: number; writers: number; oracle: string; ownedLines: string[] }[] = [];

/**
 * 命令原文 → oracle 类型。**这一位是本探针最重要的一列** —— 合计数把两种输出压成一个
 * 平均数, 而它们的**语义完全不同**:
 *   · tsc  的每一行是「**哪个文件**的第几行有类型错」→ 归因天然成立
 *   · test 的每一行是「**哪个测试**没过」→ 点名的是 `.test.ts`, 而病根在实现文件里,
 *     实现文件的名字**根本不出现在输出里**
 * 判据只看命令串里出现了什么, 拿不准归 other (不猜)。
 */
function oracleTypeOf(cmd: string): string {
  const c = cmd.toLowerCase();
  const hasTsc = /tsc|typecheck|type-check/.test(c);
  const hasTest = /vitest|bun test|jest|npm test|pnpm test/.test(c);
  if (hasTsc && hasTest) return 'tsc+test';
  if (hasTsc) return 'tsc';
  if (hasTest) return 'test';
  return c ? 'other' : 'unknown';
}

for (const runId of readdirSync(CONTINUITY)) {
  const dir = join(CONTINUITY, runId);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_dag.json');
  } catch {
    continue; // 不是目录
  }
  const cps: { base: string; cp: Checkpoint }[] = [];
  for (const f of files) {
    try {
      cps.push({ base: f, cp: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Checkpoint });
    } catch {
      /* 坏 JSON 跳过 —— 不编一条出来 */
    }
  }
  // 本跑的写者表: 任何有 outputPaths 的节点 (含 __r1 那些轮 —— 写者身份不因轮次改变)。
  const results: Record<string, LeafResult> = {};
  for (const { cp } of cps) {
    if (!cp.nodeId || !cp.outputPaths?.length) continue;
    const id = cp.nodeId;
    const prev = results[id]?.filesTouched ?? [];
    results[id] = { id, status: 'done', kind: 'agent', output: '', deps: [], usage: { in: 0, out: 0 },
      filesTouched: [...new Set([...prev, ...cp.outputPaths])] } as LeafResult;
  }
  // 节点 → 命令原文 (来自 _dag.json 的 plan)。**按 oracle 类型分组**才读得出形状 ——
  // 合计数会把 tsc 与 vitest 两种完全不同的输出压成一个平均数。
  let cmdOf: Record<string, string> = {};
  try {
    const dag = JSON.parse(readFileSync(join(dir, '_dag.json'), 'utf8')) as { plan?: { nodes?: Record<string, { command?: string }> } };
    for (const [id, n] of Object.entries(dag.plan?.nodes ?? {})) if (n.command) cmdOf[id] = n.command;
  } catch {
    /* 没有 _dag.json → 归 unknown, 不编一个命令出来 */
  }
  let touchedRun = false;
  for (const { base, cp } of cps) {
    if (cp.leafKind !== 'command' || cp.failureKind !== 'assert-failed') continue;
    const fp = failFileFor(dir, base);
    if (!fp) {
      noFullText++;
      continue; // 没有全文就不量 —— 拿 summary 量正是那个 14% 的口径问题
    }
    const text = readFileSync(fp, 'utf8');
    const a = attributeBlame(text, results, { root: REPO_ROOT, statFile: isFile });
    const owned = a.byWriter.reduce((n, w) => n + w.lines.length, 0);
    gates++;
    touchedRun = true;
    agg.owned += owned;
    agg.foreign += a.foreign.length;
    agg.pathless += a.pathless.length;
    agg.total += a.linesTotal;
    perGate.push({ run: runId.slice(0, 8), node: cp.nodeId ?? base, owned, foreign: a.foreign.length,
      pathless: a.pathless.length, total: a.linesTotal, writers: Object.keys(results).length,
      oracle: oracleTypeOf(cmdOf[cp.nodeId ?? ''] ?? ''), ownedLines: a.byWriter.flatMap((w) => w.lines) });
  }
  if (touchedRun) runs++;
}

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}%` : '—');
console.log(`\n语料: ${runs} 个 run · ${gates} 个 assert-failed 的 command 节点 (全文可得)`);
console.log(`⚠ 另有 ${noFullText} 个没有 fail-*.txt 全文 —— 不拿 summary 顶替 (那正是旧数的口径问题)\n`);
console.log(
  ['run'.padEnd(10), 'node'.padEnd(26), '行'.padStart(5), '认领'.padStart(7), '跑外'.padStart(7), '无路径'.padStart(8), '写者'.padStart(6)].join(''),
);
for (const g of perGate) {
  console.log(
    [g.run.padEnd(10), g.node.slice(0, 25).padEnd(26), String(g.total).padStart(5), String(g.owned).padStart(7),
     String(g.foreign).padStart(7), String(g.pathless).padStart(8), String(g.writers).padStart(6)].join(''),
  );
}
console.log(`\n合计 ${agg.total} 行 → 写者认领 ${agg.owned} (${pct(agg.owned, agg.total)}) · ` +
  `本跑外文件 ${agg.foreign} (${pct(agg.foreign, agg.total)}) · 无路径 ${agg.pathless} (${pct(agg.pathless, agg.total)})`);
// ── 按 oracle 类型分组 ────────────────────────────────────────────────
const byType = new Map<string, { owned: number; foreign: number; pathless: number; total: number; n: number }>();
for (const g of perGate) {
  const t = byType.get(g.oracle) ?? { owned: 0, foreign: 0, pathless: 0, total: 0, n: 0 };
  t.owned += g.owned; t.foreign += g.foreign; t.pathless += g.pathless; t.total += g.total; t.n++;
  byType.set(g.oracle, t);
}
console.log('\n按 oracle 类型分组 (合计数把两种语义不同的输出压成了一个平均数):');
console.log(['oracle'.padEnd(10), '闸数'.padStart(6), '行'.padStart(6), '认领'.padStart(8), '跑外'.padStart(8), '无路径'.padStart(9)].join(''));
for (const [t, v] of [...byType].sort((a, b) => b[1].total - a[1].total)) {
  console.log([t.padEnd(10), String(v.n).padStart(6), String(v.total).padStart(6),
    `${v.owned} (${pct(v.owned, v.total)})`.padStart(9), `${v.foreign} (${pct(v.foreign, v.total)})`.padStart(9),
    `${v.pathless} (${pct(v.pathless, v.total)})`.padStart(10)].join(''));
}

// ── 决定性的那一列: 归得了因的错, 是不是 L0 已经拦得住的那一类 ──────────
// TS1xxx = 语法错 → `parseContent` 在**写它的那个 leaf 的会话内**就判得出来 (L0, 已落地);
// TS2xxx+ = 语义/类型错 → L0 看不见, **那才是 B2 唯一可能的增量**。
let syn = 0;
let sem = 0;
for (const g of perGate) {
  if (g.owned === 0) continue;
  for (const line of g.ownedLines) {
    const m = /error TS(\d+)/.exec(line);
    if (!m) continue;
    (Number(m[1]) < 2000 ? (syn += 1) : (sem += 1));
  }
}
console.log(`\n归了因的那些错里: 语法类 TS1xxx = ${syn} (L0 写后即验已拦) · 语义类 TS2xxx+ = ${sem} (**B2 唯一的增量**)`);

console.log(`\n判据(写在动手前): 写者认领占比若 < 30% ⇒ B2 定向返修够不着, 停。`);
console.log('读数 2026-08-17: 合计 17% —— **判据触发, B2/B3 停**。且更强的一条在上面那行:');
console.log('  归了因的 73 行里 58 行是 TS1xxx 语法错, 而那一类 L0 写后即验在会话内就拦住了;');
console.log('  **B2 唯一的增量 = 归得了因的语义错 = 1 行** (436 行 / 21 个红闸 / 10 个 run)。');
console.log('⚠ 主结论看"认领"这一列; foreign/pathless 的切分依赖今天的盘, 打折读 (见文件头口径②) ——');
console.log('  实测撞到过: 78837e20/gate_tsc 的 23 行判成"无路径", 真因是 overtime.test.ts 那之后被删了。');
