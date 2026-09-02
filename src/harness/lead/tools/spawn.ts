/**
 * src/harness/lead/tools/spawn —— `spawn` 卡:N 个独立 worker 并行。
 * 契约 S1 change note:「tasks[2..16] + 可选 decision;compile → N 个无边兄弟,
 * 有 decision 时前置一个决策节点;写集重叠当场拒」。
 *
 * review-fix (P2⑥,2026-09-02): 不再把 `ctx.acceptance`(run 级验收命令)接每个 task 的
 * self_check —— N 个并行 task 各自动着不同的文件,其中一个先跑完就会拿全 run 的验收命令
 * (如整仓 `bun test`)给自己判分,这时其它 task 可能还在半改状态,判到的红不是它的错,
 * 反而会把它拖进对着别人半成品做的自修环。run 级判据只该在「一个节点的产物就是整条 run
 * 的判据对象」时接(work / best_of),N-way 扇出的每个 task 不是。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, LeadCtx, LeadTool } from '../types';

const TaskSchema = z
  .object({
    goal: z.string().min(1),
    brief: z.string().min(1),
    write_set: z.array(z.string()).optional(),
  })
  .strict();

const SpawnSchema = z
  .object({
    tasks: z.array(TaskSchema).min(2).max(16),
    decision: z.object({ goal: z.string().min(1) }).strict().optional(),
    /** review-fix (P2⑤,2026-09-02):见 tools/work.ts 同名字段注释。 */
    help: z.boolean().optional(),
  })
  .strict();

type SpawnParams = z.infer<typeof SpawnSchema>;

const SHORT =
  'Start N independent workers in parallel. Each task: {goal, brief, write_set?}. Add `decision` when the ' +
  'tasks must agree on an interface, schema, or naming: one node outputs it first, all tasks depend on it. ';

/** 两个及以上 task 声明的 write_set 相交 → 返回撞上的第一个文件;否则 null。声明了才查(缺省=未知,不当场拒)。 */
function firstOverlap(writeSets: readonly (readonly string[])[]): string | null {
  const seen = new Set<string>();
  for (const files of writeSets) {
    for (const f of files) {
      if (seen.has(f)) return f;
      seen.add(f);
    }
  }
  return null;
}

export const spawnTool: LeadTool<SpawnParams> = {
  name: 'spawn',
  short: SHORT,
  schema: SpawnSchema,
  manual: () => renderManual('spawn'),
  compile(params: SpawnParams, ctx: LeadCtx): CompileResult {
    const overlap = firstOverlap(params.tasks.map((t) => t.write_set ?? []));
    if (overlap) {
      return {
        ok: false,
        error: `write set 重叠: 两个及以上 task 都声明了写 '${overlap}' —— 并行写同一份文件是竞争,拆开写集或改用 work 串行处理。`,
        manual: renderManual('spawn'),
      };
    }
    const nodes: ConductorPlan['nodes'] = {};
    let decisionId: string | undefined;
    if (params.decision) {
      decisionId = 'decision';
      nodes[decisionId] = { executor: 'agent' as const, goal: params.decision.goal, tier: 'strong' as const };
    }
    params.tasks.forEach((task, i) => {
      const id = `task-${i + 1}`;
      nodes[id] = {
        executor: 'agent' as const,
        goal: `${task.goal}\n\n${task.brief}`,
        ...(task.write_set ? { write_set: task.write_set } : {}),
        ...(decisionId ? { depends_on: [decisionId] } : {}),
      };
    });
    return { ok: true, plan: { name: 'lead-spawn', nodes } };
  },
};
