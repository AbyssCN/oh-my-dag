/**
 * m3-thinking-mode —— **M3 的 thinking 到底能不能关, 关了值不值** (owner 2026-08-14 问)。
 *
 * ## 先纠正两个此前的判词(都是我下早了)
 *
 * 1. ~~「M3 关不掉 thinking」~~ —— 错。经 gateway 发 `reasoning_effort` 六档全无差(实测),
 *    但那是**我们没接对**: minimax 用自己的 `thinking.type`, 不认 OpenAI 那个键。
 *    官方三处一致(platform.minimax.io/docs/api-reference/responses-create ·
 *    infini-ai 接入文档 · vLLM recipes): M3 支持 `disabled`/`adaptive`, **M2.x 才是真关不掉**。
 *    ⚠ 各端点缺省还不同: OpenAI-compatible Chat Completions **省略 = adaptive(开着)**,
 *    Anthropic-compatible / Responses API **省略 = 关**。我们走前者, 所以一直在思考。
 * 2. ~~「M3 把推理内联在正文」~~ —— 半错。**直连 API 时 `content` 是干净的**, 推理在
 *    `reasoning_content` 单独字段; 经 pi 通道拿到的 text 才混着 `<think>`。
 *    脏在通道, 不在模型。
 *
 * ## 为什么直连而不是走 gateway
 *
 * `thinking.type` 是 minimax 私有参数, 我们的 pi 通道没有透传口。**先证明值不值得接线, 再谈接线**
 * —— 反过来就是为一个没量过的收益改生产码。
 *
 * ## 四要素
 *
 * - **单一变量** = `thinking` 字段。题目 / prompt / max_tokens / 端点 / key 全同。
 * - **对照基线** = `omit`(省略 = 生产今天经 pi 的实际行为) + `adaptive·control`(噪声地板)。
 * - **成败信号**(跑前钉死): `disabled` 若把 **out token 降 ≥2×** 且 **正确分与格式守的跌幅 ≤ 噪声地板**
 *   → 值得接线; 若质量跌幅超地板 → 这是**用质量换成本**, 该由 owner 按座位分别裁, 不是无脑开。
 *   首个样本已见疑似质量代价(`"type":"int"` 而非要求的 `"number"`), 所以两侧都要收数。
 * - **收什么数**: 正确分 · 格式守 · out token · 延迟 · 有无 reasoning_content。
 *
 * 跑: MINIMAX_CN_API_KEY=$MINIMAX_API_KEY bun --env-file=.env run scripts/probes/m3-thinking-mode.ts [--n 3]
 */
import '../../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LEAF_SYSTEM_PREFIX } from '../../src/harness/dag/defaults';
import { WORKER_TASKS, type WorkerGrade } from '../../src/eval/tasks/worker-quality';
import { stripThink } from '../../src/model/strip-think';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '3'));
const OUT = opt('out') ?? '.omd/eval/m3-thinking-mode';
const ENDPOINT = 'https://api.minimaxi.com/v1/text/chatcompletion_v2';
const KEY = process.env.MINIMAX_CN_API_KEY ?? process.env.MINIMAX_API_KEY;
const log = (s: string): void => void process.stderr.write(s + '\n');
if (!KEY) {
  log('m3-thinking-mode: 缺 MINIMAX_CN_API_KEY / MINIMAX_API_KEY');
  process.exit(2);
}

interface Arm {
  name: string;
  extra: Record<string, unknown>;
  note: string;
}
const ARMS: Arm[] = [
  { name: 'omit', extra: {}, note: '省略 thinking = 生产今天的行为 (该端点缺省 adaptive)' },
  { name: 'disabled', extra: { thinking: { type: 'disabled' } }, note: '显式关思考' },
  { name: 'adaptive', extra: { thinking: { type: 'adaptive' } }, note: '显式开自适应思考' },
  { name: 'omit·control', extra: {}, note: '复制 omit —— 本轮噪声地板' },
];

interface Trial {
  arm: string;
  task: string;
  kind: string;
  rep: number;
  score: number;
  formatOk: boolean;
  outTokens: number;
  latencyMs: number;
  hasReasoning: boolean;
  hadThinkInBody: boolean;
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
    outTokens: 0,
    latencyMs: 0,
    hasReasoning: false,
    hadThinkInBody: false,
  };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'MiniMax-M3',
        messages: [
          { role: 'system', content: LEAF_SYSTEM_PREFIX },
          { role: 'user', content: task.prompt },
        ],
        max_tokens: 32768,
        ...arm.extra,
      }),
    });
    const j = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = j.choices?.[0]?.message ?? {};
    const raw = msg.content ?? '';
    // 通道若仍把推理内联进正文, 照样剥掉再判 —— 判的是"正文对不对", 不是"它话多不多"。
    const s = stripThink(raw);
    const g: WorkerGrade = await task.grade(s.body);
    const u = j.usage ?? {};
    return {
      ...base,
      score: g.score,
      formatOk: g.formatOk,
      outTokens: u.completion_tokens ?? (u.total_tokens ?? 0) - (u.prompt_tokens ?? 0),
      latencyMs: Date.now() - t0,
      hasReasoning: Boolean(msg.reasoning_content),
      hadThinkInBody: s.hadThink,
      ...(g.note ? { note: g.note } : {}),
    };
  } catch (e) {
    return { ...base, latencyMs: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

mkdirSync(OUT, { recursive: true });
const jobs: { arm: Arm; task: (typeof WORKER_TASKS)[number]; rep: number }[] = [];
for (const arm of ARMS) for (const task of WORKER_TASKS) for (let rep = 1; rep <= N; rep++) jobs.push({ arm, task, rep });
log(`M3 thinking mode: ${ARMS.length} 臂 × ${WORKER_TASKS.length} 题 × ${N} 次 = ${jobs.length} 次调用 (直连 ${ENDPOINT})`);

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
let md = `# M3 thinking mode A/B (直连 minimaxi, N=${N})\n\n`;
md += `| 臂 | 题次 | 正确分 | 格式守 | 平均out | 中位延迟 | 有reasoning字段 | 正文含think | 说明 |\n`;
md += `|---|---|---|---|---|---|---|---|---|\n`;
for (const arm of ARMS) {
  const xs = trials.filter((t) => t.arm === arm.name && !t.error);
  const lat = xs.map((t) => t.latencyMs).sort((a, b) => a - b);
  md +=
    `| ${arm.name} | ${xs.length} | ${pct(xs.map((t) => t.score))} | ${pct(xs.map((t) => (t.formatOk ? 1 : 0)))} | ` +
    `${avg(xs.map((t) => t.outTokens)).toFixed(0)} | ${((lat[Math.floor(lat.length / 2)] ?? 0) / 1000).toFixed(1)}s | ` +
    `${pct(xs.map((t) => (t.hasReasoning ? 1 : 0)))} | ${pct(xs.map((t) => (t.hadThinkInBody ? 1 : 0)))} | ${arm.note} |\n`;
}
md += `\n## 逐题正确分\n\n| 题目 | ${ARMS.map((a) => a.name).join(' | ')} |\n|---|${ARMS.map(() => '---').join('|')}|\n`;
for (const task of WORKER_TASKS) {
  md += `| ${task.id} | ${ARMS.map((a) => pct(trials.filter((t) => t.arm === a.name && t.task === task.id && !t.error).map((t) => t.score))).join(' | ')} |\n`;
}
const g = (n: string, f: (t: Trial) => number): number => avg(trials.filter((t) => t.arm === n && !t.error).map(f));
md += `\n噪声地板 (omit vs omit·control): 正确分 ${Math.abs(g('omit', (t) => t.score) - g('omit·control', (t) => t.score)) * 100}pp\n`;
const errs = trials.filter((t) => t.error);
if (errs.length) md += `\n调用出错 ${errs.length} 次: ${[...new Set(errs.map((e) => e.error))].slice(0, 3).join(' · ')}\n`;
writeFileSync(`${OUT}/report.md`, md);
writeFileSync(`${OUT}/trials.json`, JSON.stringify(trials, null, 2));
log('\n' + md);
log(`→ 存盘 ${OUT}/`);
