/**
 * src/harness/lead/tools/explore —— `explore` 卡:N 个只读并行侦察 worker。
 * 契约 S1 change note:「questions[1..8] + persona?;compile → N 个空写集只读 agent 兄弟」。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, LeadTool } from '../types';

const ExploreSchema = z
  .object({
    questions: z.array(z.string().min(1)).min(1).max(8),
    persona: z.string().optional(),
  })
  .strict();

type ExploreParams = z.infer<typeof ExploreSchema>;

const SHORT =
  'N read-only workers that each answer one question about the repo and return facts with paths. No writes. ' +
  'Use before briefing when you need facts from many places at once.';

export const exploreTool: LeadTool<ExploreParams> = {
  name: 'explore',
  short: SHORT,
  schema: ExploreSchema,
  manual: () => renderManual('explore'),
  compile(params: ExploreParams): CompileResult {
    const nodes: ConductorPlan['nodes'] = {};
    params.questions.forEach((question, i) => {
      const id = `explore-${i + 1}`;
      nodes[id] = {
        executor: 'agent',
        goal: params.persona ? `As ${params.persona}: ${question}` : question,
        // 只读侦察:空写集(compile-time 承诺,不是运行时推断)。
        write_set: [],
      };
    });
    return { ok: true, plan: { name: 'lead-explore', nodes } };
  },
};
