/**
 * src/mcp/tools/dag-tools — dag_run / dag_run_plan / dag_status / dag_result MCP tools (D-8 宽出).
 *
 * Pure-fn factory: createDagTools({engine, runRegistry, cwd, clock}) → OmdMcpTool[].
 * Handlers inject engine seam (runExecutorDag / runExecutorDagWithPlan) + RunRegistry.
 * runExecutorDag is fire-and-forget: register → start → execute → succeed/fail (in background).
 * dag_status / dag_result query RunRegistry; unknown runId → isError (never crash).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { NodeDetail, RunRegistry } from '../run-registry.js';
import type { OmdMcpTool } from '../server.js';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../harness/executor-dag-types.js';
import type { CheckpointManager } from '../../harness/continuity/checkpoint-manager.js';
import type { ConductorPlan } from '../../harness/conductor-plan.js';
import { parsePlan } from '../../harness/conductor-plan.js';
import { topoLevels } from '../../harness/executor-dag.js';
import { renderProgressAscii } from './dag-ascii.js';
import type { HudMirror } from '../../hud/mirror.js';
import type { PlanLedger } from '../../harness/plan-ledger.js';
import { computeCost } from '../../model/cost-ledger.js';

// renderProgressAscii 已抽到 ./dag-ascii (纯函数, statusline 复用); 此处保留 re-export 兼容既有 importer。
export { renderProgressAscii };

/**
 * 派发简报 (D-8 宽出): 图结构 + 模型坐标一屏可读 — 客户端派发瞬间就知道开了多少节点/
 * 几层/什么模型, 不必等 dag_status。levels 经 topoLevels (环图不该出现 — parsePlan 不查环,
 * 防御性兜底)。
 */
export function dispatchBriefing(plan: ConductorPlan, config: ExecutorDagConfig): string {
  const entries = Object.entries(plan.nodes);
  const byKind: Record<string, number> = {};
  for (const [, n] of entries) {
    const kind = n.executor ?? 'leaf';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  let levelsLine: string;
  let workersLine = '';
  let topo: string[][] | undefined;
  try {
    topo = topoLevels(plan);
    const widest = Math.max(...topo.map((l) => l.length));
    levelsLine = `levels: ${topo.length} (widest ${widest})`;
    const cap = config.maxFanout && config.maxFanout > 0 ? config.maxFanout : undefined;
    workersLine = `workers: up to ${cap ? Math.min(widest, cap) : widest}${cap ? ` (cap ${cap})` : ' (cap ∞)'}`;
  } catch {
    levelsLine = 'levels: ? (graph not topo-sortable)';
  }
  const kinds = Object.entries(byKind)
    .map(([k, c]) => `${k}:${c}`)
    .join(' ');
  const models = [
    config.conductorModel ? `conductor=${config.conductorModel}` : '',
    `leaf=${config.leafModel}`,
    config.agentLeafModel ? `agent=${config.agentLeafModel}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const summary = [`nodes: ${entries.length} (${kinds})`, levelsLine, workersLine, `models: ${models}`].filter(Boolean).join('\n');
  // ASCII 层级图: dispatch 瞬间全部 pending
  const progress = { planned: entries.map(([id, n]) => ({ id, kind: n.executor ?? 'leaf' })), started: [], settled: [] };
  const ascii = renderProgressAscii(topo, progress);
  return `${summary}\n${ascii}`;
}

/** Engine seam — callers inject real implementations, tests inject fakes. */
export interface DagEngine {
  runExecutorDag(task: string, config: ExecutorDagConfig): Promise<ExecutorDagResult>;
  runExecutorDagWithPlan(plan: ConductorPlan, config: ExecutorDagConfig): Promise<ExecutorDagResult>;
}

/** Dependencies injected into dag tool handlers. */
export interface DagToolDeps {
  engine: DagEngine;
  runRegistry: RunRegistry;
  cwd: string;
  /** Clock seam — injectable for deterministic tests. Default: () => new Date().toISOString(). */
  clock?: () => string;
  /** Default ExecutorDagConfig base (leafModel, conductorModel, etc.) — spread with per-call overrides. */
  defaultConfig?: Partial<ExecutorDagConfig>;
  /**
   * W2 continuity (D-3 断点续跑): 给则每个 run 落节点 checkpoint (.omd/continuity/<runId>/),
   * dag_run_plan 的 resume 参数命中已绿节点即跳过 (429 打断后不再整图重跑)。省略 = 不落不续。
   */
  continuity?: { manager: CheckpointManager; repoRoot: string };
  /**
   * omd-hud 活体镜像 (给则每个 onNodeEvent + 完成态把 DAG 进度原子写 .omd/hud/dag.json,
   * statusline 数据源)。fail-open 不影响执行; 省略 = 不写 (HUD 空闲)。
   */
  hudMirror?: HudMirror;
  /**
   * plan-memory Phase A 账本 (给则每个完成 run 记一笔: family 聚类 + 版本去重 + 战绩)。
   * 纯记账零行为改变; record 自身 fail-open。省略 = 不记。
   */
  ledger?: PlanLedger;
}

/**
 * plan-memory 记账 (dag_run/dag_run_plan 完成钩子共用)。
 * ok = verifier pass ∨ (无 verifier ∧ 全叶 done) — A3 修复: MCP 路径无 verifier, "pass 才记"=账本永空。
 * cost = Σ leaf computeCost + conductor (fail-open: unpriced 计 0)。
 */
function recordPlanRun(
  ledger: PlanLedger,
  taskText: string,
  result: ExecutorDagResult,
  conductorModel: string | undefined,
): void {
  const leaves = Object.values(result.results);
  const allDone = leaves.length > 0 && leaves.every((l) => l.status === 'done');
  const ok = result.verification ? result.verification.pass : allDone;
  let costUsd = 0;
  for (const leaf of leaves) {
    if (leaf.model && leaf.usage) costUsd += computeCost(leaf.usage, leaf.model).costUsd;
  }
  if (conductorModel) costUsd += computeCost(result.usage.conductor, conductorModel).costUsd;
  ledger.record({
    taskText,
    plan: {
      name: result.plan.name,
      ...(result.plan.description ? { description: result.plan.description } : {}),
      nodes: result.plan.nodes as unknown as Record<string, unknown>,
    },
    ok,
    verified: !!result.verification,
    costUsd,
  });
}

/** Map ExecutorDagResult.results → per-node NodeDetail {status, output} for registry storage. */
function extractNodeDetails(result: ExecutorDagResult): Record<string, NodeDetail> {
  const details: Record<string, NodeDetail> = {};
  for (const [id, leaf] of Object.entries(result.results)) {
    details[id] = { status: leaf.status, output: leaf.output };
  }
  return details;
}

/** Summarize a completed ExecutorDagResult for D-8 wide output (no full dump). */
function summarizeResult(result: ExecutorDagResult): Record<string, unknown> {
  const nodeIds = Object.keys(result.results);
  const done = nodeIds.filter((id) => result.results[id]!.status === 'done').length;
  const failed = nodeIds.filter((id) => result.results[id]!.status === 'failed').length;
  const artifactPaths: string[] = [];
  for (const leaf of Object.values(result.results)) {
    if (leaf.filesTouched) artifactPaths.push(...leaf.filesTouched);
  }
  // Sink outputs: leaf id absent from every other leaf's deps → terminal node.
  // Per-node cap 2000 chars; total cap 8000 chars — drop trailing whole nodes, flag _truncated.
  const dependedOn = new Set<string>();
  for (const leaf of Object.values(result.results)) {
    for (const dep of leaf.deps) dependedOn.add(dep);
  }
  const outputs: Record<string, string | boolean> = {};
  let outputsChars = 0;
  let truncated = false;
  for (const id of nodeIds) {
    if (dependedOn.has(id)) continue;
    const text = result.results[id]!.output;
    if (!text) continue;
    const clipped = text.slice(0, 2000);
    if (outputsChars + clipped.length > 8000) {
      truncated = true;
      break;
    }
    outputs[id] = clipped;
    outputsChars += clipped.length;
  }
  if (truncated) outputs['_truncated'] = true;
  return {
    sessionId: result.sessionId,
    nodeCount: nodeIds.length,
    done,
    failed,
    artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
    verification: result.verification
      ? { pass: result.verification.pass, reason: result.verification.reason }
      : undefined,
    // 用量可见性 (TUI /cost parity): 调用方能看到本 run 烧了多少 token/命中多少 cache。
    usage: {
      conductor: result.usage.conductor,
      leavesIn: result.usage.leavesIn,
      leavesOut: result.usage.leavesOut,
      leavesCacheHit: result.usage.leavesCacheHit,
      ...(result.usage.verifier ? { verifier: result.usage.verifier } : {}),
    },
    outputs: Object.keys(outputs).length > 0 ? outputs : undefined,
  };
}

/**
 * Build 5 dag tools: dag_run, dag_run_plan, dag_status, dag_result, dag_node_output.
 * Each handler is a pure fn closed over {engine, runRegistry, cwd, clock}.
 */
/**
 * Shared plan-launch: register/reopen the run, wire live progress + continuity, fire the engine
 * (fire-and-forget), return the running-status tool result. Reused by dag_run_plan and dag_resume.
 */
function launchPlanRun(
  parsedPlan: ConductorPlan,
  opts: { resume?: string; leafModel?: string; maxFanout?: number; task?: string; toolName: string },
  deps: DagToolDeps,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const { engine, runRegistry, defaultConfig, continuity, hudMirror, ledger } = deps;
  const { resume, leafModel, maxFanout, task, toolName } = opts;
  const runId = resume ?? randomUUID();
  const goal = task?.slice(0, 200) ?? parsedPlan.name ?? 'prebuilt plan';
  if (resume) {
    // resume 语义: failed run 重开 / server 重启后未知 runId 重登记; 在飞或已 done 的拒绝。
    const rec = runRegistry.getRecord(resume);
    if (rec && rec.status !== 'failed') {
      return { content: [{ type: 'text', text: `resume 拒绝: run ${resume} 当前 ${rec.status} (仅 failed/未知可续)` }], isError: true };
    }
    runRegistry.reopenForResume(runId, { goal, meta: { tool: toolName, resumed: true } });
  } else {
    runRegistry.register(runId, { goal, meta: { tool: toolName } });
    runRegistry.start(runId);
  }
  let hudLevels: string[][] | undefined;
  try {
    hudLevels = topoLevels(parsedPlan);
  } catch {
    hudLevels = undefined;
  }
  const config: ExecutorDagConfig = {
    ...defaultConfig,
    leafModel: leafModel ?? defaultConfig?.leafModel ?? '',
    onNodeEvent: (e) => {
      runRegistry.applyNodeEvent(runId, e);
      hudMirror?.write(runId, runRegistry.getRecord(runId), hudLevels);
    },
    ...(maxFanout ? { maxFanout } : {}),
    ...(continuity
      ? { continuity: { manager: continuity.manager, runId, resume: !!resume, repoRoot: continuity.repoRoot } }
      : {}),
  } as ExecutorDagConfig;
  if (!config.leafModel) {
    runRegistry.fail(runId, `${toolName}: leafModel required (param or defaultConfig)`);
    return { content: [{ type: 'text', text: `runId: ${runId}\nerror: leafModel required` }], isError: true };
  }
  engine
    .runExecutorDagWithPlan(parsedPlan, config)
    .then((result) => {
      runRegistry.setNodeDetails(runId, extractNodeDetails(result));
      runRegistry.succeed(runId, summarizeResult(result));
      hudMirror?.write(runId, runRegistry.getRecord(runId), hudLevels);
      if (ledger && task) recordPlanRun(ledger, task, result, config.conductorModel);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      runRegistry.fail(runId, msg);
      hudMirror?.write(runId, runRegistry.getRecord(runId), hudLevels);
    });
  return {
    content: [{ type: 'text', text: `runId: ${runId}\nstatus: running\n--- dispatch ---\n${dispatchBriefing(parsedPlan, config)}` }],
  };
}

/**
 * dag_resume — one-step resume: reload a run's plan from its on-disk checkpoint (`_dag.json`) and
 * re-run, skipping still-green nodes. Closes the manual "read _dag.json → dag_run_plan resume" loop.
 */
function makeDagResume(deps: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_resume',
    description: 'Resume a failed/interrupted run by runId — reload its plan from checkpoint, re-run skipping green nodes.',
    inputSchema: {
      runId: z.string().describe('runId of a failed/interrupted run (see dag_runs)'),
      leafModel: z.string().optional().describe('Leaf model override (provider:modelId)'),
      maxFanout: z.number().int().positive().optional().describe('Concurrency cap for node fan-out'),
    },
    handler: async (args) => {
      const { runId, leafModel, maxFanout } = args as { runId?: string; leafModel?: string; maxFanout?: number };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_resume: missing required param "runId"');
      }
      if (!deps.continuity) {
        return { content: [{ type: 'text' as const, text: 'dag_resume: continuity not configured — no checkpoints to resume from' }], isError: true };
      }
      const meta = deps.continuity.manager.loadDagMetadata(runId);
      if (!meta) {
        return { content: [{ type: 'text' as const, text: `dag_resume: no checkpoint for run ${runId} (see dag_runs)` }], isError: true };
      }
      if (!meta.plan) {
        return { content: [{ type: 'text' as const, text: `dag_resume: run ${runId} stored only a skeleton (pre-plan-memory) — can't auto-replay; re-supply the plan via dag_run_plan resume=${runId}` }], isError: true };
      }
      const parsed = parsePlan(JSON.stringify(meta.plan));
      if (!parsed.ok) {
        return { content: [{ type: 'text' as const, text: `dag_resume: stored plan for ${runId} is invalid — ${parsed.error}` }], isError: true };
      }
      return launchPlanRun(parsed.plan, { resume: runId, leafModel, maxFanout, task: meta.goal, toolName: 'dag_resume' }, deps);
    },
  };
}

export function createDagTools(deps: DagToolDeps): OmdMcpTool[] {
  return [
    makeDagRun(deps),
    makeDagRunPlan(deps),
    makeDagResume(deps),
    makeDagStatus(deps),
    makeDagResult(deps),
    makeDagNodeOutput(deps),
  ];
}

// ---------------------------------------------------------------------------
// dag_run — task → conductor plan → fan-out → {runId, summary}.
// ---------------------------------------------------------------------------

function makeDagRun({ engine, runRegistry, defaultConfig, continuity, hudMirror, ledger }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_run',
    description: 'Execute a task via conductor DAG planning + leaf fan-out. resume=<runId> skips checkpointed nodes.',
    inputSchema: {
      task: z.string().describe('Task description for the conductor to plan and execute'),
      conductorModel: z.string().optional().describe('Conductor model (provider:modelId)'),
      leafModel: z.string().optional().describe('Leaf model (provider:modelId)'),
      resume: z.string().optional().describe('Prior runId to resume — done nodes with valid checkpoints are skipped'),
      maxFanout: z.number().int().positive().optional().describe('Concurrency cap for node fan-out (default: provider pool)'),
    },
    handler: async (args) => {
      const { task, conductorModel, leafModel, resume, maxFanout } = args as {
        task?: string;
        conductorModel?: string;
        leafModel?: string;
        resume?: string;
        maxFanout?: number;
      };
      if (!task) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_run: missing required param "task"');
      }
      const runId = resume ?? randomUUID();
      const goal = task.slice(0, 200);
      if (resume) {
        // resume 语义: failed run 重开 / server 重启后未知 runId 重登记; 在飞或已 done 的拒绝。
        const rec = runRegistry.getRecord(resume);
        if (rec && rec.status !== 'failed') {
          return {
            content: [{ type: 'text' as const, text: `resume 拒绝: run ${resume} 当前 ${rec.status} (仅 failed/未知可续)` }],
            isError: true,
          };
        }
        runRegistry.reopenForResume(runId, { goal, meta: { tool: 'dag_run', resumed: true } });
      } else {
        runRegistry.register(runId, { goal, meta: { tool: 'dag_run' } });
        runRegistry.start(runId);
      }

      // Fire-and-forget: execute in background, update registry on completion.
      const config: ExecutorDagConfig = {
        ...defaultConfig,
        conductorModel: conductorModel ?? defaultConfig?.conductorModel ?? '',
        leafModel: leafModel ?? defaultConfig?.leafModel ?? '',
        // 活体进度: conductor 出图后引擎发 planned → start/settle 流进 registry (dag_status 实时) +
        // hudMirror 原子写 .omd/hud/dag.json (omd-hud statusline 数据源; conductor 路径无 topo → levels=null 平铺)。
        onNodeEvent: (e) => {
          runRegistry.applyNodeEvent(runId, e);
          hudMirror?.write(runId, runRegistry.getRecord(runId));
        },
        // 并发手闸: 参数 > defaultConfig (装配层 provider 池) > 引擎全宽。
        ...(maxFanout ? { maxFanout } : {}),
        // D-3 断点续跑: checkpoint 恒落盘; resume 时命中已绿节点跳过 (429 打断不再整图重跑)。
        ...(continuity
          ? { continuity: { manager: continuity.manager, runId, resume: !!resume, repoRoot: continuity.repoRoot } }
          : {}),
      } as ExecutorDagConfig;

      // Validate required config fields (engine will throw if missing, but we catch early).
      if (!config.conductorModel) {
        runRegistry.fail(runId, 'dag_run: conductorModel required (param or defaultConfig)');
        return {
          content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: conductorModel required` }],
          isError: true,
        };
      }
      if (!config.leafModel) {
        runRegistry.fail(runId, 'dag_run: leafModel required (param or defaultConfig)');
        return {
          content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: leafModel required` }],
          isError: true,
        };
      }

      // Async execution — don't await (fire-and-forget). Registry tracks status.
      engine
        .runExecutorDag(task, config)
        .then((result) => {
          runRegistry.setNodeDetails(runId, extractNodeDetails(result));
          runRegistry.succeed(runId, summarizeResult(result));
          hudMirror?.write(runId, runRegistry.getRecord(runId)); // 终态 done → statusline grace 后收起
          // plan-memory Phase A: 记一笔 (family 聚类 + 版本 + 战绩)。record 自身 fail-open。
          if (ledger) recordPlanRun(ledger, task, result, config.conductorModel);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          runRegistry.fail(runId, msg);
          hudMirror?.write(runId, runRegistry.getRecord(runId)); // 终态 failed
        });

      return {
        content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// dag_run_plan — pre-built plan JSON → execute (skip conductor) → {runId, summary}.
// ---------------------------------------------------------------------------

function makeDagRunPlan(deps: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_run_plan',
    description: 'Execute a pre-built ConductorPlan JSON (skips conductor). resume=<runId> skips checkpointed nodes.',
    inputSchema: {
      plan: z.string().describe('ConductorPlan JSON string (validated by parsePlan)'),
      task: z.string().optional().describe('Task description (for escalation re-planning seed)'),
      leafModel: z.string().optional().describe('Leaf model (provider:modelId)'),
      resume: z.string().optional().describe('Prior runId to resume — done nodes with valid checkpoints are skipped'),
      maxFanout: z.number().int().positive().optional().describe('Concurrency cap for node fan-out (default: provider pool)'),
    },
    handler: async (args) => {
      const { plan: planJson, task, leafModel, resume, maxFanout } = args as {
        plan?: string;
        task?: string;
        leafModel?: string;
        resume?: string;
        maxFanout?: number;
      };
      if (!planJson) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_run_plan: missing required param "plan"');
      }

      // Validate plan via parsePlan (rejects invalid ConductorPlan).
      const parsed = parsePlan(planJson);
      if (!parsed.ok) {
        throw new McpError(ErrorCode.InvalidParams, `dag_run_plan: invalid plan — ${parsed.error}`);
      }

      return launchPlanRun(parsed.plan, { resume, leafModel, maxFanout, task, toolName: 'dag_run_plan' }, deps);
    },
  };
}

// ---------------------------------------------------------------------------
// dag_status — runId → status summary (unknown → isError).
// ---------------------------------------------------------------------------

function makeDagStatus({ runRegistry }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_status',
    description: 'Get status of a DAG run by runId. Unknown runId → error.',
    inputSchema: {
      runId: z.string().describe('Run ID returned by dag_run or dag_run_plan'),
    },
    handler: async (args) => {
      const { runId } = args as { runId?: string };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_status: missing required param "runId"');
      }
      const rec = runRegistry.getRecord(runId);
      if (!rec) {
        return { content: [{ type: 'text' as const, text: `unknown run ${runId}` }], isError: true };
      }
      const summary = runRegistry.getSummary(runId);
      // running 态追加 ASCII 层级图 (进度实时渲染)
      if (rec.status === 'running' && rec.progress) {
        const p = rec.progress;
        const ascii = renderProgressAscii(undefined, p);
        summary.content[0] = { type: 'text' as const, text: `${summary.content[0]!.text}\n${ascii}` };
      }
      return { content: summary.content, isError: summary.isError };
    },
  };
}

// ---------------------------------------------------------------------------
// dag_result — runId → full result summary (only if done; unknown/pending/running/failed → error).
// ---------------------------------------------------------------------------

function makeDagResult({ runRegistry }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_result',
    description: 'Get full result of a completed DAG run. Non-done status → error.',
    inputSchema: {
      runId: z.string().describe('Run ID returned by dag_run or dag_run_plan'),
    },
    handler: async (args) => {
      const { runId } = args as { runId?: string };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_result: missing required param "runId"');
      }
      const rec = runRegistry.getRecord(runId);
      if (!rec) {
        return { content: [{ type: 'text' as const, text: `unknown run ${runId}` }], isError: true };
      }
      if (rec.status !== 'done') {
        return {
          content: [{ type: 'text' as const, text: `run ${runId} is ${rec.status}, not done — result unavailable` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(rec.result, null, 2) }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// dag_node_output — runId+nodeId → full node output, paged 4000 chars per call.
// ---------------------------------------------------------------------------

/** Page size (chars) for dag_node_output slices. */
const NODE_OUTPUT_PAGE_SIZE = 4000;

function makeDagNodeOutput({ runRegistry }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_node_output',
    description:
      "Get one node's full output from a DAG run, paged in 4000-char chunks via offset. Unknown run/node → error.",
    inputSchema: {
      runId: z.string().describe('Run ID returned by dag_run or dag_run_plan'),
      nodeId: z.string().describe('Node (leaf) ID within the run'),
      offset: z.number().int().min(0).optional().describe('Char offset to start from (default 0); use nextOffset to continue'),
    },
    handler: async (args) => {
      const { runId, nodeId, offset } = args as { runId?: string; nodeId?: string; offset?: number };
      if (!runId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_node_output: missing required param "runId"');
      }
      if (!nodeId) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_node_output: missing required param "nodeId"');
      }
      if (!runRegistry.getRecord(runId)) {
        return { content: [{ type: 'text' as const, text: `unknown run ${runId}` }], isError: true };
      }
      const detail = runRegistry.getNodeDetail(runId, nodeId);
      if (!detail) {
        return {
          content: [{ type: 'text' as const, text: `unknown node ${nodeId} in run ${runId}` }],
          isError: true,
        };
      }
      const start = Math.max(0, offset ?? 0);
      const end = Math.min(start + NODE_OUTPUT_PAGE_SIZE, detail.output.length);
      const page = detail.output.slice(start, end);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              text: page,
              status: detail.status,
              totalChars: detail.output.length,
              nextOffset: end < detail.output.length ? end : null,
            }),
          },
        ],
      };
    },
  };
}
