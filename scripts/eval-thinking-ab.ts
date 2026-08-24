/**
 * eval-thinking-ab —— **量产座位 `thinking=low` 的质量影响实测** (P2-d ③, 2026-07-29)。
 *
 * 补的缺口: 2026-07-29 把 leaf/agent/lens/expand/distill/overflow/continuity 七个量产座位整体降到
 * `thinking=low`, 依据只有成本 (reasoning token 按 output 计价, 而 output 是缓存命中价的 15.7 倍)。
 * **质量在 mimo 上实测无差, 在 deepseek 上没测过** —— 而这两家的档位语义根本不同
 * (`model-caps.ts:29` 的官方口径: deepseek 的 low/medium **等同 high**)。若那句话为真, 这次降档
 * 既没省到钱也没伤到质量, 整件事是空的; 若为假, 就得知道伤在哪。这个脚本先答"到底动没动",
 * 再答"动了之后活干得怎么样"。
 *
 * 三条臂只差一个字段 (thinkingLevel), 模型/prompt/题目全同 —— 单变量:
 *   low      生产今天的值
 *   off      不发 reasoning_effort (provider 默认档; 也是所有没走座位表的调用路径的实际行为)
 *   high     配置里给校验/大脑簇的那档
 *   ·control 复制 low 再跑一遍 = 本轮的**噪声地板**; 两臂差值没超过它就是没差
 *
 * 判据全确定性 (src/eval/tasks/worker-quality.ts): 生成的代码进子进程真跑, JSON 真解析,
 * 数值真对答案。一个判官都不请 —— 判官自己就有档位偏好, 拿它评档位是自证。
 *
 * 跑: bun --env-file=.env run scripts/eval-thinking-ab.ts [--n 5] [--model deepseek:deepseek-v4-flash]
 */
import '../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import { computeCost } from '../src/model/cost-ledger';
import { LEAF_SYSTEM_PREFIX } from '../src/harness/dag/defaults';
import { WORKER_TASKS, type WorkerGrade } from '../src/eval/tasks/worker-quality';
import { tryResolveSeatModel, type ThinkingLevel } from '../src/model/role-models';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '5'));
// 默认跟 `leaf` 座走 (2026-08-03): 这个脚本量的是"worker 档的 thinking 旋钮有没有用",
// 而 worker 主力就是 leaf 座。坐标仍可 --model 覆盖 —— 它本来就是这个实验的自变量。
const leafSeat = tryResolveSeatModel('leaf');
const MODEL = opt('model') ?? leafSeat?.model;
if (!MODEL) {
  process.stderr.write('eval-thinking-ab: `leaf` 座位解析不出模型, 且没给 --model\n');
  process.exit(2);
}
const MODEL_COORD: string = MODEL;
/**
 * 「这个读数属于哪个座位」的凭据 —— 起跑打一次, 且**写进 report.md**。
 * 只打 stderr 不够: 报告是留下来的那份, 而座位漂了正是从报告里看不出来的 (见 seat-sourced.test.ts)。
 */
const SEAT_PROVENANCE = opt('model') ? ' (--model 覆盖)' : ` (leaf 座 · 来源 ${leafSeat?.source})`;
const CONCURRENCY = Math.max(1, Number(opt('concurrency') ?? '4'));
const OUT = opt('out') ?? '.omd/eval/thinking-ab';
const only = opt('tasks')?.split(',').map((s) => s.trim()).filter(Boolean);

interface Arm {
  name: string;
  thinking?: ThinkingLevel;
  note: string;
}
const ARMS: Arm[] = [
  { name: 'low', thinking: 'low', note: '生产今天的量产座位档' },
  { name: 'off', thinking: undefined, note: '不发 reasoning_effort (provider 默认)' },
  { name: 'high', thinking: 'high', note: '大脑簇/校验那档' },
  { name: 'low·control', thinking: 'low', note: '复制 low —— 本轮噪声地板' },
];

const log = (s: string): void => void process.stderr.write(s + '\n');

interface Trial {
  arm: string;
  task: string;
  kind: string;
  rep: number;
  score: number;
  formatOk: boolean;
  note?: string;
  usage: { in: number; out: number; cacheHit: number };
  costUsd: number;
  latencyMs: number;
  outputChars: number;
  error?: string;
}

async function trial(arm: Arm, task: (typeof WORKER_TASKS)[number], rep: number): Promise<Trial> {
  const t0 = Date.now();
  const base = { arm: arm.name, task: task.id, kind: task.kind, rep };
  try {
    const r = await send({
      model: MODEL_COORD,
      // 与 inproc leaf 同一 system 前缀 —— 那是量产座位真实吃到的上下文, 换一个就不是在测同一件事。
      messages: [
        { role: 'system', content: LEAF_SYSTEM_PREFIX },
        { role: 'user', content: task.prompt },
      ],
      ...(arm.thinking ? { thinkingLevel: arm.thinking } : {}),
      maxTokens: 8192,
    });
    const text = r.text ?? '';
    const g: WorkerGrade = await task.grade(text);
    const usage = { in: r.usage?.in ?? 0, out: r.usage?.out ?? 0, cacheHit: r.usage?.cacheHit ?? 0 };
    return {
      ...base,
      score: g.score,
      formatOk: g.formatOk,
      ...(g.note ? { note: g.note } : {}),
      usage,
      costUsd: computeCost({ in: usage.in, out: usage.out, cacheHit: usage.cacheHit }, MODEL_COORD).costUsd ?? 0, // 订阅通道 → 0 USD 计入合计 (行级真相在 channel 列)
      latencyMs: Date.now() - t0,
      outputChars: text.length,
    };
  } catch (e) {
    return {
      ...base,
      score: 0,
      formatOk: false,
      usage: { in: 0, out: 0, cacheHit: 0 },
      costUsd: 0,
      latencyMs: Date.now() - t0,
      outputChars: 0,
      error: (e as Error).message.slice(0, 200),
    };
  }
}

async function pooled<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      for (let i = next++; i < jobs.length; i = next++) out[i] = await jobs[i]!();
    }),
  );
  return out;
}

bootstrapModelRuntime();
const tasks = WORKER_TASKS.filter((t) => !only || only.includes(t.id));
log(`thinking A/B: ${MODEL}${SEAT_PROVENANCE} · ${ARMS.length} 臂 × ${tasks.length} 题 × ${N} 次 = ${ARMS.length * tasks.length * N} 次调用`);

const jobs: (() => Promise<Trial>)[] = [];
for (const arm of ARMS) for (const t of tasks) for (let r = 0; r < N; r++) jobs.push(() => trial(arm, t, r));
let done = 0;
const trials = await pooled(
  jobs.map((j) => async () => {
    const t = await j();
    if (++done % 20 === 0) log(`  ${done}/${jobs.length}`);
    return t;
  }),
  CONCURRENCY,
);

// ── 报告 ──────────────────────────────────────────────────────────────────────
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number): string => `${(x * 100).toFixed(0).padStart(3)}%`;
const byArm = (name: string): Trial[] => trials.filter((t) => t.arm === name);

const lines: string[] = ['', `════════ 量产座位 thinking 档 A/B (${MODEL}${SEAT_PROVENANCE} · 确定性判据, 无判官) ════════`, ''];
for (const a of ARMS) lines.push(`${a.name.padEnd(12)} thinking=${a.thinking ?? '(不发)'} —— ${a.note}`);
lines.push('');
lines.push('臂            题次  正确分  满分率  格式守  平均out  平均in  $/1000次  中位延迟');
for (const a of ARMS) {
  const rs = byArm(a.name);
  const lat = rs.map((t) => t.latencyMs).sort((x, y) => x - y);
  lines.push(
    [
      a.name.padEnd(12),
      String(rs.length).padStart(4),
      pct(mean(rs.map((t) => t.score))),
      pct(rs.filter((t) => t.score === 1).length / Math.max(1, rs.length)),
      pct(rs.filter((t) => t.formatOk).length / Math.max(1, rs.length)),
      Math.round(mean(rs.map((t) => t.usage.out))).toString().padStart(7),
      Math.round(mean(rs.map((t) => t.usage.in))).toString().padStart(6),
      `$${(mean(rs.map((t) => t.costUsd)) * 1000).toFixed(2)}`.padStart(8),
      `${((lat[lat.length >> 1] ?? 0) / 1000).toFixed(1)}s`.padStart(8),
    ].join('  '),
  );
}

lines.push('', `逐题正确分 (N=${N}):`);
lines.push('题目                    ' + ARMS.map((a) => a.name.padEnd(13)).join(''));
for (const t of tasks) {
  const cells = ARMS.map((a) => pct(mean(byArm(a.name).filter((x) => x.task === t.id).map((x) => x.score))).padEnd(13));
  lines.push(`${t.id.padEnd(24)}${cells.join('')}`);
}

lines.push('', '按题型:');
for (const kind of [...new Set(tasks.map((t) => t.kind))]) {
  const cells = ARMS.map((a) => pct(mean(byArm(a.name).filter((x) => x.kind === kind).map((x) => x.score))).padEnd(13));
  lines.push(`${kind.padEnd(24)}${cells.join('')}`);
}

const noiseFloor = Math.abs(mean(byArm('low').map((t) => t.score)) - mean(byArm('low·control').map((t) => t.score)));
lines.push(
  '',
  `噪声地板 (low vs low·control) = ${(noiseFloor * 100).toFixed(1)} 个百分点 —— 任何小于它的臂间差都读不出来。`,
);
const errs = trials.filter((t) => t.error);
if (errs.length) lines.push(`调用出错 ${errs.length} 次: ${[...new Set(errs.map((t) => t.error))].slice(0, 3).join(' | ')}`);
lines.push(
  '',
  '读法: **平均out** 先看 —— 若三臂几乎相同, 说明 deepseek 根本没把 low/high 当回事 (官方口径「low/medium 等同 high」),',
  '      那么降档既没省钱也没伤质量, 这个旋钮在 deepseek 上是空的。out 有差再往左看质量列。',
  '      **格式守**比正确分更该看: 量产座位的产出是给下游程序吃的, 格式破了下游直接崩。',
);

const report = lines.join('\n');
process.stdout.write(report + '\n');
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/report.md`, report);
writeFileSync(`${OUT}/trials.json`, JSON.stringify(trials, null, 2));
log(`  → 存盘 ${OUT}/`);
