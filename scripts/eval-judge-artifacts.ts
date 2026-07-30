/**
 * eval-judge-artifacts —— **S1 的同语料 A/B**: judge 看得见产物内容, 判决会差多少 (2026-08-03)。
 *
 * ## 它回答的那一位
 *
 * 两次带种 live 交付物全对却判 3 轮未收敛。判词说得很清楚: 它只拿到「声称写入了文件」,
 * 拿不到文件里写了什么, 于是**被要求裁决它看不见的东西** → fail-closed。
 * 修法是把产物内容由引擎读盘补进视图 (`plan/judge-artifacts.ts`), 但那改的是**每一次** judge
 * 调用, 所以缺省关着, 等这个脚本给出读数再决定翻不翻。
 *
 * ## 两个方向必须一起看 (代价不对称)
 *
 *   假阴性 (做完了判没成) = 贵。今天 100% —— 这是要降的那个。
 *   假阳性 (没做完判成了) = 毒。今天被 fail-closed 保住 —— **不许因为这次改动被换掉**。
 *
 * 只报"收敛率升了"是自证: 让 judge 更容易说"成了"当然会降假阴性, 代价可能全在另一侧。
 * 故判据是**两条一起**: 假阴性显著降 **且** 假阳性不升。达不到就别翻默认。
 *
 * ## 隔离
 *
 * 只打 judge 那**一次**调用 (同 eval-judge-fillrate 的分工): 语料是固定的子节点视图 + 真写在
 * 沙箱里的文件, conductor/leaf 的方差全挡在外面, 两臂唯一的差别就是视图里有没有产物内容。
 *
 * 跑:
 *   bun --env-file=.env run scripts/eval-judge-artifacts.ts [--n 8] [--model deepseek:deepseek-v4-pro]
 *                                                           [--cases content-faithful,...] [--out .omd/eval/s1]
 */
import '../src/harness/script-bootstrap';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapModelRuntime } from '../src/model/bootstrap';
import { send } from '../src/model/gateway';
import { makeLlmConvergenceJudge } from '../src/harness/plan/llm-judge';
import { renderRoundForJudge, type JudgeChildView } from '../src/harness/plan/conductor-judge';
import { collectJudgeArtifacts, DEFAULT_ARTIFACT_BUDGET } from '../src/harness/plan/judge-artifacts';
import { JUDGE_ARTIFACT_CASES, type JudgeArtifactCase } from '../src/eval/tasks/judge-artifact-cases';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = Math.max(1, Number(opt('n') ?? '8'));
const MODEL = opt('model') ?? 'deepseek:deepseek-v4-pro';
const CONCURRENCY = Math.max(1, Number(opt('concurrency') ?? '4'));
const only = opt('cases')?.split(',').map((s) => s.trim()).filter(Boolean);
const OUT = opt('out');

const log = (s: string): void => void process.stderr.write(s + '\n');
const cases = JUDGE_ARTIFACT_CASES.filter((c) => !only || only.includes(c.id));

/**
 * 把语料的文件真写进**这一段自己的**沙箱 —— 引擎读盘读的就是这些。
 *
 * ⚠ 每段一个子目录, 不是共用一个根: 四段刻意用同一批路径 (docs/batch.md …) 来构造"同样的存在性、
 * 不同的内容", 共用根就会互相覆盖 —— 第一版正是这么写的, 于是 on 臂读到的是**别的段**的文件,
 * 判词说 "batch.md 缺少支持格式" 而那段语料明明写了。**读数当场作废且看不出来**: 两臂都 8/8
 * 假阴性, 长得像"注入内容没有用"。
 */
function caseRoot(root: string, c: JudgeArtifactCase): string {
  return join(root, c.id);
}
function materialize(root: string, c: JudgeArtifactCase): void {
  for (const child of c.children) {
    for (const [rel, body] of Object.entries(child.files)) {
      const p = join(caseRoot(root, c), rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
  }
}

/** 语料 → judge 视图。`withArtifacts` 是两臂唯一的差别。 */
function viewOf(root: string, c: JudgeArtifactCase, withArtifacts: boolean): string {
  const children: JudgeChildView[] = c.children.map((ch) => {
    const facts = ch.claims.length ? [`写入文件: ${ch.claims.join(', ')}`] : [];
    const artifacts = withArtifacts
      ? collectJudgeArtifacts(
          ch.claims,
          (p) => {
            try {
              return readFileSync(join(caseRoot(root, c), p), 'utf-8');
            } catch {
              return null;
            }
          },
          DEFAULT_ARTIFACT_BUDGET,
        )
      : [];
    return {
      id: ch.id,
      originalId: ch.id,
      status: 'done',
      output: ch.output,
      ...(facts.length ? { facts } : {}),
      ...(artifacts.length ? { artifacts } : {}),
    };
  });
  return renderRoundForJudge(children);
}

interface Trial {
  arm: 'off' | 'on';
  case: string;
  rep: number;
  converged: boolean;
  /** 裁决方向对不对。 */
  verdictRight: boolean;
  /** 假阴性: 该收敛判成没收敛。 */
  falseNeg: boolean;
  /** 假阳性: 不该收敛判成收敛 —— **这一侧不许变差**。 */
  falsePos: boolean;
  /** mustReject 点全了没有 (该收敛的段恒 true)。 */
  recallFull: boolean;
  named: string[];
  /** 判词全文。**必须记** —— 2026-07-30 那次就是读了判词才知道 judge 没冤枉谁 (它拒的是它看不见的
   *  东西), 只看收敛布尔会把"它拒得有道理"误读成"它坏了"。 */
  reason: string;
  usage: { in: number; out: number };
  latencyMs: number;
  error?: string;
}

async function trial(root: string, c: JudgeArtifactCase, arm: 'off' | 'on', rep: number): Promise<Trial> {
  const summary = viewOf(root, c, arm === 'on');
  const t0 = Date.now();
  let usage = { in: 0, out: 0 };
  const judge = makeLlmConvergenceJudge<string>({
    judgeModel: MODEL,
    task: c.task,
    extract: () => ({ status: 'done', summary }),
    callModelFn: async (req) => {
      const r = await send(req);
      usage = { in: usage.in + (r.usage?.in ?? 0), out: usage.out + (r.usage?.out ?? 0) };
      return r;
    },
  });
  const base = { arm, case: c.id, rep, usage, latencyMs: 0 };
  try {
    const v = await judge(summary, 1);
    const named = (v.rejectedNodes ?? []).filter((x): x is string => typeof x === 'string');
    const right = v.converged === c.shouldConverge;
    return {
      ...base,
      latencyMs: Date.now() - t0,
      usage,
      converged: v.converged,
      verdictRight: right,
      falseNeg: c.shouldConverge && !v.converged,
      falsePos: !c.shouldConverge && v.converged,
      recallFull: c.mustReject.every((id) => named.includes(id)),
      named,
      reason: (v.failureReason ?? '').slice(0, 600),
    };
  } catch (e) {
    // fail-closed 记账: 判不出来**不算判对**, 也不算假阳性 (它没说"成了")。
    return {
      ...base,
      latencyMs: Date.now() - t0,
      usage,
      converged: false,
      verdictRight: false,
      falseNeg: c.shouldConverge,
      falsePos: false,
      recallFull: false,
      named: [],
      reason: '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 有界并发泵。 */
async function pump<T>(jobs: (() => Promise<T>)[], cap: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(cap, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
}

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}%` : '—');

async function main(): Promise<void> {
  await bootstrapModelRuntime();
  const root = mkdtempSync(join(tmpdir(), 'omd-s1-eval-'));
  for (const c of cases) materialize(root, c);

  log(`[S1 A/B] 座位 ${MODEL} · ${cases.length} 段 × ${N} 次 × 2 臂 = ${cases.length * N * 2} 次判决`);
  log(`[S1 A/B] 沙箱 ${root}`);

  const jobs: (() => Promise<Trial>)[] = [];
  for (const arm of ['off', 'on'] as const)
    for (const c of cases) for (let r = 0; r < N; r++) jobs.push(() => trial(root, c, arm, r));
  const trials = await pump(jobs, CONCURRENCY);

  // ── 报告 ──────────────────────────────────────────────────────────────────
  for (const arm of ['off', 'on'] as const) {
    const t = trials.filter((x) => x.arm === arm);
    log('');
    log(`═══ 臂 ${arm}${arm === 'on' ? ' (视图含产物内容)' : ' (今天的生产行为)'} ═══`);
    const rows = cases.map((c) => {
      const ct = t.filter((x) => x.case === c.id);
      return {
        段: c.id,
        该收敛: c.shouldConverge ? '是' : '否',
        裁决准: pct(ct.filter((x) => x.verdictRight).length, ct.length),
        假阴性: c.shouldConverge ? pct(ct.filter((x) => x.falseNeg).length, ct.length) : '—',
        假阳性: c.shouldConverge ? '—' : pct(ct.filter((x) => x.falsePos).length, ct.length),
        召回全: c.shouldConverge ? '—' : pct(ct.filter((x) => x.recallFull).length, ct.length),
        平均in: Math.round(ct.reduce((s, x) => s + x.usage.in, 0) / Math.max(1, ct.length)),
        平均out: Math.round(ct.reduce((s, x) => s + x.usage.out, 0) / Math.max(1, ct.length)),
        错: ct.filter((x) => x.error).length,
      };
    });
    console.table(rows);
  }

  log('');
  log('═══ 两臂对照 (判据: 假阴性显著降 **且** 假阳性不升) ═══');
  const side = (arm: 'off' | 'on', pick: (t: Trial) => boolean, within: (c: JudgeArtifactCase) => boolean) => {
    const pool = trials.filter((x) => x.arm === arm && within(cases.find((c) => c.id === x.case)!));
    return { n: pool.length, k: pool.filter(pick).length };
  };
  const fnOff = side('off', (t) => t.falseNeg, (c) => c.shouldConverge);
  const fnOn = side('on', (t) => t.falseNeg, (c) => c.shouldConverge);
  const fpOff = side('off', (t) => t.falsePos, (c) => !c.shouldConverge);
  const fpOn = side('on', (t) => t.falsePos, (c) => !c.shouldConverge);
  const inOff = trials.filter((x) => x.arm === 'off').reduce((s, x) => s + x.usage.in, 0);
  const inOn = trials.filter((x) => x.arm === 'on').reduce((s, x) => s + x.usage.in, 0);
  console.table([
    { 指标: '假阴性 (贵, 要降)', off: `${fnOff.k}/${fnOff.n} ${pct(fnOff.k, fnOff.n)}`, on: `${fnOn.k}/${fnOn.n} ${pct(fnOn.k, fnOn.n)}` },
    { 指标: '假阳性 (毒, 不许升)', off: `${fpOff.k}/${fpOff.n} ${pct(fpOff.k, fpOff.n)}`, on: `${fpOn.k}/${fpOn.n} ${pct(fpOn.k, fpOn.n)}` },
    { 指标: 'prompt token 合计', off: String(inOff), on: `${inOn} (${inOff ? '+' + (((inOn - inOff) / inOff) * 100).toFixed(0) + '%' : '—'})` },
  ]);

  const verdict =
    fnOn.k / Math.max(1, fnOn.n) < fnOff.k / Math.max(1, fnOff.n) && fpOn.k <= fpOff.k
      ? '两侧都满足 → 可以考虑翻默认 (先看 n 够不够: 小 n 的 0 不是 0)'
      : '未同时满足 → **不翻默认**';
  // 假阴性的判词全打出来 —— 这是"改了为什么还不收敛"唯一问得出答案的地方。
  const fns = trials.filter((t) => t.falseNeg && t.reason);
  if (fns.length) {
    log('');
    log('═══ 假阴性的判词 (它到底在拒什么) ═══');
    for (const t of fns.slice(0, 8)) log(`[${t.arm}/${t.case}#${t.rep}] ${t.reason}`);
  }

  log('');
  log(`裁决: ${verdict}`);

  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'trials.json'), JSON.stringify({ model: MODEL, n: N, trials }, null, 2));
    log(`原始读数 → ${join(OUT, 'trials.json')}`);
  }
  rmSync(root, { recursive: true, force: true });
}

await main();
