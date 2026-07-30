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
import type { CheckpointManager } from '../../harness/continuity/checkpoint-manager';
import type { RunRegistry } from '../run-registry';
import type { HudRunRecordLike } from '../../hud/mirror';
import { recordDagRun, type DagRecorder } from '../../harness/dag-record';

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
  /**
   * W2 continuity + **节点级环 journal** (INV-P2-6, D-F 后降级到节点级)。给则:节点落 checkpoint,
   * 两个 conductor 节点 (契约段/执行段) 各自的轮次/毒集/上轮原因落 `_loop-<nodeId>.json` ——
   * `resume=<runId>` 才接得回来。省略 = 不落不续 (自主环仍能跑,但崩了从第 1 轮起且**毒集清零**,
   * 被拒产出会复活)。
   */
  continuity?: { manager: CheckpointManager; repoRoot: string };
  /**
   * omd-hud 活体镜像 (同 dag_run)。省略 = 不写 (HUD 空闲), 不影响执行。
   */
  hudMirror?: { write: (runId: string, record: HudRunRecordLike | null, levels?: string[][]) => void };
  /**
   * DAG 运行留痕器 (同 dag_run 那一个实例)。
   *
   * goal 这条**一次落两条**: 契约段 `goal-contract` 与执行段 `goal-execute` 各是一张图, `onComplete`
   * 各响一次, 靠同一个 `runId` 归组 —— 「这次 goal 花了多少 token / 吃到多少缓存」就是这两条相加。
   * 挂在 `runGoal` 的 `.then()` 上拿不到这个: 那里只剩 `RunGoalResult`, 两张图的用量已经不在了。
   */
  recorder?: DagRecorder;
}

/** 阶段结论压成宽出摘要 (D-8: 客户端上下文只拿结论, 全文自己 Read spec/report)。 */
export function summarizeGoal(r: RunGoalResult): string {
  const lines = [
    `goal: ${r.goal}`,
    `tier: ${r.tier} · ${r.converged ? '收敛' : '未收敛'} · ${r.rounds} 轮`,
    // D-I: 判卷标准进摘要 —— 调用方第一眼就该看见"这次是拿什么判的", 尤其是探索型
    // (它明说没有机器判据, 于是"收敛"这两个字该被读作 judge 的意见而不是 oracle 的结论)。
    r.acceptance.kind === 'executable'
      ? `验收: 执行型 · \`${r.acceptance.command}\` (期望退出码 ${r.acceptance.expectExit})`
      : `验收: 探索型 (无机器判据) · 学习目标: ${r.acceptance.learningGoal}`,
    ...r.stages.map((s) => `  [${s.status}] ${s.stage} — ${s.summary}`),
  ];
  // D-Q/D-P: "没跑完"的两种收尾要第一眼看得见 —— 它们各自对应完全不同的下一步
  // (阻塞 = owner 去看; 取消 = 直接 resume), 混在 stages 里读不出来。
  if (r.blocked) lines.push(`阻塞 (需外部输入): ${r.blocked}`);
  if (r.cancelled) lines.push(`已叫停: ${r.cancelled} · 续跑 dag_goal resume=<同一 runId>`);
  if (r.repoContext) lines.push(`仓内事实: ${r.repoContext.split('\n').length} 行`);
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
      // 上界 4 = PlanNode.max_rounds 的 schema 上界 (环封在 conductor 节点内, D-F) —— 两处必须同数,
      // 不然这里放进来的 5 会在下游被静默钳掉, 又是一个"配了但不生效"的旋钮。
      maxRounds: z.number().int().min(1).max(4).optional().describe('Execute-phase inner-loop round cap (default 2 = 1 repair)'),
      researchRounds: z.number().int().min(1).max(4).optional().describe('Research inner-loop cap (default 1)'),
      resume: z
        .string()
        .optional()
        .describe('runId of an interrupted dag_goal — resume its inner loop rounds (keeps poison set + green nodes)'),
    },
    handler: async (args) => {
      const { goal, tier, maxRounds, researchRounds, resume } = args as {
        goal?: string;
        tier?: GoalTier;
        maxRounds?: number;
        researchRounds?: number;
        resume?: string;
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
      // resume 复用**同一个 runId** —— journal 与 checkpoint 都按 runId 存, 换 id 就等于从零开始。
      if (resume && !deps.continuity) {
        return {
          content: [{ type: 'text' as const, text: 'dag_goal: resume 需要 continuity (未配置 → 无 journal 可续)' }],
          isError: true,
        };
      }
      const runId = resume || randomUUID();
      if (resume) {
        // 同一个 runId 重开: `register` 会因重复 id 抛 (server 还记得这个 run 时), 于是续跑一个
        // **本进程里跑失败/被叫停过**的 goal 原本会当场炸 —— 走 reopenForResume (failed/cancelled/未知
        // 三种都接得住), 与 dag_run/dag_run_plan 的 resume 同一条路。
        const rec = deps.runRegistry.getRecord(runId);
        if (rec && rec.status !== 'failed' && rec.status !== 'cancelled') {
          return {
            content: [{ type: 'text' as const, text: `dag_goal resume 拒绝: run ${runId} 当前 ${rec.status} (仅 failed/cancelled/未知可续)` }],
            isError: true,
          };
        }
        deps.runRegistry.reopenForResume(runId, { goal: goal.slice(0, 200), meta: { tool: 'dag_goal', resumed: true } });
      } else {
        deps.runRegistry.register(runId, { goal: goal.slice(0, 200), meta: { tool: 'dag_goal' } });
        deps.runRegistry.start(runId);
      }

      // INV-P2-6: continuity 给了才落环 journal; resume 时才读它 (与 per-node resume 同一开关)。
      // D-P: 取消把手一并挂上 —— 自主环是最长活的那条路 (research + 多轮执行), 也是最需要能叫停的。
      const dagWithContinuity: ExecutorDagConfig = {
        ...dag,
        cancelSignal: deps.runRegistry.attachCancel(runId),
        // **活体进度** (2026-07-30 取消冒烟撞出来的): `dag_goal` 此前**一个事件都不发** ——
        // 于是最长活的那条路 (research + 多轮执行, 动辄几分钟) 在 `dag_status` 上全程是
        // `planned 0 · started 0 · settled 0`, HUD 也是黑的。dag_run/dag_run_plan 一直有这条线,
        // goal 这条从 P1 起就漏了, 一直没人撞见是因为大家都在看最终结果。
        onNodeEvent: (e) => {
          deps.runRegistry.applyNodeEvent(runId, e);
          deps.hudMirror?.write(runId, deps.runRegistry.getRecord(runId));
        },
        ...(deps.continuity
          ? {
              continuity: {
                manager: deps.continuity.manager,
                runId,
                repoRoot: deps.continuity.repoRoot,
                ...(resume ? { resume: true } : {}),
              },
            }
          : {}),
        // 运行留痕: 两段图各落一条, 同 runId 归组。链上基座自带的 onComplete (今天没有, 但别让
        // 以后加的那个被这里悄悄吃掉 —— 这正是 dag_goal 事件面从 P1 漏到 07-30 的那类洞)。
        ...(deps.recorder
          ? { onComplete: recordDagRun(deps.recorder, { runId, question: goal }, dag.onComplete) }
          : {}),
      } as ExecutorDagConfig;

      // fire-and-forget: 自主环是长活 (research + spec + 多轮执行), 三段式取结果。
      deps
        .runGoal(goal, {
          cwd: deps.cwd,
          dag: dagWithContinuity,
          ...(maxRounds ? { maxRounds } : {}),
          ...(researchRounds ? { researchRounds } : {}),
          ...(tier ? { tier } : {}),
        })
        .then((r) => {
          // 未收敛 = 自主环没达成 goal → 记 failed (**不算完成**): 谎报成功比失败更贵,
          // 调用方据此决定要不要人接手。
          // D-P 例外: 被叫停的记 cancelled —— 它没失败, 只是没跑完, 而这两者的下一步不一样
          // (查为什么挂了 vs 直接 resume)。blocked 仍记 failed: 它确实没达成, 只是原因是"要人"。
          if (r.converged) deps.runRegistry.succeed(runId, summarizeGoal(r));
          else if (r.cancelled) deps.runRegistry.cancel(runId, r.cancelled, summarizeGoal(r));
          else deps.runRegistry.fail(runId, summarizeGoal(r));
        })
        .catch((err) => deps.runRegistry.fail(runId, err instanceof Error ? err.message : String(err)));

      return { content: [{ type: 'text' as const, text: `runId: ${runId}\nstatus: running` }] };
    },
  };
}
