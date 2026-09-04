/**
 * src/harness/conductor/tools/spawn —— `spawn` 卡:N 个独立 worker 并行。
 * 契约 S1 change note:「tasks[2..16] + 可选 decision;compile → N 个无边兄弟,
 * 有 decision 时前置一个决策节点;写集重叠当场拒」。
 *
 * review-fix (P2⑥,2026-09-02): 不再把 `ctx.acceptance`(run 级验收命令)接每个 task 的
 * self_check —— N 个并行 task 各自动着不同的文件,其中一个先跑完就会拿全 run 的验收命令
 * (如整仓 `bun test`)给自己判分,这时其它 task 可能还在半改状态,判到的红不是它的错,
 * 反而会把它拖进对着别人半成品做的自修环。run 级判据只该在「一个节点的产物就是整条 run
 * 的判据对象」时接(work / best_of),N-way 扇出的每个 task 不是。
 *
 * 2026-09-04 leaf profile / agent card / MCP plumbing:TaskSchema 加 profile / template /
 * mcp 三个可选字段,与 work 同形 —— 未知名 → compile 拒(拒绝语义同 work)。透传到每个
 * task 节点同名字段。
 */
import { z } from 'zod';
import type { ConductorPlan } from '../../conductor-plan';
import { renderManual } from '../render-manual';
import type { CompileResult, ConductorCtx, ConductorTool } from '../types';

const TaskSchema = z
  .object({
    goal: z.string().min(1),
    brief: z.string().min(1),
    write_set: z.array(z.string()).optional(),
    profile: z.string().min(1).optional(),
    template: z.string().min(1).optional(),
    mcp: z.array(z.string().min(1)).optional(),
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
type TaskParams = z.infer<typeof TaskSchema>;

const SHORT =
  'Start N independent workers in parallel. Each task: {goal, brief, write_set?}. Add `decision` when the ' +
  'tasks must agree on an interface, schema, or naming: one node outputs it first, all tasks depend on it.' +
  ' +p/t/m.';

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

/** compile 顶层:对每个 task 查 profile / template / mcp 名,未知名 → 拒因(单点 + 已知名单)。 */
function checkTaskRegistries(task: TaskParams, ctx: ConductorCtx): string | null {
  const reg = ctx.registries;
  if (!reg) return null;
  if (task.profile && !reg.profiles.includes(task.profile)) {
    return `task 带未注册的 profile 名: '${task.profile}'。已知名册: ${reg.profiles.slice(0, 12).join(', ')}${reg.profiles.length > 12 ? ', …' : ''}.`;
  }
  if (task.template && !reg.templates.includes(task.template)) {
    return `task 带未注册的 agent template 名: '${task.template}'。已知名册: ${reg.templates.slice(0, 12).join(', ')}${reg.templates.length > 12 ? ', …' : ''}.`;
  }
  if (task.mcp) {
    const servers = new Set(reg.servers);
    const bad = task.mcp.filter((m) => {
      const head = m.split(':')[0]!;
      return !servers.has(head);
    });
    if (bad.length) {
      return `task 带未注册的 MCP server: ${bad.join(', ')}。已知: ${reg.servers.slice(0, 12).join(', ')}${reg.servers.length > 12 ? ', …' : ''}.`;
    }
  }
  return null;
}

export const spawnTool: ConductorTool<SpawnParams> = {
  name: 'spawn',
  short: SHORT,
  schema: SpawnSchema,
  manual: () => renderManual('spawn'),
  compile(params: SpawnParams, ctx: ConductorCtx): CompileResult {
    const overlap = firstOverlap(params.tasks.map((t) => t.write_set ?? []));
    if (overlap) {
      return {
        ok: false,
        error: `write set 重叠: 两个及以上 task 都声明了写 '${overlap}' —— 并行写同一份文件是竞争,拆开写集或改用 work 串行处理。`,
        manual: renderManual('spawn'),
      };
    }
    for (let i = 0; i < params.tasks.length; i++) {
      const bad = checkTaskRegistries(params.tasks[i]!, ctx);
      if (bad) return { ok: false, error: bad, manual: renderManual('spawn') };
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
        ...(task.profile ? { profile: task.profile } : {}),
        ...(task.template ? { template: task.template } : {}),
        ...(task.mcp ? { mcp: task.mcp } : {}),
        ...(decisionId ? { depends_on: [decisionId] } : {}),
      };
    });
    return { ok: true, plan: { name: 'conductor-spawn', nodes } };
  },
};
