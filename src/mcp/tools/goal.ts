/**
 * src/mcp/tools/goal —— `dag_goal` 异步工具 (自主 goal 引擎 P1 / INV-GOAL-1)。
 *
 * 一个大 goal 进来 → research → spec → execute → verify → 1 轮修复, 阶段间零人工介入,
 * 返回 runId (三段式同 dag_run: runId → dag_status 轮询 → dag_result 取产物, D-3)。
 *
 * 纯处理器 + 注入 {runGoal, runRegistry, cwd, buildConfig} —— 与 dag-tools 同一注入范式,
 * 测试传 fake 即可端到端跑。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OmdMcpTool } from '../server';
import type { RunGoalResult, GoalTier } from '../../harness/goal/run-goal';
import type { ExecutorDagConfig } from '../../harness/executor-dag-types';
import type { RunRegistry } from '../run-registry';

export interface GoalToolDeps {
  /** 自主环实现 (默认注入真 runGoal)。 */
  runGoal: (
    goal: string,
    config: { cwd: string; dag: ExecutorDagConfig; maxRounds?: number; researchRounds?: number; tier?: GoalTier },
  ) => Promise<RunGoalResult>;
  runRegistry: RunRegistry;
  cwd: string;
  /**
   * engine config 基座 —— **thunk, 每次调用重解** (INV-MODEL-3 无 boot 冻结: 长驻 server 里
   * 装配期算死的座位会让 omd_set_role 改完不生效)。
   */
  buildConfig: () => Partial<ExecutorDagConfig>;
}

/** 阶段结论压成宽出摘要 (D-8: 客户端上下文只拿结论, 全文自己 Read spec/report)。 */
export function summarizeGoal(r: RunGoalResult): string {
  const lines = [
    `goal: ${r.goal}`,
    `tier: ${r.tier} · ${r.converged ? '收敛' : '未收敛'} · ${r.rounds} 轮`,
    ...r.stages.map((s) => `  [${s.status}] ${s.stage} — ${s.summary}`),
  ];
  if (r.specPath) lines.push(`spec: ${r.specPath}`);
  if (r.sources.length) lines.push(`来源 (${r.sources.length}): ${r.sources.slice(0, 5).join(', ')}`);
  if (r.reusedNodes.length) lines.push(`修复轮复用: ${r.reusedNodes.length} 节点`);
  return lines.join('\n');
}

export function createGoalTool(deps: GoalToolDeps): OmdMcpTool {
  return {
    name: 'dag_goal',
    description: 'Autonomous goal: research → spec → execute → verify → 1 repair round. Returns runId.',
    inputSchema: {
      goal: z.string().describe('The goal to pursue autonomously (required)'),
      tier: z.enum(['simple', 'complex']).optional().describe('Force routing; omit = auto-classify'),
      maxRounds: z.number().int().min(1).max(5).optional().describe('Execute-phase round cap (default 2 = 1 repair)'),
      researchRounds: z.number().int().min(1).max(4).optional().describe('Research inner-loop cap (default 1)'),
    },
    handler: async (args) => {
      const { goal, tier, maxRounds, researchRounds } = args as {
        goal?: string;
        tier?: GoalTier;
        maxRounds?: number;
        researchRounds?: number;
      };
      if (!goal?.trim()) {
        return { content: [{ type: 'text' as const, text: 'dag_goal: goal 必填' }], isError: true };
      }
      let dag: Partial<ExecutorDagConfig>;
      try {
        dag = deps.buildConfig();
      } catch (e) {
        // 起跑自检 / 座位未配 (INV-MODEL-5): 响亮但不崩 server。
        return { content: [{ type: 'text' as const, text: `dag_goal 拒绝: ${(e as Error).message}` }], isError: true };
      }
      const runId = randomUUID();
      deps.runRegistry.register(runId, { goal: goal.slice(0, 200), meta: { tool: 'dag_goal' } });
      deps.runRegistry.start(runId);

      // fire-and-forget: 自主环是长活 (research + spec + 多轮执行), 三段式取结果。
      deps
        .runGoal(goal, {
          cwd: deps.cwd,
          dag: dag as ExecutorDagConfig,
          ...(maxRounds ? { maxRounds } : {}),
          ...(researchRounds ? { researchRounds } : {}),
          ...(tier ? { tier } : {}),
        })
        .then((r) => {
          // 未收敛 = 自主环没达成 goal → 记 failed (**不算完成**): 谎报成功比失败更贵,
          // 调用方据此决定要不要人接手。
          if (r.converged) deps.runRegistry.succeed(runId, summarizeGoal(r));
          else deps.runRegistry.fail(runId, summarizeGoal(r));
        })
        .catch((err) => deps.runRegistry.fail(runId, err instanceof Error ? err.message : String(err)));

      return { content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }] };
    },
  };
}
