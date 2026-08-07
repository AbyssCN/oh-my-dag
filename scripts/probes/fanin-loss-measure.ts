#!/usr/bin/env bun
/**
 * fanin-loss-measure —— **第 0 档 vs 第 1a 档**:LLM 定向摘要 与 程序化抽取合并,
 * 在**盘上的真实语料**上比产物锚保留率(2026-08-07)。
 *
 * ## 为什么今天就能跑,不用等新 run 攒读数
 *
 * 两样东西已经在盘上:
 *   · `<runDir>/fanin-<nodeId>.txt` —— **被压缩过的全文原件**(`saveFaninFull` 存的),76 份;
 *   · `<runDir>/_dag.json` —— **全量 plan**,含每个节点的 `goal` 与 `depends_on`。
 * 于是 `producerGoal` 与 `depGoals`(定向摘要的"定向"来源)可以**精确重建**,
 * 不是拿一个近似的 prompt 去糊。
 *
 * ⚠ 语料的可用面是 **9/76**,原因写清楚免得被读成"样本随便挑的":
 *   · 49 份的 nodeId 在顶层 plan 里找不到 —— 它们是 conductor 展开的**子图节点**
 *     (内容寻址 id),plan 上没有;
 *   · 再去掉零锚的(这把尺子对它们**不适用**,不是无损)与找不到 consumer 的。
 *   剩 9 份 / 78k 字符 / **685 个锚**。判别的单位是**锚**不是文件,所以 685 才是分母。
 *
 * ## 两臂
 *
 *   **A 第 0 档**(今天的生产实现):`runFaninSummary` 真发一次 LLM,`composeFaninView` 组装。
 *   **B 第 1a 档**(程序化抽取):零 LLM。产物锚**全集**逐字 + 头尾切片 + 全文指针。
 *
 * B 的锚保留率**构造上必然是 100%** —— 所以这个实验**不是**在测 B,是在测 A:
 * A 到底丢不丢锚、丢多少。
 *
 * ## 预先声明的判据(动手前写死)
 *
 *   ① A 的 `lost` 合计 = 0        → 摘要根本没在丢锚。第 1 档省的只是一发便宜调用,
 *                                   **不值得做**。这是"不塌"那一侧的证据,同样要写。
 *   ② A 的 `lost` > 0            → 量出丢了多少、丢的是什么。1a 有明确收益,
 *                                   而 `lostSample` 决定这收益要不要紧。
 *   ③ B 的视图长度 ≫ A          → B 不是"合并"是"没压缩":省了 LLM 却把成本推给
 *                                   consumer 的 input。要连着 ① ② 一起读,不许单看锚。
 *
 * ## 它测不到什么(边界声明,别拿它多说)
 *
 * A 是**定向**摘要(拿到了 depGoals),B 不是 —— B 不知道下游要什么。
 * 所以本实验能说「B 保锚更多」,**不能说「B 总体更好」**。后者要下游任务质量的 oracle,
 * 那是另一个实验。**锚只是承诺里的一项,不是摘要的全部价值。**
 *
 * 跑:bun run scripts/probes/fanin-loss-measure.ts [--cap 30000] [--model provider:id] [--arms A,B]
 */
import '../../src/harness/script-bootstrap';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { makeDefaultGenerate } from '../../src/harness/dag/defaults';
import {
  DEFAULT_FANIN_SCHEMA,
  composeFaninView,
  faninAnchorLoss,
  runFaninSummary,
} from '../../src/harness/fanin-summary';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';

const argv = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const CAP = Number(flag('cap', '30000'));
const MODEL = flag('model', 'kimi-coding:k3');
const ARMS = flag('arms', 'A,B').split(',').map((s) => s.trim());
const OUT = '/tmp/fanin-loss';
const log = (s: string): void => void process.stderr.write(s + '\n');

/**
 * **第 1a 档:程序化抽取合并**(零 LLM)。
 *
 * 刻意留在探针里而不是进 `src/` —— 它是**被测对象**,实验若判它不值得做,
 * 进了 src 就是一段投机的死代码。判值得再搬。
 *
 * 三段,顺序固定(确定性:同一输入两次给同一份):
 *   ① 产物锚全集,逐字 —— 保留率构造上 100%,这是它相对 A 的**唯一**结构性优势;
 *   ② 头 + 尾切片 —— 开头通常是框定,结尾通常是结论。中段被丢,这是它的代价;
 *   ③ 全文指针 —— 与 A 一致,带工具的 consumer 可自 Read。
 */
function composeExtractiveView(full: string, anchors: string[], fullPath: string | null, side = 800): string {
  const head = full.slice(0, side);
  const tail = full.length > side * 2 ? full.slice(-side) : '';
  const pointer = fullPath ? `\n[full output ${full.length} chars → ${fullPath}]` : '';
  return [
    '<fan-in-extract>',
    `[artifacts ${anchors.length}] ${anchors.join(' ')}`,
    `[head] ${head}`,
    tail ? `[tail] ${tail}` : '',
    pointer,
    '</fan-in-extract>',
  ]
    .filter(Boolean)
    .join('\n');
}

interface Sample {
  file: string;
  runId: string;
  nodeId: string;
  full: string;
  producerGoal?: string;
  depGoals: string[];
  anchors: string[];
}

// ── 从盘上重建语料 ───────────────────────────────────────────────────────────
const files = execSync('find .omd/continuity -name "fanin-*.txt"').toString().trim().split('\n').filter(Boolean);
const samples: Sample[] = [];
let skipNoNode = 0;
let skipNoAnchor = 0;
let skipTooBig = 0;
for (const f of files) {
  const dir = f.slice(0, f.lastIndexOf('/'));
  const nodeId = f.slice(f.lastIndexOf('/fanin-') + 7, -4);
  const dagPath = `${dir}/_dag.json`;
  if (!existsSync(dagPath)) continue;
  let plan: { nodes?: Record<string, { goal?: string; depends_on?: string[] }> } | undefined;
  try {
    plan = (JSON.parse(readFileSync(dagPath, 'utf8')) as { plan?: typeof plan }).plan;
  } catch {
    continue; // 坏 JSON 不计进任何一格 —— 不假装看过
  }
  const node = plan?.nodes?.[nodeId];
  if (!node) {
    skipNoNode++;
    continue;
  }
  const full = readFileSync(f, 'utf8');
  const anchors = [...new Set(full.match(/(?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,5}/g) ?? [])].sort();
  if (!anchors.length) {
    skipNoAnchor++;
    continue;
  }
  if (full.length > CAP) {
    skipTooBig++;
    continue;
  }
  const depGoals = Object.entries(plan!.nodes!)
    .filter(([, n]) => (n.depends_on ?? []).includes(nodeId))
    .map(([, n]) => n.goal)
    .filter((g): g is string => typeof g === 'string' && g.length > 0);
  if (!depGoals.length) continue;
  samples.push({ file: f, runId: dir.split('/').pop()!, nodeId, full, ...(node.goal ? { producerGoal: node.goal } : {}), depGoals, anchors });
}

log(
  `语料 ${samples.length}/${files.length} 份 · 合计 ${(samples.reduce((a, s) => a + s.full.length, 0) / 1000).toFixed(0)}k 字符 · ` +
    `锚合计 ${samples.reduce((a, s) => a + s.anchors.length, 0)}`,
);
log(`  排除: 子图节点(plan 里无此 id) ${skipNoNode} · 零锚(尺子不适用) ${skipNoAnchor} · 超 ${CAP} 字符 ${skipTooBig}`);
if (!samples.length) {
  log('没有可用语料 —— 停。');
  process.exit(1);
}

bootstrapModelRuntime();
mkdirSync(OUT, { recursive: true });
const generate = makeDefaultGenerate('fanin-loss-measure');

interface Row {
  nodeId: string;
  chars: number;
  anchors: number;
  aOk: boolean;
  aLost?: number;
  aViewLen?: number;
  aSample?: string[];
  bLost?: number;
  bViewLen?: number;
}
const rows: Row[] = [];

for (const s of samples) {
  const row: Row = { nodeId: s.nodeId, chars: s.full.length, anchors: s.anchors.length, aOk: false };
  if (ARMS.includes('A')) {
    try {
      const { summaryJson } = await runFaninSummary({
        generate,
        model: MODEL,
        ...(s.producerGoal ? { producerGoal: s.producerGoal } : {}),
        output: s.full,
        depGoals: s.depGoals,
        schema: DEFAULT_FANIN_SCHEMA,
        traceName: `fanin-loss:${s.nodeId}`,
      });
      if (summaryJson) {
        // 指针传 null: 量的是**摘要本身**保了多少锚。带上指针路径会把指针里那个路径算成"保住了",
        // 而那是 composeFaninView 白送的一个锚, 不是摘要器的功劳。
        const view = composeFaninView(summaryJson, null, s.full.length);
        const l = faninAnchorLoss(s.full, view);
        row.aOk = true;
        row.aLost = l.lost;
        row.aViewLen = view.length;
        row.aSample = l.lostSample;
      }
    } catch (e) {
      log(`  ✖ A 臂 ${s.nodeId}: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  if (ARMS.includes('B')) {
    const view = composeExtractiveView(s.full, s.anchors, null);
    const l = faninAnchorLoss(s.full, view);
    row.bLost = l.lost;
    row.bViewLen = view.length;
  }
  rows.push(row);
  log(
    `  ${s.nodeId.slice(0, 28).padEnd(28)} ${String(row.chars).padStart(6)}字 ${String(row.anchors).padStart(4)}锚 · ` +
      `A ${row.aOk ? `丢${row.aLost} 视图${row.aViewLen}字` : '(失败)'} · B 丢${row.bLost} 视图${row.bViewLen}字`,
  );
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
// **每臂各自的分母**: B 是零 LLM 的, 它的读数不该因为 A 那一发失败就消失。
// 两臂共用一个 okRows 是"拿手边最像的那个数当分母"(S-19) 的教科书形状 —— 首版就是这么写的。
const aRows = rows.filter((r) => r.aOk);
const bRows = rows.filter((r) => r.bLost !== undefined);
const tot = (rs: Row[], f: (r: Row) => number): number => rs.reduce((a, r) => a + f(r), 0);
const pct = (rs: Row[], lost: number): string => {
  const an = tot(rs, (r) => r.anchors);
  return an ? (((an - lost) / an) * 100).toFixed(1) + '%' : 'n/a (这批没有锚 — 不适用, 不是满分)';
};
const aAnchors = tot(aRows, (r) => r.anchors);
const bAnchors = tot(bRows, (r) => r.anchors);
const aLostTotal = tot(aRows, (r) => r.aLost ?? 0);
const bLostTotal = tot(bRows, (r) => r.bLost ?? 0);
// 视图/原文长度比 —— 判据③ 的那个数。>1 = "摘要"比被摘的还长。
const ratio = (rs: Row[], f: (r: Row) => number): string =>
  rs.length ? (tot(rs, f) / tot(rs, (r) => r.chars)).toFixed(2) : 'n/a';
const lines = [
  '\n════════ fan-in 产物锚保留率: 第 0 档 (LLM 定向摘要) vs 第 1a 档 (程序化抽取) ════════',
  `摘要模型 ${MODEL} · 语料 ${samples.length} 份 (A 臂成功 ${aRows.length} · B 臂 ${bRows.length}) —— **两臂各算各的分母**`,
  '',
  `  A 第 0 档   锚 ${aAnchors} 丢 ${aLostTotal} (保留 ${pct(aRows, aLostTotal)}) · 视图均长 ${aRows.length ? Math.round(tot(aRows, (r) => r.aViewLen ?? 0) / aRows.length) : 0} 字 · 视图/原文 ${ratio(aRows, (r) => r.aViewLen ?? 0)}`,
  `  B 第 1a 档  锚 ${bAnchors} 丢 ${bLostTotal} (保留 ${pct(bRows, bLostTotal)}) · 视图均长 ${bRows.length ? Math.round(tot(bRows, (r) => r.bViewLen ?? 0) / bRows.length) : 0} 字 · 视图/原文 ${ratio(bRows, (r) => r.bViewLen ?? 0)}`,
  '',
  '判据 (跑之前写死, 见本文件头):',
  '  ① A 丢 0      → 摘要没在丢锚, 第 1 档省的只是一发便宜调用, **不值得做**;',
  '  ② A 丢 > 0    → 1a 有明确收益; 丢的是什么(下面的样本)决定这收益要不要紧;',
  '  ③ B 视图 ≫ A  → B 不是合并是没压缩, 成本从 LLM 转嫁到 consumer 的 input。',
  '',
  '⚠ 边界: A 是**定向**摘要(拿到了 depGoals), B 不是。本实验只能说「B 保锚更多」,',
  '   **不能说「B 总体更好」** —— 锚只是那句承诺里的一项, 不是摘要的全部价值。',
];
const lostSamples = aRows.filter((r) => (r.aLost ?? 0) > 0);
if (lostSamples.length) {
  lines.push('', 'A 臂丢掉的锚 (样本):');
  for (const r of lostSamples.slice(0, 8)) lines.push(`  ${r.nodeId}: 丢 ${r.aLost}/${r.anchors} → ${(r.aSample ?? []).join('  ')}`);
}
const report = lines.join('\n');
process.stdout.write(report + '\n');
writeFileSync(`${OUT}/report.md`, report);
writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));
log(`  → 写入 ${OUT}/`);
