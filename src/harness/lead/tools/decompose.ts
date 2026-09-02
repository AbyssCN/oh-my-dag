/**
 * src/harness/lead/tools/decompose —— `decompose` 卡:一步在规划期分不出来,留给 escalation
 * 座位现场画子图。契约 S1 change note:「goal / hint? / max_nodes?;compile → 单个
 * executor:'conductor' 节点,座位 = escalation,只展开一层」。
 *
 * 「子图不许再嵌 conductor 或 map」不是这里新加的闸 —— 那是既有的 D-D 展开闸
 * (`src/harness/plan/conductor-expand.ts`,「D-D 禁嵌套」),运行时对**任何**
 * `executor:'conductor'` 节点的子图都生效,compile() 不需要、也不应该重新实现一遍。
 * 这条规则的存在必须让模型看得见 —— manual 里那句 ENFORCED 原样来自
 * `GRAPH_SHAPES` 的 `runtime-decomposition.enforced`(真源,不是这里手抄的第二份)。
 */
import { z } from 'zod';
import { renderManual } from '../render-manual';
import type { CompileResult, LeadCtx, LeadTool } from '../types';

const DecomposeSchema = z
  .object({
    goal: z.string().min(1),
    hint: z.enum(['router', 'loop-until', 'iterate', 'escalation', 'saga', 'verify']).optional(),
    max_nodes: z.number().int().positive().max(64).optional(),
    /** review-fix (P2⑤,2026-09-02):见 tools/work.ts 同名字段注释。 */
    help: z.boolean().optional(),
  })
  .strict();

type DecomposeParams = z.infer<typeof DecomposeSchema>;

const SHORT =
  'A stronger model draws a subgraph for a goal you cannot split and one worker cannot finish. Optional hint ' +
  'names a control-flow: router, loop-until, iterate, escalation, saga, verify. Pass help:true for the full manual.';

export const decomposeTool: LeadTool<DecomposeParams> = {
  name: 'decompose',
  short: SHORT,
  schema: DecomposeSchema,
  manual: () => renderManual('decompose'),
  compile(params: DecomposeParams, ctx: LeadCtx): CompileResult {
    return {
      ok: true,
      plan: {
        name: 'lead-decompose',
        nodes: {
          decompose: {
            executor: 'conductor',
            // 座位 = escalation(D-2 的 ctx.seats.escalation),不是普通 worker 座。
            model: ctx.seats.escalation,
            goal: params.hint
              ? `${params.goal}\n\n(shape hint: ${params.hint} — the runtime owns the loop/branch/stop/scoring logic; this names the shape only)`
              : params.goal,
            // 只展开一层:省略 max_rounds(缺省 1,零回归),不在这里显式开多轮。
            ...(params.max_nodes ? { max_nodes: params.max_nodes } : {}),
          },
        },
      },
    };
  },
};
