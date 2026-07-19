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
import type { OmdMcpTool } from '../server.js';
import type { RunRegistry } from '../run-registry.js';
import type { ExecutorDagConfig, ExecutorDagResult } from '../../harness/executor-dag-types.js';
import type { ConductorPlan } from '../../harness/conductor-plan.js';
import { parsePlan } from '../../harness/conductor-plan.js';

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
  return {
    sessionId: result.sessionId,
    nodeCount: nodeIds.length,
    done,
    failed,
    artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
    verification: result.verification
      ? { pass: result.verification.pass, reason: result.verification.reason }
      : undefined,
  };
}

/**
 * Build 4 dag tools: dag_run, dag_run_plan, dag_status, dag_result.
 * Each handler is a pure fn closed over {engine, runRegistry, cwd, clock}.
 */
export function createDagTools(deps: DagToolDeps): OmdMcpTool[] {
  return [
    makeDagRun(deps),
    makeDagRunPlan(deps),
    makeDagStatus(deps),
    makeDagResult(deps),
  ];
}

// ---------------------------------------------------------------------------
// dag_run — task → conductor plan → fan-out → {runId, summary}.
// ---------------------------------------------------------------------------

function makeDagRun({ engine, runRegistry, defaultConfig }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_run',
    description: 'Execute a task via conductor DAG planning + leaf fan-out. Returns runId + summary.',
    inputSchema: {
      task: z.string().describe('Task description for the conductor to plan and execute'),
      conductorModel: z.string().optional().describe('Conductor model (provider:modelId)'),
      leafModel: z.string().optional().describe('Leaf model (provider:modelId)'),
    },
    handler: async (args) => {
      const { task, conductorModel, leafModel } = args as {
        task?: string;
        conductorModel?: string;
        leafModel?: string;
      };
      if (!task) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_run: missing required param "task"');
      }
      const runId = randomUUID();
      const goal = task.slice(0, 200);
      runRegistry.register(runId, { goal, meta: { tool: 'dag_run' } });
      runRegistry.start(runId);

      // Fire-and-forget: execute in background, update registry on completion.
      const config: ExecutorDagConfig = {
        ...defaultConfig,
        conductorModel: conductorModel ?? defaultConfig?.conductorModel ?? '',
        leafModel: leafModel ?? defaultConfig?.leafModel ?? '',
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
          runRegistry.succeed(runId, summarizeResult(result));
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          runRegistry.fail(runId, msg);
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

function makeDagRunPlan({ engine, runRegistry, defaultConfig }: DagToolDeps): OmdMcpTool {
  return {
    name: 'dag_run_plan',
    description: 'Execute a pre-built ConductorPlan JSON (skips conductor). Returns runId + summary.',
    inputSchema: {
      plan: z.string().describe('ConductorPlan JSON string (validated by parsePlan)'),
      task: z.string().optional().describe('Task description (for escalation re-planning seed)'),
      leafModel: z.string().optional().describe('Leaf model (provider:modelId)'),
    },
    handler: async (args) => {
      const { plan: planJson, task, leafModel } = args as {
        plan?: string;
        task?: string;
        leafModel?: string;
      };
      if (!planJson) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_run_plan: missing required param "plan"');
      }

      // Validate plan via parsePlan (rejects invalid ConductorPlan).
      const parsed = parsePlan(planJson);
      if (!parsed.ok) {
        throw new McpError(ErrorCode.InvalidParams, `dag_run_plan: invalid plan — ${parsed.error}`);
      }

      const runId = randomUUID();
      const goal = task?.slice(0, 200) ?? parsed.plan.name ?? 'prebuilt plan';
      runRegistry.register(runId, { goal, meta: { tool: 'dag_run_plan' } });
      runRegistry.start(runId);

      const config: ExecutorDagConfig = {
        ...defaultConfig,
        leafModel: leafModel ?? defaultConfig?.leafModel ?? '',
      } as ExecutorDagConfig;

      if (!config.leafModel) {
        runRegistry.fail(runId, 'dag_run_plan: leafModel required (param or defaultConfig)');
        return {
          content: [{ type: 'text' as const, text: `runId: ${runId}\nerror: leafModel required` }],
          isError: true,
        };
      }

      engine
        .runExecutorDagWithPlan(parsed.plan, config)
        .then((result) => {
          runRegistry.succeed(runId, summarizeResult(result));
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          runRegistry.fail(runId, msg);
        });

      return {
        content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }],
      };
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
      const summary = runRegistry.getSummary(runId);
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
