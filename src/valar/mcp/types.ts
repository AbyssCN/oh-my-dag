/**
 * src/valar/mcp/types —— MCP 路由层接口 (Contract D74 轴 A)。
 *
 * 后端连接抽象成可注入的 McpClient → router 纯逻辑可测 (fake client), 不打真 MCP server。
 * 默认实现 = @modelcontextprotocol/sdk (见 sdk-client.ts)。
 */

/** MCP server 规格: stdio (command+args) 或 http (url)。 */
export interface ServerSpec {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/** MCP server 原始返回的工具。 */
export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** 索引里的工具。id = 限定名 `${server}/${name}` (跨 server 防撞 + 路由用)。 */
export interface IndexedTool {
  id: string;
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

export type ServerStatus = 'connected' | 'unavailable';

/** 注入式 MCP 客户端 (默认 SDK, 测试 fake)。 */
export interface McpClient {
  listTools(): Promise<RawTool[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** spec → 已连接的 client。连不上则抛 (MR-INV-6 fail-closed)。 */
export type McpClientFactory = (spec: ServerSpec) => Promise<McpClient>;

export class McpRouterError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'McpRouterError';
  }
}
