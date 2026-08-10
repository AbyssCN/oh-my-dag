/**
 * C-5 策略闸的契约测试 (SDD D-7 / O-4 一期判据)。
 * 判据: annotations.readOnlyHint === true → 只读默认放行; 其余一律副作用类。
 * 副作用类: 'allow' 放行 · 'deny' 拒 · {allow} 仅当清单含 server 名或 'server:tool'。
 * 外部 server 用 InMemory linked pair (不起子进程), 照 meta-tools.test.ts:18-63 模式。
 * 反向自检 (照 meta-tools.test.ts:114/135 惯例):
 *   (a) ★ 已知坏样本 = 'deny' + 副作用工具 → 必须拒且 echoCalls()===0 (证伪: 没拒 = 闸没生效);
 *   (b) readOnlyHint 工具在 'deny' 下必须放行 (证伪: 只读也被拒 = 判据读反);
 *   (c) {allow:[server]} / {allow:['server:tool']} 必须放行; 清单不含 → 必须拒 (证伪: 清单不生效则此条红);
 *   (d) 缺省 'allow' 必须与今日行为一致 (证伪: 缺省被误改则既有 meta-tools.test.ts 或此条红)。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openMcpCallLedger } from './call-ledger';
import { createMcpClientTools } from './meta-tools';

type Policy =
  | { sideEffects: 'allow' | { allow: string[] } | 'deny' }
  | (() => { sideEffects: 'allow' | { allow: string[] } | 'deny' });

/**
 * 进程内测试 server,工具分两档:peek (annotations.readOnlyHint=true) + poke (无标注 → 副作用类)。
 * echoCalls 计数 = C-5「没发往 server」的判据。
 */
function makeTestServer(): { connectTo: () => Promise<import('@modelcontextprotocol/sdk/shared/transport.js').Transport>; echoCalls: () => number } {
  let echoCalls = 0;
  const srv = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
  srv.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'peek',
        description: 'read-only peek',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      },
      { name: 'poke', description: 'side-effect poke', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
    ],
  }));
  srv.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'peek' || req.params.name === 'poke') {
      echoCalls += 1;
      return { content: [{ type: 'text' as const, text: `${req.params.name}:${(req.params.arguments as { msg?: string })?.msg}` }] };
    }
    return { content: [{ type: 'text' as const, text: 'kaboom 原文' }], isError: true };
  });
  return {
    connectTo: async () => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await srv.connect(serverT);
      return clientT;
    },
    echoCalls: () => echoCalls,
  };
}

function setup(policy?: Policy): {
  find: NonNullable<ReturnType<typeof createMcpClientTools>[0]>;
  call: NonNullable<ReturnType<typeof createMcpClientTools>[1]>;
  ledger: ReturnType<typeof openMcpCallLedger>;
  echoCalls: () => number;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-mcp-policy-'));
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { t: { command: 'unused-by-inmemory' } } }));
  const server = makeTestServer();
  const ledger = openMcpCallLedger({ db: new Database(':memory:') });
  const tools = createMcpClientTools({ cwd, session: 'test-session', ledger, poolDeps: { transportFactory: () => server.connectTo() }, policy });
  expect(tools.map((t) => t.name)).toEqual(['mcp_find', 'mcp_call']);
  const [find, call] = tools;
  return { find: find!, call: call!, ledger, echoCalls: server.echoCalls };
}

const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n');

describe('C-5 策略闸 (O-4 一期判据)', () => {
  test('(a) ★ 已知坏样本: deny + 副作用工具 → 拒, 错误含理由与声明方法, ledger 记 rejected-policy, 不发往 server', async () => {
    const { find, call, ledger, echoCalls } = setup({ sideEffects: 'deny' });
    await find.execute('x', { query: 't:poke' }); // 先过 C-4 教学闸
    const r = await call.execute('x', { tool: 't:poke', args: { msg: 'hi' } });
    expect(text(r)).toContain('拒绝');
    expect(text(r)).toContain('副作用'); // 理由
    expect(text(r)).toContain('声明方法'); // 声明方法
    expect(text(r)).toContain('mcp 字段'); // 点名 plan 节点 mcp 字段 / 模板卡 frontmatter mcp
    expect(echoCalls()).toBe(0); // C-5: 没发往 server
    const rows = ledger.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('rejected-policy');
    expect(rows[0]!.error).toContain('副作用');
    expect(rows[0]!.error).toContain('声明方法');
  });

  test('(b) readOnlyHint=true 工具在 deny 下放行 (只读默认放行, 策略只卡副作用)', async () => {
    const { find, call, ledger, echoCalls } = setup({ sideEffects: 'deny' });
    await find.execute('x', { query: 't:peek' });
    const r = await call.execute('x', { tool: 't:peek', args: { msg: 'ro' } });
    expect(text(r)).toBe('peek:ro');
    expect(echoCalls()).toBe(1);
    expect(ledger.rows().map((x) => x.status)).toEqual(['ok']);
  });

  test('(c) {allow:[server]} 与 {allow:[server:tool]} 下副作用放行; 清单不含 → 拒', async () => {
    for (const sideEffects of [{ allow: ['t'] }, { allow: ['t:poke'] }]) {
      const { find, call, echoCalls } = setup({ sideEffects });
      await find.execute('x', { query: 't:poke' });
      const r = await call.execute('x', { tool: 't:poke', args: { msg: 'y' } });
      expect(text(r)).toBe('poke:y');
      expect(echoCalls()).toBe(1);
    }
    // 证伪: allow 清单不生效 → 这半边不红。
    const { find, call, ledger, echoCalls } = setup({ sideEffects: { allow: ['nope'] } });
    await find.execute('x', { query: 't:poke' });
    const r = await call.execute('x', { tool: 't:poke', args: { msg: 'y' } });
    expect(text(r)).toContain('拒绝');
    expect(echoCalls()).toBe(0);
    expect(ledger.rows().map((x) => x.status)).toEqual(['rejected-policy']);
  });

  test('(d) 缺省 allow 与今日行为一致 (不传 policy)', async () => {
    const { find, call, echoCalls } = setup();
    await find.execute('x', { query: 't:poke' });
    const r = await call.execute('x', { tool: 't:poke', args: { msg: 'z' } });
    expect(text(r)).toBe('poke:z');
    expect(echoCalls()).toBe(1);
  });
});
  test('(e) policy 函数形按调用求值 (agent-leaf per-run mcpAllow 的通道)', async () => {
    // 证伪: resolvePolicy 不走函数形 → 本条红 (函数形被当静态对象 → 恒 undefined → 缺省 allow 放行)。
    let current: { sideEffects: 'allow' | { allow: string[] } | 'deny' } = { sideEffects: 'deny' };
    const { find, call, echoCalls } = setup(() => current);
    await find.execute('x', { query: 't:poke' });
    const r1 = await call.execute('x', { tool: 't:poke', args: { msg: 'a' } });
    expect(text(r1)).toContain('拒绝');
    expect(echoCalls()).toBe(0); // deny 下没发往 server
    current = { sideEffects: { allow: ['t'] } };
    const r2 = await call.execute('x', { tool: 't:poke', args: { msg: 'b' } });
    expect(text(r2)).toBe('poke:b');
    expect(echoCalls()).toBe(1);
  });
