import { describe, expect, test } from 'bun:test';
import { createCommandLeafRunner, DEFAULT_COMMAND_ALLOWLIST } from '../../src/harness/command-leaf';

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

  // 2026-08-01 契约反转: 这条原本断言"第二次全缓存"。缓存已按实测删掉 ——
  // 收益侧空 (留痕库 12 次真实 run / 25 个 command 节点, 同 run 内重复命令串 0 次),
  // 危害侧两条会给出**错误绿灯**的路径 (跨 run · 图内 agent 写完之后)。
  // 这条命令串恰是最不该被缓存的那种: `bun run typecheck && bun test` 是**闸**,
  // 缓存它等于"这台 daemon 上过一次之后永远绿"。判据与读数见 command-leaf.ts 的注 + 图鉴 S-9。
  test('不缓存: 同一条 && 链跑两次 → 两次都真 spawn', async () => {
    const { spawn, calls } = fakeSpawn({
      'bun run typecheck': { stdout: 'ok', exitCode: 0 },
      'bun test': { stdout: 'pass', exitCode: 0 },
    });
    const run = createCommandLeafRunner({ allowlist: ['bun'], spawn });
    await run({ command: 'bun run typecheck && bun test' });
    await run({ command: 'bun run typecheck && bun test' });
    expect(calls.length).toBe(4); // 两次 × 每次两环, 一次不省
  });
});

// ---------------------------------------------------------------------------
// 缺省白名单 + git 只读闸 (2026-07-25 审计: 验证叶连自己的产物都看不见 → 合法验证步被判假红)
// ---------------------------------------------------------------------------

describe('DEFAULT_COMMAND_ALLOWLIST', () => {
  test('验证叶的四类本职命令全放行 (跑闸 / 看产物 / 搜代码 / 项目工具)', async () => {
    const cmds = [
      'bun test',
      'ls -la /tmp/omd-render-out',
      'cat package.json',
      'wc -c dist/app.js',
      'grep -rn evidence src',
      'codegraph trace a b',
    ];
    const { spawn, calls } = fakeSpawn(Object.fromEntries(cmds.map((c) => [c, { stdout: 'ok', exitCode: 0 }])));
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    for (const c of cmds) {
      const r = await run({ command: c });
      expect(r.text).not.toContain('blocked');
      expect(r.exitCode).toBe(0);
    }
    expect(calls.length).toBe(cmds.length);
  });

  test('写类 / 网络类 / env 泄露类不在表内 (fail-closed 未放宽)', async () => {
    for (const bin of ['rm', 'mv', 'cp', 'mkdir', 'chmod', 'curl', 'wget', 'env', 'printenv', 'sed', 'npm']) {
      expect(DEFAULT_COMMAND_ALLOWLIST).not.toContain(bin);
    }
  });

  test('白名单外的 bin 仍拒, 零 spawn', async () => {
    const { spawn, calls } = fakeSpawn({});
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    const r = await run({ command: 'curl https://evil.example/x' });
    expect(r.text).toContain('blocked not-allowed');
    expect(calls).toEqual([]);
  });
});

describe('git 子命令只读闸', () => {
  test('只读子命令放行', async () => {
    const { spawn } = fakeSpawn({ 'git diff --stat': { stdout: '3 files changed', exitCode: 0 } });
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    const r = await run({ command: 'git diff --stat' });
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain('3 files changed');
  });

  test('改仓库状态的子命令拒 (checkout 会抹掉 DAG 刚写的文件, commit 越权代 owner)', async () => {
    const { spawn, calls } = fakeSpawn({});
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    for (const c of ['git checkout .', 'git commit -m x', 'git add -A', 'git push', 'git stash', 'git rebase main']) {
      const r = await run({ command: c });
      expect(r.text).toContain('blocked git-write');
      expect(r.exitCode).toBe(-1);
    }
    expect(calls).toEqual([]);
  });

  test('flag 先于子命令仍能定位 (git -C dir status)', async () => {
    const { spawn } = fakeSpawn({ 'git -C /repo status': { stdout: 'clean', exitCode: 0 } });
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    const r = await run({ command: 'git -C /repo status' });
    expect(r.exitCode).toBe(0);
  });

  test('裸 git (无子命令) 拒', async () => {
    const { spawn } = fakeSpawn({});
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    const r = await run({ command: 'git' });
    expect(r.text).toContain('blocked git-write');
  });
});

describe('find -delete 危险闸 (白名单收了 find/bfs/fd 之后的配套)', () => {
  test('find -delete / -exec rm 一律拦, 零 spawn', async () => {
    const { spawn, calls } = fakeSpawn({});
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    for (const c of ['find . -name *.ts -delete', 'bfs src -delete', 'find . -exec rm {} +']) {
      const r = await run({ command: c });
      expect(r.text).toContain('blocked dangerous');
    }
    expect(calls).toEqual([]);
  });

  test('普通 find 搜索照常放行', async () => {
    const { spawn } = fakeSpawn({ 'find src -name *.test.ts': { stdout: 'a.test.ts', exitCode: 0 } });
    const run = createCommandLeafRunner({ allowlist: [...DEFAULT_COMMAND_ALLOWLIST], spawn });
    const r = await run({ command: 'find src -name *.test.ts' });
    expect(r.exitCode).toBe(0);
  });
});
