/**
 * inproc-direct-2arm —— **inproc 座位的重测: M3 与 v4-flash 都直连官方 API**(owner 2026-08-14 要求)。
 *
 * ## 为什么要重测
 *
 * 此前 inproc 的两边读数**不在同一条通道上**:
 *   · M3 的 `adaptive` 读数来自**直连**(m3-thinking-mode.ts) —— 100% / 100%
 *   · v4-flash 的读数来自 `eval-thinking-ab`, 走**我们的 pi 通道**
 * 而 pi 通道对 M3 有两处已证实的接线问题(正文混 `<think>` · `thinking.type` 设不了),
 * 对 deepseek 则是另一套行为。**通道不同 ⇒ 那个对比夹带了"谁被接错线"这个第二变量。**
 * FanOutQA 首跑更明显: 经 gateway 的 v4-flash out 只有 264(**没开思考**), 直连一开思考是 7k–17k。
 *
 * ## 四要素
 *
 * - **单一变量** = 模型。通道(都直连官方 chat completions)· 题目(worker-quality 10 题)·
 *   system 前缀(都用 `LEAF_SYSTEM_PREFIX`, 与生产 inproc leaf 同)· max_tokens · 判据 全同。
 *   思考档都取**各自缺省/最佳**: M3 显式 `thinking:{type:'adaptive'}`(该端点缺省即 adaptive,
 *   写死免得默认漂); deepseek 不传(官网口径缺省即 thinking 档)。
 * - **对照基线 + 噪声地板** = 两个模型各带一个 `·control` 臂(同配置重跑)。
 * - **成败信号**(跑前钉死): 正确分与格式守之差 **超过噪声地板**才算读得出;
 *   在地板内 = 两边打平, 那时按**成本/延迟**裁, 不许拿地板内的差编故事。
 * - **两侧都收**: 正确分 · 格式守 · out token · 延迟 · 逐题分布。
 *
 * ⚠ 已知边界: worker-quality 这 10 题在**开思考档**上对两边都接近饱和(此前 M3 adaptive 100%、
 *   v4-flash 各档 100%)。真要分辨力得看 FanOutQA(见 fanoutqa-2arm.ts)。本脚本的价值是
 *   **把通道这个混杂变量消掉**, 而不是指望它分出胜负。
 *
 * 跑: MINIMAX_CN_API_KEY=$MINIMAX_API_KEY bun --env-file=.env run scripts/probes/inproc-direct-2arm.ts [--n 3]
 */
import '../../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LEAF_SYSTEM_PREFIX } from '../../src/harness/dag/defaults';
import { WORKER_TASKS, type WorkerGrade } from '../../src/eval/tasks/worker-quality';
import { stripThink } from './strip-think';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '3'));
const MAX_TOKENS = Math.max(1024, Number(opt('max-tokens') ?? '32768'));
const OUT = opt('out') ?? '.omd/eval/inproc-direct';
const log = (s: string): void => void process.stderr.write(s + '\n');

interface Arm {
  name: string;
  vendor: 'minimax' | 'deepseek';
  model: string;
}
const ARMS: Arm[] = [
  { name: 'm3', vendor: 'minimax', model: 'MiniMax-M3' },
  { name: 'm3·control', vendor: 'minimax', model: 'MiniMax-M3' },
  { name: 'v4-flash', vendor: 'deepseek', model: 'deepseek-v4-flash' },
  { name: 'v4-flash·control', vendor: 'deepseek', model: 'deepseek-v4-flash' },
];

interface Trial {
  arm: string;
  task: string;
  kind: string;
  rep: number;
  score: number;
  formatOk: boolean;
  outTokens: number;
  truncated: boolean;
  hadThink: boolean;
  latencyMs: number;
  note?: string;
  error?: string;
}

async function call(arm: Arm, prompt: string): Promise<{ text: string; out: number }> {
  const isMM = arm.vendor === 'minimax';
  const url = isMM ? 'https://api.minimaxi.com/v1/text/chatcompletion_v2' : 'https://api.deepseek.com/chat/completions';
  const key = isMM ? (process.env.MINIMAX_CN_API_KEY ?? process.env.MINIMAX_API_KEY) : process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error(`${arm.vendor}: 缺 API key`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: arm.model,
      messages: [
        { role: 'system', content: LEAF_SYSTEM_PREFIX },
        { role: 'user', content: prompt },
      ],
      max_tokens: MAX_TOKENS,
      ...(isMM ? { thinking: { type: 'adaptive' } } : {}),
    }),
  });
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { completion_tokens?: number; total_tokens?: number; prompt_tokens?: number };
    base_resp?: { status_code?: number; status_msg?: string };
    error?: { message?: string };
  };
  if (j.error?.message) throw new Error(`${arm.vendor}: ${j.error.message}`);
  if (j.base_resp && j.base_resp.status_code !== 0) throw new Error(`${arm.vendor}: ${j.base_resp.status_msg}`);
  const u = j.usage ?? {};
  return {
    text: j.choices?.[0]?.message?.content ?? '',
    out: u.completion_tokens ?? Math.max(0, (u.total_tokens ?? 0) - (u.prompt_tokens ?? 0)),
  };
}

async function trial(arm: Arm, task: (typeof WORKER_TASKS)[number], rep: number): Promise<Trial> {
  const t0 = Date.now();
  const base = { arm: arm.name, task: task.id, kind: task.kind, rep, score: 0, formatOk: false, outTokens: 0, truncated: false, hadThink: false, latencyMs: 0 };
  try {
    const r = await call(arm, task.prompt);
    // 直连档实测两边正文都干净; 仍过一遍剥离(幂等), 免得端点某天改了返回形态而读数悄悄变。
    const s = stripThink(r.text);
    const g: WorkerGrade = await task.grade(s.body);
    return {
      ...base,
      score: g.score,
      formatOk: g.formatOk,
      outTokens: r.out,
      truncated: r.out >= MAX_TOKENS - 64,
      hadThink: s.hadThink,
      latencyMs: Date.now() - t0,
      ...(g.note ? { note: g.note } : {}),
    };
  } catch (e) {
    return { ...base, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

mkdirSync(OUT, { recursive: true });
const jobs: { arm: Arm; task: (typeof WORKER_TASKS)[number]; rep: number }[] = [];
for (const arm of ARMS) for (const task of WORKER_TASKS) for (let rep = 1; rep <= N; rep++) jobs.push({ arm, task, rep });
log(`inproc 直连 A/B: ${ARMS.length} 臂 × ${WORKER_TASKS.length} 题 × ${N} 次 = ${jobs.length} 次调用`);

const trials: Trial[] = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
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
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
let md = `# inproc 直连 A/B (worker-quality 10 题, N=${N}, 两边均直连官方 API)\n\n`;
md += `| 臂 | 题次 | 正确分 | 格式守 | 平均out | 中位延迟 | 撞顶 | 正文含think | 错 |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const arm of ARMS) {
  const xs = trials.filter((t) => t.arm === arm.name && !t.error);
  const lat = xs.map((t) => t.latencyMs).sort((a, b) => a - b);
  md +=
    `| ${arm.name} | ${xs.length} | ${pct(xs.map((t) => t.score))} | ${pct(xs.map((t) => (t.formatOk ? 1 : 0)))} | ` +
    `${avg(xs.map((t) => t.outTokens)).toFixed(0)} | ${((lat[Math.floor(lat.length / 2)] ?? 0) / 1000).toFixed(1)}s | ` +
    `${pct(xs.map((t) => (t.truncated ? 1 : 0)))} | ${pct(xs.map((t) => (t.hadThink ? 1 : 0)))} | ` +
    `${trials.filter((t) => t.arm === arm.name && t.error).length} |\n`;
}
md += `\n## 逐题正确分\n\n| 题目 | ${ARMS.map((a) => a.name).join(' | ')} |\n|---|${ARMS.map(() => '---').join('|')}|\n`;
for (const task of WORKER_TASKS) {
  md += `| ${task.id} | ${ARMS.map((a) => pct(trials.filter((t) => t.arm === a.name && t.task === task.id && !t.error).map((t) => t.score))).join(' | ')} |\n`;
}
const g = (n: string, f: (t: Trial) => number): number => avg(trials.filter((t) => t.arm === n && !t.error).map(f));
md += `\n噪声地板 m3: 正确分 ${(Math.abs(g('m3', (t) => t.score) - g('m3·control', (t) => t.score)) * 100).toFixed(1)}pp · `;
md += `格式守 ${(Math.abs(g('m3', (t) => (t.formatOk ? 1 : 0)) - g('m3·control', (t) => (t.formatOk ? 1 : 0))) * 100).toFixed(1)}pp\n`;
md += `噪声地板 v4-flash: 正确分 ${(Math.abs(g('v4-flash', (t) => t.score) - g('v4-flash·control', (t) => t.score)) * 100).toFixed(1)}pp · `;
md += `格式守 ${(Math.abs(g('v4-flash', (t) => (t.formatOk ? 1 : 0)) - g('v4-flash·control', (t) => (t.formatOk ? 1 : 0))) * 100).toFixed(1)}pp\n`;
const errs = trials.filter((t) => t.error);
if (errs.length) md += `\n调用出错 ${errs.length} 次: ${[...new Set(errs.map((e) => e.error))].slice(0, 3).join(' · ')}\n`;
writeFileSync(`${OUT}/report.md`, md);
writeFileSync(`${OUT}/trials.json`, JSON.stringify(trials, null, 2));
log('\n' + md);
log(`→ 落盘 ${OUT}/`);
