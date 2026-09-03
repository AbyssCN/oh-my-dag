/**
 * src/harness/conductor/tools/decompose —— `decompose` 卡:一步在规划期分不出来,留给 escalation 座位现场处理。
 *
 * 2026-09-04 (v1 规划式 conductor 退役, owner 裁 2026-09-03): 不再编译成 `executor:'conductor'` 节点 (那个节点类型与
 * 30k 画图 prompt 一起删了), 而是编译成一张**嵌套的编排循环** (conductor/loop-plan.ts): 一个 conductor 节点坐
 * escalation 座, 手里同样是七张卡, 深度 +1。派发方 (goal/loop-run.ts `runChild`) 认出循环 plan 就给子 run 装循环面。
 * 「只展开一层」由深度上限 `LOOP_MAX_DEPTH` 守: 深度 1 的 conductor 再调 decompose 当场拒 (compile 拒, 拒因带 manual)。
 */
import { z } from 'zod';
import { renderManual } from '../render-manual';
import { LOOP_MAX_DEPTH, compileOrchestratingLoop } from '../loop-plan';
import type { CompileResult, ConductorCtx, ConductorTool } from '../types';

const DecomposeSchema = z
  .object({
    goal: z.string().min(1),
    hint: z.enum(['router', 'loop-until', 'iterate', 'escalation', 'saga', 'verify']).optional(),
    /** review-fix (P2⑤,2026-09-02):见 tools/work.ts 同名字段注释。 */
    help: z.boolean().optional(),
  })
  .strict();

type DecomposeParams = z.infer<typeof DecomposeSchema>;

const SHORT =
  'A stronger model draws a subgraph for a goal you cannot split and one worker cannot finish. Optional hint ' +
  'names a control-flow: router, loop-until, iterate, escalation, saga, verify.';

export const decomposeTool: ConductorTool<DecomposeParams> = {
  name: 'decompose',
  short: SHORT,
  schema: DecomposeSchema,
  manual: () => renderManual('decompose'),
  compile(params: DecomposeParams, ctx: ConductorCtx): CompileResult {
    const depth = ctx.depth ?? 0;
    if (depth >= LOOP_MAX_DEPTH) {
      return {
        ok: false,
        error:
          `decompose 只展开一层: 这里已经是第 ${depth} 层嵌套循环, 不能再 decompose (深度上限 ${LOOP_MAX_DEPTH})。` +
          '把这一步直接用 work / spawn / map 派出去。',
        manual: renderManual('decompose'),
      };
    }
    const goal = params.hint
      ? `${params.goal}\n\n(shape hint: ${params.hint} — the runtime owns the loop/branch/stop/scoring logic; this names the shape only)`
      : params.goal;
    return {
      ok: true,
      // 座位 = escalation (D-2 的 ctx.seats.escalation), 不是普通 worker 座; 深度 +1 写进 plan, 派发方据此装面。
      plan: compileOrchestratingLoop({ goal, ctx, conductorModel: ctx.seats.escalation, depth: depth + 1 }),
    };
  },
};
