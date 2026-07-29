/**
 * eval-conductor-judge —— **conductor 节点内环 judge 实测** (P3 D-E, 2026-07-29)。
 *
 * 为什么必须单独测, 不能借外层那组 100%:
 *   ① 打的是**另一份 prompt** (`plan/conductor-judge.ts`)。外层判"整轮 run 达成没有", 内环判
 *      "这一个节点的 goal 达成没有" —— 目标窄一截, 语气与 id 空间都不同。
 *   ② 内环**把可点名的 id 明写进 prompt**, 外层不写 (外层的 id 空间就是整张图, 模型看得见;
 *      内环的 id 是内容寻址的 `parent::fp`, 不给清单模型只能猜)。这条差异恰好会改幽灵率。
 *   ③ D-F 撤外层之后, **内环 judge 是唯一还在判的那个**。它的点名质量直接决定毒集还剩多少价值。
 *
 * 量法承 `eval-judge-fillrate.ts`: 复用同一份固定语料 (`src/eval/tasks/judge-rounds.ts`) 与同一套
 * 四分类, 只把渲染换成**内环那种**汇总格式, 并调生产那两个函数 (prompt / parse) —— 抄一份去测
 * 测的就是抄的那份。
 *
 * 跑: bun --env-file=.env run scripts/eval-conductor-judge.ts [--n 10] [--cases fabricated,...]
 */
import '../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import {
  conductorJudgePrompt,
  parseConductorVerdict,
  renderRoundForJudge,
  CONDUCTOR_JUDGE_MAX_TOKENS,
} from '../src/harness/plan/conductor-judge';
import { JUDGE_ROUND_CASES, type JudgeRoundCase } from '../src/eval/tasks/judge-rounds';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '10'));
const only = opt('cases')?.split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(opt('concurrency') ?? '4'));
const OUT = opt('out') ?? '.omd/eval/conductor-judge';

const JUDGE_SEAT = 'deepseek:deepseek-v4-pro';
const CONDUCTOR_SEAT = 'deepseek:deepseek-v4-pro';
const LEAF_SEAT = 'deepseek:deepseek-v4-flash';

interface Arm {
  name: string;
  note: string;
  model: string;
  thinking?: 'low' | 'high';
}
const ARMS: Arm[] = [
  // 生产今天的真实调用: judgeModel 没配 → 回落 conductorModel, thinkingLevel 走座位档/high。
  { name: 'as-shipped', note: `${CONDUCTOR_SEAT} · high (judgeModel 未配 → 回落 conductor 座位)`, model: CONDUCTOR_SEAT, thinking: 'high' },
  { name: 'judge-seat', note: `${JUDGE_SEAT} · high (显式配 judgeModel 时)`, model: JUDGE_SEAT, thinking: 'high' },
  // 便宜档: 内环 judge 每个 conductor 节点每轮一次, 比外层贵得多 —— 值不值得降档要有数。
  { name: 'flash-cheap', note: `${LEAF_SEAT} · high (降档省钱可行否)`, model: LEAF_SEAT, thinking: 'high' },
];

const log = (s: string): void => void process.stderr.write(s + '\n');

/** 内容寻址的子节点 id (D-B 的形状: `parent::fp`)。语料的 id 当 originalId 用。 */
const childId = (c: JudgeRoundCase, name: string): string =>
  `contract::${Bun.hash(`${c.id}/${name}`).toString(36).slice(0, 10)}`;

/**
 * 把语料渲染成**内环那种**汇总 (runConductorRound 拼的那段: 首行统计 + 每子节点 `[originalId] status`)。
 * 刻意保留 originalId 在正文里 —— 生产就是这么给的 (给人看的那一面可读), 而**可点名的是内容寻址 id**。
 * 于是这份语料顺带考了一件真事: 模型会不会拿正文里那个好读的名字去点名 (→ 幽灵)。
 */
function renderConductorRound(c: JudgeRoundCase): { output: string; childIds: string[]; idOf: Map<string, string> } {
  const idOf = new Map<string, string>();
  const views = Object.entries(c.nodes).map(([name, out]) => {
    const cid = childId(c, name);
    idOf.set(name, cid);
    return { id: cid, originalId: name, status: out === null ? 'failed' : 'done', output: out ?? '[failed]' };
  });
  // 打的是**生产那一份**渲染 (renderRoundForJudge), 不是这里另抄一份 —— 抄一份测的就是抄的那份。
  return { output: renderRoundForJudge(views), childIds: views.map((v) => v.id), idOf };
}

type Verdict = 'converged' | 'minted' | 'blind' | 'ghost-only';
interface Trial {
  arm: string;
  case: string;
  rep: number;
  verdict: Verdict;
  converged: boolean;
  named: number;
  ghosts: string[];
  verdictRight: boolean;
  recallFull: boolean;
  latencyMs: number;
  usage: { in: number; out: number };
  error?: string;
}

async function trial(arm: Arm, c: JudgeRoundCase, rep: number): Promise<Trial> {
  const { output, childIds, idOf } = renderConductorRound(c);
  // 内环判的是**节点自己的 goal** —— 语料的 task 就当那个 goal。
  const prompt = conductorJudgePrompt(c.task, output, childIds);
  const t0 = Date.now();
  const base = { arm: arm.name, case: c.id, rep };
  try {
    const r = await send({
      model: arm.model,
      messages: [{ role: 'user', content: prompt }],
      ...(arm.thinking ? { thinkingLevel: arm.thinking } : {}),
      maxTokens: CONDUCTOR_JUDGE_MAX_TOKENS,
      temperature: 0.3,
    });
    const usage = { in: r.usage?.in ?? 0, out: r.usage?.out ?? 0 };
    const v = parseConductorVerdict(r.text ?? '', childIds);
    const verdict: Verdict = v.converged
      ? 'converged'
      : v.rejected.length > 0
        ? 'minted'
        : v.ghosts.length > 0
          ? 'ghost-only'
          : 'blind';
    // 该点名的那些, 换算成内容寻址 id 之后有没有点全。
    const mustIds = c.mustReject.map((n) => idOf.get(n)!);
    return {
      ...base,
      latencyMs: Date.now() - t0,
      usage,
      verdict,
      converged: v.converged,
      named: v.rejected.length + v.ghosts.length,
      ghosts: v.ghosts,
      verdictRight: v.converged === c.shouldConverge,
      recallFull: mustIds.every((id) => v.rejected.includes(id)),
    };
  } catch (e) {
    return {
      ...base,
      latencyMs: Date.now() - t0,
      usage: { in: 0, out: 0 },
      verdict: 'blind',
      converged: false,
      named: 0,
      ghosts: [],
      verdictRight: false,
      recallFull: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const pct = (a: number, b: number): string => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

async function main(): Promise<void> {
  bootstrapModelRuntime();
  const cases = JUDGE_ROUND_CASES.filter((c) => !only || only.includes(c.id));
  const jobs: Array<{ arm: Arm; c: JudgeRoundCase; rep: number }> = [];
  for (const arm of ARMS) for (const c of cases) for (let r = 1; r <= N; r++) jobs.push({ arm, c, rep: r });
  log(`[eval] 内环 judge: ${ARMS.length} 臂 × ${cases.length} 段 × ${N} 次 = ${jobs.length} 次调用`);

  let done = 0;
  const trials = await pool(jobs, CONCURRENCY, async (j) => {
    const t = await trial(j.arm, j.c, j.rep);
    if (++done % 10 === 0) log(`[eval] ${done}/${jobs.length}`);
    return t;
  });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/trials.json`, JSON.stringify(trials, null, 2), 'utf-8');

  // ── 汇总 ──
  const lines: string[] = [];
  lines.push(`\n内环 judge 实测 (N=${N}/格, ${cases.length} 段语料)\n`);
  lines.push('| 臂 | 铸票率 | 瞎判率 | 幽灵率 | 裁决准 | 召回全 | 平均票数 | out tok | 中位延迟 | 错误 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of ARMS) {
    const t = trials.filter((x) => x.arm === arm.name);
    const shouldReject = t.filter((x) => !JUDGE_ROUND_CASES.find((c) => c.id === x.case)!.shouldConverge);
    const lat = t.map((x) => x.latencyMs).sort((a, b) => a - b);
    lines.push(
      `| ${arm.name} | ${pct(shouldReject.filter((x) => x.verdict === 'minted').length, shouldReject.length)} ` +
        `| ${pct(shouldReject.filter((x) => x.verdict === 'blind').length, shouldReject.length)} ` +
        `| ${pct(t.filter((x) => x.ghosts.length > 0).length, t.length)} ` +
        `| ${pct(t.filter((x) => x.verdictRight).length, t.length)} ` +
        `| ${pct(shouldReject.filter((x) => x.recallFull).length, shouldReject.length)} ` +
        `| ${(shouldReject.reduce((s, x) => s + x.named, 0) / Math.max(1, shouldReject.length)).toFixed(1)} ` +
        `| ${Math.round(t.reduce((s, x) => s + x.usage.out, 0) / Math.max(1, t.length))} ` +
        `| ${((lat[Math.floor(lat.length / 2)] ?? 0) / 1000).toFixed(1)}s ` +
        `| ${t.filter((x) => x.error).length} |`,
    );
  }
  lines.push('\n逐段 (裁决准 / 召回全):\n');
  lines.push(`| 段 | ${ARMS.map((a) => a.name).join(' | ')} |`);
  lines.push(`|---|${ARMS.map(() => '---').join('|')}|`);
  for (const c of cases) {
    const cells = ARMS.map((a) => {
      const t = trials.filter((x) => x.arm === a.name && x.case === c.id);
      return `${pct(t.filter((x) => x.verdictRight).length, t.length)} / ${pct(t.filter((x) => x.recallFull).length, t.length)}`;
    });
    lines.push(`| ${c.id} | ${cells.join(' | ')} |`);
  }
  const report = lines.join('\n');
  writeFileSync(`${OUT}/report.md`, report, 'utf-8');
  process.stdout.write(`${report}\n\n读数落在 ${OUT}/\n`);
}

await main();
