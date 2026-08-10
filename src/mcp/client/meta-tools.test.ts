/**
 * 双 meta-tool 的契约闸(SDD S1):C-2 三分支 / C-3 参数闸 / C-4 教学式失败闸 / C-6 台账 / I-2。
 * 外部 server 用 InMemory linked pair(不起子进程);真 stdio 传输在 pool.test.ts 验。
 * 反向自检:C-3 / C-4 两条闸都在这里被喂已知坏样本证明会红。
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

/** 进程内测试 server:echo(带 required 参数)+ boom(恒失败)。echoCalls 计数 = C-3「没发往 server」的判据。 */
function makeTestServer(): { connectTo: () => Promise<import('@modelcontextprotocol/sdk/shared/transport.js').Transport>; echoCalls: () => number } {
  let echoCalls = 0;
  const srv = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
  srv.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'echoes msg back',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      },
      { name: 'boom', description: 'always fails', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  srv.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'echo') {
      echoCalls += 1;
      return { content: [{ type: 'text' as const, text: `echo:${(req.params.arguments as { msg?: string })?.msg}` }] };
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

function setup(): {
  find: NonNullable<ReturnType<typeof createMcpClientTools>[0]>;
  call: NonNullable<ReturnType<typeof createMcpClientTools>[1]>;
  ledger: ReturnType<typeof openMcpCallLedger>;
  echoCalls: () => number;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-mcp-meta-'));
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { t: { command: 'unused-by-inmemory' } } }));
  const server = makeTestServer();
  const ledger = openMcpCallLedger({ db: new Database(':memory:') });
  const tools = createMcpClientTools({ cwd, session: 'test-session', ledger, poolDeps: { transportFactory: () => server.connectTo() } });
  expect(tools.map((t) => t.name)).toEqual(['mcp_find', 'mcp_call']);
  const [find, call] = tools;
  return { find: find!, call: call!, ledger, echoCalls: server.echoCalls };
}

const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n');

describe('I-2 挂载判据', () => {
  test('零注册 → 空数组 (tools 数组与今日字节相同的前提)', () => {
    expect(createMcpClientTools({ cwd: mkdtempSync(join(tmpdir(), 'omd-mcp-empty-')) })).toEqual([]);
  });

  test('注册表存在但坏 → 照挂两件, find 暴露错误 (坏配置不静默)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-mcp-bad-'));
    mkdirSync(join(cwd, '.omd'), { recursive: true });
    writeFileSync(join(cwd, '.omd', 'mcp.json'), '不是 JSON');
    const tools = createMcpClientTools({ cwd, ledger: openMcpCallLedger({ db: new Database(':memory:') }) });
    expect(tools.map((t) => t.name)).toEqual(['mcp_find', 'mcp_call']);
    const r = await tools[0]!.execute('x', {});
    expect(text(r)).toContain('读取失败');
  });

  test('promptSnippet 静态 —— 不含任何扫盘算出的数字/名字 (冻结前缀纪律)', () => {
    const { find, call } = setup();
    for (const t of [find, call]) {
      expect(t.promptSnippet).not.toMatch(/\bt\b.*\d|echo|boom/);
    }
  });
});

describe('C-2 mcp_find 三分支', () => {
  test('裸调用 → server 概览 (名字与工具数在返回值里, 不在前缀里)', async () => {
    const { find } = setup();
    const r = await find.execute('x', {});
    expect(text(r)).toContain('t: 2 个工具');
    expect(text(r)).toContain('echo');
  });

  test('关键词 → name+description 匹配清单', async () => {
    const { find } = setup();
    const r = await find.execute('x', { query: 'echoes' });
    expect(text(r)).toContain('t:echo');
    expect(text(r)).not.toContain('t:boom');
  });

  test('精确名 → 完整 schema (含 required 字段)', async () => {
    const { find } = setup();
    const r = await find.execute('x', { query: 't:echo' });
    expect(text(r)).toContain('"required"');
    expect(text(r)).toContain('"msg"');
  });
});

describe('C-4 教学式失败闸 (反向自检: 已知坏样本 = 没 find 就 call)', () => {
  test('★ 未 find 直接 call → 拒绝 + 附完整 schema; 同一工具重发即放行', async () => {
    const { call, echoCalls } = setup();
    const first = await call.execute('x', { tool: 't:echo', args: { msg: 'hi' } });
    expect(text(first)).toContain('拒绝');
    expect(text(first)).toContain('"required"'); // 拒绝即披露
    expect(echoCalls()).toBe(0); // 没发往 server
    const second = await call.execute('x', { tool: 't:echo', args: { msg: 'hi' } });
    expect(text(second)).toBe('echo:hi'); // 拒绝即解锁 (C-4 后半)
    expect(echoCalls()).toBe(1);
  });

  test('find 过再 call → 一次通过', async () => {
    const { find, call, echoCalls } = setup();
    await find.execute('x', { query: 't:echo' });
    const r = await call.execute('x', { tool: 't:echo', args: { msg: 'yo' } });
    expect(text(r)).toBe('echo:yo');
    expect(echoCalls()).toBe(1);
  });
});

describe('C-3 参数闸 (反向自检: 已知坏样本 = 缺 required 字段)', () => {
  test('★ 参数不合 schema → 拒绝并指名字段, 不发往 server', async () => {
    const { find, call, echoCalls } = setup();
    await find.execute('x', { query: 't:echo' });
    const r = await call.execute('x', { tool: 't:echo', args: {} }); // 缺 required msg
    expect(text(r)).toContain('拒绝');
    expect(text(r)).toContain('msg');
    expect(echoCalls()).toBe(0); // C-3: 不发往 server
  });
});

describe('C-6 台账 (成败都记 + 拒绝三态分列)', () => {
  test('★ ok / error / rejected-unfetched / rejected-args / unknown-tool 各一行, error 存原文', async () => {
    const { find, call, ledger } = setup();
    await call.execute('x', { tool: 't:echo' }); // rejected-unfetched (顺带解锁)
    await call.execute('x', { tool: 't:echo', args: {} }); // rejected-args
    await call.execute('x', { tool: 't:echo', args: { msg: 'ok' } }); // ok
    await find.execute('x', { query: 't:boom' });
    await call.execute('x', { tool: 't:boom' }); // error (isError 回传)
    await call.execute('x', { tool: 'no-such' }); // unknown-tool
    const rows = ledger.rows();
    expect(rows.map((r) => r.status)).toEqual(['rejected-unfetched', 'rejected-args', 'ok', 'error', 'unknown-tool']);
    expect(rows.every((r) => r.session === 'test-session')).toBe(true);
    const boom = rows.find((r) => r.status === 'error');
    expect(boom?.error).toContain('kaboom 原文'); // fail-open 不吞证据
    const okRow = rows.find((r) => r.status === 'ok');
    expect(okRow?.error).toBeNull(); // NULL≠'' 纪律
  });
});

describe('名字解析', () => {
  test('裸名唯一 → 命中; 未注册 server → 报已注册清单', async () => {
    const { find, call } = setup();
    await find.execute('x', { query: 'echo' }); // 裸名精确命中也披露 schema
    const ok = await call.execute('x', { tool: 'echo', args: { msg: 'bare' } });
    expect(text(ok)).toBe('echo:bare');
    const bad = await call.execute('x', { tool: 'nope:tool' });
    expect(text(bad)).toContain('未注册的 MCP server');
  });
});
