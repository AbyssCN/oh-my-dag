/**
 * src/mcp/tools/fleet —— dag_review / dag_slim / dag_deepen / dag_debug 四个异步 MCP 工具。
 *
 * 受监督子进程包装本仓 scripts/dag-{review,slim,deepen}.ts: Bun.spawn(['bun','run',<script>,...flags])
 * 数组参数非 shell 字符串 (无注入面), flag 白名单构造 + 值拒 `--` 前缀 (防 flag 走私), cwd 注入。
 * 三段式 registry (同 dag_run 范式): register → start → fire-and-forget 子进程 →
 *   exit 0  → succeed({summary, reportPath})   (summary = stdout brief 尾段)
 *   exit ≠0 → fail(stderr 尾 400 字)
 * --out 由本模块定 (/tmp/omd-fleet-<tool>-<runId>.md) — 报告路径确定可知, 不靠解析脚本 stdout。
 *
 * D-4 观察面 (SDD 2026-08-11-dag-观察面与审核跟踪升级, C-5): dag_review 有 onNodeEvent 订阅者
 * (TUI) 时, 子进程经 run.ts 的 OMD_REVIEW_EVENT_FILE 汇把进度 NDJSON 逐行追加到事件文件,
 * 本模块轮询翻成标准 DagNodeEvent 灌 pushDagEvent (合成 runId = 本工具 runId, 维度 = 节点)。
 * 合成 run 不进 dag_runs 列表 (D-11) —— 只上 TUI 实时面板, 回看走 review 全文写入磁盘。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { logger } from '../../logger';
import { awaitWhileAlive, spawnWithPipes } from '../../harness/proc/await-exit';
import type { DagNodeEvent } from '../../harness/dag/types';
import type { ReviewProgressEvent } from '../../harness/review/run';
import type { RunRegistry } from '../run-registry.js';
import type { OmdMcpTool } from '../server.js';


// ---------------------------------------------------------------------------
// deps + spawn 接缝
// ---------------------------------------------------------------------------

/** 子进程结果 (exit code + 已收集的 stdout/stderr 全文)。 */
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** spawn 接缝 —— 测试注入 fake; 生产默认 Bun.spawn (下方 defaultSpawn)。env 追加进子进程 (默认继承)。 */
export interface SpawnFn {
  (cmd: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<SpawnResult>;
}

/** Dependencies injected into fleet tool handlers. */
export interface FleetToolDeps {
  runRegistry: RunRegistry;
  /** 仓根 — 子进程 cwd + 脚本相对路径基准。 */
  cwd: string;
  /** 覆盖 spawn (测试)。默认 Bun.spawn(['bun','run',...])。 */
  spawn?: SpawnFn;
  /**
   * D-4 观察面订阅者 (TUI pushDagEvent 源, 经 assemble.ts 传达): 给了则 dag_review 把子进程
   * 进度翻成标准 DagNodeEvent 灌进来 (合成 runId = 本工具 runId, 维度 = 节点)。省略 = 不转 (现状)。
   */
  onNodeEvent?: (runId: string, e: DagNodeEvent) => void;
}

/**
 * D-4 翻面: review 进度事件 (ReviewProgressEvent, run.ts 的 onProgress 汇) → 标准 DagNodeEvent。
 * 维度 = 节点; verdict.gate 恒 'review' —— pass/fail 方向 (D-9) 在 run.ts 发射时已定, 这里只翻形状。
 */
export function toDagNodeEvent(e: ReviewProgressEvent): DagNodeEvent {
  switch (e.type) {
    case 'planned':
      return { type: 'planned', nodes: e.nodes };
    case 'start':
      return { type: 'start', id: e.id, kind: e.kind };
    case 'settle':
      return { type: 'settle', id: e.id, status: e.status, kind: e.kind, model: e.model, durationMs: e.durationMs, failReason: e.failReason };
    case 'verdict':
      return { type: 'verdict', id: e.id, gate: e.gate, verdict: e.verdict, round: e.round, reason: e.reason };
  }
}

/**
 * D-4 事件汇轮询 (SDD C-5): 子进程把 review 进度 NDJSON **逐行追加**到 eventFile (run.ts 的
 * OMD_REVIEW_EVENT_FILE 汇), 本进程每 intervalMs 读增量翻成 DagNodeEvent 灌 onNodeEvent (合成 runId)。
 * 返回 stop(): 停轮询 + 终排 (子进程退出后可能还有最后几条, 不留尾巴)。
 * 文件未建/行解析失败 → 静默/仅 warn (观察面是可丢的旁路, 不打断 review 本身)。
 */
export function startReviewEventPoller(
  opts: { file: string; runId: string; onNodeEvent: (runId: string, e: DagNodeEvent) => void; intervalMs?: number },
): () => void {
  const { file, runId, onNodeEvent } = opts;
  const intervalMs = opts.intervalMs ?? 200;
  let tail = ''; // 半行缓冲 (追加写可能读到写了一半的 JSON)
  const drain = (): void => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return; // 文件还没建 (子进程未起) → 下轮再说
    }
    const lines = (tail + text).split('\n');
    tail = lines.pop() ?? '';
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        onNodeEvent(runId, toDagNodeEvent(JSON.parse(ln) as ReviewProgressEvent));
      } catch (err) {
        logger.warn({ runId, err: (err as Error).message }, '[fleet/dag_review] 事件行解析失败 (跳过, 观察面旁路)');
      }
    }
  };
  drain();
  const timer = setInterval(drain, intervalMs);
  timer.unref?.(); // 不挡进程退出 (fire-and-forget 子进程)
  return () => {
    clearInterval(timer);
    drain();
  };
}

/**
 * 生产 spawn: 数组参数 + cwd/env 注入 + stdout/stderr 管道收集。
 *
 * ## 四张脸现在都有界了(2026-08-15 裁决:**不裁 deadline, 换尺子**)
 *
 * 上一程只补了"管道没建起来"那一张(`spawnWithPipes`,不含时间假设),另外三张
 * (`proc.exited` 永不 resolve / 抛 EBADF / 管道到不了 EOF)当时记成「待裁」——
 * 因为 fleet 的子进程**按设计长跑**(`bun run scripts/dag-*.ts`,分钟级到更久),
 * 给它编一个 deadline 编小了杀正常作业、编大了等于没有。
 *
 * **裁法是换判据**:要挡的从来不是"作业跑太久", 而是"运行时把记账弄丢了", 而这两件事
 * 用 `processGone(pid)` **可以直接分辨** —— 进程还在就无限等(一秒不催), 进程没了而事件
 * 仍没落定才抛。于是这里**没有任何作业时长上限**, 也不需要有。见 `awaitWhileAlive` 头注。
 */
const defaultSpawn: SpawnFn = async (cmd, opts) => {
  const label = `fleet 子进程 \`${cmd.slice(0, 3).join(' ')}\``;
  const proc = spawnWithPipes(
    () => Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: 'pipe', stderr: 'pipe' }),
    ['stdout', 'stderr'],
    label,
  );
  // 三件事各自包 —— 判词要能说清是**哪一件**没落定(合成一个 Promise.all 就只剩"有一件")。
  const [exitCode, stdout, stderr] = await Promise.all([
    awaitWhileAlive(proc.exited, proc.pid, `${label} 等退出码`),
    awaitWhileAlive(new Response(proc.stdout).text(), proc.pid, `${label} 读 stdout`),
    awaitWhileAlive(new Response(proc.stderr).text(), proc.pid, `${label} 读 stderr`),
  ]);
  return { exitCode, stdout, stderr };
};

// ---------------------------------------------------------------------------
// 共用: flag 白名单构造 + 子进程派发
// ---------------------------------------------------------------------------

/** 值安全闸: 数组 spawn 无 shell 注入, 但值以 `--` 开头会走私成新 flag — 拒。 */
function safeValue(v: string): string | null {
  return v.startsWith('--') ? null : v;
}

/** push flag 对 (值经 safeValue; 非法 → 返回 false 由调用方报错)。 */
function pushFlag(argv: string[], name: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  if (safeValue(value) === null) return false;
  argv.push(`--${name}`, value);
  return true;
}

/** 摘要取 stdout 尾段 (brief 模式单行清单; 截 2000 字护 registry)。 */
function summarizeStdout(stdout: string): string {
  const trimmed = stdout.trim();
  return trimmed.length > 2000 ? trimmed.slice(-2000) : trimmed;
}

/** stderr 尾 400 字 (fail reason — registry 只留定位线索, 全文在 stdout/报告)。 */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.slice(-400);
}

interface FleetRunOpts {
  tool: string;
  script: string;
  argv: string[];
  reportPath: string;
  goal: string;
  /**
   * D-4: review 进度事件文件 (子进程 NDJSON 逐行追加; 父进程轮询翻成 DagNodeEvent 灌 onNodeEvent)。
   * 给了 → spawn env 带 OMD_REVIEW_EVENT_FILE, 退出后清理临时目录。
   */
  eventFile?: string;
}

/** 三段式派发: register → start → 后台 spawn → succeed/fail。同步回 runId。 */
function dispatchFleetRun(
  { runRegistry, cwd, spawn, onNodeEvent }: Required<Pick<FleetToolDeps, 'runRegistry' | 'cwd'>> & { spawn: SpawnFn; onNodeEvent?: FleetToolDeps['onNodeEvent'] },
  opts: FleetRunOpts,
): string {
  const runId = randomUUID();
  runRegistry.register(runId, { goal: opts.goal, meta: { tool: opts.tool } });
  runRegistry.start(runId);

  // D-4: 有观察面订阅者 → 轮询子进程进度事件 (run.ts 经 OMD_REVIEW_EVENT_FILE 汇 NDJSON)。
  const stopPoller = opts.eventFile && onNodeEvent
    ? startReviewEventPoller({ file: opts.eventFile, runId, onNodeEvent })
    : null;

  spawn(
    ['bun', 'run', opts.script, ...opts.argv, '--out', opts.reportPath],
    { cwd, ...(opts.eventFile ? { env: { OMD_REVIEW_EVENT_FILE: opts.eventFile } } : {}) },
  )
    .then(({ exitCode, stdout, stderr }) => {
      if (exitCode === 0) {
        runRegistry.succeed(runId, { summary: summarizeStdout(stdout), reportPath: opts.reportPath });
      } else {
        runRegistry.fail(runId, `exit ${exitCode}: ${stderrTail(stderr)}`);
      }
    })
    .catch((err) => {
      runRegistry.fail(runId, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      stopPoller?.(); // 终排: 收走子进程退出前最后几条
      if (opts.eventFile) {
        try {
          rmSync(dirname(opts.eventFile), { recursive: true, force: true });
        } catch {
          // 临时目录清理失败不炸 (/tmp 自清)。
        }
      }
    });

  return runId;
}

/** 报告存盘路径 (本模块定 → 确定可知)。 */
function reportPathFor(tool: string): string {
  return `/tmp/omd-fleet-${tool}-${randomUUID()}.md`;
}

// ---------------------------------------------------------------------------
// 工具面
// ---------------------------------------------------------------------------

/** Build 4 fleet tools: dag_review, dag_slim, dag_deepen, dag_debug. */
export function createFleetTools(deps: FleetToolDeps): OmdMcpTool[] {
  const spawn = deps.spawn ?? defaultSpawn;
  return [
    makeDagReview(deps, spawn),
    makeDagSlim(deps, spawn),
    makeDagDeepen(deps, spawn),
    makeDagDebug(deps, spawn),
  ];
}

const REVIEW_GATES = ['G0', 'G1', 'G2', 'G3'] as const;

function makeDagReview(deps: FleetToolDeps, spawn: SpawnFn): OmdMcpTool {
  return {
    name: 'dag_review',
    description: 'Adversarial code review async. gate G0-G3, scope=paths, deep=single-agent full-repo review. Returns runId.',
    inputSchema: {
      gate: z.enum(REVIEW_GATES).optional().describe('Review gate G0|G1|G2|G3 (default G2)'),
      scope: z.string().optional().describe('Comma-separated pathspec limiting the diff (e.g. "src,sql")'),
      deep: z.boolean().optional().describe('深审档: 单 agent 读全仓 + 实测(--single);比默认多维并行贵但精度高/自然去重'),
    },
    handler: async (args) => {
      const { gate, scope, deep } = args as { gate?: string; scope?: string; deep?: boolean };
      const argv: string[] = ['--brief'];
      if (gate) argv.push('--gate', gate);
      if (deep) argv.push('--single');
      if (!pushFlag(argv, 'paths', scope)) {
        return { content: [{ type: 'text' as const, text: 'dag_review: scope must not start with "--"' }], isError: true };
      }
      const runId = dispatchFleetRun({ ...deps, spawn }, {
        tool: 'dag_review',
        script: 'scripts/dag-review.ts',
        argv,
        reportPath: reportPathFor('review'),
        goal: `review gate=${gate ?? 'G2'}${scope ? ` paths=${scope}` : ''}`,
        // D-4: 有 TUI 等观察面订阅者 → 起事件文件轮询 (合成 runId = 本 run, 维度 = 节点)。
        eventFile: deps.onNodeEvent ? join(mkdtempSync(join(tmpdir(), 'omd-review-events-')), 'events.ndjson') : undefined,
      });
      return { content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }] };
    },
  };
}

function makeDagSlim(deps: FleetToolDeps, spawn: SpawnFn): OmdMcpTool {
  return {
    name: 'dag_slim',
    description: 'Run over-engineering cut-only audit (scripts/dag-slim.ts) async. scope=comma paths. Returns runId.',
    inputSchema: {
      scope: z.string().optional().describe('Comma-separated pathspec limiting the diff'),
    },
    handler: async (args) => {
      const { scope } = args as { scope?: string };
      const argv: string[] = [];
      if (!pushFlag(argv, 'paths', scope)) {
        return { content: [{ type: 'text' as const, text: 'dag_slim: scope must not start with "--"' }], isError: true };
      }
      const runId = dispatchFleetRun({ ...deps, spawn }, {
        tool: 'dag_slim',
        script: 'scripts/dag-slim.ts',
        argv,
        reportPath: reportPathFor('slim'),
        goal: `slim${scope ? ` paths=${scope}` : ''}`,
      });
      return { content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }] };
    },
  };
}

function makeDagDeepen(deps: FleetToolDeps, spawn: SpawnFn): OmdMcpTool {
  return {
    name: 'dag_deepen',
    description: 'Run architecture-deepening hotspot scan (scripts/dag-deepen.ts) async. Returns runId + HTML report path.',
    inputSchema: {
      commits: z.number().int().min(1).optional().describe('Git log window for hotspot frequency (default 200)'),
      hotspots: z.number().int().min(1).optional().describe('Top-K directory clusters to scan (default 6)'),
    },
    handler: async (args) => {
      const { commits, hotspots } = args as { commits?: number; hotspots?: number };
      const argv: string[] = [];
      if (commits !== undefined) argv.push('--commits', String(commits));
      if (hotspots !== undefined) argv.push('--hotspots', String(hotspots));
      const runId = dispatchFleetRun({ ...deps, spawn }, {
        tool: 'dag_deepen',
        script: 'scripts/dag-deepen.ts',
        argv,
        reportPath: reportPathFor('deepen'),
        goal: `deepen commits=${commits ?? 200} hotspots=${hotspots ?? 6}`,
      });
      return { content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }] };
    },
  };
}

function makeDagDebug(deps: FleetToolDeps, spawn: SpawnFn): OmdMcpTool {
  return {
    name: 'dag_debug',
    description: 'Parallel multi-hypothesis root-cause debug async. failure=symptom, repro optional. No root cause→no fix. Returns runId.',
    inputSchema: {
      failure: z.string().min(1).describe('Failure symptom / stack trace / "worked yesterday" description'),
      repro: z.string().optional().describe('Reproduction shell command (expected to go red)'),
      oracleCmd: z.string().optional().describe('Red→green re-verify command (recorded; gated fix mode is future)'),
      rounds: z.number().int().min(1).optional().describe('Max hypothesis rounds before escalating (default 3)'),
      hypotheses: z.number().int().min(1).optional().describe('Max concurrent hypotheses per round (default 5)'),
    },
    handler: async (args) => {
      const { failure, repro, oracleCmd, rounds, hypotheses } = args as {
        failure: string; repro?: string; oracleCmd?: string; rounds?: number; hypotheses?: number;
      };
      // failure 是位置参数 → 防 `--` 前缀被脚本解析成 flag。
      if (safeValue(failure) === null) {
        return { content: [{ type: 'text' as const, text: 'dag_debug: failure must not start with "--"' }], isError: true };
      }
      const argv: string[] = [failure];
      if (!pushFlag(argv, 'repro', repro) || !pushFlag(argv, 'oracle-cmd', oracleCmd)) {
        return { content: [{ type: 'text' as const, text: 'dag_debug: repro/oracleCmd must not start with "--"' }], isError: true };
      }
      if (rounds !== undefined) argv.push('--rounds', String(rounds));
      if (hypotheses !== undefined) argv.push('--hypotheses', String(hypotheses));
      const runId = dispatchFleetRun({ ...deps, spawn }, {
        tool: 'dag_debug',
        script: 'scripts/dag-debug.ts',
        argv,
        reportPath: reportPathFor('debug'),
        goal: `debug: ${failure.slice(0, 80)}`,
      });
      return { content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }] };
    },
  };
}
