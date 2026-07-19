/**
 * scripts/dag-deepen CLI 测试 —— --help 干净环境 (env -i 等价: 空 env) 下 exit 0 出 usage,
 * 不触模型不触 git。子进程真跑脚本 (契约面是 CLI, 不是内部函数)。
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

describe('dag-deepen CLI', () => {
  test('--help: 空环境下 exit 0 + stdout 出 usage', () => {
    const proc = Bun.spawnSync([process.execPath, 'scripts/dag-deepen.ts', '--help'], {
      cwd: REPO_ROOT,
      env: {}, // env -i 等价: 无 API key / 无 HOME 派生变量也不许崩
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    expect(out).toContain('usage:');
    expect(out).toContain('dag-deepen');
    expect(out).toContain('--commits');
    expect(out).toContain('--hotspots');
  });

  test('坏数字旗标 fail-fast (exit 1 + 明确报错, 防 NaN 透传)', () => {
    const proc = Bun.spawnSync([process.execPath, 'scripts/dag-deepen.ts', '--commits', 'abc'], {
      cwd: REPO_ROOT,
      env: {},
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain('--commits');
  });
});
