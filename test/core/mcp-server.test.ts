import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createOmdMcpServer, type OmdMcpTool } from '../../src/mcp/server';

// server 骨架注册面 (SDD omd-mcp-server, task-server-skeleton):
// createOmdMcpServer 纯组装 —— 注册的工具经 InMemoryTransport 双端无进程可见、可调、坏参被拒。

const echoTool: OmdMcpTool = {
  name: 'echo',
  description: '回显入参 (测试桩)',
  inputSchema: { q: z.string() },
  handler: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
};

const pingTool: OmdMcpTool = {
  name: 'ping',
  description: '零参探活 (测试桩)',
  inputSchema: {},
  handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
};

async function wire(tools: OmdMcpTool[]): Promise<Client> {
  const server = createOmdMcpServer(tools, { name: 'omd', version: 'test' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(ct), client.connect(st)]);
  return client;
}

describe('createOmdMcpServer 注册面', () => {
  test('tools/list 反映全部注册工具 (name + description 原样)', async () => {
    const client = await wire([echoTool, pingTool]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'ping']);
    expect(tools.find((t) => t.name === 'echo')?.description).toBe('回显入参 (测试桩)');
    await client.close();
  });

  test('空注册面 (骨架期): tools/list 回空表而非 -32601', async () => {
    const client = await wire([]);
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();
  });

  test('注册工具可调: 参数经 schema 解析到达 handler, 结果回传', async () => {
    const client = await wire([echoTool]);
    const res = await client.callTool({ name: 'echo', arguments: { q: 'hi' } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify({ q: 'hi' }) }]);
    await client.close();
  });

  test('schema 拒坏参 → MCP error 非 crash (server 仍活)', async () => {
    const client = await wire([echoTool]);
    let rejected = false;
    try {
      const r = await client.callTool({ name: 'echo', arguments: { q: 123 } });
      rejected = r.isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    // 拒后 server 未崩: 注册面仍可枚举
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    await client.close();
  });
});
