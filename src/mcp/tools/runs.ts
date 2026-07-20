/**
 * src/mcp/tools/runs — dag_runs 同步 MCP 工具。
 *
 * 内存 runRegistry.listRuns ∪ 磁盘 continuity 扫描 (<cwd>/.omd/continuity/<runId>/_dag.json)
 * 合并去重 (内存态优先): 磁盘独有 run 无活体状态 → status 'unknown(restart)'。
 * 缺文件/坏 JSON/缺字段静默跳; status 过滤仅适用内存态 (磁盘态不可知, 带过滤时排除)。
 * 输出按 createdAt 倒序 ≤20 条, goal 宽出截断。deps {runRegistry, cwd} 注入可测。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunRegistry, RunStatus } from '../run-registry.js';
import type { OmdMcpTool } from '../server.js';

/** 列上限 + goal 渲染截断宽。 */
const MAX_RUNS = 20;
const GOAL_WIDTH = 80;

/** Dependencies injected into the dag_runs handler. */
export interface RunsToolDeps {
  runRegistry: RunRegistry;
  /** 仓根 — continuity 目录 (<cwd>/.omd/continuity) 基准。 */
  cwd: string;
}

/** 合并后的一行视图。 */
interface RunRow {
  runId: string;
  status: RunStatus | 'unknown(restart)';
  goal: string;
  createdAt: string;
}

/** Build dag_runs tool definition. Handler is a pure sync fn closed over {runRegistry, cwd}. */
export function createRunsTools(deps: RunsToolDeps): OmdMcpTool[] {
  return [makeDagRuns(deps)];
}

function makeDagRuns({ runRegistry, cwd }: RunsToolDeps): OmdMcpTool {
  return {
    name: 'dag_runs',
    description: 'List DAG runs: memory registry + disk continuity checkpoints merged; disk-only runs marked unknown(restart).',
    inputSchema: {
      status: z.enum(['pending', 'running', 'done', 'failed']).optional()
        .describe('Filter by run status; excludes disk-only unknown(restart) runs'),
    },
    handler: ({ status }) => {
      const rows = new Map<string, RunRow>();
      for (const runId of runRegistry.listRuns(status as RunStatus | undefined)) {
        const rec = runRegistry.getRecord(runId);
        if (!rec) continue;
        rows.set(runId, { runId, status: rec.status, goal: rec.goal, createdAt: rec.createdAt });
      }
      // 磁盘态无活体 status — 仅无过滤时并入, 内存态优先 (已存在则跳)。
      if (!status) {
        for (const row of scanDiskRuns(cwd)) {
          if (!rows.has(row.runId)) rows.set(row.runId, row);
        }
      }
      const sorted = [...rows.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, MAX_RUNS);
      if (sorted.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No runs found.' }] };
      }
      const text = sorted
        .map((r) => `${r.runId}  ${r.status}  ${r.createdAt}  ${truncate(r.goal)}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  };
}

/** 磁盘扫描: continuity/<runId>/_dag.json → RunRow[]。目录不存在/坏 JSON/缺字段 → 静默跳。 */
function scanDiskRuns(cwd: string): RunRow[] {
  const base = join(cwd, '.omd', 'continuity');
  let dirs: string[];
  try {
    dirs = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const rows: RunRow[] = [];
  for (const dir of dirs) {
    try {
      const meta = JSON.parse(readFileSync(join(base, dir, '_dag.json'), 'utf-8')) as Record<string, unknown>;
      if (typeof meta.runId !== 'string' || typeof meta.goal !== 'string' || typeof meta.createdAt !== 'string') continue;
      rows.push({ runId: meta.runId, status: 'unknown(restart)', goal: meta.goal, createdAt: meta.createdAt });
    } catch {
      // 对齐 CheckpointManager.loadDagMetadata 的 null 语义 — 损坏条目不阻断列表。
    }
  }
  return rows;
}

/** goal 宽出截断 (GOAL_WIDTH, 末尾 …)。 */
function truncate(goal: string): string {
  return goal.length <= GOAL_WIDTH ? goal : `${goal.slice(0, GOAL_WIDTH - 1)}…`;
}
