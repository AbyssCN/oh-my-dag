/**
 * src/mcp/client/meta-tools —— 外部 MCP 的双 meta-tool 暴露面(开放生态 SDD S1 / D-2 / D-8)。
 *
 * ## 为什么是两个恒定工具,不是 N 个外部工具
 *
 * pi 通道的 tools 数组是**字节稳定冻结前缀**(skill-tool.ts:63-74 的论证同一条):把外部
 * 工具 schema 直接并进 tools 数组,装一个 server 就废全前缀 prompt cache。所以 deferred
 * 走 proxy 形态:tools 数组只有 `mcp_find` + `mcp_call` 两件(schema 冻结),发现与 schema
 * 披露全走**工具返回值**(messages 是追加的,不破前缀)。外部工具数与前缀体量从此解耦(I-2)。
 *
 * ## 教学式失败闸(D-8 / C-4)
 *
 * 对没 find 过的工具直接 call → 确定性拒绝,错误体附完整 schema,**同时放行后续调用**
 * (拒绝本身就是披露,教的是"下次先 find")。这是可跑判据不是 prompt 劝说 ——
 * 本仓实测结论:讲道理拦不住(§8.4)。
 *
 * ⚠ promptSnippet / description 必须静态 —— 任何扫盘算出的数字进冻结前缀 = 废 cache。
 */
import { Type } from 'typebox';
import type { Static } from 'typebox';
import type { TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';
import type { AnyOmdTool, OmdTool } from '../../harness/agent-tools';
import { logger } from '../../logger';
import { type McpCallLedger, openMcpCallLedger } from './call-ledger';
import { loadMcpClientConfig } from './config';
import { McpClientPool, type McpPoolDeps, type McpToolInfo } from './pool';

const FIND_SCHEMA = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        'Omit for a server overview. A keyword to search tool names/descriptions. ' +
        'An exact name ("server:tool" or a unique tool name) to fetch the full schema.',
    }),
  ),
});

const CALL_SCHEMA = Type.Object({
  tool: Type.String({ description: 'Tool to invoke: "server:tool", or the bare name if unique.' }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Arguments matching the tool schema.' })),
});

export interface McpClientToolsOpts {
  /** 工作根:注册表 `.omd/mcp.json` 与台账 `.omd/mcp-calls.db` 都锚它。 */
  cwd: string;
  /** 台账 session 标识(chat 传会话 id;省略 → 台账列落 NULL,不编造)。 */
  session?: string | (() => string | undefined);
  /** 测试注入::memory: 台账。 */
  ledger?: McpCallLedger;
  /** 测试注入:InMemory transport。 */
  poolDeps?: McpPoolDeps;
}

/** `server:tool` 全名。schema 已披露集合(C-4 闸)以它为键。 */
const keyOf = (t: McpToolInfo): string => `${t.server}:${t.name}`;

function schemaText(t: McpToolInfo): string {
  return [
    `工具 ${keyOf(t)} —— ${t.description || '(无描述)'}`,
    'schema:',
    JSON.stringify(t.inputSchema, null, 2),
    `调用: mcp_call({ tool: "${keyOf(t)}", args: { ... } })`,
  ].join('\n');
}

/**
 * 组装双 meta-tool。**零注册返回空数组**(I-2,镜像零 skill 纪律:恒失败的工具比没有更糟);
 * 注册表存在但读坏 → 照挂,把错误暴露在返回值里(坏配置不静默,S-3 族)。
 */
export function createMcpClientTools(o: McpClientToolsOpts): AnyOmdTool[] {
  const config = loadMcpClientConfig(o.cwd);
  if (config.servers.length === 0 && !config.loadError) return [];

  const pool = new McpClientPool(config.servers, o.poolDeps ?? {});
  // 台账懒开:第一笔才建库文件 —— 装配不该在只 find 不 call 的会话里留一个空 db。
  let ledger: McpCallLedger | null = o.ledger ?? null;
  const record: McpCallLedger['record'] = (input) => {
    if (!ledger) {
      try {
        ledger = openMcpCallLedger({ root: o.cwd });
      } catch (e) {
        logger.warn({ err: (e as Error).message }, '[omd/mcp-client] 台账打开失败 (fail-open, 本次调用不入账)');
        return;
      }
    }
    const session = typeof o.session === 'function' ? o.session() : o.session;
    ledger.record({ ...input, session: session ?? null });
  };

  /** C-4 闸的状态:本装配生命周期内已披露过 schema 的工具全名。 */
  const fetched = new Set<string>();

  /** 名字解析:'server:tool' 只连该 server;裸名连全部找唯一匹配。 */
  async function resolveTool(raw: string): Promise<{ tool: McpToolInfo } | { error: string; server: string | null }> {
    const name = raw.trim();
    const idx = name.indexOf(':');
    if (idx > 0) {
      const server = name.slice(0, idx);
      const bare = name.slice(idx + 1);
      if (!pool.serverNames().includes(server)) {
        return { error: `未注册的 MCP server "${server}"。已注册: ${pool.serverNames().join(', ')}`, server: null };
      }
      try {
        const hit = (await pool.toolsOf(server)).find((t) => t.name === bare);
        return hit ? { tool: hit } : { error: `server "${server}" 没有工具 "${bare}"。用 mcp_find("${server}") 看它有什么。`, server };
      } catch (e) {
        return { error: `连接 ${server} 失败: ${(e as Error).message}`, server };
      }
    }
    const { tools, errors } = await pool.listAll();
    const hits = tools.filter((t) => t.name === name);
    if (hits.length === 1) return { tool: hits[0] as McpToolInfo };
    if (hits.length > 1) {
      return { error: `工具名 "${name}" 在多个 server 上存在: ${hits.map(keyOf).join(', ')} —— 用 server:tool 指明。`, server: null };
    }
    const errText = errors.length ? `(部分 server 连不上: ${errors.map((e) => `${e.server}: ${e.error}`).join('; ')})` : '';
    return { error: `没有名为 "${name}" 的工具。用 mcp_find() 看有哪些。${errText}`, server: null };
  }

  const find: OmdTool<{ query: string | null; hits: number }> = {
    name: 'mcp_find',
    label: 'mcp_find',
    description:
      'Discover external MCP tools. No query: overview of registered servers. ' +
      'Keyword: search tool names/descriptions. Exact name ("server:tool"): fetch the full input schema ' +
      '(required before mcp_call).',
    promptSnippet:
      'mcp_find(query?) —— 发现外部 MCP 工具: 不带参数列 server 概览; 关键词搜工具; 精确名 (server:tool) 取完整 schema。',
    parameters: FIND_SCHEMA,
    executionMode: 'parallel',
    async execute(_id, params) {
      const { query } = params as Static<typeof FIND_SCHEMA>;
      const q = query?.trim() ?? '';
      if (config.loadError) {
        return {
          content: [{ type: 'text', text: `MCP 注册表读取失败: ${config.loadError}\n修好 .omd/mcp.json 再试。` }],
          details: { query: q || null, hits: 0 },
        };
      }
      // 精确名优先:命中即披露 schema 并解锁 mcp_call(C-2 第三分支)。
      const resolved = await resolveTool(q);
      if (q && 'tool' in resolved) {
        fetched.add(keyOf(resolved.tool));
        return { content: [{ type: 'text', text: schemaText(resolved.tool) }], details: { query: q, hits: 1 } };
      }
      const { tools, errors } = await pool.listAll();
      const errLines = errors.map((e) => `- ${e.server}: 连接失败 —— ${e.error}`);
      if (!q) {
        // 概览(C-2 第一分支)。server 名/工具数在**返回值**里 —— 冻结前缀一个字都不带它们。
        const byServer = new Map<string, McpToolInfo[]>();
        for (const t of tools) {
          const list = byServer.get(t.server) ?? [];
          list.push(t);
          byServer.set(t.server, list);
        }
        const lines = [...byServer.entries()].map(
          ([s, ts]) => `- ${s}: ${ts.length} 个工具 (${ts.slice(0, 10).map((t) => t.name).join(', ')}${ts.length > 10 ? ', …' : ''})`,
        );
        const text = [
          `已注册 ${pool.serverNames().length} 个 MCP server:`,
          ...lines,
          ...errLines,
          '下一步: mcp_find("关键词") 搜工具, mcp_find("server:tool") 取 schema。',
        ].join('\n');
        return { content: [{ type: 'text', text }], details: { query: null, hits: tools.length } };
      }
      // 关键词(C-2 第二分支)。
      const needle = q.toLowerCase();
      const hits = tools.filter((t) => t.name.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle));
      const shown = hits.slice(0, 40);
      const lines = shown.map((t) => `- ${keyOf(t)} —— ${t.description.slice(0, 120) || '(无描述)'}`);
      const text = hits.length
        ? [`匹配 "${q}" 的工具 ${hits.length} 个${hits.length > 40 ? '(截前 40)' : ''}:`, ...lines, ...errLines, '取 schema: mcp_find("server:tool")。'].join('\n')
        : [`没有匹配 "${q}" 的工具。`, ...errLines, '用 mcp_find() 看全部 server。'].join('\n');
      return { content: [{ type: 'text', text }], details: { query: q, hits: hits.length } };
    },
  };

  const call: OmdTool<{ tool: string; status: string }> = {
    name: 'mcp_call',
    label: 'mcp_call',
    description:
      'Invoke an external MCP tool by name ("server:tool", or bare name if unique). ' +
      'The tool schema must have been fetched via mcp_find first; unfetched calls are rejected ' +
      'with the schema attached (and unlocked for retry).',
    promptSnippet: 'mcp_call(tool, args) —— 调用外部 MCP 工具。先用 mcp_find 取 schema, 未取过会被拒并附 schema。',
    promptGuidelines: ['外部 MCP 工具: 先 mcp_find 取 schema 再 mcp_call; 参数不合 schema 的调用不会发往 server。'],
    parameters: CALL_SCHEMA,
    executionMode: 'sequential', // 外部工具副作用未知 → 串行(对齐 write/bash 的口径)
    async execute(_id, params) {
      const { tool: rawName, args } = params as Static<typeof CALL_SCHEMA>;
      const callArgs = (args ?? {}) as Record<string, unknown>;
      if (config.loadError) {
        record({ server: null, tool: rawName, status: 'unknown-tool', error: `注册表读取失败: ${config.loadError}` });
        return {
          content: [{ type: 'text', text: `MCP 注册表读取失败: ${config.loadError}` }],
          details: { tool: rawName, status: 'unknown-tool' },
        };
      }
      const resolved = await resolveTool(rawName);
      if ('error' in resolved) {
        record({ server: resolved.server, tool: rawName, status: 'unknown-tool', error: resolved.error });
        return { content: [{ type: 'text', text: resolved.error }], details: { tool: rawName, status: 'unknown-tool' } };
      }
      const t = resolved.tool;
      const key = keyOf(t);
      // C-4 教学式失败闸:拒绝即披露即解锁。
      if (!fetched.has(key)) {
        fetched.add(key);
        record({ server: t.server, tool: key, status: 'rejected-unfetched' });
        return {
          content: [
            { type: 'text', text: `拒绝: ${key} 的 schema 尚未经 mcp_find 取过。schema 如下, 核对参数后重发即可:\n${schemaText(t)}` },
          ],
          details: { tool: key, status: 'rejected-unfetched' },
        };
      }
      // C-3 参数校验:不合 schema 不发往 server。schema 是外部给的 JSON Schema ——
      // typebox Check 覆盖标准子集;校验器自身抛错 → 跳过校验放行(fail-open, warn 留痕)。
      try {
        if (!Check(t.inputSchema as TSchema, callArgs)) {
          const errs = Errors(t.inputSchema as TSchema, callArgs)
            .slice(0, 5)
            .map((e) => `${(e as { path?: string }).path || '(root)'}: ${(e as { message?: string }).message ?? '不合 schema'}`);
          const text = `拒绝: 参数不合 ${key} 的 schema —— ${errs.join('; ')}\n${schemaText(t)}`;
          record({ server: t.server, tool: key, status: 'rejected-args', error: errs.join('; ') });
          return { content: [{ type: 'text', text }], details: { tool: key, status: 'rejected-args' } };
        }
      } catch (e) {
        logger.warn({ tool: key, err: (e as Error).message }, '[omd/mcp-client] schema 校验器自身失败 —— 跳过校验放行');
      }
      try {
        const outcome = await pool.call(t.server, t.name, callArgs);
        record({ server: t.server, tool: key, status: outcome.isError ? 'error' : 'ok', error: outcome.isError ? outcome.text : null });
        const text = outcome.isError ? `[TOOL ERROR] ${key}: ${outcome.text}` : outcome.text;
        return { content: [{ type: 'text', text }], details: { tool: key, status: outcome.isError ? 'error' : 'ok' } };
      } catch (e) {
        const msg = (e as Error).message;
        record({ server: t.server, tool: key, status: 'connect-error', error: msg });
        return { content: [{ type: 'text', text: `[TOOL ERROR] ${key} 调用失败: ${msg}` }], details: { tool: key, status: 'connect-error' } };
      }
    },
  };

  return [find as AnyOmdTool, call as AnyOmdTool];
}
