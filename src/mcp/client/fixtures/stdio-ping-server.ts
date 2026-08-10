/**
 * 测试 fixture:最小 stdio MCP server(一个 `ping` 工具)。
 * pool.test 用真 StdioClientTransport 拉起它 —— 验的是真传输路,不是 InMemory 替身。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const srv = new McpServer({ name: 'fixture-ping', version: '0' }, { capabilities: { tools: {} } });
srv.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'ping', description: 'returns pong', inputSchema: { type: 'object', properties: {} } }],
}));
srv.server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'ping') return { content: [{ type: 'text', text: `unknown ${req.params.name}` }], isError: true };
  return { content: [{ type: 'text', text: 'pong' }] };
});
await srv.connect(new StdioServerTransport());
