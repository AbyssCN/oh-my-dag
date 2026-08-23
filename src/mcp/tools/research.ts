/**
 * src/mcp/tools/research —— dag_research 异步工具 (D-8 宽出)。
 *
 * S2 进程化 (SDD 2026-08-10 §2) 后是**两段式**:
 *   - 母进程 (server) handler: 校验 → spawn detached 子进程 (scripts/dag-exec.ts) → 立即返回 runId。
 *     不再等 researchFanout —— 客户端拿 runId 轮询 dag_status, 报告写入磁盘后 dag_result 取 reportPath
 *     (此前"长跑 1800s 被客户端判死"的洞随等待一起消失)。
 *   - 子进程 (dag-exec, env OMD_DAG_EXEC_CHILD=1): executeDagResearchInProc —— 登记 run (属主=子进程)
 *     → researchFanout (runId 透传, 报告文件名与 registry runId 同源) → succeed/fail 写穿 runs.db。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withHeartbeat } from '../progress';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { OmdMcpTool } from '../server.js';
import type { RunRegistry } from '../run-registry.js';
import { OMD_DAG_EXEC_CHILD, defaultSpawnDagExec, type SpawnDagExecFn } from './dag-tools';

/** researchFanout 接缝 —— 具体实现在 orchestration 层注入。
 * `runId`: S2 起由调用方生成并透传, 报告文件名与 registry runId **同源** ——
 * 一 run 两个 id 正是本仓钉过的「两份必漂」形态 (报告头的 id 与 dag_status 的 id 对不上,
 * 读的人分不清谁是主)。executor research 节点不传 → 内部自造 (原语义不变)。 */
export interface ResearchFanout {
  (params: { question: string; council?: boolean; super?: boolean; k?: number; rounds?: number; runId?: string }): Promise<{
    runId: string;
    reportPath: string;
    summary: string;
  }>;
}

/** createDagResearchTool 的注入面 (S2: registry + spawn 接缝, 测试可注入替身)。 */
export interface DagResearchToolDeps {
  runRegistry: RunRegistry;
  spawnDagExec?: SpawnDagExecFn;
}

/**
 * 进程内执行体 (S2) —— 只在 dag-exec 子进程与测试里跑 (同 dag-tools 的 executeDagRunInProc)。
 *
 * 接手语义同 dag_run: 未知 runId → register+start (属主=本进程); failed/cancelled → 重开;
 * running/done → 拒绝 (母进程 spawn 前已查盘, 这里第二道闸)。
 *
 * dag_research **没有取消把手** (researchFanout 无 signal 口) —— dag_cancel 对它走 SIGTERM
 * 硬停: run 留 running 在盘上, 重启后 hydrate 按打断落 failed。协作式停不适用于研究。
 */
export async function executeDagResearchInProc(
  runId: string,
  args: { question: string; council?: boolean; super?: boolean; k?: number; rounds?: number },
  researchFanout: ResearchFanout,
  runRegistry: RunRegistry,
  extra: unknown,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const goal = args.question.slice(0, 200);
  const rec = runRegistry.getRecord(runId);
  if (rec && rec.status !== 'failed' && rec.status !== 'cancelled') {
    return { content: [{ type: 'text' as const, text: `resume 拒绝: run ${runId} 当前 ${rec.status} (仅 failed/cancelled/未知可续)` }], isError: true };
  }
  if (rec) runRegistry.reopenForResume(runId, { goal, meta: { tool: 'dag_research', resumed: true } });
  else {
    runRegistry.register(runId, { goal, meta: { tool: 'dag_research' } });
    runRegistry.start(runId);
  }
  try {
    const result = await withHeartbeat(extra as never, 'dag_research', () =>
      researchFanout({
        question: args.question,
        ...(args.council !== undefined ? { council: args.council } : {}),
        ...(args.super !== undefined ? { super: args.super } : {}),
        ...(args.k !== undefined ? { k: args.k } : {}),
        ...(args.rounds !== undefined ? { rounds: args.rounds } : {}),
        runId,
      }),
    );
    const payload = { runId, reportPath: result.reportPath, summary: result.summary };
    runRegistry.succeed(runId, payload);
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runRegistry.fail(runId, msg);
    return { content: [{ type: 'text' as const, text: msg }], isError: true };
  }
}

/** 构造 dag_research 工具定义, researchFanout 由调用方注入 (接缝)。 */
export function createDagResearchTool(researchFanout: ResearchFanout, deps: DagResearchToolDeps): OmdMcpTool {
  return {
    name: 'dag_research',
    description: 'Run async research fanout on question (S2: detached child process), store report to disk, return runId to poll.',
    inputSchema: {
      question: z.string().describe('Research question (required)'),
      council: z.boolean().optional().describe('Enable council deliberation'),
      super: z.boolean().optional().describe('Enable super-deep mode'),
      k: z.number().optional().describe('Top-k results to return'),
      rounds: z.number().int().min(1).max(4).optional().describe('Second-pass rounds cap (default 1; engine stops early when no new material)'),
    },
    handler: async (args, extra) => {
      const { question, council, super: superMode, k, rounds, resume } = args as {
        question?: string;
        council?: boolean;
        super?: boolean;
        k?: number;
        rounds?: number;
        /** (内部) dag-exec 子进程接手用: 以给定 runId 起跑。不进 schema —— 对 MCP 客户端不可见。 */
        resume?: string;
      };
      if (!question) {
        throw new McpError(ErrorCode.InvalidParams, 'dag_research: missing required param "question"');
      }
      const runId = resume ?? randomUUID();
      // 子进程自证 (同 dag_run): env 旗标 → 进程内执行体, 不再二次 spawn。
      if (process.env[OMD_DAG_EXEC_CHILD] === '1') {
        return executeDagResearchInProc(
          runId,
          { question, ...(council !== undefined ? { council } : {}), ...(superMode !== undefined ? { super: superMode } : {}), ...(k !== undefined ? { k } : {}), ...(rounds !== undefined ? { rounds } : {}) },
          researchFanout,
          deps.runRegistry,
          extra,
        );
      }
      // 母进程: spawn + 立即返回。**不登记 run** (同 dag_run —— 属主必须是子进程, pid 判活要认它)。
      const spawned = (deps.spawnDagExec ?? defaultSpawnDagExec)({
        tool: 'dag_research',
        runId,
        cwd: process.cwd(),
        args: { question, ...(council !== undefined ? { council } : {}), ...(superMode !== undefined ? { super: superMode } : {}), ...(k !== undefined ? { k } : {}), ...(rounds !== undefined ? { rounds } : {}) },
      });
      if (!spawned.ok) {
        return { content: [{ type: 'text' as const, text: `dag_research 起跑失败: ${spawned.error}` }], isError: true };
      }
      return {
        content: [{
          type: 'text' as const,
          text:
            `runId: ${runId}\nstatus: running\n` +
            `(子进程 pid ${spawned.pid ?? '?'}, 日志 ${spawned.logPath})\n` +
            '它不随本会话结束而死。研究完报告落盘 — 轮询 dag_status runId=... (刚起跑查无此 run, 等几秒), done 后 dag_result 取 reportPath。',
        }],
      };
    },
  };
}
