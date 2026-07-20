import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
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

// ——— D-9 回归 (审核实测抓过 3 个僵尸进程 100% CPU 忙转): 客户端消失/stdin EOF → server ≤5s 干净自退。
// 真起子进程 `bun run src/harness/tui.ts mcp` (非 InMemory), 先 initialize 握手证明 server 活着
// (排除 boot 即崩的假绿), 再关 stdin 断言自退。

/** 从 stdout 协议流里读到指定 id 的响应 (deadline 内); 读不到/流断回 false。 */
async function readResponseId(stdout: ReadableStream<Uint8Array>, id: number, timeoutMs: number): Promise<boolean> {
  const reader = stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null),
      ]);
      if (chunk === null || chunk.done) return false;
      buf += dec.decode(chunk.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          if ((JSON.parse(line) as { id?: number }).id === id) return true;
        } catch { /* stdout 是协议通道, 非 JSON 行不该出现; 跳过等真响应 */ }
      }
    }
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe('omd mcp 进程生命周期 (D-9 回归)', () => {
  test('客户端消失 (stdin 关闭) → ≤5s 干净自退 exit 0, 不留僵尸忙转', async () => {
    const tuiPath = fileURLToPath(new URL('../../src/harness/tui.ts', import.meta.url));
    const proc = Bun.spawn(['bun', 'run', tuiPath, 'mcp'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderrText = new Response(proc.stderr).text(); // 早挂消费防管道背压, 失败时供诊断
    try {
      const init = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'regression-test', version: '0' } },
      };
      proc.stdin.write(`${JSON.stringify(init)}\n`);
      proc.stdin.flush();
      const alive = await readResponseId(proc.stdout, 1, 15_000);
      if (!alive) throw new Error(`server 未完成 initialize 握手 (boot 失败?)\nstderr: ${await stderrText}`);

      // 客户端消失 = stdin EOF → 断言 ≤5s 自退
      const t0 = Date.now();
      proc.stdin.end();
      const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(exited).toBe(true);
      expect(proc.exitCode).toBe(0);
    } finally {
      proc.kill();
    }
  }, 25_000);
});
