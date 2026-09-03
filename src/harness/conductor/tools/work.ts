/**
 * src/harness/conductor/tools/work —— `work` 卡:单个 worker,一处有界改动。
 * 契约 S1 change note:「short + zod strict schema(goal / brief min(40) / write_set? /
 * resume_of?)+ compile → 单个 executor:'agent' 节点」。
 */
import { z } from 'zod';
import { renderManual } from '../render-manual';
import type { CompileResult, ConductorCtx, ConductorTool } from '../types';

const WorkSchema = z
  .object({
    goal: z.string().min(1),
    brief: z.string().min(40),
    write_set: z.array(z.string()).optional(),
    /** resume: 复用同一节点 id —— 同 id 重派 (fresh context), 上一次同 id 的结果由运行时机械回灌进 goal
     * (orchestrating-loop.ts `injectPriorResult`, owner 2026-09-02 裁 2-C); 引擎没有按 id 续会话的机制。 */
    resume_of: z.string().min(1).optional(),
    /** review-fix (P2⑤,2026-09-02):true → 只返 manual,不 compile。不是 D-4 的调度字段,
     * 显式声明进 schema 是为了让只认发布的 JSON Schema 说话的调用方也够得到这条路 ——
     * `.strict()` 会在 `isHelpRequest` 短路之前就把未声明的 `help` 拒收(见 tools/index.ts)。 */
    help: z.boolean().optional(),
  })
  .strict();

type WorkParams = z.infer<typeof WorkSchema>;

/** 把 goal 里的路径分隔符换成 '-',截到一个可读长度,兜底非空 —— 只用于生成节点 id。 */
function slugId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'task';
}

const SHORT =
  'Start ONE worker for one bounded change. Default for any task with a single owner of the code. ' +
  'Params: goal (one sentence), brief (min 40 chars: reproduction output, scope, what not to touch). ';

export const workTool: ConductorTool<WorkParams> = {
  name: 'work',
  short: SHORT,
  schema: WorkSchema,
  manual: () => renderManual('work'),
  compile(params: WorkParams, ctx: ConductorCtx): CompileResult {
    const id = params.resume_of ?? slugId(params.goal);
    const plan = {
      name: `conductor-work-${id}`,
      nodes: {
        [id]: {
          executor: 'agent' as const,
          goal: `${params.goal}\n\n${params.brief}`,
          ...(params.write_set ? { write_set: params.write_set } : {}),
          ...(ctx.acceptance ? { self_check: { command: ctx.acceptance.command, expect_exit: ctx.acceptance.expect_exit } } : {}),
        },
      },
    };
    return { ok: true, plan };
  },
};
