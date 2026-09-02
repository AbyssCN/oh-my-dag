/**
 * src/harness/lead/tools/best-of —— `best_of` 卡:n 个竞争尝试,验收命令打分。
 * 契约 S1 change note:「n[2..8] / goal / brief / mode?;无 scorer(判据不可执行)时 compile
 * 返回 ok:false」。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, LeadCtx, LeadTool } from '../types';

const BestOfSchema = z
  .object({
    n: z.number().int().min(2).max(8),
    goal: z.string().min(1),
    brief: z.string().min(40),
    mode: z.enum(['best-score', 'first-green']).optional(),
  })
  .strict();

type BestOfParams = z.infer<typeof BestOfSchema>;

const SHORT =
  'n competing workers on the same goal; the acceptance command scores them; the engine keeps the best. ' +
  'Costs n full loops. Use when variance is high and the budget holds n loops.';

export const bestOfTool: LeadTool<BestOfParams> = {
  name: 'best_of',
  short: SHORT,
  schema: BestOfSchema,
  manual: () => renderManual('best_of'),
  compile(params: BestOfParams, ctx: LeadCtx): CompileResult {
    if (!ctx.acceptance) {
      return {
        ok: false,
        error:
          'best_of 需要一条可执行判据(冻结的验收命令)给候选打分 —— 这次 run 没有,选出来的只会是模型的偏好,' +
          '引擎拒绝在没有 scorer 的情况下跑 best_of。',
        manual: renderManual('best_of'),
      };
    }
    const nodes: ConductorPlan['nodes'] = {};
    for (let i = 0; i < params.n; i++) {
      const id = `attempt-${i + 1}`;
      nodes[id] = {
        executor: 'agent',
        goal: `${params.goal}\n\n${params.brief}\n\n(independent attempt ${i + 1} of ${params.n}; take a different approach from any sibling)`,
        self_check: { command: ctx.acceptance.command, expect_exit: ctx.acceptance.expect_exit },
      };
    }
    return { ok: true, plan: { name: 'lead-best-of', nodes } };
  },
};
