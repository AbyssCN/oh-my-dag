/**
 * src/mcp/client/pool —— 外部 MCP server 连接池(开放生态 SDD S1 / D-4)。
 *
 * **懒连接 + 进程内共享**:装配期零连接(agent leaf 是同进程 runner,宽扇出不能每叶
 * 起 N 个子进程);首次 find/call 才连,连上后 client 与工具清单缓存到进程生命周期。
 * 连接失败**不缓存**(下次调用重试)但错误原文必须返回给调用方 —— fail-open 不吞证据。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../../logger';
import type { McpServerConfig } from './config';

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** ListTools 带的 annotations.readOnlyHint(缺省 undefined = 副作用类, C-5 判据)。 */
  readOnlyHint?: boolean;
}

export interface McpCallOutcome {
  text: string;
  isError: boolean;
}

interface Conn {
  client: Client;
  tools: McpToolInfo[];
}

/** 测试接缝:注入 transport(InMemory linked pair),不起真子进程。 */
export interface McpPoolDeps {
  transportFactory?: (s: McpServerConfig) => Transport | Promise<Transport>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${what} 超时 (${ms}ms)`)), ms);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

function makeTransport(s: McpServerConfig): Transport {
  if (s.kind === 'stdio') {
    return new StdioClientTransport({
      command: s.command as string,
      ...(s.args ? { args: s.args } : {}),
      // SDK 传了 env 就**替换**默认环境而非合并 —— 显式合并,否则子进程连 PATH 都没有。
      env: { ...getDefaultEnvironment(), ...(s.env ?? {}) },
      stderr: 'ignore',
    });
  }
  const url = new URL(s.url as string);
  const requestInit = s.headers ? { requestInit: { headers: s.headers } } : {};
  return s.kind === 'sse' ? new SSEClientTransport(url, requestInit) : new StreamableHTTPClientTransport(url, requestInit);
}

export class McpClientPool {
  private conns = new Map<string, Promise<Conn>>();
  private byName = new Map<string, McpServerConfig>();

  constructor(
    servers: readonly McpServerConfig[],
    private deps: McpPoolDeps = {},
  ) {
    for (const s of servers) this.byName.set(s.name, s);
  }

  serverNames(): string[] {
    return [...this.byName.keys()];
  }

  /** 懒连接。失败从缓存删除(下次重试),错误上抛给调用方呈现。 */
  private conn(name: string): Promise<Conn> {
    const existing = this.conns.get(name);
    if (existing) return existing;
    const cfg = this.byName.get(name);
    if (!cfg) return Promise.reject(new Error(`未注册的 MCP server: ${name}`));
    const p = (async (): Promise<Conn> => {
      const transport = await (this.deps.transportFactory ? this.deps.transportFactory(cfg) : makeTransport(cfg));
      const client = new Client({ name: 'omd-mcp-client', version: '0' });
      await withTimeout(client.connect(transport), cfg.connectTimeoutMs, `连接 ${name}`);
      const listed = await withTimeout(client.listTools(), cfg.connectTimeoutMs, `listTools ${name}`);
      const tools: McpToolInfo[] = listed.tools.map((t) => ({
        server: name,
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        readOnlyHint: t.annotations?.readOnlyHint,
      }));
      return { client, tools };
    })();
    this.conns.set(name, p);
    p.catch(() => this.conns.delete(name)); // 失败不缓存 —— 下次调用重试
    return p;
  }

  /** 单 server 的工具清单(懒连)。 */
  async toolsOf(name: string): Promise<McpToolInfo[]> {
    return (await this.conn(name)).tools;
  }

  /** 全部 server 的工具清单;连不上的进 errors(错误原文,不吞)。 */
  async listAll(): Promise<{ tools: McpToolInfo[]; errors: Array<{ server: string; error: string }> }> {
    const tools: McpToolInfo[] = [];
    const errors: Array<{ server: string; error: string }> = [];
    await Promise.all(
      this.serverNames().map(async (name) => {
        try {
          tools.push(...(await this.toolsOf(name)));
        } catch (e) {
          errors.push({ server: name, error: (e as Error).message });
        }
      }),
    );
    return { tools, errors };
  }

  /** 调用一个工具。结果文本块拼接;非文本块以占位符入文(证据可见)。 */
  async call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
    const cfg = this.byName.get(server);
    if (!cfg) throw new Error(`未注册的 MCP server: ${server}`);
    const { client } = await this.conn(server);
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: cfg.callTimeoutMs });
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = blocks
      .map((b) => (b.type === 'text' ? (b.text ?? '') : `[non-text content: ${b.type}]`))
      .join('\n');
    return { text, isError: result.isError === true };
  }

  async close(): Promise<void> {
    for (const [name, p] of this.conns) {
      try {
        const c = await p;
        await c.client.close();
      } catch (e) {
        logger.warn({ server: name, err: (e as Error).message }, '[omd/mcp-client] close 失败 (fail-open)');
      }
    }
    this.conns.clear();
  }
}
