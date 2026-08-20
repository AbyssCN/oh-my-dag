#!/usr/bin/env bun
/**
 * scripts/probes/exec-fork-runner — 契约 execute::3tliwmwch7vbj 的执行体。
 *
 * 只**调用**现成件 (零 src/ 改动):
 *   - `resolveEngineModels` (mcp/assemble) 读冻结座位
 *   - `createAgentLeafRunner` (harness/agent-leaf) = SDK resume 透传的宿主
 *   - `CheckpointManager` (harness/continuity/checkpoint-manager) = 节点级 resume/loadAllGreen
 *   - `runExecutorDagWithPlan` (harness/dag/engine) = 引擎本体, 吃预构造 plan, 跳过 conductor
 *
 * 四臂: `--arm ab-probe|baseline|control|treatment`。四信号 a/b/c/d 与 readings schema 见契约 §3/§5。
 *
 * 用法: `bun run scripts/probes/exec-fork-runner.ts --arm <ab-probe|baseline|control|treatment>`
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootstrapModelRuntime } from '../../src/model/bootstrap';
import { resolveEngineModels } from '../../src/mcp/assemble';
import { createAgentLeafRunner } from '../../src/harness/agent-leaf';
import { CheckpointManager } from '../../src/harness/continuity/checkpoint-manager';
import { runExecutorDagWithPlan } from '../../src/harness/dag/engine';
import { parsePlan } from '../../src/harness/conductor-plan';
import type { ConductorPlan } from '../../src/harness/conductor-plan';
import type { ExecutorDagConfig } from '../../src/harness/dag/types';

// ── 契约 §1 固定路径/夹具 ────────────────────────────────────────────────────
const BASE = '/tmp/omd-contract-3tliwmwch7vbj';
const FIXTURE_REPO = join(BASE, 'sandbox-git');
const WORKTREE = join(BASE, 'worktree');
const READINGS_DIR = join(import.meta.dir, 'readings');
const REPO_ROOT = process.cwd();

const README_TASK = `Change task.py so that max_pair(a, b) returns the larger of a and b.
Do not modify test_task.py, README_TASK.md, or verify.sh.
Run: bash verify.sh until it exits 0.
`;
const TASK_PY = `def max_pair(a, b):
    raise NotImplementedError
`;
const TEST_TASK_PY = `from task import max_pair

def test_max_pair():
    assert max_pair(2, 3) == 3
    assert max_pair(9, 4) == 9
    assert max_pair(-1, -5) == -1
`;
const VERIFY_SH = `#!/usr/bin/env bash
set -euo pipefail
exec python3 -m pytest test_task.py -q
`;

const SEED_FACT = 'CONTRACT-FACT-3TLIWMWCH7VBJ';
const SEED_GOAL = `Output exactly one line: ${SEED_FACT}\nDo not read or write any files.`;

const GOAL_CONTROL =
  '在 cwd 对应的 detached worktree 中,按 README_TASK.md 完成 sandbox 小改动。不得修改 test_task.py、' +
  'README_TASK.md、verify.sh。改完运行 verify 命令: bash verify.sh,直到 exit 0。最终输出第一行必须是 ' +
  'RESULT-STATUS: pass 或 RESULT-STATUS: fail。第一行之后,按原样复述你在上游节点输出中看到的所有 ' +
  'CONTRACT-FACT-* 事实;一个都没看到就写 NO-FACT。不得改动 worktree 之外的任何文件。';
const GOAL_TREATMENT_A = GOAL_CONTROL;
const GOAL_TREATMENT_B =
  'In the detached worktree at your cwd, complete the small sandbox change per README_TASK.md. Do not ' +
  'modify test_task.py, README_TASK.md, or verify.sh. Then run the verify command `bash verify.sh` until ' +
  'it exits 0. First line of final output must be exactly `RESULT-STATUS: pass` or `RESULT-STATUS: fail`. ' +
  'After that line, restate verbatim every `CONTRACT-FACT-*` fact you saw in upstream node output; write ' +
  '`NO-FACT` if you saw none. Do not modify any file outside the worktree.';

const QUOTA_RE = /GoUsageLimitError|insufficient_quota|usage_limit_reached|rate_limit|quota exceeded/i;
const WALLCLOCK_ABORT_MS = 7_200_000;

// ── §5 schema ────────────────────────────────────────────────────────────────
type Entry = 'not_run' | 'ran_miss' | 'na' | 'ran';

interface PathReading {
  pathId: string;
  goal: string;
  entry: Entry;
  wallclockMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadInputTokensFirst: number | null;
  cacheCreationInputTokensFirst: number | null;
  contextRebuilt: boolean | null;
  verifyPassed: boolean | null;
  quotaWall: { hit: boolean; rawError: string | null };
}

interface GroupReading {
  group: 1 | 2 | 3;
  paths: [PathReading, PathReading];
  armWallclockMaxMs: number | null;
  pairDistance: number | null;
  contextRebuilt: boolean | null;
}

interface AbortPoint {
  triggered: boolean;
  reason: 'a=false' | 'quota_wall' | 'wallclock_2h' | 'budget_3_groups' | null;
  atGroup: number | null;
  atPath: string | null;
  cumulativeWallclockMs: number | null;
}

interface ArmReading {
  arm: 'baseline' | 'control' | 'treatment';
  entry: Entry;
  groups?: GroupReading[];
  distances?: (number | null)[];
  armWallclockMaxMs: number | null;
  verdict: {
    separable: boolean | null;
    reason: string | null;
    maxControl: number | null;
    minTreatment: number | null;
    thresholdUsed: 0.1;
    noiseCap: 0.25;
  } | null;
  abort: AbortPoint | null;
}

// ── §4 距离度量 ────────────────────────────────────────────────────────────────
function normalize(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0)
    .flatMap((l) => l.split(/\s+/));
}

function levenshtein(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function dist(x: string, y: string): number {
  const a = normalize(x);
  const b = normalize(y);
  const L = levenshtein(a, b);
  return L / Math.max(a.length, b.length, 1);
}

// ── 小工具 ───────────────────────────────────────────────────────────────────
function sh(args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf-8' });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { ok: r.status === 0, out };
}

/** 累计墙钟 (§7 中止规则③) — 跨调用维护的模块级状态。 */
let cumulativeWallclockMs = 0;
let abortState: AbortPoint = { triggered: false, reason: null, atGroup: null, atPath: null, cumulativeWallclockMs: null };

function checkAbort(reason: AbortPoint['reason'], atGroup: number | null, atPath: string | null): void {
  if (abortState.triggered) return;
  abortState = { triggered: true, reason, atGroup, atPath, cumulativeWallclockMs };
}

function notRunPath(pathId: string, goal: string): PathReading {
  return {
    pathId,
    goal,
    entry: 'not_run',
    wallclockMs: null,
    tokensIn: null,
    tokensOut: null,
    cacheReadInputTokensFirst: null,
    cacheCreationInputTokensFirst: null,
    contextRebuilt: null,
    verifyPassed: null,
    quotaWall: { hit: false, rawError: null },
  };
}

// ── 契约 §1 sandbox 夹具 ─────────────────────────────────────────────────────
function initFixtureRepo(): string {
  mkdirSync(FIXTURE_REPO, { recursive: true });
  writeFileSync(join(FIXTURE_REPO, 'README_TASK.md'), README_TASK);
  writeFileSync(join(FIXTURE_REPO, 'task.py'), TASK_PY);
  writeFileSync(join(FIXTURE_REPO, 'test_task.py'), TEST_TASK_PY);
  writeFileSync(join(FIXTURE_REPO, 'verify.sh'), VERIFY_SH);
  sh(['chmod', '+x', join(FIXTURE_REPO, 'verify.sh')]);
  sh(['git', 'init', '-q'], FIXTURE_REPO);
  sh(['git', 'config', 'user.email', 'probe@omd.local'], FIXTURE_REPO);
  sh(['git', 'config', 'user.name', 'omd-probe'], FIXTURE_REPO);
  sh(['git', 'add', '-A'], FIXTURE_REPO);
  sh(['git', 'commit', '-q', '-m', 'fixture'], FIXTURE_REPO);
  const rev = sh(['git', 'rev-parse', 'HEAD'], FIXTURE_REPO);
  if (!rev.ok) throw new Error(`initFixtureRepo: rev-parse 失败: ${rev.out}`);
  return rev.out.trim();
}

function resetWorktree(fixtureCommit: string): void {
  sh(['git', '-C', FIXTURE_REPO, 'worktree', 'remove', '--force', WORKTREE]);
  sh(['git', '-C', FIXTURE_REPO, 'worktree', 'prune']);
  const add = sh(['git', '-C', FIXTURE_REPO, 'worktree', 'add', '--detach', WORKTREE, fixtureCommit]);
  if (!add.ok) throw new Error(`resetWorktree: worktree add 失败: ${add.out}`);
}

function removeWorktreeFinal(): void {
  sh(['git', '-C', FIXTURE_REPO, 'worktree', 'remove', '--force', WORKTREE]);
  sh(['git', '-C', FIXTURE_REPO, 'worktree', 'prune']);
}

// ── checkpoint 清理: 只删 S, 保留 U (契约 §2.2) ────────────────────────────────
function deleteSCheckpoint(runId: string): void {
  const dir = join(REPO_ROOT, '.omd', 'continuity', runId);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'S.json' || /^S\.__r\d+\.json$/.test(entry) || entry === 'out-S.txt' || entry === 'fail-S.txt' || /^(out|fail)-S\.__r\d+\.txt$/.test(entry)) {
      rmSync(join(dir, entry), { force: true });
    }
  }
}

// ── plan 构造 ────────────────────────────────────────────────────────────────
function buildPlan(opts: { withU: boolean; sGoal: string; seat: string }): ConductorPlan {
  const nodes: Record<string, unknown> = {};
  if (opts.withU) nodes.U = { goal: SEED_GOAL, model: opts.seat };
  nodes.S = {
    goal: opts.sGoal,
    executor: 'agent',
    model: opts.seat,
    ...(opts.withU ? { depends_on: ['U'] } : {}),
  };
  const raw = { name: 'exec-fork-probe', nodes };
  const parsed = parsePlan(JSON.stringify(raw), { knownServers: new Set() });
  if (!parsed.ok) throw new Error(`buildPlan: parsePlan 拒绝: ${parsed.error}`);
  return parsed.plan;
}

// ── 一条路径的执行 ───────────────────────────────────────────────────────────
interface RunPathResult {
  reading: PathReading;
  output: string;
  aborted: boolean;
}

async function runOnePath(opts: {
  pathId: string;
  goal: string;
  withU: boolean;
  seat: string;
  runId: string | null; // null = 无 continuity (baseline)
  fixtureCommit: string;
  cm: CheckpointManager;
}): Promise<RunPathResult> {
  const { pathId, goal, withU, seat, runId, fixtureCommit, cm } = opts;
  resetWorktree(fixtureCommit);

  // 第一次 message_end 的原生 usage (SDK resume 透传通道, claude-sdk-loop.ts:302)。
  // 用装箱对象而非裸 let: 赋值发生在异步回调里, TS 的 CFA 看不到那次赋值, 裸 let 会在下方读取处
  // 被窄化回声明时的 `null` (narrows-to-never), 装箱字段不受这条 CFA 限制影响。
  const usageBox: { v: { cacheRead?: number; cacheWrite?: number } | null } = { v: null };
  const agentRunner = createAgentLeafRunner({
    cwd: WORKTREE,
    hashlineEdit: true,
    leafTimeoutMs: 600_000,
    onEvent: (e) => {
      if (usageBox.v !== null) return;
      if (e.type !== 'message_end') return;
      const msg = (e as { message?: { usage?: { cacheRead?: number; cacheWrite?: number } } }).message;
      if (msg?.usage) usageBox.v = { cacheRead: msg.usage.cacheRead, cacheWrite: msg.usage.cacheWrite };
    },
  });

  const config: ExecutorDagConfig = {
    conductorModel: '',
    leafModel: seat,
    agentLeafModel: seat,
    agentRunner,
    maxFanout: 2,
    ...(runId ? { continuity: { manager: cm, runId, resume: true, repoRoot: REPO_ROOT } } : {}),
  };

  const plan = buildPlan({ withU, sGoal: goal, seat });
  const t0 = Date.now();
  let rawError: string | null = null;
  let sOutput = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  try {
    const result = await runExecutorDagWithPlan(plan, config);
    const s = result.results.S;
    sOutput = s?.output ?? '';
    tokensIn = s?.usage?.in ?? null;
    tokensOut = s?.usage?.out ?? null;
    if (s?.status === 'failed') rawError = sOutput.slice(0, 2000);
  } catch (e) {
    rawError = (e as Error).message;
  }
  const wallclockMs = Date.now() - t0;
  cumulativeWallclockMs += wallclockMs;

  const quotaHit = rawError !== null && QUOTA_RE.test(rawError);

  // 独立 verify: 在 WORKTREE 里自己跑一遍 (不信任 agent 的自述)。
  const verify = sh(['bash', 'verify.sh'], WORKTREE);
  const firstLine = sOutput.split('\n')[0]?.trim() ?? '';
  const porcelain = sh(['git', '-C', WORKTREE, 'status', '--porcelain']);
  const onlyTaskPyChanged = porcelain.ok && porcelain.out.trim() === 'M task.py';
  const verifyPassed = verify.ok && firstLine === 'RESULT-STATUS: pass' && onlyTaskPyChanged;

  const contextRebuilt = withU ? sOutput.includes(SEED_FACT) : null;

  const reading: PathReading = {
    pathId,
    goal,
    entry: rawError && !quotaHit ? 'ran_miss' : 'ran',
    wallclockMs,
    tokensIn,
    tokensOut,
    cacheReadInputTokensFirst: usageBox.v ? (usageBox.v.cacheRead ?? null) : null,
    cacheCreationInputTokensFirst: usageBox.v ? (usageBox.v.cacheWrite ?? null) : null,
    contextRebuilt,
    verifyPassed,
    quotaWall: { hit: quotaHit, rawError: quotaHit ? rawError : null },
  };

  if (runId) deleteSCheckpoint(runId);

  let aborted = false;
  if (quotaHit) {
    checkAbort('quota_wall', null, pathId);
    aborted = true;
  } else if (withU && contextRebuilt === false) {
    checkAbort('a=false', null, pathId);
    aborted = true;
  } else if (cumulativeWallclockMs > WALLCLOCK_ABORT_MS) {
    checkAbort('wallclock_2h', null, pathId);
    aborted = true;
  }
  return { reading, output: sOutput, aborted };
}

// ── 判词 (§8, 事先写死) ────────────────────────────────────────────────────────
function judge(controlDist: (number | null)[], treatmentDist: (number | null)[]): ArmReading['verdict'] {
  const c = controlDist.filter((x): x is number => x !== null);
  const t = treatmentDist.filter((x): x is number => x !== null);
  if (c.length !== 3 || t.length !== 3) {
    return { separable: null, reason: 'insufficient', maxControl: null, minTreatment: null, thresholdUsed: 0.1, noiseCap: 0.25 };
  }
  const maxC = Math.max(...c);
  const minD = Math.min(...t);
  const separable = minD >= maxC + 0.1 && maxC <= 0.25;
  return {
    separable,
    reason: separable ? '不同 goal 产生可分输出' : '不同 goal 未与噪声底分离',
    maxControl: maxC,
    minTreatment: minD,
    thresholdUsed: 0.1,
    noiseCap: 0.25,
  };
}

// ── ab-probe 臂: 最小 resume+cwd 杀手闸 (量 a 与 b, 单 group 两路首发) ─────────────
interface AbProbeReading {
  entry: Entry;
  a: boolean | null;
  b: (number | null)[];
  paths: PathReading[];
  abortReason: string | null;
  seat: string;
}

async function runAbProbe(seat: string, fixtureCommit: string, cm: CheckpointManager): Promise<AbProbeReading> {
  const seedRunId = randomUUID();
  const seedPlan = buildPlan({ withU: true, sGoal: GOAL_CONTROL, seat });
  // 只跑 U (单独构一个只含 U 的 plan)。
  const seedOnlyU = { name: 'exec-fork-probe-seed', nodes: { U: (seedPlan.nodes as Record<string, unknown>).U } };
  const parsedSeed = parsePlan(JSON.stringify(seedOnlyU), { knownServers: new Set() });
  if (!parsedSeed.ok) throw new Error(`ab-probe: seed plan 拒绝: ${parsedSeed.error}`);
  await runExecutorDagWithPlan(parsedSeed.plan, {
    conductorModel: '',
    leafModel: seat,
    agentLeafModel: seat,
    continuity: { manager: cm, runId: seedRunId, resume: false, repoRoot: REPO_ROOT },
  });
  const greens = cm.loadAllGreen(seedRunId);
  const seedOk = greens.length === 1 && greens[0]!.nodeId === 'U' && greens[0]!.status === 'done';
  console.log(`ab-probe: seed loadAllGreen = ${JSON.stringify(greens.map((g) => ({ nodeId: g.nodeId, status: g.status })))} (期望仅 [{U,done}]) → ${seedOk ? 'PASS' : 'FAIL'}`);
  if (!seedOk) {
    return { entry: 'ran_miss', a: null, b: [], paths: [], abortReason: 'seed_not_green', seat };
  }
  const r1 = await runOnePath({
    pathId: 'ab-probe-1',
    goal: GOAL_CONTROL,
    withU: true,
    seat,
    runId: seedRunId,
    fixtureCommit,
    cm,
  });
  console.log(`ab-probe p1: a(contextRebuilt)=${r1.reading.contextRebuilt} b(cacheReadInputTokensFirst)=${r1.reading.cacheReadInputTokensFirst} verifyPassed=${r1.reading.verifyPassed} quotaWall=${r1.reading.quotaWall.hit}`);
  let r2: RunPathResult | null = null;
  if (!r1.aborted) {
    r2 = await runOnePath({
      pathId: 'ab-probe-2',
      goal: GOAL_CONTROL,
      withU: true,
      seat,
      runId: seedRunId,
      fixtureCommit,
      cm,
    });
    console.log(`ab-probe p2: a(contextRebuilt)=${r2.reading.contextRebuilt} b(cacheReadInputTokensFirst)=${r2.reading.cacheReadInputTokensFirst} verifyPassed=${r2.reading.verifyPassed} quotaWall=${r2.reading.quotaWall.hit}`);
  }
  const paths = r2 ? [r1.reading, r2.reading] : [r1.reading];
  const anyMiss = paths.some((p) => p.entry === 'ran_miss');
  const a = r1.reading.contextRebuilt === true && (r2 === null || r2.reading.contextRebuilt === true) ? true
    : (r1.reading.contextRebuilt === false || r2?.reading.contextRebuilt === false) ? false : null;
  const entry: Entry = anyMiss ? 'ran_miss' : 'ran';
  const abProbeReading = {
    entry,
    a,
    b: paths.map((p) => p.cacheReadInputTokensFirst),
    paths,
    abortReason: r1.aborted ? 'a=false-after-p1' : null,
    seat,
  };
  return abProbeReading;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const arm = process.argv.includes('--arm') ? process.argv[process.argv.indexOf('--arm') + 1] : undefined;
  if (!arm || !['ab-probe', 'baseline', 'control', 'treatment'].includes(arm)) {
    console.error('用法: bun run scripts/probes/exec-fork-runner.ts --arm <ab-probe|baseline|control|treatment>');
    process.exitCode = 2;
    return;
  }

  bootstrapModelRuntime();
  const models = resolveEngineModels(process.env);
  const seat = models.agentLeafModel ?? models.leafModel;
  if (!seat) {
    console.error('fail-closed: 读不到冻结 agent 座位 (resolveEngineModels 空) — 不跑');
    process.exitCode = 2;
    return;
  }
  mkdirSync(READINGS_DIR, { recursive: true });
  const abProbePath = join(READINGS_DIR, 'ab-probe.json');
  const priorAbProbe = existsSync(abProbePath) ? (JSON.parse(readFileSync(abProbePath, 'utf-8')) as Partial<AbProbeReading> & { runIds?: Record<string, string> }) : {};
  if (priorAbProbe.seat != null && priorAbProbe.seat !== seat) {
    console.error(`fail-closed: ab-probe.json 已冻结座位 ${priorAbProbe.seat}, 本次读到 ${seat} — 座位漂移, 不跑`);
    process.exitCode = 2;
    return;
  }
  const runIds: Record<string, string> = priorAbProbe.runIds ?? {};

  const cm = new CheckpointManager(REPO_ROOT);
  const fixtureCommit = initFixtureRepo();

  try {
    if (arm === 'ab-probe') {
      const result = await runAbProbe(seat, fixtureCommit, cm);
      const out = { runIds, ...result };
      writeFileSync(abProbePath, JSON.stringify(out, null, 2));
      console.log(`ab-probe: entry=${result.entry} a=${result.a} b=${JSON.stringify(result.b)} abortReason=${result.abortReason}`);
      if (result.entry === 'ran_miss') process.exitCode = 1;
      return;
    }

    if (arm === 'baseline') {
      const r = await runOnePath({ pathId: 'baseline', goal: GOAL_CONTROL, withU: false, seat, runId: null, fixtureCommit, cm });
      const reading: ArmReading = {
        arm: 'baseline',
        entry: r.reading.entry,
        armWallclockMaxMs: r.reading.wallclockMs,
        verdict: null,
        abort: abortState.triggered ? abortState : null,
      };
      writeFileSync(join(READINGS_DIR, 'baseline.json'), JSON.stringify({ ...reading, path: r.reading }, null, 2));
      console.log(`baseline: entry=${r.reading.entry} wallclockMs=${r.reading.wallclockMs} verifyPassed=${r.reading.verifyPassed}`);
      return;
    }

    if (arm === 'control' || arm === 'treatment') {
      const runId = runIds[arm] ?? randomUUID();
      runIds[arm] = runId;
      const abProbeOut = { entry: 'not_run', a: null, b: [], paths: [], abortReason: null, ...priorAbProbe, seat, runIds };
      writeFileSync(abProbePath, JSON.stringify(abProbeOut, null, 2));

      // 共同起点: 只跑一次 (若尚未跑过) — 单节点 [U] plan, 落 checkpoint。
      const existingGreens = cm.loadAllGreen(runId);
      if (existingGreens.length === 0) {
        const seedOnlyU = { name: 'exec-fork-probe-seed', nodes: { U: { goal: SEED_GOAL, model: seat } } };
        const parsedSeed = parsePlan(JSON.stringify(seedOnlyU), { knownServers: new Set() });
        if (!parsedSeed.ok) throw new Error(`共同起点 plan 拒绝: ${parsedSeed.error}`);
        await runExecutorDagWithPlan(parsedSeed.plan, {
          conductorModel: '',
          leafModel: seat,
          agentLeafModel: seat,
          continuity: { manager: cm, runId, resume: false, repoRoot: REPO_ROOT },
        });
      }
      const greens = cm.loadAllGreen(runId);
      const seedOk = greens.length === 1 && greens[0]!.nodeId === 'U' && greens[0]!.status === 'done';
      if (!seedOk) {
        console.error(`共同起点未满足: loadAllGreen(${runId}) = ${JSON.stringify(greens.map((g) => ({ nodeId: g.nodeId, status: g.status })))} — abort, 不进入测量`);
        const arm2: ArmReading = {
          arm,
          entry: 'ran_miss',
          armWallclockMaxMs: null,
          verdict: null,
          abort: { triggered: true, reason: null, atGroup: null, atPath: null, cumulativeWallclockMs },
        };
        writeFileSync(join(READINGS_DIR, `${arm}.json`), JSON.stringify(arm2, null, 2));
        process.exitCode = 1;
        return;
      }

      const groups: GroupReading[] = [];
      const distances: (number | null)[] = [];
      for (let g = 1; g <= 3 && !abortState.triggered; g++) {
        const goals: [string, string] =
          arm === 'control' ? [GOAL_CONTROL, GOAL_CONTROL] : [GOAL_TREATMENT_A, GOAL_TREATMENT_B];
        const p1 = await runOnePath({ pathId: `g${g}-${arm === 'control' ? 'c' : 't'}1`, goal: goals[0], withU: true, seat, runId, fixtureCommit, cm });
        if (p1.aborted) {
          abortState = { ...abortState, atGroup: g, atPath: p1.reading.pathId };
          groups.push({ group: g as 1 | 2 | 3, paths: [p1.reading, notRunPath(`g${g}-${arm === 'control' ? 'c' : 't'}2`, goals[1])], armWallclockMaxMs: p1.reading.wallclockMs, pairDistance: null, contextRebuilt: null });
          break;
        }
        const p2 = await runOnePath({ pathId: `g${g}-${arm === 'control' ? 'c' : 't'}2`, goal: goals[1], withU: true, seat, runId, fixtureCommit, cm });
        const armMax = Math.max(p1.reading.wallclockMs ?? 0, p2.reading.wallclockMs ?? 0);
        const pairDistance = dist(p1.output, p2.output);
        distances.push(pairDistance);
        groups.push({
          group: g as 1 | 2 | 3,
          paths: [p1.reading, p2.reading],
          armWallclockMaxMs: armMax,
          pairDistance,
          contextRebuilt: p1.reading.contextRebuilt === true && p2.reading.contextRebuilt === true,
        });
        if (p2.aborted) {
          abortState = { ...abortState, atGroup: g, atPath: p2.reading.pathId };
          break;
        }
        if (g === 3) checkAbort('budget_3_groups', 3, null);
      }

      const control = arm === 'control' ? distances : [];
      const treatment = arm === 'treatment' ? distances : [];
      const verdict = arm === 'treatment' ? judge(readSiblingDistances('control'), treatment) : arm === 'control' ? null : null;

      const armReading: ArmReading = {
        arm,
        entry: groups.length ? 'ran' : 'not_run',
        groups,
        distances: arm === 'control' ? control : treatment,
        armWallclockMaxMs: groups.length ? Math.max(...groups.map((gr) => gr.armWallclockMaxMs ?? 0)) : null,
        verdict,
        abort: abortState.triggered ? abortState : null,
      };
      writeFileSync(join(READINGS_DIR, `${arm}.json`), JSON.stringify(armReading, null, 2));
      console.log(`${arm}: groups=${groups.length} distances=${JSON.stringify(arm === 'control' ? control : treatment)} abort=${abortState.triggered ? abortState.reason : 'none'}`);
      return;
    }
  } finally {
    removeWorktreeFinal();
  }
}


/** control 臂的 distances 落盘后, treatment 侧要读它来判 verdict (两臂各自独立起跑)。 */
function readSiblingDistances(arm: 'control'): (number | null)[] {
  const p = join(READINGS_DIR, `${arm}.json`);
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8')) as { distances?: (number | null)[] };
    return j.distances ?? [];
  } catch {
    return [];
  }
}

main().catch((e) => {
  console.error(`exec-fork-runner 顶层异常 (runId 见上文日志, 状态未必已落盘): ${(e as Error).message}`);
  process.exitCode = 1;
});
