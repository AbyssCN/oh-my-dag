/**
 * src/harness/lead/tools/research —— `research` 卡:一条问题的有据网络调研。
 * 契约 S1 change note:「question / lenses? / depth?;`ctx.researchAvailable === false` 时
 * compile 返回 ok:false 并给判词」。
 */
import { z } from 'zod';
import { renderManual } from '../render-manual';
import type { CompileResult, LeadCtx, LeadTool } from '../types';

const ResearchSchema = z
  .object({
    question: z.string().min(1),
    lenses: z.array(z.string().min(1)).max(6).optional(),
    depth: z.enum(['first', 'second-pass']).optional(),
  })
  .strict();

type ResearchParams = z.infer<typeof ResearchSchema>;

const SHORT =
  'Web research on one question. Only when the run has a search provider. depth:"second-pass" digs only ' +
  'what the first pass left uncited or unread.';

export const researchTool: LeadTool<ResearchParams> = {
  name: 'research',
  short: SHORT,
  schema: ResearchSchema,
  manual: () => renderManual('research'),
  compile(params: ResearchParams, ctx: LeadCtx): CompileResult {
    if (ctx.researchAvailable === false) {
      return {
        ok: false,
        error: '这次 run 没有搜索 provider(ctx.researchAvailable=false)—— research 节点会抓不到任何真页面而失败,不派它。',
        manual: renderManual('research'),
      };
    }
    const secondPass = params.depth === 'second-pass';
    const research = params.lenses?.length || secondPass
      ? {
          ...(params.lenses?.length ? { lensCount: params.lenses.length } : {}),
          ...(secondPass ? { rounds: 2 } : {}),
        }
      : undefined;
    return {
      ok: true,
      plan: {
        name: 'lead-research',
        nodes: {
          research: {
            executor: 'research',
            goal: params.lenses?.length ? `${params.question}\n\nLenses: ${params.lenses.join(' / ')}` : params.question,
            ...(research ? { research } : {}),
          },
        },
      },
    };
  },
};
