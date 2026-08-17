/**
 * C2 判据: 三条配置主干的坏配置 → 进程不砖 + issues 命中字段路径; 合法配置 → issues 为空。
 * (fail-open 跳过行为本身由各主干既有测试钉住, 本文件只钉"证据面"这一新增维度。)
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigIssue } from './issues';
import { readDeclaredPlans } from './config-discovery';
import { loadMcpClientConfig } from '../mcp/client/config';
import { readExtensionList } from '../tui/ext/host';

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-c2-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('C2 · declaredPlans (.omd/config.json)', () => {
  test('坏条目逐条点名字段路径, 好条目照收', () => {
    const d = tmp();
    const p = join(d, 'config.json');
    writeFileSync(
      p,
      JSON.stringify({
        declaredPlans: [
          { provider: 'kimi-coding', kind: 'flat' },
          { provider: '', kind: 'flat' },
          { provider: 'x', kind: 'tokens' },
          'junk',
        ],
      }),
    );
    const issues: ConfigIssue[] = [];
    const plans = readDeclaredPlans({}, p, issues);
    expect(plans).toEqual([{ provider: 'kimi-coding', kind: 'flat', rateUsd: 0, plan: 'declared' }]);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('declaredPlans[1].provider');
    expect(paths).toContain('declaredPlans[2].kind');
    expect(paths.some((x) => x.startsWith('declaredPlans[3]'))).toBe(true);
  });

  test('坏 JSON: 不砖, issue 带文件路径与原文', () => {
    const d = tmp();
    const p = join(d, 'config.json');
    writeFileSync(p, '{ not json');
    const issues: ConfigIssue[] = [];
    expect(readDeclaredPlans({}, p, issues)).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.source).toBe(p);
  });

  test('反向: 合法配置 issues 为空', () => {
    const d = tmp();
    const p = join(d, 'config.json');
    writeFileSync(p, JSON.stringify({ declaredPlans: [{ provider: 'a', kind: 'token', rateUsd: 1 }] }));
    const issues: ConfigIssue[] = [];
    expect(readDeclaredPlans({}, p, issues)).toHaveLength(1);
    expect(issues).toEqual([]);
  });
});

describe('C2 · .omd/mcp.json', () => {
  test('字段类型不对的条目: 跳过 + issue 点名字段; 好条目照载', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'));
    writeFileSync(
      join(cwd, '.omd', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { command: 'echo', args: ['hi'] },
          bad: { command: 'echo', args: '-y foo' },
        },
      }),
    );
    const issues: ConfigIssue[] = [];
    const cfg = loadMcpClientConfig(cwd, issues);
    expect(cfg.servers.map((s) => s.name)).toEqual(['good']);
    expect(issues.some((i) => i.path === 'mcpServers.bad.args')).toBe(true);
  });

  test('缺 command/url 的条目进 issue (此前只有一条日志)', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'));
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { hollow: {} } }));
    const issues: ConfigIssue[] = [];
    expect(loadMcpClientConfig(cwd, issues).servers).toEqual([]);
    expect(issues.some((i) => i.path === 'mcpServers.hollow')).toBe(true);
  });

  test('反向: 合法配置 issues 为空且 sink 省略时行为同前', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'));
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { s: { url: 'http://x' } } }));
    const issues: ConfigIssue[] = [];
    expect(loadMcpClientConfig(cwd, issues).servers).toHaveLength(1);
    expect(issues).toEqual([]);
    expect(loadMcpClientConfig(cwd).servers).toHaveLength(1);
  });
});

describe('C2 · .omd/extensions.json', () => {
  test('缺 entry 的条目 / 入口文件不存在: 各自 issue 点名; 好条目照收', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'));
    const realEntry = join(cwd, 'ext.js');
    writeFileSync(realEntry, '// entry');
    writeFileSync(
      join(cwd, '.omd', 'extensions.json'),
      JSON.stringify({
        extensions: [
          { name: 'ok', entry: realEntry },
          { name: 'no-entry' },
          { name: 'ghost', entry: join(cwd, 'missing.js') },
        ],
      }),
    );
    const issues: ConfigIssue[] = [];
    const list = readExtensionList(cwd, issues);
    expect(list).toEqual([{ name: 'ok', entry: realEntry }]);
    expect(issues.some((i) => i.path === 'extensions[1].entry')).toBe(true);
    expect(issues.some((i) => i.path === 'extensions[2].entry' && i.message.includes('missing.js'))).toBe(true);
  });

  test('坏 JSON: 不砖 + issue; 反向: 合法清单 issues 为空', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'));
    writeFileSync(join(cwd, '.omd', 'extensions.json'), '[[[');
    const issues: ConfigIssue[] = [];
    expect(readExtensionList(cwd, issues)).toEqual([]);
    expect(issues).toHaveLength(1);

    const entry = join(cwd, 'e.js');
    writeFileSync(entry, '//');
    writeFileSync(join(cwd, '.omd', 'extensions.json'), JSON.stringify({ extensions: [{ name: 'a', entry }] }));
    const clean: ConfigIssue[] = [];
    expect(readExtensionList(cwd, clean)).toHaveLength(1);
    expect(clean).toEqual([]);
  });
});
