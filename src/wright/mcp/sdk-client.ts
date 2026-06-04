/**
 * src/wright/mcp/sdk-client —— 默认 McpClientFactory (官方 @modelcontextprotocol/sdk)。
 * MR-INV-2: 进程内客户端连后端 (stdio/http), 不用 pi-mcp-adapter。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpClient, McpClientFactory, RawTool, ServerSpec } from './types';

function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...extra })) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export const sdkClientFactory: McpClientFactory = async (spec: ServerSpec): Promise<McpClient> => {
  const client = new Client({ name: 'wright-mcp-router', version: '0.1.0' });
  const transport = spec.url
    ? new StreamableHTTPClientTransport(new URL(spec.url))
    : new StdioClientTransport({
        command: spec.command ?? (() => {
          throw new Error(`server "${spec.name}": need command (stdio) or url (http)`);
        })(),
        args: spec.args ?? [],
        env: cleanEnv(spec.env),
      });
  await client.connect(transport);
  return {
    async listTools(): Promise<RawTool[]> {
      const r = await client.listTools();
      return r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },
    async callTool(name: string, args: unknown): Promise<unknown> {
      return await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
};
