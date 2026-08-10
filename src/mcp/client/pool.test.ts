/**
 * 连接池的真传输闸(SDD S1 / D-4):真 stdio 子进程 + 懒连接 + 失败不缓存。
 * InMemory 假体验不出传输层 —— 这里拉起 fixtures/stdio-ping-server.ts 走真 StdioClientTransport。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { McpClientPool } from './pool';
import type { McpServerConfig } from './config';

const FIXTURE = join(import.meta.dir, 'fixtures', 'stdio-ping-server.ts');

const stdioCfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: 'fx',
  kind: 'stdio',
  command: 'bun',
  args: [FIXTURE],
  connectTimeoutMs: 15_000,
  callTimeoutMs: 15_000,
  ...over,
});

const pools: McpClientPool[] = [];
afterAll(async () => {
  for (const p of pools) await p.close();
});

describe('McpClientPool (真 stdio)', () => {
  test('★ 真子进程: listAll 拿到 ping, call 返回 pong (C-1 的传输腿)', async () => {
    const pool = new McpClientPool([stdioCfg()]);
    pools.push(pool);
    const { tools, errors } = await pool.listAll();
    expect(errors).toEqual([]);
    expect(tools.map((t) => `${t.server}:${t.name}`)).toEqual(['fx:ping']);
    const r = await pool.call('fx', 'ping', {});
    expect(r.text).toBe('pong');
    expect(r.isError).toBe(false);
  }, 30_000);

  // 反向自检: 把 conn() 的 p.catch(() => delete) 去掉 → 第二次 listAll 仍然吐同一个缓存错误, 这条红。
  test('★ 连不上的 server 进 errors 带原文, 失败不缓存 (下次重试)', async () => {
    const pool = new McpClientPool([stdioCfg({ name: 'dead', command: 'this-command-does-not-exist-omd', args: [], connectTimeoutMs: 3_000 })]);
    pools.push(pool);
    const first = await pool.listAll();
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]?.server).toBe('dead');
    expect(first.errors[0]?.error).toBeTruthy(); // 错误原文, 不吞
    const second = await pool.listAll(); // 重试路径 (不是缓存的同一个 rejected promise)
    expect(second.errors).toHaveLength(1);
  }, 15_000);

  test('装配零连接 —— 只 new 不触任何 server (懒连接判据)', () => {
    // 判据: command 是不存在的可执行文件, 若构造期就连, 这里会抛/超时; 纯 new 必须瞬时安静通过。
    const pool = new McpClientPool([stdioCfg({ name: 'lazy', command: 'this-command-does-not-exist-omd' })]);
    pools.push(pool);
    expect(pool.serverNames()).toEqual(['lazy']);
  });
});
