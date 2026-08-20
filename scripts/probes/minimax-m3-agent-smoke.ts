/**
 * minimax-m3-agent-smoke —— **MiniMax M3 能不能坐 `agent` 座 (工具循环, 改文件)** 的 go/no-go。
 *
 * ## 为什么先跑这个而不是直接上 eval-executor-ab
 *
 * 仓里已记的硬事实 (`scripts/eval-executor-ab.ts:AGENT_CAPABLE_POOL`): **全部 `opencode-go` 座位在
 * agent leaf 里返 0-token empty-done** —— 单发通得过, 工具循环照样是空的。所以"座位探针 ✓"**推不出**
 * "能当 worker agent"。这个探针把那一跳变成看得见的:一次真 agent leaf, 一个真 fixture, 一个真 oracle。
 * 通不过就一票否决, 省掉几十分钟的 executor-ab。
 *
 * ## 四要素 (动手前写死)
 *
 * - **单一变量** = 模型坐标。fixture (debug-planted, 自带"种完必须红"自检) · prompt · thinking 档
 *   (两臂都硬钉 `high`, 不吃通道缺省 —— pi 缺省 xhigh / claude 订阅缺省 medium, 不钉就是两个变量) ·
 *   sandbox (bwrap, sandboxRoot=worktree) 全同。
 * - **对照基线** = 现役 `agent` 座 `claude-code:claude-sonnet-5`, **同一条件同一次跑**量出来,
 *   不引用任何历史读数。
 * - **预先声明的成败信号** (跑之前定死, 事后不许改):
 *     G0 通道闸  toolCalls > 0 ∧ filesTouched ≠ ∅ ∧ ¬stalled ∧ ¬spinFused
 *                → 不过 = M3 在工具循环上根本不动手, worker agent 一票否决 (与 opencode-go 同病)。
 *     G1 能力闸  测试全绿 ∧ tsc 干净 ∧ 一个测试文件都没碰
 *                → 过 = 能修一个"tsc 干净但逻辑错"的真 bug。
 *     两闸独立记: G0 过而 G1 不过 = 通道成立但活干不对 (可换题再量);
 *                G0 不过 = 通道不成立 (换题也没用, 先修栈)。
 * - **两侧都收数**: 不塌收 {墙钟, token, toolCalls, 改动行数, 无关文件数, noop 写比例};
 *   塌了收 {stalled/spinFused/异常原文, 最后一段 text} —— 空 catch 不许吞证据 (仓规 §坑-2)。
 *
 * 跑: MINIMAX_CN_API_KEY=$MINIMAX_API_KEY bun --env-file=.env run scripts/probes/minimax-m3-agent-smoke.ts [--reps 2]
 */
import '../../src/harness/script-bootstrap';
import { mkdirSync, writeFileSync } from 'node:fs';
import { $ } from 'bun';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';
import { createAgentLeafRunner } from '../../src/harness/agent-leaf';
import { createDebugFixture } from '../../src/eval/tasks/debug-planted';
import { createDistantBugFixture, wholeSuite } from '../../src/eval/tasks/hard';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPS = Math.max(1, Number(opt('reps') ?? '2'));
const MODELS = (opt('models') ?? 'minimax-cn:MiniMax-M3,claude-code:claude-sonnet-5')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = opt('out') ?? '.omd/eval/m3-agent-smoke';
/**
 * `easy` = debug-planted (因果同址 + scoped oracle) —— 2026-08-14 首跑 **4/4 全绿, 两臂零差**。
 * 那是**尺子饱和**不是"两个模型一样强": 一个在任何干预下都不动的数量的是尺子 (仓规 §加尺子)。
 * `hard` = H2 因果异址 (bug 种在 A, 红测试在 B, 因处无红测指路) + H3 全量 oracle (改坏邻居当场现形)。
 * 判据同样跑之前钉死: G1 = 全量绿 ∧ regressions=0 ∧ 没碰测试文件。
 */
const TASK = (opt('task') ?? 'easy') as 'easy' | 'hard';
const log = (s: string): void => void process.stderr.write(s + '\n');

interface Row {
  model: string;
  rep: number;
  /** G0: 通道成立 (真调了工具且真碰了文件, 没停摆没空转熔断)。 */
  g0: boolean;
  /** G1: 活干对了 (测试绿 + tsc 干净 + 没碰测试文件)。 */
  g1: boolean;
  toolCalls: number;
  filesTouched: number;
  noopWrites: number;
  stalled: boolean;
  spinFused?: string;
  testPass: number;
  tscClean: boolean;
  /** hard 档: 相对"动手前"的新坏测试数 (局部弄绿的代价)。easy 档恒 0 (scoped oracle 看不见邻居)。 */
  regressions: number;
  touchedTest: boolean;
  diffLines: number;
  otherFiles: number;
  tokensIn: number;
  tokensOut: number;
  wallMs: number;
  textTail: string;
  error?: string;
}

interface Oracle {
  tscClean: boolean;
  /** 0..1 过测比。 */
  pass: number;
  regressions: number;
}

/** easy 档 oracle: whole-project tsc + **scoped** 测试 (只看症状那一个文件)。 */
async function scopedOracle(root: string): Promise<Oracle> {
  const tsc = await $`npx tsc --noEmit -p tsconfig.json`.cwd(root).quiet().nothrow();
  const t = await $`bun test src/model/family-rotate.test.ts`.cwd(root).quiet().nothrow();
  const out = t.stdout.toString() + t.stderr.toString();
  const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
  const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
  return { tscClean: tsc.exitCode === 0, pass: pass + fail ? pass / (pass + fail) : 0, regressions: 0 };
}

/** hard 档 oracle: 全量 tsc + 全量 bun test, 且相对动手前基线算 regressions。 */
async function suiteOracle(root: string, baselineFail: number): Promise<Oracle> {
  const s = await wholeSuite(root, baselineFail);
  return {
    tscClean: s.tscClean,
    pass: s.pass + s.fail ? s.pass / (s.pass + s.fail) : 0,
    regressions: s.regressions,
  };
}

async function once(model: string, rep: number): Promise<Row> {
  const fx = TASK === 'hard' ? await createDistantBugFixture() : await createDebugFixture();
  /** hard 档必须先量"动手前有多少红" —— 没有它, `regressions` 就只能靠猜, 而它正是这档的判据。 */
  const baselineFail = TASK === 'hard' ? (await wholeSuite(fx.root)).fail : 0;
  const t0 = Date.now();
  const base = {
    model,
    rep,
    g0: false,
    g1: false,
    toolCalls: 0,
    filesTouched: 0,
    noopWrites: 0,
    stalled: false,
    testPass: 0,
    tscClean: false,
    regressions: 0,
    touchedTest: false,
    diffLines: 0,
    otherFiles: 0,
    tokensIn: 0,
    tokensOut: 0,
    wallMs: 0,
    textTail: '',
  };
  try {
    const run = createAgentLeafRunner({
      cwd: fx.root,
      hashlineEdit: true,
      sandboxRoot: fx.root,
      thinkingLevel: 'high', // 两臂硬钉 —— 不钉就吃通道缺省, 那是第二个变量
      leafTimeoutMs: 900_000,
    });
    const r = await run({ prompt: fx.spec, model });
    const touched = r.filesTouched ?? [];
    const noop = (r.writeEffects ?? []).filter((w) => w.noop).length;
    const o = TASK === 'hard' ? await suiteOracle(fx.root, baselineFail) : await scopedOracle(fx.root);
    const diff = await $`git diff --numstat HEAD`.cwd(fx.root).quiet().nothrow();
    const numstat = diff.stdout
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    const diffLines = numstat.reduce((n, c) => n + Number(c[0] ?? 0) + Number(c[1] ?? 0), 0);
    // 「无关文件」= 改了但不在种 bug 的那几个因文件里 (两档的因文件不同, 从 fixture 拿, 别写死路径)。
    const otherFiles = numstat.filter((c) => !fx.buggyFiles.some((b) => (c[2] ?? '').includes(b))).length;
    const touchedTest = numstat.some((c) => (c[2] ?? '').includes('.test.'));
    const g0 = (r.toolCalls ?? 0) > 0 && touched.length > 0 && !r.stalled && !r.spinFused;
    const g1 = o.pass === 1 && o.tscClean && !touchedTest && o.regressions === 0;
    return {
      ...base,
      g0,
      g1,
      toolCalls: r.toolCalls ?? 0,
      filesTouched: touched.length,
      noopWrites: noop,
      stalled: r.stalled === true,
      ...(r.spinFused ? { spinFused: r.spinFused } : {}),
      testPass: o.pass,
      tscClean: o.tscClean,
      regressions: o.regressions,
      touchedTest,
      diffLines,
      otherFiles,
      tokensIn: r.usage?.in ?? 0,
      tokensOut: r.usage?.out ?? 0,
      wallMs: Date.now() - t0,
      textTail: (r.text ?? '').slice(-400),
    };
  } catch (e) {
    // 塌了也是读数: 原文进 row, 不吞。
    return { ...base, wallMs: Date.now() - t0, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  } finally {
    await fx.cleanup();
  }
}

bootstrapModelRuntime();
mkdirSync(OUT, { recursive: true });
const rows: Row[] = [];
for (const m of MODELS) {
  for (let rep = 1; rep <= REPS; rep++) {
    log(`▶ ${m} rep${rep} …`);
    const row = await once(m, rep);
    rows.push(row);
    log(
      `  G0=${row.g0 ? '✓' : '✗'} G1=${row.g1 ? '✓' : '✗'} tools=${row.toolCalls} files=${row.filesTouched} ` +
        `pass=${(row.testPass * 100).toFixed(1)}% tsc=${row.tscClean ? '✓' : '✗'} reg=${row.regressions} ${(row.wallMs / 1000).toFixed(0)}s` +
        (row.error ? ` ERR ${row.error}` : ''),
    );
    writeFileSync(`${OUT}/rows.json`, JSON.stringify(rows, null, 2));
  }
}
log(`\n写入 ${OUT}/rows.json (${rows.length} 行)`);
