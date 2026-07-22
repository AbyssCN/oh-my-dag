/**
 * src/mcp/tools/fleet —— dag_review / dag_slim / dag_deepen / dag_debug 异步 MCP 工具 + dream_consolidate 同步工具。
 *
 * 受监督子进程包装本仓 scripts/dag-{review,slim,deepen}.ts: Bun.spawn(['bun','run',<script>,...flags])
 * 数组参数非 shell 字符串 (无注入面), flag 白名单构造 + 值拒 `--` 前缀 (防 flag 走私), cwd 注入。
 * 三段式 registry (同 dag_run 范式): register → start → fire-and-forget 子进程 →
 *   exit 0  → succeed({summary, reportPath})   (summary = stdout brief 尾段)
 *   exit ≠0 → fail(stderr 尾 400 字)
 * --out 由本模块定 (/tmp/omd-fleet-<tool>-<runId>.md) — 报告路径确定可知, 不靠解析脚本 stdout。
 * dream_consolidate 不注册不进 registry: 同步 await pump(), 直回 PumpResult 统计。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunRegistry } from '../run-registry.js';
import type { OmdMcpTool } from '../server.js';
import type { DreamPump } from '../../harness/learning/types.js';

// ---------------------------------------------------------------------------
// deps + spawn 接缝
// ---------------------------------------------------------------------------

/** 子进程结果 (exit code + 已收集的 stdout/stderr 全文)。 */
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** spawn 接缝 —— 测试注入 fake; 生产默认 Bun.spawn (下方 defaultSpawn)。 */
export interface SpawnFn {
  (cmd: string[], opts: { cwd: string }): Promise<SpawnResult>;
}

/** Dependencies injected into fleet tool handlers. */
export interface FleetToolDeps {
  runRegistry: RunRegistry;
  /** 仓根 — 子进程 cwd + 脚本相对路径基准。 */
  cwd: string;
  /** 覆盖 spawn (测试)。默认 Bun.spawn(['bun','run',...])。 */
  spawn?: SpawnFn;
  /** dream pump (dream_consolidate)。省略 → 该工具回 isError 不炸。 */
  dream?: DreamPump;
}

/** 生产 spawn: 数组参数 + cwd 注入 + stdout/stderr 管道收集。 */
const defaultSpawn: SpawnFn = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
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
}

/** 三段式派发: register → start → 后台 spawn → succeed/fail。同步回 runId。 */
function dispatchFleetRun({ runRegistry, cwd, spawn }: Required<Pick<FleetToolDeps, 'runRegistry' | 'cwd'>> & { spawn: SpawnFn }, opts: FleetRunOpts): string {
  const runId = randomUUID();
  runRegistry.register(runId, { goal: opts.goal, meta: { tool: opts.tool } });
  runRegistry.start(runId);

  spawn(['bun', 'run', opts.script, ...opts.argv, '--out', opts.reportPath], { cwd })
    .then(({ exitCode, stdout, stderr }) => {
      if (exitCode === 0) {
        runRegistry.succeed(runId, { summary: summarizeStdout(stdout), reportPath: opts.reportPath });
      } else {
        runRegistry.fail(runId, `exit ${exitCode}: ${stderrTail(stderr)}`);
      }
    })
    .catch((err) => {
      runRegistry.fail(runId, err instanceof Error ? err.message : String(err));
    });

  return runId;
}

/** 报告落盘路径 (本模块定 → 确定可知)。 */
function reportPathFor(tool: string): string {
  return `/tmp/omd-fleet-${tool}-${randomUUID()}.md`;
}

// ---------------------------------------------------------------------------
// 工具面
// ---------------------------------------------------------------------------

/** Build 5 fleet tools: dag_review, dag_slim, dag_deepen, dag_debug, dream_consolidate. */
export function createFleetTools(deps: FleetToolDeps): OmdMcpTool[] {
  const spawn = deps.spawn ?? defaultSpawn;
  return [
    makeDagReview(deps, spawn),
    makeDagSlim(deps, spawn),
    makeDagDeepen(deps, spawn),
    makeDagDebug(deps, spawn),
    makeDreamConsolidate(deps),
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

function makeDreamConsolidate({ dream }: FleetToolDeps): OmdMcpTool {
  return {
    name: 'dream_consolidate',
    description: 'Run one dream consolidation pump round synchronously; returns events/facts stats. Unwired → error.',
    inputSchema: {},
    handler: async () => {
      if (!dream) {
        return { content: [{ type: 'text' as const, text: 'dream_consolidate: dream pump not wired' }], isError: true };
      }
      const result = await dream.pump();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  };
}
