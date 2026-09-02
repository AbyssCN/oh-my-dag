/**
 * P3 S2 —— `run_acceptance`: 引擎冻结的验收命令由工具跑, 模型改不了一个字 (D-6 / INV-10 / INV-17)。
 *
 * 证伪方式(每格一条反向):
 *   · 把 `judgeAcceptanceExit` 里 `isBareWholeSuitePytest(command) &&` 那半拿掉 → 「带路径 pytest + exit 2 → red」
 *     与「非 pytest + exit 2 → red」两格当场变 inconclusive(假绿通道打开)即红;
 *   · 把 `runAcceptance` 里的 `sandboxCommand(...)` 包裹摘掉 → INV-17 那格即红;
 *   · 把 `commandBlockReason` 那道闸摘掉 → 「闸拒 → blocked 且 spawn 没被调」即红;
 *   · 把 `delta` 的 `baseline != null` 守卫改成恒写 → 「无基线 → delta 缺席」即红;
 *   · 把 agent-tools 里 `if (opts.acceptance)` 的条件去掉 → 「缺席 getter → 工具不在面上」即红。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeAcceptanceExit, runAcceptance, renderAcceptanceOutcome, type AcceptanceOutcome } from './acceptance-run';
import { createOmdAgentTools, withPipefail, type AnyOmdTool } from './agent-tools';
import { sandboxCommand } from './hooks/shell-sandbox';
import { DEFAULT_COMMAND_ALLOWLIST } from './command-leaf';

const ALLOW = [...DEFAULT_COMMAND_ALLOWLIST, 'pytest', 'python3', 'test'];

/** 记录 spawn 收到什么、按脚本返回退出码。 */
const fakeSpawn = (exitCode: number | null, stdout = '', signal: string | null = null) => {
  const calls: { command: string; cwd: string }[] = [];
  const spawn = async (command: string, cwd: string) => {
    calls.push({ command, cwd });
    return { stdout, stderr: '', exitCode, signal };
  };
  return { spawn, calls };
};

describe('judgeAcceptanceExit —— 三格互斥, inconclusive 只对 bare 整仓 pytest (D-11)', () => {
  test('退出码等于期望 → green', () => {
    expect(judgeAcceptanceExit('pytest -q', 0, 0)).toBe('green');
    expect(judgeAcceptanceExit('bun test', 1, 1)).toBe('green');
  });
  test('★ bare 整仓 pytest + 2/4/5 → inconclusive', () => {
    for (const exit of [2, 4, 5]) {
      expect(judgeAcceptanceExit('pytest -q', exit, 0)).toBe('inconclusive');
      expect(judgeAcceptanceExit('python3 -m pytest -q', exit, 0)).toBe('inconclusive');
    }
  });
  test('★ 带路径 pytest + exit 2 → red (不是「没跑起来」, 是真红)', () => {
    expect(judgeAcceptanceExit('pytest -q tests/test_x.py::test_y', 2, 0)).toBe('red');
    expect(judgeAcceptanceExit('pytest -q tests/test_x.py', 5, 0)).toBe('red');
  });
  test('★ 非 pytest 命令 + exit 2 → red', () => {
    expect(judgeAcceptanceExit('bun test', 2, 0)).toBe('red');
    expect(judgeAcceptanceExit('bun test', 5, 0)).toBe('red');
  });
  test('bare pytest 但退出码 1 (测试真失败) → red, 不进 inconclusive', () => {
    expect(judgeAcceptanceExit('pytest -q', 1, 0)).toBe('red');
  });
  test('信号死 (null) → red', () => {
    expect(judgeAcceptanceExit('pytest -q', null, 0)).toBe('red');
  });
});

describe('runAcceptance —— 跑的是冻结原文, 闸链与沙箱同源', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-acc-'));

  test('★ spawn 收到的命令 = withPipefail(冻结原文), 一个字不多不少', async () => {
    const { spawn, calls } = fakeSpawn(0, 'ok');
    const out = await runAcceptance({ command: 'bun test', expect_exit: 0 }, { cwd, allowlist: ALLOW, spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(withPipefail('bun test'));
    expect(out.kind).toBe('exited');
    if (out.kind === 'exited') {
      expect(out.verdict).toBe('green');
      expect(out.ran).toBe(withPipefail('bun test'));
      expect(out.command).toBe('bun test');
    }
  });

  test('★ INV-17: sandbox 在场时, 实跑串 === withPipefail(sandboxCommand(冻结原文, {root}))', async () => {
    const { spawn, calls } = fakeSpawn(0);
    await runAcceptance({ command: 'bun test', expect_exit: 0 }, { cwd, allowlist: ALLOW, spawn, sandbox: { root: cwd } });
    expect(calls[0]!.command).toBe(withPipefail(sandboxCommand('bun test', { root: cwd })));
  });

  test('★ bare 整仓 pytest + exit 5 → inconclusive, 判词含退出码', async () => {
    const { spawn } = fakeSpawn(5, 'no tests ran');
    const out = await runAcceptance({ command: 'pytest -q', expect_exit: 0 }, { cwd, allowlist: ALLOW, spawn });
    expect(out.kind).toBe('exited');
    if (out.kind === 'exited') {
      expect(out.verdict).toBe('inconclusive');
      expect(out.why).toContain('5');
      expect(renderAcceptanceOutcome(out)).toContain('INCONCLUSIVE');
    }
  });

  test('★ 闸拒 (危险命令 / 首词不在白名单) → blocked, spawn 没被调, delta 缺席', async () => {
    const { spawn, calls } = fakeSpawn(0);
    const dangerous = await runAcceptance({ command: 'rm -rf /', expect_exit: 0 }, { cwd, allowlist: ALLOW, spawn, baseline: [] });
    expect(dangerous.kind).toBe('blocked');
    const notAllowed = await runAcceptance({ command: 'curl http://x', expect_exit: 0 }, { cwd, allowlist: ALLOW, spawn, baseline: [] });
    expect(notAllowed.kind).toBe('blocked');
    if (notAllowed.kind === 'blocked') expect(notAllowed.reason).toContain('not-allowed');
    expect(calls).toHaveLength(0);
    expect('delta' in dangerous).toBe(false);
  });

  test('★ 失败集 delta: 有基线才有, new / fixed 两列; 无基线 → delta 缺席 (不写空数组冒充零变化)', async () => {
    const out1 = await runAcceptance({ command: 'bun test', expect_exit: 0 }, { cwd, allowlist: ALLOW, spawn: fakeSpawn(1, '(fail) a > x\n(fail) b > y\n').spawn });
    expect(out1.kind).toBe('exited');
    if (out1.kind !== 'exited') return;
    expect(out1.failSet).toEqual(['a > x', 'b > y']);
    expect(out1.delta).toBeUndefined();
    const out2 = await runAcceptance(
      { command: 'bun test', expect_exit: 0 },
      { cwd, allowlist: ALLOW, spawn: fakeSpawn(1, '(fail) b > y\n(fail) c > z\n').spawn, baseline: out1.failSet },
    );
    expect(out2.kind).toBe('exited');
    if (out2.kind !== 'exited') return;
    expect(out2.delta).toEqual({ new: ['c > z'], fixed: ['a > x'] });
    expect(renderAcceptanceOutcome(out2)).toContain('新增失败 1 · 修掉 1');
  });

  test('信号死 → exitCode null, verdict red', async () => {
    const { spawn } = fakeSpawn(null, '', 'SIGKILL');
    const out = await runAcceptance({ command: 'bun test', expect_exit: 0 }, { cwd, allowlist: ALLOW, spawn });
    expect(out.kind === 'exited' && out.exitCode === null && out.verdict === 'red').toBe(true);
  });
});

describe('工具面 —— run_acceptance 只在给了 getter 时挂; schema 无 command (D-6)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omd-acc-tool-'));
  const names = (tools: AnyOmdTool[]) => tools.map((t) => t.name);

  test('★ 缺席 getter → 工具不在面上 (不静默 no-op); bash 面不变', () => {
    const tools = createOmdAgentTools({ cwd });
    expect(names(tools)).not.toContain('run_acceptance');
    expect(names(tools)).toContain('bash');
  });

  test('★ 给了 getter → 在面上, 参数面没有 command; 调用走 getter 的执行体', async () => {
    const outcome: AcceptanceOutcome = { kind: 'exited', verdict: 'green', command: 'bun test', ran: 'bun test', exitCode: 0, expectExit: 0, tail: 'ok', failSet: [] };
    let calls = 0;
    const tools = createOmdAgentTools({ cwd, acceptance: () => async () => { calls++; return { text: 'GREEN', outcome }; } });
    const tool = tools.find((t) => t.name === 'run_acceptance')!;
    expect(tool).toBeDefined();
    const props = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).not.toContain('command');
    const r = (await tool.execute('c1', {} as never, undefined, undefined)) as { content: { type: string; text?: string }[]; details: { verdict: string } };
    expect(calls).toBe(1);
    expect(r.content[0]!.text).toBe('GREEN');
    expect(r.details.verdict).toBe('green');
  });

  test('getter 返 undefined (本次没派判据) → 调用即拒, 错误说明原因', async () => {
    const tools = createOmdAgentTools({ cwd, acceptance: () => undefined });
    const tool = tools.find((t) => t.name === 'run_acceptance')!;
    await expect(tool.execute('c1', {} as never, undefined, undefined)).rejects.toThrow(/没有 self_check/);
  });
});
