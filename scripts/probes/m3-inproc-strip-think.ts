/**
 * m3-inproc-strip-think —— **M3 的 inproc 读数到底是模型的还是解析层的**。
 *
 * ## 为什么有这个脚本
 *
 * 2026-08-14 首跑 `eval-thinking-ab --model minimax-cn:MiniMax-M3`: 格式守 **33~40%**
 * (基线 deepseek-v4-flash 同题同判据 100%)。差 60 个百分点, 噪声地板 1.2pp —— 看上去是碾压性的负判词。
 *
 * **读判词之前先读了原文**, 于是发现塌的不是模型: M3 把推理用 `<think>…</think>` **内联在正文里**回,
 * 而 omd 全仓对 `<think>` 零处理 (`ugrep -rn 'think>' src/` 零命中) —— 于是 `JSON.parse` 在第一个
 * 字符就炸。剥掉那段之后, `</think>` 后面跟的是**完全正确、无围栏的 JSON**。
 * 「格式守 33%」量的是 omd 的解析层, 不是 M3 的服从度。
 *
 * 这就是仓规那条的又一个实例: **一个读数在下结论前先读它的理由**。把它当模型缺陷记进账,
 * 会把一个一行就能修的适配缺口, 写成"M3 不能当 inproc 座"的永久判词。
 *
 * ## 四要素
 *
 * - **单一变量** = 剥不剥 `<think>`。模型/题目/prompt/thinking 档 (low) /maxTokens 全同。
 * - **对照基线** = 同一次跑里的 `m3·raw` 臂 (复现首跑的塌) + `m3·strip·control` (噪声地板);
 *   跨模型基线引 `.omd/eval/inproc-base` (deepseek-v4-flash, 同题同判据同 thinking=low, 同日)。
 * - **预先声明的成败信号**: `m3·strip` 的**格式守**若回到 ≥90%, 则首跑那 60pp 差归因于解析层成立;
 *   若仍 <60%, 则剥离不是主因, M3 确实不守格式 —— 两侧都是结论, 都要写进报告。
 * - **收什么数**: 正确分 · 格式守 · 逐题 · out token · 延迟; 以及剥离前后**同一批回复**的对照
 *   (raw 与 strip 跑的是各自独立的调用, 不共享回复 —— 共享会让"剥离"与"重采样"混成一个变量)。
 *
 * 跑: MINIMAX_CN_API_KEY=$MINIMAX_API_KEY bun --env-file=.env run scripts/probes/m3-inproc-strip-think.ts [--n 3]
 */
import '../../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';
import { send } from '../../src/model/gateway';
import { LEAF_SYSTEM_PREFIX } from '../../src/harness/dag/defaults';
import { WORKER_TASKS, type WorkerGrade } from '../../src/eval/tasks/worker-quality';
// ⚠ 纯函数留在独立模块里 —— 本文件顶层就在跑 A/B, 谁 import 它谁就点火 (2026-08-14 实测烧了 100 次调用)。
import { stripThink } from '../../src/model/strip-think';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '3'));
const MODEL = opt('model') ?? 'minimax-cn:MiniMax-M3';
const OUT = opt('out') ?? '.omd/eval/m3-inproc-strip';
const log = (s: string): void => void process.stderr.write(s + '\n');

interface Arm {
  name: string;
  strip: boolean;
  note: string;
}
const ARMS: Arm[] = [
  { name: 'm3·raw', strip: false, note: '生产今天的行为 —— gateway 原样把 <think> 交给下游' },
  { name: 'm3·strip', strip: true, note: '剥掉闭合的 <think> 段再判' },
  { name: 'm3·strip·control', strip: true, note: '复制 strip —— 本轮噪声地板' },
];

interface Trial {
  arm: string;
  task: string;
  kind: string;
  rep: number;
  score: number;
  formatOk: boolean;
  hadThink: boolean;
  unclosed: boolean;
  outTokens: number;
  latencyMs: number;
  note?: string;
  error?: string;
}

async function trial(arm: Arm, task: (typeof WORKER_TASKS)[number], rep: number): Promise<Trial> {
  const t0 = Date.now();
  const base = {
    arm: arm.name,
    task: task.id,
    kind: task.kind,
    rep,
    score: 0,
    formatOk: false,
    hadThink: false,
    unclosed: false,
    outTokens: 0,
    latencyMs: 0,
  };
  try {
    const r = await send({
      model: MODEL,
      messages: [
        { role: 'system', content: LEAF_SYSTEM_PREFIX },
        { role: 'user', content: task.prompt },
      ],
      thinkingLevel: 'low',
      maxTokens: 8192,
    });
    const raw = r.text ?? '';
    const s = stripThink(raw);
    const judged = arm.strip ? s.body : raw;
    const g: WorkerGrade = await task.grade(judged);
    return {
      ...base,
      score: g.score,
      formatOk: g.formatOk,
      hadThink: s.hadThink,
      unclosed: s.unclosed,
      outTokens: r.usage?.out ?? 0,
      latencyMs: Date.now() - t0,
      ...(g.note ? { note: g.note } : {}),
    };
  } catch (e) {
    return { ...base, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

bootstrapModelRuntime();
mkdirSync(OUT, { recursive: true });
const jobs: { arm: Arm; task: (typeof WORKER_TASKS)[number]; rep: number }[] = [];
for (const arm of ARMS) for (const task of WORKER_TASKS) for (let rep = 1; rep <= N; rep++) jobs.push({ arm, task, rep });
log(`strip-think A/B: ${MODEL} · ${ARMS.length} 臂 × ${WORKER_TASKS.length} 题 × ${N} 次 = ${jobs.length} 次调用`);

const trials: Trial[] = [];
const CONC = 4;
let cursor = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const j = jobs[i]!;
      trials.push(await trial(j.arm, j.task, j.rep));
      if (trials.length % 20 === 0) log(`  ${trials.length}/${jobs.length}`);
    }
  }),
);

const pct = (xs: number[]): string => (xs.length ? `${((xs.reduce((a, b) => a + b, 0) / xs.length) * 100).toFixed(0)}%` : '—');
let md = `# M3 inproc · <think> 剥离 A/B (${MODEL}, N=${N})\n\n`;
md += `| 臂 | 题次 | 正确分 | 格式守 | 带 think | 未闭合 | 平均out | 中位延迟 |\n|---|---|---|---|---|---|---|---|\n`;
const lines: string[] = [];
for (const arm of ARMS) {
  const xs = trials.filter((t) => t.arm === arm.name && !t.error);
  const lat = xs.map((t) => t.latencyMs).sort((a, b) => a - b);
  const row =
    `| ${arm.name} | ${xs.length} | ${pct(xs.map((t) => t.score))} | ${pct(xs.map((t) => (t.formatOk ? 1 : 0)))} | ` +
    `${pct(xs.map((t) => (t.hadThink ? 1 : 0)))} | ${pct(xs.map((t) => (t.unclosed ? 1 : 0)))} | ` +
    `${Math.round(xs.reduce((a, b) => a + b.outTokens, 0) / (xs.length || 1))} | ${((lat[Math.floor(lat.length / 2)] ?? 0) / 1000).toFixed(1)}s |`;
  md += row + '\n';
  lines.push(row);
}
md += `\n## 逐题格式守\n\n| 题目 | ${ARMS.map((a) => a.name).join(' | ')} |\n|---|${ARMS.map(() => '---').join('|')}|\n`;
for (const task of WORKER_TASKS) {
  const cells = ARMS.map((a) => pct(trials.filter((t) => t.arm === a.name && t.task === task.id && !t.error).map((t) => (t.formatOk ? 1 : 0))));
  md += `| ${task.id} | ${cells.join(' | ')} |\n`;
}
const errs = trials.filter((t) => t.error);
if (errs.length) md += `\n调用出错 ${errs.length} 次: ${[...new Set(errs.map((e) => e.error))].slice(0, 3).join(' · ')}\n`;
writeFileSync(`${OUT}/report.md`, md);
writeFileSync(`${OUT}/trials.json`, JSON.stringify(trials, null, 2));
log('\n' + md);
log(`→ 存盘 ${OUT}/`);
