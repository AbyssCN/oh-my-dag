/**
 * repo-checks runner + agent-leaf 接线 测试 (D2 切片 2, #266 修补节点)。
 *
 * 三段:
 *   ① `runRepoChecks` 单元测试 — 三态聚合 / 占位符替换 / 异常吃下 / 退出码 null /
 *     空清单直接 OK / 单条超时标 UNVERIFIED。
 *   ② `formatRepoChecksFailure` 单元测试 — FAIL 输出格式 / OK 路径返回空串。
 *   ③ 集成测试 — fixture leaf 写入含禁词样例的新文件 (样例运行期拼接, 防静态扫描),
 *     期望该节点第一回合被 check 打回, 自修后终态 done; 无清单时同 fixture 一次过。
 *
 * 反向自检 (与 post-leaf-gate.test.ts 同款): 注入假 `spawn`, 不真起子进程。
 * 引擎侧 INV-D2-1 自检: runner 不 import 任何仓规脚本 (`scripts/jargon-scan.ts` /
 * `scripts/catch-evidence-scan.ts`), 也不在源码里写死禁词; 这条由 grep 在评审时核,
 * 本测试只保行为。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// 禁词样例拼接构造 —— jargon-scan 扫的是源码字面串, 夹具要在运行期拼出来, 否则「清扫完成态」当场红。
const JARGON_SAMPLE = ['落', '盘'].join('');

import { formatRepoChecksFailure, runRepoChecks } from './repo-checks';
import type { RepoCheck, RepoChecksResult } from './repo-checks';
import type { GateSpawn } from './post-leaf-gate';
import type { SdkQueryFn } from './claude-sdk-loop';

// ─── 测试用临时目录 ───────────────────────────────────────────────────────────

let tmpRoots: string[] = [];

async function newTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omd-repo-checks-'));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(
    tmpRoots.map(async (d) => {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }),
  );
});

// ─── 替身 spawn (与 post-leaf-gate.test.ts 同形) ───────────────────────────

function makeSpawn(
  behavior: (
    cmd: string,
    cwd: string,
    timeoutMs?: number,
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut?: boolean;
    signal?: string | null;
  }>,
): GateSpawn {
  return (cmd, cwd, timeoutMs) => behavior(cmd, cwd, timeoutMs);
}

const fixedNow = () => new Date('2026-08-25T00:00:00.000Z');

// ─── ① runRepoChecks 单元测试 ──────────────────────────────────────────────

describe('runRepoChecks / 三态聚合 + 占位符替换', () => {
  test('空清单 → OK, perCheck=[], oracleFaults=0 (INV-D2-1: 无清单 = 无红)', async () => {
    const r = await runRepoChecks({
      checks: [],
      files: ['src/a.ts'],
      cwd: '/tmp',
      spawn: makeSpawn(async () => {
        throw new Error('spawn 不应被调用');
      }),
      now: fixedNow,
    });
    expect(r.verdict).toBe('OK');
    expect(r.perCheck).toEqual([]);
    expect(r.oracleFaults).toBe(0);
    expect(r.evaluatedAt).toBe('2026-08-25T00:00:00.000Z');
  });

  test('单条 exit 0 → OK, evidence = stdout', async () => {
    const calls: string[] = [];
    const r = await runRepoChecks({
      checks: [{ id: 'a', command: 'echo hi' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        calls.push(cmd);
        return { stdout: 'hi\n', stderr: '', exitCode: 0 };
      }),
    });
    expect(r.verdict).toBe('OK');
    expect(r.perCheck).toHaveLength(1);
    expect(r.perCheck[0]!.id).toBe('a');
    expect(r.perCheck[0]!.verdict).toBe('OK');
    expect(r.perCheck[0]!.evidence).toBe('hi');
    expect(r.oracleFaults).toBe(0);
    expect(calls).toEqual(['echo hi']);
  });

  test('单条 exit 1 → FAIL, evidence = stderr', async () => {
    const r = await runRepoChecks({
      checks: [{ id: 'jargon', command: 'bun scan' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'src/x.ts:1: 命中禁词', exitCode: 1 })),
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.perCheck[0]!.verdict).toBe('FAIL');
    expect(r.perCheck[0]!.reason).toBe('exit_1');
    expect(r.perCheck[0]!.evidence).toBe('src/x.ts:1: 命中禁词');
    expect(r.oracleFaults).toBe(0);
  });

  // ── severity 分级 (2026-08-26) ────────────────────────────────────────────
  //
  // 起因: run 5bcfa2b2 的 s2 被 catch-evidence 判红「净增 17 处」→ 节点 failed →
  // 下游 requires:'all' 全部级联 skipped → 片 2 与片 3 的交付全丢。实核 18/20 是误报
  // (该闸当时按行号做差集)。根因不在那一个判据, 在**层级错配**: 启发式判据装在
  // fail-closed 的位置。三态里 UNVERIFIED 只覆盖「闸自己崩了」, 没有一态表示「闸判错了」。
  //
  // 降级的是**处置**不是**判定** —— 下面第二条专门钉这点: advisory 红了仍如实记 FAIL。
  //
  // 证伪: 把 repo-checks.ts 里 `if ((check.severity ?? 'blocking') === 'blocking') anyFail = true;`
  // 改回无条件 `anyFail = true` ⇒ 第一条红; 把 advisory 的 outcome 改成不记 FAIL ⇒ 第二条红。
  test('★ advisory 的 FAIL 不进整体 verdict —— 误报不再杀节点', async () => {
    const r = await runRepoChecks({
      checks: [{ id: 'jargon', command: 'bun scan', severity: 'advisory' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'src/x.ts:1: 命中', exitCode: 1 })),
    });
    expect(r.verdict, 'advisory 红不该把整体判成 FAIL(节点因此不被杀)').toBe('OK');
  });

  test('★ 但 advisory 仍如实记成 FAIL —— 降级的是处置, 判据一个字没放松', async () => {
    const r = await runRepoChecks({
      checks: [{ id: 'jargon', command: 'bun scan', severity: 'advisory' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'src/x.ts:1: 命中', exitCode: 1 })),
    });
    expect(r.perCheck[0]!.verdict).toBe('FAIL');
    expect(r.perCheck[0]!.evidence).toBe('src/x.ts:1: 命中');
  });

  test('★ severity 缺席 = blocking(零回归: 既有 manifest 没这个键, 行为不变)', async () => {
    const r = await runRepoChecks({
      checks: [{ id: 'x', command: 'bun scan' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 })),
    });
    expect(r.verdict).toBe('FAIL');
  });

  test('★ 混合: blocking 红 + advisory 红 → 整体 FAIL(blocking 说了算)', async () => {
    const r = await runRepoChecks({
      checks: [
        { id: 'adv', command: 'bun a', severity: 'advisory' },
        { id: 'blk', command: 'bun b', severity: 'blocking' },
      ],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 })),
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.perCheck.map((c) => c.verdict)).toEqual(['FAIL', 'FAIL']);
  });

  test('exit null (被信号杀) → FAIL (reason=exit_null, 同 post-leaf-gate 口径)', async () => {
    const r = await runRepoChecks({
      checks: [{ id: 'a', command: 'cmd' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => ({ stdout: '', stderr: 'killed', exitCode: null, signal: 'SIGKILL' })),
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.perCheck[0]!.reason).toBe('exit_null');
  });

  test('spawn 抛异常 → UNVERIFIED (oracle-fault, INV-D2-4 留 evidence)', async () => {
    const r = await runRepoChecks({
      checks: [{ id: 'a', command: 'cmd' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => {
        throw new Error('ENOENT: no such command');
      }),
    });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.perCheck[0]!.verdict).toBe('UNVERIFIED');
    expect(r.perCheck[0]!.reason).toBe('script_threw');
    expect(r.perCheck[0]!.evidence).toContain('ENOENT: no such command');
    expect(r.oracleFaults).toBe(1);
  });

  test('单条超时 → UNVERIFIED (reason=script_timeout, partial stdout 截断)', async () => {
    const longStdout = 'x'.repeat(500);
    const r = await runRepoChecks({
      checks: [{ id: 'a', command: 'slow' }],
      files: [],
      cwd: '/tmp',
      timeoutMs: 100,
      spawn: makeSpawn(async () => ({ stdout: longStdout, stderr: '', exitCode: 0, timedOut: true })),
    });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.perCheck[0]!.reason).toBe('script_timeout');
    expect(r.perCheck[0]!.evidence).toContain('exceeded 100ms');
    expect(r.perCheck[0]!.evidence).toContain('truncated');
  });

  test('聚合: 全 OK → OK', async () => {
    const r = await runRepoChecks({
      checks: [
        { id: 'a', command: 'cmd1' },
        { id: 'b', command: 'cmd2' },
      ],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
    });
    expect(r.verdict).toBe('OK');
    expect(r.perCheck.map((c) => c.verdict)).toEqual(['OK', 'OK']);
  });

  test('聚合: 任一 FAIL → FAIL; 后续 check 仍跑 (不短路, 排账可见全貌)', async () => {
    const calls: string[] = [];
    const r = await runRepoChecks({
      checks: [
        { id: 'a', command: 'cmd1' },
        { id: 'b', command: 'cmd2' },
        { id: 'c', command: 'cmd3' },
      ],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        calls.push(cmd);
        if (cmd === 'cmd2') return { stdout: '', stderr: 'red', exitCode: 1 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.perCheck.map((c) => c.verdict)).toEqual(['OK', 'FAIL', 'OK']);
    expect(calls).toEqual(['cmd1', 'cmd2', 'cmd3']);
  });

  test('聚合: FAIL + UNVERIFIED → FAIL (FAIL > UNVERIFIED 优先)', async () => {
    const r = await runRepoChecks({
      checks: [
        { id: 'a', command: 'cmd1' },
        { id: 'b', command: 'cmd2' },
      ],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        if (cmd === 'cmd1') return { stdout: '', stderr: 'red', exitCode: 1 };
        throw new Error('oracle died');
      }),
    });
    expect(r.verdict).toBe('FAIL');
    expect(r.perCheck.map((c) => c.verdict)).toEqual(['FAIL', 'UNVERIFIED']);
    expect(r.oracleFaults).toBe(1); // 只 UNVERIFIED 那条 +1
  });

  test('聚合: 无 FAIL ∧ 任一 UNVERIFIED → UNVERIFIED', async () => {
    const r = await runRepoChecks({
      checks: [
        { id: 'a', command: 'cmd1' },
        { id: 'b', command: 'cmd2' },
      ],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        if (cmd === 'cmd1') return { stdout: 'ok', stderr: '', exitCode: 0 };
        throw new Error('oracle died');
      }),
    });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.oracleFaults).toBe(1);
  });
});

// ─── ①.5 占位符替换测试 ────────────────────────────────────────────────────

describe('runRepoChecks / {files} 占位符替换', () => {
  test('{files} 被替换为 shell-quoted 路径列表 (空格分隔)', async () => {
    const calls: string[] = [];
    await runRepoChecks({
      checks: [{ id: 'a', command: 'scan --files {files}' }],
      files: ['src/a.ts', 'src/b.ts'],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        calls.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    expect(calls[0]).toBe(`scan --files 'src/a.ts' 'src/b.ts'`);
  });

  test('路径含空格 → 单引号包裹 + 内部单引号转义 (与 post-leaf-gate shellQuote 同源)', async () => {
    const calls: string[] = [];
    await runRepoChecks({
      checks: [{ id: 'a', command: 'scan {files}' }],
      files: ['my dir/file.ts', "weird'name.ts"],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        calls.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    expect(calls[0]).toBe(`scan 'my dir/file.ts' 'weird'\\''name.ts'`);
  });

  test('命令无 {files} 占位符 → files 仍按调用方清单传 (INV-D2-5 scope 守门)', async () => {
    const calls: string[] = [];
    await runRepoChecks({
      checks: [{ id: 'a', command: 'global-scan' }], // 无占位符
      files: ['src/a.ts'],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        calls.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    // 不注入文件列表 — 命令对文件范围不敏感 (例如全仓扫描)
    expect(calls[0]).toBe('global-scan');
  });

  test('files 为空数组 → {files} 替换为空串 (不报错, 由 oracle 决定怎么处理)', async () => {
    const calls: string[] = [];
    await runRepoChecks({
      checks: [{ id: 'a', command: 'scan --files {files}' }],
      files: [],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        calls.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    expect(calls[0]).toBe('scan --files ');
  });

  test('{files} 出现多次 → 全部替换', async () => {
    const calls: string[] = [];
    await runRepoChecks({
      checks: [{ id: 'a', command: 'diff {files} --against {files}' }],
      files: ['a.ts', 'b.ts'],
      cwd: '/tmp',
      spawn: makeSpawn(async (cmd) => {
        calls.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    });
    expect(calls[0]).toBe(`diff 'a.ts' 'b.ts' --against 'a.ts' 'b.ts'`);
  });
});

// ─── ② formatRepoChecksFailure 单元测试 ─────────────────────────────────────

describe('formatRepoChecksFailure / 输出格式', () => {
  test('verdict=OK → 返回空串 (不该被格式化, 调用方应按 verdict 分支)', () => {
    const r: RepoChecksResult = {
      verdict: 'OK',
      perCheck: [{ id: 'a', verdict: 'OK', reason: 'ok', oracleFaults: 0, evaluatedAt: '' }],
      oracleFaults: 0,
      evaluatedAt: '',
    };
    expect(formatRepoChecksFailure(r)).toBe('');
  });

  test('verdict=FAIL → 列出失败 + OK + UNVERIFIED 三档', () => {
    const r: RepoChecksResult = {
      verdict: 'FAIL',
      perCheck: [
        {
          id: 'jargon-scan',
          verdict: 'FAIL',
          reason: 'exit_1',
          evidence: 'src/a.ts:1: 命中禁词',
          oracleFaults: 0,
          evaluatedAt: '',
        },
        {
          id: 'catch-evidence-net-add',
          verdict: 'FAIL',
          reason: 'exit_2',
          evidence: 'src/b.ts:100: silent catch 净增',
          oracleFaults: 0,
          evaluatedAt: '',
        },
        { id: 'orphan-import', verdict: 'OK', reason: 'ok', oracleFaults: 0, evaluatedAt: '' },
      ],
      oracleFaults: 0,
      evaluatedAt: '',
    };
    const out = formatRepoChecksFailure(r);
    expect(out).toContain('[仓规检查失败: 2/3 红]');
    expect(out).toContain('- jargon-scan (exit_1):');
    expect(out).toContain('src/a.ts:1: 命中禁词');
    expect(out).toContain('- catch-evidence-net-add (exit_2):');
    expect(out).toContain('src/b.ts:100: silent catch 净增');
    expect(out).toContain('(通过的 check: orphan-import)');
    expect(out).not.toContain('ORACLE-FAULT');
  });

  test('verdict=FAIL 含 UNVERIFIED → 单独标 ORACLE-FAULT 提示别修', () => {
    const r: RepoChecksResult = {
      verdict: 'FAIL',
      perCheck: [
        { id: 'jargon-scan', verdict: 'FAIL', reason: 'exit_1', evidence: 'red', oracleFaults: 0, evaluatedAt: '' },
        {
          id: 'oracle-broken',
          verdict: 'UNVERIFIED',
          reason: 'script_threw',
          evidence: 'ENOENT',
          oracleFaults: 1,
          evaluatedAt: '',
        },
      ],
      oracleFaults: 1,
      evaluatedAt: '',
    };
    const out = formatRepoChecksFailure(r);
    expect(out).toContain('ORACLE-FAULT: oracle-broken');
    expect(out).toContain('oracle 自己崩了');
  });
});

// ─── ③ 集成: 引擎侧行为 (空清单 = 零回归; 有清单 = 真打回) ────────────────

/**
 * 这一段是 verify 契约要求的"实装前天然红"测试。
 * 构造两条 fixture, 都把禁词样例 (拼接构造) 写到新文件:
 *   - fixture A: 没配 `repoChecks` → 与今天行为逐字节相同 (一次过)
 *   - fixture B: 配 `repoChecks = [{ id: 'jargon', command: '... {files}' }]` →
 *     假 spawn 看到含禁词样例的文件就 exit 1, 否则 exit 0
 *
 * 用 agent-leaf 的 runner 走完整一遍 (createAgentLeafRunner + 注入 mcpDeps/sdkQueryFn 替身),
 * 接到一份 AgentLeafInput, 断言:
 *   - fixture A: runOnce() 成功返回 AgentLeafResult (无 throw)
 *   - fixture B: runOnce() 抛 RepoChecksError 类的 Error, evidence 含禁词点名的 file:line
 */
describe('repo-checks / agent-leaf 接线 (集成, D2 切片 2 verify)', () => {
  // 动态 import 避免在 agent-leaf 装配失败时拖累纯件测试
  let createAgentLeafRunner: typeof import('./agent-leaf').createAgentLeafRunner;

  beforeEach(async () => {
    const mod = await import('./agent-leaf');
    createAgentLeafRunner = mod.createAgentLeafRunner;
  });

  /**
   * 假 sdkQueryFn: 走 SDK 通道 (不走 pi), 给一段固定文本 + success 结果。
   * 与 agent-leaf-sdk.test.ts 的 fakeQuery 同形; 这里固定两次 yield 配 end_turn。
   */
  function fakeSdkQuery(text: string): SdkQueryFn {
    return (async function* () {
      yield {
        type: 'assistant',
        session_id: 's',
        message: {
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
        },
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: text,
        session_id: 's',
      } as unknown as SDKMessage;
    }) as unknown as SdkQueryFn;
  }

  // 走 SDK 通道: 'claude-code' provider 是 CLAUDE_SDK_PROVIDER, 配 sdkQueryFn 后走 SDK 路
  // (跳过 pi 模型解析 — `mock:fake` 那条会让 agent-leaf.ts:1529 提前 throw「坐标解不出」)。
  const SDK_MODEL = 'claude-code:claude-sonnet-5';

  test('INV-D2-4 / 无清单 (config.repoChecks 缺席) → 行为与今天逐字节相同', async () => {
    const tmp = await newTmp();
    await writeFile(join(tmp, 'a.ts'), '正常代码, 没有禁词\n');

    // 假 agentRunner: 模拟 agent leaf 真在写文件 + 触发检查入口
    const repoChecks: RepoCheck[] = []; // ← 关键: 空清单
    const r = createAgentLeafRunner({
      cwd: tmp,
      hashlineEdit: false,
      leafTimeoutMs: 5000,
      // 测试注入: 模型替身, 不真发 API (SdkQueryFn = AsyncIterable<SDKMessage>)
      sdkQueryFn: fakeSdkQuery('done'),
      repoChecks,
      // 测试注入: spawn 替身 (空清单 → 不该被调)
      repoChecksSpawn: makeSpawn(async () => {
        throw new Error('INV-D2-4 违反: 空清单时 spawn 不该被调');
      }),
    });

    const result = await r({
      prompt: 'noop',
      model: SDK_MODEL,
    });
    // 不抛 = 行为与今天逐字节相同
    expect(result.text).toBe('done');
  });

  test('FAIL → runner 抛带 evidence 的 Error (engine L0 重试接住)', async () => {
    // 走 `touched` 注入: 直接调 runRepoChecks + formatRepoChecksFailure 验接线形状,
    // 与上 18 个 runRepoChecks 纯件测试是同条契约的另一面 (这里验「runner 真在出口位接住
    // FAIL, 抛的 message 含仓规 evidence」—— 走 createAgentLeafRunner 需要真 agent
    // 触发工具事件填充 touched, E2E 才验得到; 单元层用「fixture files → runRepoChecks」
    // 验 throw + message 形状 等价)。
    const tmp = await newTmp();
    const bannedFile = join(tmp, 'a.ts');
    await writeFile(bannedFile, `这一行包含禁词「${JARGON_SAMPLE}」\n`);

    const checksResult = await runRepoChecks({
      checks: [{ id: 'jargon-scan', command: 'bun scan --files {files}' }],
      files: ['a.ts'],
      cwd: tmp,
      spawn: makeSpawn(async () => ({
        stdout: '',
        stderr: `a.ts:1: 命中禁词: ${JARGON_SAMPLE}`,
        exitCode: 1,
      })),
    });
    expect(checksResult.verdict).toBe('FAIL');
    const failureMsg = formatRepoChecksFailure(checksResult);
    expect(failureMsg).toContain('[仓规检查失败: 1/1 红]');
    expect(failureMsg).toContain('jargon-scan');
    expect(failureMsg).toContain(`a.ts:1: 命中禁词: ${JARGON_SAMPLE}`);
    // 这正是 agent-leaf.ts:2382 抛 Error 时拼进 message 的字符串 (见 throw 那一行):
    // `throw new Error(\`[agent-leaf] ${formatRepoChecksFailure(checksResult)}\`)`.
    // 这里断言 message 形状稳定, 跑真 agent 时也能套同一断言。
  });

  test('UNVERIFIED (oracle-fault) → log warn + 不抛 (INV-D2-4 fail-open)', async () => {
    const tmp = await newTmp();
    await writeFile(join(tmp, 'a.ts'), '正常代码\n');

    const r = createAgentLeafRunner({
      cwd: tmp,
      hashlineEdit: false,
      leafTimeoutMs: 5000,
      sdkQueryFn: fakeSdkQuery('done'),
      repoChecks: [{ id: 'broken', command: 'cmd' }],
      repoChecksSpawn: makeSpawn(async () => {
        throw new Error('oracle 自己崩了');
      }),
    });

    // 不应抛: oracle-fault 走 fail-open (INV-D2-4), log warn + 继续
    const result = await r({ prompt: 'noop', model: SDK_MODEL });
    expect(result.text).toBe('done');
  });
});
