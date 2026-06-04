/**
 * src/valar/mcp/mcp-router-extension —— 把 McpRouter 接进 TUI (Contract D74 轴 A)。
 *
 * 注册 3 个 meta-tool (LLM 唯一可见的 MCP 面) + `/mcp` 管理命令。
 *   mcp_search(need)   → BM25 检索, 返候选 {id, description} (MR-INV-1: 不含 schema)
 *   mcp_describe(name) → 单个工具完整 inputSchema (按需)
 *   mcp_call(name,args)→ 路由执行
 * `menuBlock()` = 常驻菜单字符串 (供 tui 在 before_agent_start 注入系统提示, MR-INV-1)。
 */
import { Type, type Static } from 'typebox';
import {
  defineTool,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { McpRouter } from './router';
import type { ServerSpec } from './types';
import { logger } from '../../logger';

const SEARCH = Type.Object({
  need: Type.String({ description: '一句话描述你要做什么 (例: "搜网页" / "查谁给我发过邮件")。' }),
  k: Type.Optional(Type.Number({ description: '返回候选数, 默认 5。' })),
});
const DESCRIBE = Type.Object({
  name: Type.String({ description: '工具 id, 形如 server/tool (从 mcp_search 或菜单拿)。' }),
});
const CALL = Type.Object({
  name: Type.String({ description: '工具 id, 形如 server/tool。' }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '工具入参 (先 mcp_describe 看 schema)。' })),
});
type SearchParams = Static<typeof SEARCH>;
type DescribeParams = Static<typeof DESCRIBE>;
type CallParams = Static<typeof CALL>;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

/** stdio: "name@npm-pkg" / "name=cmd arg arg"; http: "name=https://…"。 */
export function defaultParseSpec(s: string): ServerSpec {
  const t = s.trim();
  const eq = t.indexOf('=');
  if (eq > 0) {
    const name = t.slice(0, eq).trim();
    const rhs = t.slice(eq + 1).trim();
    if (/^https?:\/\//.test(rhs)) return { name, url: rhs };
    const [command, ...args] = rhs.split(/\s+/);
    return { name, command, args };
  }
  // "name@pkg" → npx -y pkg
  const at = t.lastIndexOf('@');
  if (at > 0) {
    const name = t.slice(0, at).trim();
    const pkg = t.slice(at + 1).trim();
    return { name, command: 'npx', args: ['-y', pkg] };
  }
  // 裸名 → npx -y <name>
  return { name: t, command: 'npx', args: ['-y', t] };
}

/** 常驻菜单 (供系统提示注入)。MR-INV-1: 只名+一句话, 不含 schema。 */
export function menuBlock(router: McpRouter): string {
  const m = router.menu();
  if (m.length === 0) return '';
  const lines = m.map((e) => `- ${e.id}: ${e.description}`).join('\n');
  return [
    '<mcp-tools>',
    `经路由可用的 MCP 工具 (${m.length} 个)。要用先 mcp_describe(name) 看参数, 再 mcp_call(name, args); 模糊需求用 mcp_search(need)。`,
    lines,
    '</mcp-tools>',
  ].join('\n');
}

export interface McpRouterExtensionOpts {
  router: McpRouter;
  parseSpec?: (s: string) => ServerSpec;
}

export function createMcpRouterExtension(opts: McpRouterExtensionOpts): ExtensionFactory {
  const router = opts.router;
  const parseSpec = opts.parseSpec ?? defaultParseSpec;

  return (pi) => {
    // MR-INV-1: 每轮把当前菜单 append 进系统提示 (动态 → 重算; 同轮防重复)。
    pi.on('before_agent_start', (event) => {
      const block = menuBlock(router);
      if (!block) return {};
      if (event.systemPrompt.includes('<mcp-tools>')) return {};
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });

    pi.registerTool(
      defineTool({
        name: 'mcp_search',
        label: 'MCP search',
        description: '按需求检索可用 MCP 工具 (返候选, 不含完整 schema)。模糊需求时用; 知道工具名直接 mcp_describe。',
        promptSnippet: 'mcp_search(need) — 找工具。',
        parameters: SEARCH,
        executionMode: 'parallel',
        async execute(_id: string, p: SearchParams) {
          const hits = router.search(p.need, p.k ?? 5);
          if (hits.length === 0) return textResult('无匹配, 试 /mcp list 看全部或换措辞。', { hits: 0 });
          const lines = hits.map((t) => `- ${t.id}: ${t.description}`).join('\n');
          return textResult(lines, { hits: hits.length, ids: hits.map((t) => t.id) });
        },
      }) as unknown as ToolDefinition,
    );

    pi.registerTool(
      defineTool({
        name: 'mcp_describe',
        label: 'MCP describe',
        description: '取单个 MCP 工具的完整参数 schema (调用前看)。',
        promptSnippet: 'mcp_describe(name) — 看工具参数。',
        parameters: DESCRIBE,
        executionMode: 'parallel',
        async execute(_id: string, p: DescribeParams) {
          const t = router.describe(p.name);
          if (!t) return textResult(`未知工具 ${p.name} (用 mcp_search 找)。`, { found: false });
          return textResult(JSON.stringify({ id: t.id, description: t.description, inputSchema: t.inputSchema }, null, 2), { found: true });
        },
      }) as unknown as ToolDefinition,
    );

    pi.registerTool(
      defineTool({
        name: 'mcp_call',
        label: 'MCP call',
        description: '执行一个 MCP 工具 (经路由到对应 server)。',
        promptSnippet: 'mcp_call(name, args) — 执行工具。',
        parameters: CALL,
        executionMode: 'sequential',
        async execute(_id: string, p: CallParams, _signal, _onUpdate, ctx: ExtensionContext) {
          try {
            const res = await router.call(p.name, p.args ?? {});
            // MCP 结果通常 {content:[{type:'text',text}]}; 透传文本, 否则 JSON。
            const r = res as { content?: { type: string; text?: string }[] };
            if (Array.isArray(r?.content)) {
              const text = r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
              return textResult(text || JSON.stringify(res), { ok: true });
            }
            return textResult(typeof res === 'string' ? res : JSON.stringify(res), { ok: true });
          } catch (e) {
            ctx?.ui?.notify?.(`mcp_call 失败: ${(e as Error).message}`, 'error');
            return textResult(`error: ${(e as Error).message}`, { ok: false });
          }
        },
      }) as unknown as ToolDefinition,
    );

    // /mcp add|list|remove|toggle — 名不带斜杠 (pi 已 slice)。
    pi.registerCommand('mcp', {
      description: '管理 MCP 路由: /mcp add <name=cmd|name@pkg|name=url> · list · remove <name> · toggle <name>',
      handler: async (args: string, ctx) => {
        const [sub, ...rest] = args.trim().split(/\s+/);
        const arg = rest.join(' ').trim();
        try {
          if (sub === 'add') {
            if (!arg) return void ctx.ui.notify('用法: /mcp add <name=cmd args | name@pkg | name=https://url>', 'warning');
            ctx.ui.setStatus('mcp', `装 ${arg.slice(0, 30)}…`);
            const st = await router.add(parseSpec(arg));
            ctx.ui.setStatus('mcp', undefined);
            ctx.ui.notify(`✅ 装好 ${st.spec.name} (${st.tools} 工具)`, 'info');
          } else if (sub === 'list') {
            const s = router.status();
            const m = router.menu().length;
            ctx.ui.notify(
              s.length === 0
                ? '无 MCP server (用 /mcp add 装)。'
                : `${s.length} server / ${m} 工具:\n${s.map((x) => `  ${x.spec.name} [${x.status}${x.enabled ? '' : ',disabled'}] ${x.tools}工具`).join('\n')}`,
              'info',
            );
          } else if (sub === 'remove') {
            await router.remove(arg);
            ctx.ui.notify(`移除 ${arg}`, 'info');
          } else if (sub === 'toggle') {
            const cur = router.status().find((x) => x.spec.name === arg);
            router.toggle(arg, !(cur?.enabled ?? true));
            ctx.ui.notify(`${arg} → ${cur?.enabled ? 'disabled' : 'enabled'}`, 'info');
          } else {
            ctx.ui.notify('子命令: add | list | remove | toggle', 'warning');
          }
        } catch (e) {
          ctx.ui.setStatus('mcp', undefined);
          ctx.ui.notify(`/mcp ${sub} 失败: ${(e as Error).message}`, 'error');
          logger.warn({ sub, err: (e as Error).message }, '[valar/mcp] command failed');
        }
      },
    });
  };
}
