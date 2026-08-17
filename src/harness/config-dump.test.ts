/**
 * C3 判据:
 *  ① 取样相等 —— dump 打印的值与运行时解析函数直接调用的结果逐项相等 (dump 不新算)。
 *  ② 未配置项显式印 (default), 不省略。
 *  ③ C2 issues 汇总节: 坏配置源逐条亮出; 干净时明说无。
 * 隔离: OMD_CONFIG_PATH / PI_AGENT_DIR 全指进 tmp, 不碰真仓与 ~/.pi (D-S3-9 同精神)。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpClientConfig } from '../mcp/client/config';
import { tryResolveSeatModel } from '../model/role-models';
import { renderConfigDump } from './config-dump';

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-dump-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 隔离 env: 配置路径与凭证目录全进 tmp, 无任何 provider key。 */
function isolatedEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { OMD_CONFIG_PATH: join(cwd, 'no-such-config.json'), PI_AGENT_DIR: join(cwd, 'no-such-pi'), ...extra };
}

describe('omd config dump (renderConfigDump)', () => {
  test('② 全未配: 座位逐行 (default), providers 明说零', () => {
    const cwd = tmp();
    const text = renderConfigDump({ cwd, env: isolatedEnv(cwd), seatConfigPath: join(cwd, 'absent.json') });
    expect(text).toContain('(default: 未配');
    expect(text).toContain('零 provider');
    expect(text).toContain('(default) 无注册');
    expect(text).toContain('(default) 无扩展');
  });

  test('① 取样相等: env 配的座位坐标, dump 行 = tryResolveSeatModel 直接解析', () => {
    const cwd = tmp();
    const env = isolatedEnv(cwd, { OMD_CONDUCTOR_MODEL: 'probe:model-x' });
    const configPath = join(cwd, 'absent.json');
    const direct = tryResolveSeatModel('conductor', { env, configPath });
    expect(direct?.model).toBe('probe:model-x');
    const line = renderConfigDump({ cwd, env, seatConfigPath: configPath })
      .split('\n')
      .find((l) => l.trimStart().startsWith('conductor'));
    expect(line).toContain(direct!.model);
    expect(line).toContain(`[${direct!.via}]`);
  });

  test('① 取样相等: mcp 节 = loadMcpClientConfig 直接读', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'));
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { probe: { url: 'http://x' } } }));
    const direct = loadMcpClientConfig(cwd);
    expect(direct.servers).toHaveLength(1);
    const text = renderConfigDump({ cwd, env: isolatedEnv(cwd) });
    const s = direct.servers[0]!;
    expect(text).toContain(`${s.name.padEnd(16)} [${s.kind}] connect=${s.connectTimeoutMs}ms call=${s.callTimeoutMs}ms`);
  });

  test('③ issues 汇总: 坏 mcp 条目被点名; 干净配置明说无', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.omd'));
    writeFileSync(join(cwd, '.omd', 'mcp.json'), JSON.stringify({ mcpServers: { bad: { args: 42 } } }));
    const dirty = renderConfigDump({ cwd, env: isolatedEnv(cwd) });
    expect(dirty).toContain('[issues]');
    expect(dirty).toContain('mcpServers.bad');

    const clean = tmp();
    expect(renderConfigDump({ cwd: clean, env: isolatedEnv(clean) })).toContain('[issues] 无');
  });
});
