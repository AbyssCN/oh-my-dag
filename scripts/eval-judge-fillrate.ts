/**
 * eval-judge-fillrate —— **judge `rejectedNodes` 填写率实测** (P2-d ④, 2026-07-29)。
 *
 * 为什么这个数决定别的东西的价值:
 *   `rejectedNodes` 是 `.optional()`, 模型走 JSON 模式, **漏填不算解析失败** → 不报错不重试。
 *   漏填一次 = 本轮整体不复用 (D-4e fail-closed 兜底), 于是 P1.5 那道毒集闸与 D-21 跨轮复用
 *   同时失效, 退回"每轮整图重跑"。填写率低 → 那两件事写了也白写。
 *
 * 量法: 取固定的真实轮结果摘要 (src/eval/tasks/judge-rounds.ts), 对候选 judge 座位各跑 N 次,
 * 把每次判决按 `plan/iterate.ts:118-149` **同一套铸票逻辑**分四类 (与生产日志一一对应):
 *   converged  判收敛 (不铸票, 正常)
 *   minted     未收敛且至少一张票可解析 → 日志「D-4 铸票」
 *   blind      未收敛但一张票都开不出 → 日志「无一张可解析的票」= fail-closed 触发
 *   ghost      点名了图中不存在的 id → 日志「点名了图中不存在的节点 id」
 * 另记正确性两量 (语料自带答案): 裁决对不对 (convergeAcc) · 该点的有没有点全 (recall)。
 *
 * 三条臂刻意选成"生产今天真在跑的" vs "配置声称的" vs "没配 judgeModel 时的回落":
 *   as-shipped  judge 座位坐标, **不传 thinkingLevel** —— llm-judge.ts:85 的 send 就是不传, 这是今天的真实行为
 *   thinking-hi 同坐标 + 显式 high —— .omd/config.json 的 `autoAssignedThinking.judge` 声称的档
 *   leaf-fallback  leaf 坐标 —— `judgeModel: config.judgeModel || config.leafModel` (iterate.ts:100) 的回落臂
 *
 * 跑: bun --env-file=.env run scripts/eval-judge-fillrate.ts [--n 10] [--cases fabricated,one-failed]
 */
import '../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import { makeLlmConvergenceJudge } from '../src/harness/plan/llm-judge';
import { merkleFingerprints } from '../src/harness/plan-passes/semantic-key';
import type { ConductorPlan } from '../src/harness/conductor-plan';
import { JUDGE_ROUND_CASES, renderRoundSummary, type JudgeRoundCase } from '../src/eval/tasks/judge-rounds';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '10'));
const only = opt('cases')?.split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, Number(opt('concurrency') ?? '4'));
const OUT = opt('out') ?? '.omd/eval/judge-fillrate';

const JUDGE_SEAT = 'deepseek:deepseek-v4-pro';
const LEAF_SEAT = 'deepseek:deepseek-v4-flash';

interface Arm {
  name: string;
  note: string;
  model: string;
  thinking?: 'low' | 'medium' | 'high';
}
const ARMS: Arm[] = [
  { name: 'as-shipped', note: `${JUDGE_SEAT} · 不传 thinking (今天的真实调用)`, model: JUDGE_SEAT },
  { name: 'thinking-hi', note: `${JUDGE_SEAT} · 显式 high (config 声称的档)`, model: JUDGE_SEAT, thinking: 'high' },
  { name: 'leaf-fallback', note: `${LEAF_SEAT} · 不传 thinking (没配 judgeModel 时的回落)`, model: LEAF_SEAT },
];

const log = (s: string): void => void process.stderr.write(s + '\n');

/** 语料 → 与摘要 id 一致的 plan (铸票要拿它算指纹, 与 iterate.ts 的 `merkleFingerprints(result.plan)` 同源)。 */
function planOf(c: JudgeRoundCase): ConductorPlan {
  return {
    name: `round-${c.id}`,
    nodes: Object.fromEntries(Object.keys(c.nodes).map((id) => [id, { goal: `节点 ${id}` }])),
  } as ConductorPlan;
}

type Verdict = 'converged' | 'minted' | 'blind' | 'ghost-only';
interface Trial {
  arm: string;
  case: string;
  rep: number;
  verdict: Verdict;
  converged: boolean;
  named: number;
  minted: string[];
  ghosts: string[];
  /** 裁决方向对不对 (与语料的 shouldConverge 比)。 */
  verdictRight: boolean;
  /** mustReject 里点全了没有 (收敛段恒 true)。 */
  recallFull: boolean;
  latencyMs: number;
  usage: { in: number; out: number };
  error?: string;
}

async function trial(arm: Arm, c: JudgeRoundCase, rep: number): Promise<Trial> {
  const summary = renderRoundSummary(c);
  const t0 = Date.now();
  let usage = { in: 0, out: 0 };
  const judge = makeLlmConvergenceJudge<string>({
    judgeModel: arm.model,
    task: c.task,
    extract: () => ({ status: 'done', summary }),
    // 唯一改动是补 thinkingLevel —— 生产路径 (llm-judge.ts:85) 不传, 这里靠注入把"传了会怎样"量出来。
    callModelFn: async (req) => {
      const r = await send(arm.thinking ? { ...req, thinkingLevel: arm.thinking } : req);
      usage = { in: usage.in + (r.usage?.in ?? 0), out: usage.out + (r.usage?.out ?? 0) };
      return r;
    },
  });

  const base: Omit<Trial, 'verdict' | 'converged' | 'named' | 'minted' | 'ghosts' | 'verdictRight' | 'recallFull'> = {
    arm: arm.name,
    case: c.id,
    rep,
    latencyMs: 0,
    usage,
  };
  try {
    const v = await judge(summary, 1);
    // ── 与 plan/iterate.ts:125-146 逐句同构的铸票 (那段是闭包, 只能镜像; 改那边记得改这边) ──
    const fps = merkleFingerprints(planOf(c));
    const minted: string[] = [];
    const ghosts: string[] = [];
    for (const id of v.rejectedNodes ?? []) (fps.has(id) ? minted : ghosts).push(id);
    const verdict: Verdict = v.converged
      ? 'converged'
      : minted.length > 0
        ? 'minted'
        : ghosts.length > 0
          ? 'ghost-only'
          : 'blind';
    return {
      ...base,
      latencyMs: Date.now() - t0,
      usage,
      verdict,
      converged: v.converged,
      named: v.rejectedNodes?.length ?? 0,
      minted,
      ghosts,
      verdictRight: v.converged === c.shouldConverge,
      recallFull: c.mustReject.every((id) => minted.includes(id)),
    };
  } catch (e) {
    return {
      ...base,
      latencyMs: Date.now() - t0,
      usage,
      verdict: 'blind',
      converged: false,
      named: 0,
      minted: [],
      ghosts: [],
      verdictRight: false,
      recallFull: false,
      error: (e as Error).message.slice(0, 200),
    };
  }
}

/** 有界并发跑一批 (顺序无关, 只求别把 provider 打爆)。 */
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
const cases = JUDGE_ROUND_CASES.filter((c) => !only || only.includes(c.id));
log(`judge 填写率: ${ARMS.length} 臂 × ${cases.length} 段 × ${N} 次 = ${ARMS.length * cases.length * N} 次调用`);

const jobs: (() => Promise<Trial>)[] = [];
for (const arm of ARMS) for (const c of cases) for (let r = 0; r < N; r++) jobs.push(() => trial(arm, c, r));
let done = 0;
const trials = await pooled(
  jobs.map((j) => async () => {
    const t = await j();
    if (++done % 10 === 0) log(`  ${done}/${jobs.length}`);
    return t;
  }),
  CONCURRENCY,
);

// ── 报告 ──────────────────────────────────────────────────────────────────────
const pct = (n: number, d: number): string => (d === 0 ? '  -  ' : `${((n / d) * 100).toFixed(0).padStart(3)}%`);
const lines: string[] = ['', '════════ judge rejectedNodes 填写率 (固定语料 · 铸票逻辑镜像 iterate.ts) ════════', ''];
for (const a of ARMS) lines.push(`${a.name.padEnd(14)} ${a.note}`);
lines.push('');

const rejectCases = cases.filter((c) => !c.shouldConverge);
lines.push('总览 (只统计"该拒"的那几段 —— 收敛段本来就不该有票):');
lines.push('臂             次数  铸票率  瞎判率  幽灵率  裁决准  召回全  平均票数  in/out tok  中位延迟');
for (const a of ARMS) {
  const rs = trials.filter((t) => t.arm === a.name && rejectCases.some((c) => c.id === t.case));
  const n = rs.length;
  const lat = rs.map((t) => t.latencyMs).sort((x, y) => x - y);
  lines.push(
    [
      a.name.padEnd(14),
      String(n).padStart(4),
      pct(rs.filter((t) => t.verdict === 'minted').length, n),
      pct(rs.filter((t) => t.verdict === 'blind').length, n),
      pct(rs.filter((t) => t.ghosts.length > 0).length, n),
      pct(rs.filter((t) => t.verdictRight).length, n),
      pct(rs.filter((t) => t.recallFull).length, n),
      (rs.reduce((s, t) => s + t.named, 0) / Math.max(1, n)).toFixed(1).padStart(7),
      `${Math.round(rs.reduce((s, t) => s + t.usage.in, 0) / Math.max(1, n))}/${Math.round(rs.reduce((s, t) => s + t.usage.out, 0) / Math.max(1, n))}`.padStart(11),
      `${(lat[lat.length >> 1] ?? 0) / 1000}s`.padStart(8),
    ].join('  '),
  );
}

lines.push('', '逐段 (铸票率 / 裁决准; 每格 N=' + N + '):');
lines.push('段落                  ' + ARMS.map((a) => a.name.padEnd(14)).join(''));
for (const c of cases) {
  const cells = ARMS.map((a) => {
    const rs = trials.filter((t) => t.arm === a.name && t.case === c.id);
    return `${pct(rs.filter((t) => (c.shouldConverge ? t.verdict === 'converged' : t.verdict === 'minted')).length, rs.length)}/${pct(rs.filter((t) => t.verdictRight).length, rs.length)}`.padEnd(14);
  });
  lines.push(`${c.id.padEnd(22)}${cells.join('')}`);
}
lines.push('', ...cases.map((c) => `  ${c.id}: ${c.probes}`));

const errs = trials.filter((t) => t.error);
if (errs.length) lines.push('', `调用出错 ${errs.length} 次: ${[...new Set(errs.map((t) => t.error))].slice(0, 3).join(' | ')}`);
lines.push(
  '',
  '读法: **铸票率**就是 D-4 毒集与 D-21 跨轮复用的实际生效率 —— 瞎判率就是 fail-closed 整轮不复用的频率。',
  '      裁决准低于铸票率时, 问题不在"填不填字段", 在"判得对不对", 换 prompt 不如换模型。',
);

const report = lines.join('\n');
process.stdout.write(report + '\n');
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/report.md`, report);
writeFileSync(`${OUT}/trials.json`, JSON.stringify(trials, null, 2));
log(`  → 落盘 ${OUT}/`);
