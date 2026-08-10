/**
 * 注册表读取面的闸(SDD S1 / D-3 / I-4)。
 * 反向自检:每条闸都在这里被证明会红 —— 见各 test 注释里的证伪方式。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpClientConfig } from './config';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'omd-mcp-config-'));

function writeOwn(cwd: string, json: unknown): void {
  mkdirSync(join(cwd, '.omd'), { recursive: true });
  writeFileSync(join(cwd, '.omd', 'mcp.json'), typeof json === 'string' ? json : JSON.stringify(json));
}

describe('loadMcpClientConfig (S1)', () => {
  test('没有 .omd/mcp.json → 空表无错 (I-2 的挂载判据)', () => {
    const c = loadMcpClientConfig(tmp());
    expect(c.servers).toEqual([]);
    expect(c.loadError).toBeUndefined();
  });

  test('标准 mcpServers 解析 + 传输推断 (url→http, command→stdio) + disabled 排除', () => {
    const cwd = tmp();
    writeOwn(cwd, {
      mcpServers: {
        local: { command: 'bunx', args: ['-y', 'some-mcp'], env: { A: '1' } },
        remote: { url: 'https://example.com/mcp', headers: { authorization: 'Bearer x' } },
        legacy: { url: 'https://example.com/sse', type: 'sse' },
        off: { command: 'x', disabled: true },
      },
    });
    const c = loadMcpClientConfig(cwd);
    expect(c.servers.map((s) => [s.name, s.kind])).toEqual([
      ['local', 'stdio'],
      ['remote', 'http'],
      ['legacy', 'sse'],
    ]);
    // O-3 缺省超时(抄 Mini-Agent 实测值, 待校准)
    expect(c.servers[0]?.connectTimeoutMs).toBe(10_000);
    expect(c.servers[0]?.callTimeoutMs).toBe(60_000);
  });

  // 反向自检: 把 loadMcpClientConfig 的 catch 分支改成 return { servers: [] } (吞掉 loadError) → 这条当场红。
  test('★ 坏 JSON → 空表 + loadError 带原文 —— 坏配置不静默 (S-3 族)', () => {
    const cwd = tmp();
    writeOwn(cwd, '{ mcpServers: 这不是 JSON');
    const c = loadMcpClientConfig(cwd);
    expect(c.servers).toEqual([]);
    expect(c.loadError).toContain('.omd/mcp.json');
  });

  test('importClaudeConfig 默认关: .mcp.json 存在也不读', () => {
    const cwd = tmp();
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { claude: { command: 'x' } } }));
    writeOwn(cwd, { mcpServers: { own: { command: 'y' } } });
    expect(loadMcpClientConfig(cwd).servers.map((s) => s.name)).toEqual(['own']);
  });

  test('importClaudeConfig: true → 合并且 .omd 同名覆盖 (I-4: 对 .mcp.json 只读)', () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { claude: { command: 'x' }, both: { command: 'claude-version' } } }),
    );
    writeOwn(cwd, { importClaudeConfig: true, mcpServers: { own: { command: 'y' }, both: { command: 'omd-version' } } });
    const c = loadMcpClientConfig(cwd);
    expect(c.servers.map((s) => s.name).sort()).toEqual(['both', 'claude', 'own']);
    expect(c.servers.find((s) => s.name === 'both')?.command).toBe('omd-version');
  });

  test('既无 command 也无 url 的条目跳过 (warn 留痕), 不拖垮其余', () => {
    const cwd = tmp();
    writeOwn(cwd, { mcpServers: { broken: {}, ok: { command: 'x' } } });
    expect(loadMcpClientConfig(cwd).servers.map((s) => s.name)).toEqual(['ok']);
  });
});
