/**
 * src/harness/conductor/tools/work —— `work` 卡:单个 worker,一处有界改动。
 * 契约 S1 change note:「short + zod strict schema(goal / brief min(40) / write_set? /
 * resume_of?)+ compile → 单个 executor:'agent' 节点」。
 *
 * 2026-09-04 leaf profile / agent card / MCP plumbing:WorkSchema 加 profile / template /
 * mcp 三个可选字段。compile 透传到子图节点同名字段(未知名 → compile 拒, 拒因含
 * 已知名单 —— conductor 调试时能直接看出「我引了那个?」)。`ctx.registries` 缺席 =
 * 旧行为逐字节不变(orchestrating-loop 装配时由 loop-run 注入真源)。
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
    /** 可选岗位档案(2026-09-04):已注册名 → 叶子执行时挂载这套 leaf profile;未知名 → compile 拒。 */
    profile: z.string().min(1).optional(),
    /** 可选 agent 模板卡(2026-09-04):已注册名 → 渲染时注入 body;未知名 → compile 拒。 */
    template: z.string().min(1).optional(),
    /** 可选 MCP server 白名单(2026-09-04):元素 = 已注册 server 名或 'server:tool';未知名 → compile 拒。 */
    mcp: z.array(z.string().min(1)).optional(),
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
  'Params: goal (one sentence), brief (min 40 chars: reproduction output, scope, what not to touch).' +
  ' +p/t/m.';

/** compile 顶层的 name 校验:profile/template 名称未知,或 mcp 元素未知/未注册 → ok:false + manual。schema 过 ≠ 名对(C-1). */
function checkRegistries(p: WorkParams, ctx: ConductorCtx): string | null {
  const reg = ctx.registries;
  if (!reg) return null;
  if (p.profile && !reg.profiles.includes(p.profile)) {
    return `未注册的 profile 名: '${p.profile}'。已知名册: ${reg.profiles.slice(0, 12).join(', ')}${reg.profiles.length > 12 ? ', …' : ''}.`;
  }
  if (p.template && !reg.templates.includes(p.template)) {
    return `未注册的 agent template 名: '${p.template}'。已知名册: ${reg.templates.slice(0, 12).join(', ')}${reg.templates.length > 12 ? ', …' : ''}.`;
  }
  if (p.mcp) {
    const servers = new Set(reg.servers);
    const bad = p.mcp.filter((m) => {
      const head = m.split(':')[0]!;
      return !servers.has(head);
    });
    if (bad.length) {
      return `未注册的 MCP server: ${bad.join(', ')}。已知: ${reg.servers.slice(0, 12).join(', ')}${reg.servers.length > 12 ? ', …' : ''}.`;
    }
  }
  return null;
}

export const workTool: ConductorTool<WorkParams> = {
  name: 'work',
  short: SHORT,
  schema: WorkSchema,
  manual: () => renderManual('work'),
  compile(params: WorkParams, ctx: ConductorCtx): CompileResult {
    const bad = checkRegistries(params, ctx);
    if (bad) return { ok: false, error: bad, manual: renderManual('work') };
    const id = params.resume_of ?? slugId(params.goal);
    const plan = {
      name: `conductor-work-${id}`,
      nodes: {
        [id]: {
          executor: 'agent' as const,
          goal: `${params.goal}\n\n${params.brief}`,
          ...(params.write_set ? { write_set: params.write_set } : {}),
          ...(params.profile ? { profile: params.profile } : {}),
          ...(params.template ? { template: params.template } : {}),
          ...(params.mcp ? { mcp: params.mcp } : {}),
          ...(ctx.acceptance ? { self_check: { command: ctx.acceptance.command, expect_exit: ctx.acceptance.expect_exit } } : {}),
        },
      },
    };
    return { ok: true, plan };
  },
};
