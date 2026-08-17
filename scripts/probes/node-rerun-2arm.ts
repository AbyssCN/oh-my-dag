/**
 * node-rerun-2arm —— 节点级 resume 重跑末节点的两臂对照探针 (signal-a 探针, 2026-08-14)。
 *
 * ## 测什么 / 为什么需要它
 *
 * 一条经验假设:checkpoint 让 A 跳过、B 重跑这种「末节点单独 rerun」在生产路径里真的能让
 * cache_read_input_tokens 命中、且输出与 baseline 同步可控。两条独立失败模式:
 *
 *   ① resume 把 B 也当绿跳过 → diff=0、cacheRead 增量=0,但这只是「根本没跑」不是「稳态护 cache」;
 *   ② resume 真的重跑了 B,但 prompt 漂走 (goal 改了 / 上游改了) → 与「相同 goal 应确定」的预期冲突。
 *
 * 本探针对照这两面:
 *   - 对照臂 (control):   baseline goal = rerun goal (同 goal);期望 diff=0, cacheRead 因 A 跳过而**只**来自 B。
 *   - 处理臂 (treatment): baseline goal ≠ rerun goal;期望 diff>0 (B 真的在响应新 goal)。
 *
 * ## 机制
 *
 *   - mkdtemp 沙盒 → git init → git worktree (S2 独立 worktree) → CheckpointManager 落
 *     `<repoRoot>/.omd/continuity/<runId>` (删 OMD_DATA_HOME 强制走 repo 路径);
 *   - plan: A → B 两节点线性 (A 暖发, B 探针);
 *   - 每样本 = baseline 全图跑 (S1, resume=false) → cp checkpoint 到 S2 → rm S2/b.json →
 *     resume (S2, resume=true) 让 A 命中续跑跳过、B 重跑;
 *   - 注入式 `generate` 模拟 provider prompt-cache: 同 (model, goalHash, prompt.length) 第二次起报 cacheHit。
 *   - sharedCache **每臂内跨样本共享** → 看「逐样本累积是否护住」。
 *
 * ## 采集 (per 样本, N=2 = baseline + rerun)
 *
 *   - cache_read_input_tokens  ← 首执行节点的 LeafResult.usage.cacheHit (a 跳过则取 b);
 *   - diff_distance            ← Jaccard 距离 `1 − |L_A ∩ L_B| / |L_A ∪ L_B|`,L(x)=x.split('\n');
 *   - 墙钟分计                ← baselineMs / rerunMs / max / sum;
 *   - aSkippedOnResume         ← A 在 resume 这发是否走 checkpoint 跳过 (B-only rerun 的判据)。
 *
 * ## 信号 a (第一步 go/no-go, smoke)
 *
 *   smoke: 完整跑一遍 S1 baseline → 复制到 S2 worktree → 删 S2/b.json → resume in S2
 *   (Promise.race 30s 超时)。GO iff 三条件齐: ① rerun 30s 内返回 ② results['b'].status==='done'
 *   ③ b.output 与 baseline b.output 字节相等。NO-GO 走负侧分支,仍写 raw, 退出码 0。
 *
 * 跑: `bun run scripts/probes/node-rerun-2arm.ts [--samples 3] [--timeout-ms 30000]`
 */
import '../../src/harness/script-bootstrap';
// script-bootstrap 默认 OMD_DATA_HOME=~/.omd → runDir 出 ~;删它强制 runDir=<repoRoot>/.omd/continuity/<runId>。
delete process.env.OMD_DATA_HOME;

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import type {
  ExecutorDagConfig,
  ExecutorDagResult,
  GenerateFn,
  LeafResult,
} from '../../src/harness/dag/engine';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { resolveRoleModelConfigured } from '../../src/model/role-models';
import type { ModelUsage } from '../../src/model/types';

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SAMPLES = Math.max(3, Number(opt('samples') ?? '3'));
/** --real (2026-08-17, #103 复量): 摘掉注入 generate, 走真 leaf 座位 —— 单一变量 = 模型真/假,
 *  goal/plan/resume 机制一字不动。stub 臂 c=d 是构造使然 (确定性假模型), 量不出真噪声底。 */
const REAL = argv.includes('--real');
const TIMEOUT_MS = Math.max(1000, Number(opt('timeout-ms') ?? (REAL ? '180000' : '30000')));

// ── Schema ───────────────────────────────────────────────────────────────────
type Arm = 'control' | 'treatment';
type Status = 'go' | 'signal_a_nogo' | 'error';

interface Sample {
  arm: Arm;
  sample: number;
  goal: { baseline: string; rerun: string; identical: boolean };
  cwd: string; // rerun repoRoot (= S2 worktree)
  cacheReadInputTokens: {
    value: number | null;
    fromNodeId: 'a' | 'b' | null;
    reason: string | null;
  };
  diffDistance: number;
  wallMs: { baselineMs: number; rerunMs: number; maxMs: number; sumMs: number };
  aSkippedOnResume: boolean | null;
  bOutputBaseline: string;
  bOutputRerun: string;
}

interface RawPayload {
  status: Status;
  anchors: {
    resumeGreens: { fileLine: string; present: boolean };
    loadAllGreen: { fileLine: string; smokeGreenCount: number | null };
    resumePassthrough: {
      fileLine: string;
      resumeFlag: boolean;
      smokeASkipped: boolean | null;
      smokeWorktreeRoot: string | null;
    };
  };
  arms: Sample[];
  wallclock: { maxMs: number; sumMs: number };
  samplesPerArm: number;
  notes: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const A_GOAL = '产生稳定上游文本 A_OUT。';
const CONTROL_BASELINE = 'control: 读 data/values.txt 报行数与数字和。';
const CONTROL_RERUN = 'control: 读 data/values.txt 报行数与数字和。';
const TREATMENT_BASELINE = 'treatment v1: 报行数与数字和。';
const TREATMENT_RERUN = 'treatment v2: 报行数、和与积。';

const VALUES_CONTENT = 'alpha 12\nbeta 7\ngamma 21\n';
const TASK_CONTENT = 'probe task — 两节点 DAG 沙盒测。\nreport 走 stdout。\n';
const README_CONTENT = '# probe sandbox\n';
const LEAF_MODEL = 'probe:stub-leaf';
const RAW_PATH = join(process.cwd(), 'scripts', 'probes', REAL ? 'node-rerun-raw-real.json' : 'node-rerun-raw.json');

// 静态锚点 fileLine (rg 已验证存在)。
const ANCHOR_LINES = {
  resumeGreens: 'src/harness/dag/engine.ts:785',
  loadAllGreen: 'src/harness/continuity/checkpoint-manager.ts:360',
  resumePassthrough: 'src/harness/dag/types.ts:171 + src/harness/dag/engine.ts:2578',
} as const;

// ── Utils ────────────────────────────────────────────────────────────────────
function sha16(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Jaccard 距离: 1 − |A∩B|/|A∪B|,|A∪B|=0 → 0。 */
function jaccardDistance(a: string, b: string): number {
  const A = new Set(a.split('\n'));
  const B = new Set(b.split('\n'));
  const union = new Set<string>([...A, ...B]);
  if (union.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return 1 - inter / union.size;
}

/** req.messages 全量平铺为字符串 (string / ContentPart[] 兼容)。 */
function promptOf(req: { messages: { role: string; content: string | unknown[] }[] }): string {
  let s = '';
  for (const m of req.messages) {
    const c = m.content;
    if (typeof c === 'string') s += c;
    else if (Array.isArray(c))
      for (const p of c) s += typeof p === 'string' ? p : ((p as { text?: string }).text ?? '');
  }
  return s;
}

/** Prompt 内从 A_OUT 起取 48 字符;无 → 'NO-UPSTREAM'。 */
function extractUpstream(prompt: string): string {
  const i = prompt.indexOf('A_OUT');
  return i < 0 ? 'NO-UPSTREAM' : prompt.slice(i, i + 48);
}

/** 解析 values.txt → {n=lineCount, s=sumOfIntegers}。 */
function readValues(cwd: string): { n: number; s: number } {
  const p = join(cwd, 'data', 'values.txt');
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  let s = 0;
  for (const l of lines) {
    const m = l.match(/-?\d+/);
    if (m) s += Number(m[0]);
  }
  return { n: lines.length, s };
}

// ── Stub generate (a/b 双用,靠 prompt 内是否含 A_OUT 区分) ──────────────────
interface GenCtx {
  cache: Map<string, true>; // presence-only (key 命中过 → true)
  bGoal: string;
  runId: string;
  repoRoot: string; // sampleCwd (S1),b 节点读其 data/values.txt
}

function makeGenerate(ctx: GenCtx): GenerateFn {
  return async (req) => {
    const prompt = promptOf(req);
    const inTok = 40 + Math.ceil(prompt.length / 4);
    const outTok = 18;
    const cacheKey = `${req.model}|${sha16(ctx.bGoal)}|${prompt.length}`;
    const hit = ctx.cache.has(cacheKey);
    const cacheHit = hit ? Math.floor(inTok * 0.8) : 0;
    ctx.cache.set(cacheKey, true);

    let text: string;
    if (prompt.includes('A_OUT')) {
      // b 节点: prompt 已含 a 的输出 / 上游计划轮廓,读真 values.txt + 抽 upstream + 嵌 goalHash。
      const { n, s } = readValues(ctx.repoRoot);
      const upstream = extractUpstream(prompt);
      const goalHash = sha16(ctx.bGoal);
      text = `B_OUT lines=${n} sum=${s} upstream=${upstream} goalHash=${goalHash}`;
    } else {
      // a 节点: 暖发,文本稳定 = A_OUT + runId + bGoal 的 goalHash。
      const goalHash = sha16(ctx.bGoal);
      text = `A_OUT run=${ctx.runId} goalHash=${goalHash}`;
    }
    // 仿 inproc 节点 2ms 耗时,避免 0ms 让 wallMs 失真。
    await new Promise((r) => setTimeout(r, 2));
    return { text, usage: { in: inTok, out: outTok, cacheHit } as ModelUsage };
  };
}

// ── Plan + run helpers ───────────────────────────────────────────────────────
function planFor(bGoal: string): ConductorPlan {
  return {
    name: 'node-rerun-probe',
    nodes: {
      a: { goal: A_GOAL },
      b: { goal: bGoal, depends_on: ['a'] },
    },
  };
}

interface RunOnceOpts {
  repoRoot: string;
  runId: string;
  bGoal: string;
  resume: boolean;
  cache: Map<string, true>;
  timeoutMs: number;
}

interface RunOnceResult {
  result: ExecutorDagResult | null;
  timedOut: boolean;
  bOutput: string;
  bStatus: string | null;
  aSkipped: boolean | null;
  elapsedMs: number;
}

async function runOnce(opts: RunOnceOpts): Promise<RunOnceResult> {
  const mgr = new CheckpointManager(opts.repoRoot);
  const cfg: ExecutorDagConfig = {
    conductorModel: 'probe:stub-conductor',
    leafModel: REAL ? resolveRoleModelConfigured('leaf').model : LEAF_MODEL,
    // --real: 不注入 generate → 引擎默认真模型路径 (leaf 座, 今天 = M3)。
    ...(REAL ? {} : { generate: makeGenerate({ cache: opts.cache, bGoal: opts.bGoal, runId: opts.runId, repoRoot: opts.repoRoot }) }),
    continuity: { manager: mgr, runId: opts.runId, repoRoot: opts.repoRoot, resume: opts.resume },
  };
  const t0 = Date.now();
  const runP = runExecutorDagWithPlan(planFor(opts.bGoal), cfg);

  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
  });

  let result: ExecutorDagResult | null = null;
  let timedOut = false;
  const race = await Promise.race([
    runP.then((r) => ({ kind: 'ok' as const, r }), (e) => ({ kind: 'err' as const, e })),
    timeoutP,
  ]);
  if (timer) clearTimeout(timer);
  const elapsedMs = Date.now() - t0;
  if (race === 'timeout') {
    timedOut = true;
  } else if (race.kind === 'ok') {
    result = race.r;
  } else {
    throw race.e;
  }

  const aRes = result?.results['a'] as LeafResult | undefined;
  const bRes = result?.results['b'] as LeafResult | undefined;
  return {
    result,
    timedOut,
    bOutput: bRes?.output ?? '',
    bStatus: bRes?.status ?? null,
    aSkipped: aRes?.skipped ?? null,
    elapsedMs,
  };
}

// ── Sandbox setup ────────────────────────────────────────────────────────────
function setupSandbox(dir: string): void {
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'values.txt'), VALUES_CONTENT, 'utf8');
  writeFileSync(join(dir, 'task.md'), TASK_CONTENT, 'utf8');
  writeFileSync(join(dir, 'README.md'), README_CONTENT, 'utf8');
  git(['init', '-q'], dir);
  git(['add', '-A'], dir);
  git(['-c', 'user.name=probe', '-c', 'user.email=probe@local', 'commit', '-q', '-m', 'init'], dir);
}

function copyCheckpoint(srcCwd: string, dstCwd: string, runId: string): void {
  const src = join(srcCwd, '.omd', 'continuity', runId);
  const dst = join(dstCwd, '.omd', 'continuity', runId);
  if (!existsSync(src)) return;
  cpSync(src, dst, { recursive: true });
}

function rmBCheckpoint(cwd: string, runId: string): void {
  rmSync(join(cwd, '.omd', 'continuity', runId, 'b.json'), { force: true });
}

// ── Smoke (signal-a go/no-go) ────────────────────────────────────────────────
/** 直接写回传入的 payload.anchors (避免常量再拷贝导致 mutation 失效)。 */
async function runSmoke(anchors: RawPayload['anchors']): Promise<{ go: boolean; reason: string | null }> {
  const s1 = mkdtempSync(join(tmpdir(), 'omd-nrr-smoke-s1-'));
  const s2 = mkdtempSync(join(tmpdir(), 'omd-nrr-smoke-s2-'));
  const cache = new Map<string, true>();
  try {
    setupSandbox(s1);
    git(['worktree', 'add', '-q', s2, 'HEAD'], s1);
    const runId = 'smoke-run';
    const bGoal = CONTROL_BASELINE;

    const base = await runOnce({ repoRoot: s1, runId, bGoal, resume: false, cache, timeoutMs: TIMEOUT_MS });
    const baselineB = base.bOutput;

    copyCheckpoint(s1, s2, runId);
    rmBCheckpoint(s2, runId);

    const rerun = await runOnce({ repoRoot: s2, runId, bGoal, resume: true, cache, timeoutMs: TIMEOUT_MS });

    const mgr = new CheckpointManager(s2);
    const greens = mgr.loadAllGreen(runId);
    anchors.loadAllGreen.smokeGreenCount = greens.length;
    anchors.resumePassthrough.smokeASkipped = rerun.aSkipped;
    anchors.resumePassthrough.smokeWorktreeRoot = s2;

    let go = true;
    let reason: string | null = null;
    if (rerun.timedOut) {
      go = false;
      reason = `smoke 超时: rerun > ${TIMEOUT_MS}ms`;
    } else if (rerun.bStatus !== 'done') {
      go = false;
      reason = `smoke b.status !== 'done' (got=${rerun.bStatus})`;
    } else if (!REAL && rerun.bOutput !== baselineB) {
      // 字节相等只是 stub 臂的不变量 (确定性假模型下不等 = 管线坏了)。真模型臂下不等
      // **正是信号 c 要量的噪声**, 不是闸的前提 —— 判词里的信号 a 只问"能否重建上下文"
      // (机制锚点: A 跳过 / 绿节点在 / resume 透传), 拿③当真臂闸 = 把待测现象当故障。
      go = false;
      reason = `smoke b.output 与 baseline 不字节相等 (差异=${rerun.bOutput.length - baselineB.length} 字节)`;
    }
    return { go, reason };
  } finally {
    rmSync(s1, { recursive: true, force: true });
    rmSync(s2, { recursive: true, force: true });
  }
}

// ── 单样本 (per arm) ─────────────────────────────────────────────────────────
async function buildSample(
  arm: Arm,
  sampleIdx: number,
  baselineGoal: string,
  rerunGoal: string,
  cache: Map<string, true>,
): Promise<Sample> {
  const s1 = mkdtempSync(join(tmpdir(), `omd-nrr-${arm}-${sampleIdx}-s1-`));
  const s2 = mkdtempSync(join(tmpdir(), `omd-nrr-${arm}-${sampleIdx}-s2-`));
  const runId = `r-${arm}-${sampleIdx}`;
  try {
    setupSandbox(s1);
    git(['worktree', 'add', '-q', s2, 'HEAD'], s1);

    const baseline = await runOnce({
      repoRoot: s1,
      runId,
      bGoal: baselineGoal,
      resume: false,
      cache,
      timeoutMs: TIMEOUT_MS,
    });

    copyCheckpoint(s1, s2, runId);
    rmBCheckpoint(s2, runId);

    const rerun = await runOnce({
      repoRoot: s2,
      runId,
      bGoal: rerunGoal,
      resume: true,
      cache,
      timeoutMs: TIMEOUT_MS,
    });

    const diffDistance = jaccardDistance(baseline.bOutput, rerun.bOutput);

    // 首执行节点 = a.skipped===true ? 'b' : 'a';control arm a 跳过 → 取 b.cacheHit。
    const aRes = rerun.result?.results['a'] as LeafResult | undefined;
    const bRes = rerun.result?.results['b'] as LeafResult | undefined;
    const firstNodeId: 'a' | 'b' = rerun.aSkipped === true ? 'b' : 'a';
    const firstLeaf = firstNodeId === 'a' ? aRes : bRes;
    const cacheReadInputTokens: Sample['cacheReadInputTokens'] = {
      value: firstLeaf?.usage.cacheHit ?? null,
      fromNodeId: firstLeaf ? firstNodeId : null,
      reason: rerun.timedOut
        ? `rerun 超时 ${TIMEOUT_MS}ms,无 leaf 结果`
        : firstLeaf
          ? null
          : '无 leaf 结果',
    };

    const maxMs = Math.max(baseline.elapsedMs, rerun.elapsedMs);
    const sumMs = baseline.elapsedMs + rerun.elapsedMs;

    return {
      arm,
      sample: sampleIdx,
      goal: { baseline: baselineGoal, rerun: rerunGoal, identical: baselineGoal === rerunGoal },
      cwd: s2,
      cacheReadInputTokens,
      diffDistance,
      wallMs: { baselineMs: baseline.elapsedMs, rerunMs: rerun.elapsedMs, maxMs, sumMs },
      aSkippedOnResume: rerun.aSkipped,
      bOutputBaseline: baseline.bOutput,
      bOutputRerun: rerun.bOutput,
    };
  } finally {
    rmSync(s1, { recursive: true, force: true });
    rmSync(s2, { recursive: true, force: true });
  }
}

async function buildArm(
  arm: Arm,
  baselineGoal: string,
  rerunGoal: string,
  notes: string[],
): Promise<Sample[]> {
  const samples: Sample[] = [];
  // 每臂共享 cache 表:跨样本累积 prompt-cache 命中 (key = model|goalHash|prompt.length)。
  const cache = new Map<string, true>();
  for (let s = 0; s < SAMPLES; s++) {
    try {
      samples.push(await buildSample(arm, s, baselineGoal, rerunGoal, cache));
    } catch (e) {
      notes.push(`${arm} sample ${s} 异常: ${String(e).slice(0, 200)}`);
      samples.push({
        arm,
        sample: s,
        goal: { baseline: baselineGoal, rerun: rerunGoal, identical: baselineGoal === rerunGoal },
        cwd: '',
        cacheReadInputTokens: { value: null, fromNodeId: null, reason: `buildSample 异常: ${String(e).slice(0, 200)}` },
        diffDistance: 0,
        wallMs: { baselineMs: 0, rerunMs: 0, maxMs: 0, sumMs: 0 },
        aSkippedOnResume: null,
        bOutputBaseline: '',
        bOutputRerun: '',
      });
    }
  }
  return samples;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // payload.anchors 在此一次性建出;smoke 通过引用写回 loadAllGreen/resumePassthrough 字段。
  const payload: RawPayload = {
    status: 'error',
    anchors: {
      resumeGreens: { fileLine: ANCHOR_LINES.resumeGreens, present: true },
      loadAllGreen: { fileLine: ANCHOR_LINES.loadAllGreen, smokeGreenCount: null },
      resumePassthrough: {
        fileLine: ANCHOR_LINES.resumePassthrough,
        resumeFlag: true,
        smokeASkipped: null,
        smokeWorktreeRoot: null,
      },
    },
    arms: [],
    wallclock: { maxMs: 0, sumMs: 0 },
    samplesPerArm: SAMPLES,
    notes: [
      `cacheHit 来源 = 注入 generate 的确定性 prompt-cache 模型, 非 provider 遥测`,
      `per-arm shared cache table: 跨样本累积 prompt-cache 命中 (key=model|goalHash|prompt.length)`,
      `extractUpstream 取 prompt 内首次出现 'A_OUT' 起的 48 字符 (实际落在 task 轮廓里 'A_OUT。' 起点,而非 a 节点输出 'A_OUT run=…' 的 48 字符后段);同 goal 仍确定,故控制臂 diff=0`,
    ],
  };

  const writeRaw = (): void => {
    try {
      writeFileSync(RAW_PATH, JSON.stringify(payload, null, 2));
    } catch {
      /* raw 写失败也保持退出码 0 */
    }
  };

  try {
    // ── 信号 a: smoke (S1 baseline → copy → 删 S2/b.json → S2 resume, race 30s) ──
    const smoke = await runSmoke(payload.anchors);
    if (!smoke.go) {
      payload.status = 'signal_a_nogo';
      payload.notes.push(`信号 a NO-GO: ${smoke.reason ?? 'unknown'}`);
      writeRaw();
      console.log(
        `[omd probe: node-rerun-2arm] status=signal_a_nogo arms=0 samples/arm=${SAMPLES} → ${RAW_PATH}`,
      );
      return;
    }
    payload.status = 'go';

    payload.arms.push(...(await buildArm('control', CONTROL_BASELINE, CONTROL_RERUN, payload.notes)));
    payload.arms.push(...(await buildArm('treatment', TREATMENT_BASELINE, TREATMENT_RERUN, payload.notes)));

    // 顶墙钟 = 跨所有 sample run (baseline + rerun) 的 max / sum;smoke 排除。
    let maxMs = 0;
    let sumMs = 0;
    for (const s of payload.arms) {
      if (s.wallMs.maxMs > maxMs) maxMs = s.wallMs.maxMs;
      sumMs += s.wallMs.sumMs;
    }
    payload.wallclock = { maxMs, sumMs };

    const controlArm = payload.arms.filter((s) => s.arm === 'control');
    if (controlArm.length > 0 && controlArm.some((s) => s.diffDistance > 0)) {
      payload.notes.push('control divergence: probe nondeterminism');
    }

    writeRaw();
    console.log(
      `[omd probe: node-rerun-2arm] status=${payload.status} arms=${payload.arms.length} samples/arm=${SAMPLES} → ${RAW_PATH}`,
    );
  } catch (e) {
    payload.status = 'error';
    payload.notes.push(`error: ${String(e).slice(0, 300)}`);
    writeRaw();
    console.log(
      `[omd probe: node-rerun-2arm] status=error arms=${payload.arms.length} samples/arm=${SAMPLES} → ${RAW_PATH}`,
    );
  }
}

// 双层兜底:外层 catch 写盘 + finally exit 0 (any-branch-exit-0)。
main()
  .catch((e) => {
    try {
      const fatalPayload: RawPayload = {
        status: 'error',
        anchors: {
          resumeGreens: { fileLine: ANCHOR_LINES.resumeGreens, present: true },
          loadAllGreen: { fileLine: ANCHOR_LINES.loadAllGreen, smokeGreenCount: null },
          resumePassthrough: {
            fileLine: ANCHOR_LINES.resumePassthrough,
            resumeFlag: true,
            smokeASkipped: null,
            smokeWorktreeRoot: null,
          },
        },
        arms: [],
        wallclock: { maxMs: 0, sumMs: 0 },
        samplesPerArm: SAMPLES,
        notes: [`fatal: ${String(e).slice(0, 400)}`],
      };
      writeFileSync(RAW_PATH, JSON.stringify(fatalPayload, null, 2));
    } catch {
      /* swallow */
    }
  })
  .finally(() => {
    process.exit(0);
  });