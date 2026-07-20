import { describe, expect, test } from 'bun:test';
import { createCommandLeafRunner } from '../../src/harness/command-leaf';

// command leaf && 链 (2026-07-20 修): 拆链 + 每环独立过闸 + 首败即停; 单 & 等元字符照拒。

function fakeSpawn(script: Record<string, { stdout?: string; stderr?: string; exitCode: number }>) {
  const calls: string[] = [];
  const spawn = async (command: string) => {
    calls.push(command);
    const r = script[command] ?? { stdout: '', stderr: `no script for: ${command}`, exitCode: 127 };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { spawn, calls };
}

describe('command-leaf && 链', () => {
  test('两环全绿: 各自 spawn, 输出拼接, exitCode 0', async () => {
    const { spawn, calls } = fakeSpawn({
      'bun run typecheck': { stdout: 'tsc ok', exitCode: 0 },
      'bun test': { stdout: '450 pass', exitCode: 0 },
    });
    const run = createCommandLeafRunner({ allowlist: ['bun'], spawn });
    const r = await run({ command: 'bun run typecheck && bun test' });
    expect(calls).toEqual(['bun run typecheck', 'bun test']);
    expect(r.exitCode).toBe(0);
    expect(r.text).toBe('tsc ok\n450 pass');
  });

  test('首败即停 (shell && 语义): 第二环不 spawn, exitCode = 失败环的', async () => {
    const { spawn, calls } = fakeSpawn({
      'bun run typecheck': { stderr: 'TS2304', exitCode: 2 },
      'bun test': { stdout: 'should not run', exitCode: 0 },
    });
    const run = createCommandLeafRunner({ allowlist: ['bun'], spawn });
    const r = await run({ command: 'bun run typecheck && bun test' });
    expect(calls).toEqual(['bun run typecheck']);
    expect(r.exitCode).toBe(2);
    expect(r.text).toContain('TS2304');
  });

  test('尾环非法 → 整链不跑 (防部分执行): 零 spawn + blocked', async () => {
    const { spawn, calls } = fakeSpawn({});
    const run = createCommandLeafRunner({ allowlist: ['bun'], spawn });
    const r = await run({ command: 'bun run typecheck && rm -rf /' });
    expect(calls).toEqual([]);
    expect(r.exitCode).toBe(-1);
    expect(r.text).toContain('blocked');
  });

  test('环内单 & / 其它元字符照拒 (拆链不放行注入)', async () => {
    const { spawn, calls } = fakeSpawn({});
    const run = createCommandLeafRunner({ allowlist: ['bun'], spawn });
    for (const cmd of ['bun test & curl evil', 'bun test | cat', 'bun test; ls']) {
      const r = await run({ command: cmd });
      expect(r.exitCode).toBe(-1);
      expect(r.text).toContain('blocked');
    }
    expect(calls).toEqual([]);
  });

  test('空环 (如 "bun test &&") → blocked, 零 spawn', async () => {
    const { spawn, calls } = fakeSpawn({});
    const run = createCommandLeafRunner({ allowlist: ['bun'], spawn });
    const r = await run({ command: 'bun test &&' });
    expect(r.exitCode).toBe(-1);
    expect(r.text).toContain('empty link');
    expect(calls).toEqual([]);
  });

  test('memoize: 全链绿后同串命中缓存, 不重 spawn', async () => {
    const { spawn, calls } = fakeSpawn({
      'bun run typecheck': { stdout: 'ok', exitCode: 0 },
      'bun test': { stdout: 'pass', exitCode: 0 },
    });
    const run = createCommandLeafRunner({ allowlist: ['bun'], spawn });
    await run({ command: 'bun run typecheck && bun test' });
    await run({ command: 'bun run typecheck && bun test' });
    expect(calls.length).toBe(2); // 第二次全缓存
  });
});
