/**
 * src/harness/cli-solve.test.ts —— E1a `omd solve` 编排单测 (GWT-1..GWT-6)。
 *
 * 编排函数 = `runSolveCLI(args, deps?)`,测试**只**走 deps 注入替身:
 *   · `deps.spawn` 替 Bun.spawn (GWT-1 / GWT-2 抓 cmd 形参,GWT-3..GWT-5 模拟写 resultOut)
 *   · 真实文件系统仅用于 resultOut 路径本身 (mkdtempSync 临时仓,afterEach 清理)
 * 不依赖真实 worker / 真实 model / 真实网络 —— 编排函数本来就**不**直接起 worker。
 *
 * 对应契约:
 *   · INV-1 零第二套语义 (cli-solve 不 import 任何 engine/goal 内部件)
 *   · INV-2 参数透传保真 (D-3 flags 逐一进 worker 实参)
 *   · INV-3 退出码机械映射 (resultOut outcome → 0/2/3)
 *   · INV-4 缺参响亮 (零 spawn 退出非零)
 *   · INV-5 既有 CLI 面零回归 (由其它 cli*.test.ts 兜底;此处只盯 solve 分支)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseSolveArgs,
  readOutcomeKind,
  runSolveCLI,
  solveWorkerScriptPath,
  type SolveSpawn,
  type SolveSpawnHandle,
  type SolveSpawnOpts,
} from './cli-solve';

let dirs: string[] = [];
let stderrSnap: string[] = [];
let origStderrWrite: typeof process.stderr.write;
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'omd-solve-'));
  dirs.push(d);
  return d;
}
function snapStderr(): string {
  return stderrSnap.join('');
}
beforeEach(() => {
  stderrSnap = [];
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderrSnap.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return (origStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = origStderrWrite;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 写 resultOut 文件 (fake spawn 内部用,模拟 worker 终局产物)。 */
function writeResultOut(resultOutPath: string, outcome: string): void {
  writeFileSync(resultOutPath, `outcome: ${outcome}\nrunId: r-test\nacceptance: executable\n`);
}

/** 通用 fake spawn 工厂:记 cmd+opts + 写 resultOut + 返回 exited。 */
interface FakeSpawnCapture {
  cmd: string[];
  opts: SolveSpawnOpts;
  calls: number;
}
function makeFakeSpawn(resultOut: string, outcome: string | 'skip'): SolveSpawn & { capture: FakeSpawnCapture } {
  const capture: FakeSpawnCapture = { cmd: [], opts: { cwd: '', stdio: ['inherit', 'inherit', 'inherit'] }, calls: 0 };
  const fn = ((cmd: string[], opts: SolveSpawnOpts): SolveSpawnHandle => {
    capture.cmd = cmd;
    capture.opts = opts;
    capture.calls += 1;
    if (outcome !== 'skip') writeResultOut(resultOut, outcome);
    return { exited: Promise.resolve(0) };
  }) as SolveSpawn & { capture: FakeSpawnCapture };
  fn.capture = capture;
  return fn;
}

describe('cli-solve: INV-1 零第二套语义 (GWT-1)', () => {
  test('GWT-1 编排调 spawn,cmd 含 goal-worker 路径且 stdio inherit / 非 detached', async () => {
    const cwd = tmp();
    const resultOut = join(cwd, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    const fake = makeFakeSpawn(resultOut, 'success');
    const code = await runSolveCLI(['probe-goal', '--cwd', cwd, '--result-out', resultOut], { spawn: fake });
    expect(code).toBe(0);
    expect(fake.capture.calls).toBe(1);
    // cmd[0..1] = ['bun','run'],cmd[2] = worker 脚本路径;逐段断言
    expect(fake.capture.cmd[0]).toBe('bun');
    expect(fake.capture.cmd[1]).toBe('run');
    expect(fake.capture.cmd[2]).toBe(solveWorkerScriptPath());
    expect(fake.capture.cmd[2]!.endsWith('scripts/goal-worker.ts')).toBe(true);
    // stdio 三件套 inherit (D-5 零 TTY 探测);Bun.spawn 的 'inherit' 与 'ignore' 都不在 opts 上,
    // 而是构造时硬编码进 defaultSolveSpawn —— 测试这里只校验**注入替身**收到的 opts 形状。
    expect(fake.capture.opts.stdio).toEqual(['inherit', 'inherit', 'inherit']);
    expect(fake.capture.opts.cwd).toBe(cwd);
  });

  test('worker 路径解析:与 src/mcp/tools/goal.ts:135 同款,按包位置走 import.meta.dir', () => {
    const p = solveWorkerScriptPath();
    // cli-solve 在 src/harness/,worker 在 scripts/ —— 两条 .. 必够,再多一截会指到仓外。
    // Bun 的 path normalize 会把 `..` 吃掉,所以断言终态 = 仓根 scripts/goal-worker.ts,
    // **且文件确实在那个路径** (相对仓根的存在性)。
    expect(p.endsWith('scripts/goal-worker.ts')).toBe(true);
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe('cli-solve: INV-2 参数透传保真 (GWT-2)', () => {
  test('GWT-2 全套 flags 一一进 worker 实参,不改名不改值', async () => {
    const cwd = tmp();
    const resultOut = join(cwd, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    const fake = makeFakeSpawn(resultOut, 'success');
    const args = [
      'do-the-thing', // goal = 位置参 (D-3)
      '--cwd', cwd,
      '--sdd', '/tmp/sdd.md',
      '--tier', 'complex',
      '--max-rounds', '3',
      '--budget-minutes', '45',
      '--budget-tokens', '9000',
      '--result-out', resultOut,
    ];
    const code = await runSolveCLI(args, { spawn: fake });
    expect(code).toBe(0);
    // 各 flag 出现一次,值跟在后面;顺序按 parse → build cmd 序
    const pairs: [string, string][] = [];
    for (let i = 0; i < fake.capture.cmd.length; i += 1) {
      if (fake.capture.cmd[i]!.startsWith('--')) pairs.push([fake.capture.cmd[i]!, fake.capture.cmd[i + 1] ?? '']);
    }
    const map = new Map(pairs);
    expect(map.get('--cwd')).toBe(cwd);
    expect(map.get('--goal')).toBe('do-the-thing');
    expect(map.get('--sdd-path')).toBe('/tmp/sdd.md'); // CLI 是 --sdd,worker 是 --sdd-path
    expect(map.get('--tier')).toBe('complex');
    expect(map.get('--max-rounds')).toBe('3');
    expect(map.get('--budget-minutes')).toBe('45');
    expect(map.get('--budget-tokens')).toBe('9000');
    expect(map.get('--result-out')).toBe(resultOut);
    expect(map.get('--run-id')).toBeDefined(); // runId 必生成 (UUID)
  });
});

describe('cli-solve: INV-3 退出码机械映射 (GWT-3 / GWT-4 / GWT-5)', () => {
  test('GWT-3 outcome=success → 退出码 0', async () => {
    const cwd = tmp();
    const resultOut = join(cwd, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    const fake = makeFakeSpawn(resultOut, 'success');
    const code = await runSolveCLI(['probe', '--cwd', cwd, '--result-out', resultOut], { spawn: fake });
    expect(code).toBe(0);
    expect(snapStderr()).toContain('outcome=success');
    expect(snapStderr()).toContain(resultOut);
  });

  test('GWT-4 outcome=delivered-with-red → 0;outcome=not-converged → 2', async () => {
    const cwd1 = tmp();
    const resultOut1 = join(cwd1, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut1), { recursive: true });
    const fake1 = makeFakeSpawn(resultOut1, 'delivered-with-red');
    expect(await runSolveCLI(['p', '--cwd', cwd1, '--result-out', resultOut1], { spawn: fake1 })).toBe(0);

    const cwd2 = tmp();
    const resultOut2 = join(cwd2, '.omd', 'solve-results', 't.md');
    mkdirSync(dirname(resultOut2), { recursive: true });
    const fake2 = makeFakeSpawn(resultOut2, 'not-converged');
    expect(await runSolveCLI(['p', '--cwd', cwd2, '--result-out', resultOut2], { spawn: fake2 })).toBe(2);
  });

  test('GWT-5 worker 退出但 resultOut 缺失 → 退出码 3 且 stderr 含 resultOut 路径', async () => {
    const cwd = tmp();
    const resultOut = join(cwd, '.omd', 'solve-results', 'missing.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    // outcome='skip' → fake 不写 resultOut,模拟 worker 起不来 / 写穿前死
    const fake = makeFakeSpawn(resultOut, 'skip');
    const code = await runSolveCLI(['p', '--cwd', cwd, '--result-out', resultOut], { spawn: fake });
    expect(code).toBe(3);
    const snap = snapStderr();
    expect(snap).toContain(resultOut);
    expect(snap).toContain('缺失');
  });

  test('GWT-5b resultOut 存在但首行无 outcome → 退出码 3', async () => {
    const cwd = tmp();
    const resultOut = join(cwd, '.omd', 'solve-results', 'no-header.md');
    mkdirSync(dirname(resultOut), { recursive: true });
    writeFileSync(resultOut, 'some random log\nno outcome header here\n');
    const fake = makeFakeSpawn(resultOut, 'skip');
    const code = await runSolveCLI(['p', '--cwd', cwd, '--result-out', resultOut], { spawn: fake });
    expect(code).toBe(3);
  });
});

describe('cli-solve: INV-4 缺参响亮 (GWT-6)', () => {
  test('GWT-6 空参 → fake spawn 零调用且退出码非零 (1)', async () => {
    const fake = makeFakeSpawn('/tmp/never.md', 'skip');
    const code = await runSolveCLI([], { spawn: fake });
    expect(code).not.toBe(0);
    expect(fake.capture.calls).toBe(0);
    const snap = snapStderr();
    expect(snap).toContain('omd solve:');
    expect(snap).toContain('goal 与 --sdd');
  });

  test('--tier 非法值 → usage 退出非零 + 零 spawn', async () => {
    const fake = makeFakeSpawn('/tmp/never.md', 'skip');
    const code = await runSolveCLI(['probe', '--tier', 'weird'], { spawn: fake });
    expect(code).not.toBe(0);
    expect(fake.capture.calls).toBe(0);
    expect(snapStderr()).toContain('--tier 必须是 simple 或 complex');
  });
});

describe('parseSolveArgs 纯函数', () => {
  test('缺 goal 与 --sdd → usageError,无 spawn 风险', () => {
    const r = parseSolveArgs([], '/cwd');
    expect(r.usageError).toBeDefined();
    expect(r.cwd).toBe('/cwd');
    expect(r.resultOut).toMatch(/^\/cwd\/\.omd\/solve-results\/.+\.md$/);
  });

  test('goal + cwd + result-out + tier + 预算旗 → 全部解析', () => {
    const r = parseSolveArgs(
      ['my-goal', '--cwd', '/w', '--result-out', '/w/out.md', '--tier', 'simple', '--max-rounds', '2', '--budget-tokens', '100'],
      '/default',
    );
    expect(r.goal).toBe('my-goal');
    expect(r.cwd).toBe('/w');
    expect(r.resultOut).toBe('/w/out.md');
    expect(r.tier).toBe('simple');
    expect(r.maxRounds).toBe(2);
    expect(r.budgetTokens).toBe(100);
    expect(r.budgetMinutes).toBeUndefined();
    expect(r.usageError).toBeUndefined();
  });

  test('--sdd 单独可起 run (二选一至少其一)', () => {
    const r = parseSolveArgs(['--sdd', '/plan.md'], '/w');
    expect(r.sdd).toBe('/plan.md');
    expect(r.goal).toBeUndefined();
    expect(r.usageError).toBeUndefined();
  });
});

describe('readOutcomeKind 解析 resultOut 首部', () => {
  test('文件不存在 → undefined', () => {
    expect(readOutcomeKind('/no/such/path.md')).toBeUndefined();
  });

  test('首行 outcome: <kind> → 命中', () => {
    const f = join(tmp(), 'r.md');
    writeFileSync(f, 'outcome: success\nrunId: x\n');
    expect(readOutcomeKind(f)).toBe('success');
  });

  test('首行非 outcome → undefined', () => {
    const f = join(tmp(), 'r.md');
    writeFileSync(f, 'log line\noutcome: success\n');
    expect(readOutcomeKind(f)).toBeUndefined();
  });
});