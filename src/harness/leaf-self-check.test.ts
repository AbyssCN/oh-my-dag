/**
 * src/harness/leaf-self-check.test.ts —— P1 C-2/C-3 自修环闸 (2026-08-21)。
 *
 * 四条 GWT + C-3 三条 INV 钉死:
 *
 * | GWT    | 钉的是什么 | 形态 |
 * |--------|---|---|---|
 * | GWT-2a | 借 pi followUp: 首轮判红 → 造 follow-up → 同节点再转 → 转绿 | 单元 (buildSelfCheckFollowUp 闭包) |
 * | GWT-2b | **反向**: 摘掉 `getFollowUpMessages` 接线 → 自修环未启用 | 源码面 (agent-leaf.ts 含 getFollowUpMessages) |
 * | GWT-2c | 危险命令 → 闸拒, exitCode=-1, 不注 follow-up, 不执行 | 单元 (runSelfCheckProbe + 闸拒落账) |
 * | GWT-2d | SDK 通道 + self_check 在场 → 自修环未启用, 且有日志 | 源码面 (SDK 分支不含 getFollowUpMessages) + **行为面** (真跑一次 leaf, 读日志汇, S-1 改写) |
 *
 * | INV    | 钉的是什么 | 形态 |
 * |--------|---|---|---|
 * | INV-3-1 | rounds ≤ maxSelfRepair; maxSelfRepair=0 时判据仍跑一次但**不**注 follow-up | 单元 + 源码 |
 * | INV-3-2 | 自修一轮后 touched 零新增 → 不开下一轮 (复用 grind 停滞轴) | 单元 (闭包状态机) |
 * | INV-3-3 | OMD_SELF_CHECK=0 / opts 关 → 整体退回旁路, 与无 self_check 逐字同 | 单元 + 源码 |
 *
 * ## 反向自检 (当场验过)
 *
 *  - GWT-2b 反向 (源码): 把上面第 4 步 wiring 那段 `getFollowUpMessages: selfCheckFollowUp` 注掉 →
 *    ★B ★D 都红 (字符串消失)。
 *  - GWT-2c 反向: 把 `runSelfCheckProbe` 里的 `commandBlockReason(opts.command, opts.allowlist)` 那行
 *    注掉 → 危险命令 `rm -rf /` 落到 spawn → exitCode 0 → 闸**未红** → 红。
 *  - GWT-2d 反向 (S-1, 2026-08-30 换成真判据): 把 `agent-leaf.ts` 里
 *    `if (selfCheck && isSdkChannel) { logger.warn(..., SELF_CHECK_SDK_SKIP_LOG) }` 整段注掉
 *    → ★D1a 红 (日志汇里找不到那一行)。
 *    ⚠ 旧写法 (`expect(SELF_CHECK_SDK_SKIP_LOG).toContain('SDK 通道不启用')`) **恒绿** ——
 *    它拿常量自己的子串断言常量自己, 而那条 WARN 当时全仓零 emit 点。换真的读数与做法见
 *    ★D1 那段块注 + `docs/plan/2026-08-30-sdk-selfcheck-recon.md` §0.1。
 *    实装前读数 (HEAD c531dd56 的干净 worktree, 同一份测试): `28 tests · 27 pass · 1 fail`,
 *    红的正是 ★D1a; ★D1b/★D1c 是负向臂 (证伪方向 = 那条 WARN 变成无条件打)。
 *  - INV-3-2 反向: 把闭包里 `curTouched === lastTouched` 那条短路改回无条件注 follow-up →
 *    「零新增仍开下一轮」红, 那是把 grind 已经实测过 25:1 误杀那条闸废掉。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SELF_CHECK_SDK_SKIP_LOG,
  buildSelfCheckFollowUp,
  createAgentLeafRunner,
  runSelfCheckProbe,
  selfCheckEnvEnabled,
  workspaceDigest,
  type SelfCheckOutcome,
} from './agent-leaf';
import { setLoggerDestination } from '../logger';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const SRC = join(import.meta.dir, 'agent-leaf.ts');
const RUNNERS_SRC = join(import.meta.dir, 'leaf-runners.ts');

/** 真仓库根 + 配管道命令白名单 —— 与 leaf 默认 DEFAULT_COMMAND_ALLOWLIST 同源。 */
const ALLOWLIST = ['bun', 'bunx', 'node', 'echo', 'ls', 'cat', 'pwd', 'true', 'false', 'tsc'];

/** 留痕: 造一条 AgentMessage-like, 让测试断言「有内容」时不靠字符串匹配整包。 */
function isUserMsg(m: AgentMessage): boolean {
  return (m as { role?: string }).role === 'user';
}

/** 假 runner (本测试网里的真理来源之一): 不真 spawn, 按命令串字典给退出码。 */
function fakeRun(outcomes: ReadonlyMap<string, SelfCheckOutcome>) {
  return async (input: { command: string; cwd: string; allowlist: readonly string[] }): Promise<SelfCheckOutcome> => {
    // 闸拒也走同条路 —— 命令含 `BLOCK` 字样时强制闸拒 (不走真 commandBlockReason, 测的是闭包
    // 落账, 不是闸本身 —— 闸在 GWT-2c 直接验)。
    if (input.command.includes('BLOCK')) {
      return { kind: 'blocked', reason: '[test forced block]' };
    }
    const r = outcomes.get(input.command);
    if (!r) throw new Error(`fakeRun: no scripted outcome for command "${input.command}"`);
    return r;
  };
}

/** 一次性 truncation stub (pi `truncateTail` 形态: 不动内容, 标 touched flag)。 */
function passthroughTruncate(s: string): string {
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
// GWT-2a (主) + INV-3-1/2/3 (主) — buildSelfCheckFollowUp 闭包状态机
// ─────────────────────────────────────────────────────────────────────────
describe('GWT-2a + C-3 不变量 — buildSelfCheckFollowUp 闭包', () => {
  test('GWT-2a: 首轮判红 → 注 follow-up; 第二轮转绿 → 短路返 []; 自修 1 轮 (rounds=1, convergedAt=1, oracleExit.length=2)', async () => {
    const touched = [3, 5]; // 第 1 轮前 = 3, 第 1 轮后 = 5 (有新增)
    const outcomes = new Map<string, SelfCheckOutcome>([
      ['bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '1 fail', stderr: '' }],
    ]);
    let call = 0;
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => touched[call++] ?? touched[touched.length - 1]!,
      enabled: true,
      maxSelfRepair: 2,
      truncate: passthroughTruncate,
      probe: fakeRun(outcomes),
      observe: () => {},
    });
    // 第 1 次被调 (内环将停): oracleExit 落 1, touched 由 3 → 5 (有新增), 注 follow-up
    const first = await followUp();
    expect(first).toHaveLength(1);
    expect(isUserMsg(first[0]!)).toBe(true);
    // AgentMessage 在 pi 里是 union (含 BashExecutionMessage 之类没有 .content 的形态)。
    // 我们造的就是 role:'user' 的 UserMessage, 所以 narrow 后再读 content —— 不用 any。
    const firstUser = first[0] as { role: 'user'; content: string };
    expect(firstUser.content).toContain('[self_check 未通过');
    expect(firstUser.content).toContain('退出码 1');
    // 第 2 次被调: 自修一轮后, touched 仍是 5 (本轮 oracle 跑完未真改文件) — 但闭包在
    // 自修轮 `rounds > 0 && curTouched === lastTouched` 这条 INV-3-2 判的是「上一轮后」,
    // 此处 lastTouched 在第一次调用末尾被更新到 5, 第二轮读到 5 仍 === 5 → 不开下一轮!
    // 这就是 INV-3-2 的诚实形态: 自修一轮后若该轮 oracle 跑完后模型**未再补一刀**, 停。
    // 改 touched[2] = 7 模拟「本轮再补了一刀」才能开下一轮 → 落到 expect_exit 0 收敛。
    touched.push(7);
    outcomes.set('bun test x.test.ts', { kind: 'exited', exitCode: 0, stdout: '0 fail', stderr: '' });
    // 重置计数器到第二轮位置:
    call = 1; // 第二轮 getTouchedSize() 读到 touched[1] = 5
    const second = await followUp();
    expect(second).toEqual([]); // 收敛 → []
  });

  test('GWT-2a 收敛落账: oracleExit.length === rounds + 1, convergedAt = rounds (本例 = 0, 首轮就绿)', async () => {
    // 测的是**首轮就绿**形态: INV-4-1 「null ≠ {rounds:0}」在这里的对照面 —— rounds=0
    // 仍然要走一次 probe, oracleExit 长度 = 1, convergedAt = 0。
    let observed: { rounds: number; convergedAt: number | null; oracleExit: number[] } = {
      rounds: 0,
      convergedAt: null,
      oracleExit: [],
    };
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'true', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => 0, // 无新增, 首轮就绿, INV-3-2 不触发 (rounds > 0 短路)
      enabled: true,
      maxSelfRepair: 2,
      truncate: passthroughTruncate,
      probe: fakeRun(new Map([['true', { kind: 'exited', exitCode: 0, stdout: '', stderr: '' }]])),
      observe: (info) => {
        // 通过 observe 收集最终状态 (代理 ledger 字段)。
        // oracleExit 只数 'exited' 事件 — converged 是 exited 之后的二次观察, 不该算多一轮。
        observed.rounds = info.rounds;
        if (info.kind === 'converged') observed.convergedAt = info.rounds;
        if (info.kind === 'exited') observed.oracleExit.push(info.exitCode ?? -999);
      },
    });
    const out = await followUp();
    expect(out).toEqual([]);
    expect(observed.rounds).toBe(0); // 首轮就绿, 自修轮数 = 0
    expect(observed.convergedAt).toBe(0); // 第 0 轮转绿
    expect(observed.oracleExit).toEqual([0]); // INV-4-2: 长度 = rounds + 1
  });

  test('INV-3-2 (主): 自修一轮后 touched 零新增 → 不再开下一轮, 返 [] (无 follow-up 注)', async () => {
    // 第一轮: touched = 3, 判红, 注 follow-up (rounds += 1 → 1)
    // 第二轮: touched 仍 = 3 (模型没改文件), 闭包见 `rounds > 0 && curTouched === lastTouched`
    //        → 直接返 [], 不再注 follow-up (即使 oracle 还可再跑)。
    const touched = [3, 3]; // 两轮间无新增
    let call = 0;
    const events: string[] = [];
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => touched[call++] ?? 3,
      enabled: true,
      maxSelfRepair: 2,
      truncate: passthroughTruncate,
      probe: fakeRun(new Map([['bun test x.test.ts', { kind: 'exited', exitCode: 1, stdout: '', stderr: '' }]])),
      observe: (info) => events.push(`${info.kind}@r${info.rounds}`),
    });
    const first = await followUp();
    expect(first).toHaveLength(1); // 第一轮注 follow-up
    events.length = 0;
    const second = await followUp();
    expect(second).toEqual([]); // INV-3-2: 无新增 → 不注
    expect(events).toContain('no-progress@r1'); // 观察点留痕
  });

  test('INV-3-1: maxSelfRepair = 0 → 判据**仍跑一次**(用于判定)但**绝不**注任何 follow-up', async () => {
    let probeCalls = 0;
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => 100, // 假装永远有新增
      enabled: true,
      maxSelfRepair: 0, // 边界: 判据跑一次但不注入
      truncate: passthroughTruncate,
      probe: async () => {
        probeCalls += 1;
        return { kind: 'exited', exitCode: 1, stdout: '', stderr: '' };
      },
      observe: () => {},
    });
    const out = await followUp();
    expect(out).toEqual([]); // 不注 follow-up
    expect(probeCalls).toBe(0); // 既然 maxSelfRepair=0, 闸短路在 probe 之前 (enabled && maxSelfRepair > 0)
    // ⚠ 注: 上面这一行严格说只在闭包内短路, 见「maxSelfRepair=0 仍要跑一次」的实现位置。
    // 测试在此钉的是「短路返 []」,「仍跑一次」由 engine 侧判据单独验证 (notes-by-test 留下)。
  });

  test('INV-3-1 (主): 连续两轮 touched 零新增 + 第 n 轮 oracle 仍红 → 不开第 3 轮, 返 []', async () => {
    // 边界: maxSelfRepair = 2, oracle 一直红, touched 一直不增 — 第 3 次调用应短路。
    let call = 0;
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'false', expect_exit: 1 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => (call++ === 0 ? 0 : 0), // 全程零新增
      enabled: true,
      maxSelfRepair: 2,
      truncate: passthroughTruncate,
      probe: fakeRun(new Map([['false', { kind: 'exited', exitCode: 0, stdout: '', stderr: '' }]])),
      observe: () => {},
    });
    const a = await followUp(); // 首轮: rounds=0, touched 0→0 不触发 INV-3-2 (rounds>0 短路), 注 follow-up (rounds→1)
    expect(a).toHaveLength(1);
    const b = await followUp(); // 二轮: rounds=1, lastTouched=0, cur=0 → INV-3-2 触发, 返 []
    expect(b).toEqual([]);
    const c = await followUp(); // 三轮: 已收尾 (rounds=1), 防御性短路返 []
    expect(c).toEqual([]);
  });

  test('INV-3-3: enabled=false (env 关) → 返 [] 不跑 probe (整条路关掉)', async () => {
    let probeCalls = 0;
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => 5,
      enabled: false, // 关
      maxSelfRepair: 2,
      truncate: passthroughTruncate,
      probe: async () => {
        probeCalls += 1;
        return { kind: 'exited', exitCode: 1, stdout: '', stderr: '' };
      },
      observe: () => {},
    });
    const out = await followUp();
    expect(out).toEqual([]);
    expect(probeCalls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GWT-2c — runSelfCheckProbe 闸拒: 危险命令不执行, 闸拒落账
// ─────────────────────────────────────────────────────────────────────────
describe('GWT-2c — runSelfCheckProbe 安全闸 (INV-2-2)', () => {
  test('危险命令 (rm -rf /) → commandBlockReason 闸拒 → kind=blocked, reason 留痕, **不** spawn', async () => {
    let spawned = false;
    const out = await runSelfCheckProbe({
      command: 'rm -rf /', // 危险: 'rm' 不在白名单 ∧ 危险命令
      cwd: '/x',
      allowlist: ALLOWLIST,
      spawn: async () => {
        spawned = true;
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      },
    });
    expect(spawned).toBe(false); // INV-2-2: 不许绕开安全闸
    expect(out.kind).toBe('blocked');
    if (out.kind === 'blocked') {
      expect(out.reason).toMatch(/blocked/); // 闸拒原因留痕
    }
  });

  test('白名单内的命令 → 真 spawn, exitCode 真值透传', async () => {
    const out = await runSelfCheckProbe({
      command: 'echo ok',
      cwd: '/x',
      allowlist: ALLOWLIST,
      spawn: async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0, signal: null }),
    });
    expect(out.kind).toBe('exited');
    if (out.kind === 'exited') {
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toBe('ok\n');
    }
  });

  test('shell 元字符 (`;`) → 闸拒 (白名单只查首 token, 元字符仍拒)', async () => {
    let spawned = false;
    const out = await runSelfCheckProbe({
      command: 'echo ok; rm -rf /tmp',
      cwd: '/x',
      allowlist: ALLOWLIST,
      spawn: async () => {
        spawned = true;
        return { stdout: '', stderr: '', exitCode: 0, signal: null };
      },
    });
    expect(spawned).toBe(false);
    expect(out.kind).toBe('blocked');
  });

  test('信号死 → exitCode 折成 null (H5-1 三字段互不推断, 与 commandRunner 同款)', async () => {
    const out = await runSelfCheckProbe({
      command: 'echo ok',
      cwd: '/x',
      allowlist: ALLOWLIST,
      spawn: async () => ({ stdout: '', stderr: 'killed', exitCode: 137, signal: 'SIGKILL', timedOut: false }),
    });
    expect(out.kind).toBe('exited');
    if (out.kind === 'exited') {
      expect(out.exitCode).toBeNull(); // signal !== null ⇒ exitCode = null
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P2c — self_check 真跑 defaultSpawn 时必须用调用方的真实 allowlist, 不是
// defaultSpawn 内部硬编码的影子表 (agent-leaf.ts:801 之前的缺陷)。
// 反向自检: 把 defaultSpawn 里 `allowlist,` 改回硬编码的 11 项列表 → 本测试红
// (exitCode 变回 -1, stdout 含 'blocked not-allowed')。
// ─────────────────────────────────────────────────────────────────────────
describe('P2c — runSelfCheckProbe 真 defaultSpawn 遵守调用方 allowlist (不被硬编码影子表拒)', () => {
  test('grep 在调用方 allowlist 里, 但不在 defaultSpawn 旧硬编码表里 → 真执行, 不被内层影子闸拒', async () => {
    const out = await runSelfCheckProbe({
      command: 'grep --version',
      cwd: process.cwd(),
      allowlist: [...ALLOWLIST, 'grep'],
      // 不注入 spawn —— 走真实 defaultSpawn, 才能验到内层闸真的看见了外层 allowlist。
    });
    expect(out.kind).toBe('exited');
    if (out.kind === 'exited') {
      expect(out.exitCode).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GWT-2b (反向) — 源码面: getFollowUpMessages 在 pi 通道接线存在
// ─────────────────────────────────────────────────────────────────────────
describe('GWT-2b (反向, 必须能红) — getFollowUpMessages 接线存在', () => {
  test('★B1: agent-leaf 的 AgentLoopConfig 含 `getFollowUpMessages: selfCheckFollowUp` 接线 (删 → 红)', () => {
    const src = readFileSync(SRC, 'utf8');
    // 同一份 wiring 不能藏进条件分支深处仍算「接上了」—— 这条字符串存在 = 接线存在。
    expect(src).toMatch(/getFollowUpMessages\s*:\s*selfCheckFollowUp/);
  });

  test('★B2: 接线被 `selfCheck && !isSdkChannel && selfCheckEnabled && maxSelfRepair > 0` 闸 (关掉任何一路 → 不接, INV-3-3)', () => {
    const src = readFileSync(SRC, 'utf8');
    // 闸的形状必须四路同时满足; 任一缺失 → 接线不发生, 这是 INV-3-3 的源码面对照。
    expect(src).toMatch(/selfCheck\s*&&\s*!isSdkChannel\s*&&\s*selfCheckEnabled\s*&&\s*maxSelfRepair\s*>\s*0/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GWT-2d (反向) — SDK 通道不含 getFollowUpMessages, 且有日志 (INV-2-1)
// ─────────────────────────────────────────────────────────────────────────
describe('GWT-2d (反向, 必须能红) — SDK 通道不含 getFollowUpMessages + 有日志', () => {
  // ── ★D1 (S-1 改写, 2026-08-30): 从「常量断言常量自己」换成行为面 ────────────────
  //
  // 旧 ★D1 写的是 `expect(SELF_CHECK_SDK_SKIP_LOG).toContain('SDK 通道不启用')` ——
  // 拿常量自己的子串断言常量自己, **无论那条 WARN 有没有 emit 点都绿**。侦察实测: 该常量
  // 当时全仓零 emit (`ugrep -rn 'SELF_CHECK_SDK_SKIP_LOG' src/` 只有定义行 + 注释 + 本 import),
  // 也就是说 INV-2-1 要求的那条 WARN 根本不存在, 而这道闸一次都没红过 —— 仓规「一条永远绿的
  // 闸不是闸」。同形的 `AGENT_MEDIA_SDK_BYPASS_LOG` 早就是按下面这个做法测的
  // (agent-media-injection.test.ts:252 — 改日志汇到临时文件, 跑真 runner, 读回常量行),
  // 这里照抄那一套。
  //
  // 反向自检 (当场验过): 把 agent-leaf.ts 里 `if (selfCheck && isSdkChannel) { logger.warn(...) }`
  // 整段注掉 → ★D1a 红 (日志里找不到那一行)。

  /** 跑一次真 leaf, 把 pino 汇改到临时文件, 返回日志全文。 */
  const runAndCaptureLog = async (opts: {
    model: string;
    selfCheck?: { command: string; expect_exit: number };
  }): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-selfcheck-log-'));
    const logPath = join(dir, 'capture.log');
    const fd = openSync(logPath, 'w');
    setLoggerDestination(fd);
    try {
      // SDK 腿: 假 query 生成器 (与 agent-media-injection.test.ts 同源的两条消息)。
      const fakeQuery = (_props: { prompt: string; options: Options }) =>
        (async function* () {
          yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } } as unknown as SDKMessage;
          yield { type: 'result', subtype: 'success', result: 'done', session_id: 's', usage: {} } as unknown as SDKMessage;
        })();
      // pi 腿: 假 loop (不真起传输)。
      const fakeLoop = async (msgs: AgentMessage[]) => [
        ...msgs,
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 1, stopReason: 'stop' } as unknown as AgentMessage,
      ];
      const run = createAgentLeafRunner({ cwd: dir, sdkQueryFn: fakeQuery, loopFn: fakeLoop as never });
      await run({
        prompt: '干活',
        model: opts.model,
        ...(opts.selfCheck ? { self_check: opts.selfCheck } : {}),
      });
      return readFileSync(logPath, 'utf8');
    } finally {
      setLoggerDestination(1);
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('★D1a: SDK 通道 + self_check 在场 → 日志真的出现 SELF_CHECK_SDK_SKIP_LOG (INV-2-1 不许静默降级)', async () => {
    const log = await runAndCaptureLog({
      model: 'claude-code:claude-sonnet-5',
      selfCheck: { command: 'bun test x.test.ts', expect_exit: 0 },
    });
    expect(log).toContain(SELF_CHECK_SDK_SKIP_LOG);
    // 结构化那一位也得在 —— 只有文案没有判据坐标, 事后分不清是哪条判据被静音了。
    expect(log).toContain('"command":"bun test x.test.ts"');
    expect(log).toContain('"sdkSelfCheckSkipped":true');
  });

  test('★D1b: SDK 通道 + **无** self_check → 不打这条 (它说的是「有判据但听不见」, 不是无条件噪音)', async () => {
    const log = await runAndCaptureLog({ model: 'claude-code:claude-sonnet-5' });
    expect(log).not.toContain(SELF_CHECK_SDK_SKIP_LOG);
  });

  test('★D1c: pi 通道 + self_check 在场 → 不打这条 (pi 听得见, 打了就是假旁路读数)', async () => {
    const log = await runAndCaptureLog({
      model: 'deepseek:deepseek-v4-flash',
      selfCheck: { command: 'bun test x.test.ts', expect_exit: 0 },
    });
    expect(log).not.toContain(SELF_CHECK_SDK_SKIP_LOG);
  });

  test('★D2: SDK 分支 (runSdkAgentLoop 块) 内不含 `getFollowUpMessages` 字样 (那就是把 SDK 接进了 pi 钩子, 通道混了)', () => {
    const src = readFileSync(SRC, 'utf8');
    // 截 SDK 段到 runSdkAgentLoop 调用收尾, 检查这段不含 followUpMessages 接线 (红线字面)。
    const sdkIdx = src.indexOf('runSdkAgentLoop(');
    expect(sdkIdx).toBeGreaterThan(0);
    const sdkSlice = src.slice(sdkIdx, sdkIdx + 2_500); // 截一段足够覆盖 SDK 装配块
    expect(sdkSlice).not.toMatch(/getFollowUpMessages\s*:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C-3 INV-3-3 (env 开关) — selfCheckEnvEnabled 真源
// ─────────────────────────────────────────────────────────────────────────
describe('INV-3-3 — env 开关 selfCheckEnvEnabled', () => {
  test('OMD_SELF_CHECK=0 → false (关)', () => {
    expect(selfCheckEnvEnabled({ OMD_SELF_CHECK: '0' })).toBe(false);
  });

  test('OMD_SELF_CHECK 未设 / 其他值 → true (开, 默认路径)', () => {
    expect(selfCheckEnvEnabled({})).toBe(true);
    expect(selfCheckEnvEnabled({ OMD_SELF_CHECK: '' })).toBe(true);
    expect(selfCheckEnvEnabled({ OMD_SELF_CHECK: '1' })).toBe(true);
    expect(selfCheckEnvEnabled({ OMD_SELF_CHECK: 'off' })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// leaf-runners.ts — self_check / selfRepair 字段真源 (GWT-2a 接线面)
// ─────────────────────────────────────────────────────────────────────────
describe('leaf-runners.ts — self_check / selfRepair 字段形状', () => {
  test('AgentLeafInput 含 self_check?: { command; expect_exit }', () => {
    const src = readFileSync(RUNNERS_SRC, 'utf8');
    expect(src).toMatch(/self_check\?:\s*SelfCheckSpec/);
  });

  test('AgentLeafResult 含 selfRepair?: { rounds; oracleExit; convergedAt } | null', () => {
    const src = readFileSync(RUNNERS_SRC, 'utf8');
    // 真形状: selfRepair?: { rounds: number; oracleExit: number[]; convergedAt: number | null } | null
    expect(src).toMatch(/selfRepair\?:\s*\{\s*rounds:\s*number;\s*oracleExit:\s*number\[\];\s*convergedAt:\s*number\s*\|\s*null\s*\}\s*\|\s*null/);
  });
});

describe('判据输出指纹:两轮一模一样 = 这一轮什么都没改到', () => {
  /** 按调用次序给结果的 probe —— fakeRun 是按命令串查表的, 表达不了「同一条命令两轮输出不同」。 */
  const seq = (outs: readonly SelfCheckOutcome[]) => {
    let i = 0;
    return async (): Promise<SelfCheckOutcome> => outs[Math.min(i++, outs.length - 1)]!;
  };
  const red = (stdout: string): SelfCheckOutcome => ({ kind: 'exited', exitCode: 1, stdout, stderr: '' });

  const loop = (outs: readonly SelfCheckOutcome[]) => {
    let touched = 3;
    return buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => (touched += 2),
      enabled: true,
      maxSelfRepair: 3,
      truncate: passthroughTruncate,
      probe: seq(outs),
      observe: () => {},
    });
  };

  test('★ 连续两轮输出逐字节相同 → follow-up 明说判据看不见你的改动', async () => {
    const { followUp } = loop([red('1 fail\n'), red('1 fail\n')]);
    const first = await followUp();
    const second = await followUp();
    expect(String((first[0] as { content?: unknown })?.content)).not.toContain('逐字节相同');
    expect(String((second[0] as { content?: unknown })?.content), '第二轮才知道「和上一轮一样」').toContain('逐字节相同');
  });

  test('★ 输出变了 → 不加那句(它只在真的原地踏步时出现)', async () => {
    const { followUp } = loop([red('1 fail\n'), red('2 fail\n')]);
    await followUp();
    const second = await followUp();
    expect(String((second[0] as { content?: unknown })?.content)).not.toContain('逐字节相同');
  });
});

/**
 * 工作区判据 (2026-08-26) —— 「自上次尝试以来变没变」从**路径计数**换成**内容指纹**。
 *
 * 两个方向都要证伪, 因为老判据两个方向都漏:
 *   ① 同一文件二次编辑: 计数不动 → 老判据当场判"零新增"停掉自修环 (**假停**);
 *   ② 什么都没改:       指纹不动 → 新判据照样停 (这条不许因为换尺子而丢)。
 */
describe('★ 工作区内容指纹 —— 取代「touched 路径个数」这把会漏的尺子', () => {
  const red = (stdout: string): SelfCheckOutcome => ({ kind: 'exited', exitCode: 1, stdout, stderr: '' });
  const alwaysRed = async (): Promise<SelfCheckOutcome> => red('1 fail\n');

  /** 计数恒定 (= 模型每轮都在改**同一个文件**), 指纹按 digests 逐轮给。 */
  const loopWithDigest = (digests: readonly string[]) => {
    let i = 0;
    return buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => 1, // 恒 1 —— 老判据在这里必判"零新增"
      getWorkspaceDigest: () => digests[Math.min(i++, digests.length - 1)]!,
      enabled: true,
      maxSelfRepair: 3,
      truncate: passthroughTruncate,
      probe: alwaysRed,
      observe: () => {},
    });
  };

  test('同一文件二次编辑 (计数恒定, 内容变) → 自修环**继续**, 不被假停', async () => {
    const { followUp, ledger } = loopWithDigest(['d0', 'd1', 'd2']);
    expect(await followUp()).toHaveLength(1); // 第 1 轮
    expect(await followUp()).toHaveLength(1); // 第 2 轮 —— 老判据在这里会返 []
    expect(ledger.rounds).toBe(2);
  });

  test('反向: 工作区一个字节没变 → 照旧停 (换尺子没把停的能力丢掉)', async () => {
    const observed: string[] = [];
    let i = 0;
    const digests = ['d0', 'd1', 'd1']; // 第 2 轮之后再没动过
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => 999, // 计数狂涨 —— 老判据在这里会一直放行
      getWorkspaceDigest: () => digests[Math.min(i++, digests.length - 1)]!,
      enabled: true,
      maxSelfRepair: 3,
      truncate: passthroughTruncate,
      probe: alwaysRed,
      observe: (info) => observed.push(info.kind),
    });
    expect(await followUp()).toHaveLength(1);
    expect(await followUp()).toEqual([]);
    expect(observed).toContain('no-progress');
  });

  test('getWorkspaceDigest 缺席 → 退回计数判据 (与本改动前逐字同行为)', async () => {
    const { followUp } = buildSelfCheckFollowUp({
      spec: { command: 'bun test x.test.ts', expect_exit: 0 },
      cwd: '/x',
      allowlist: ALLOWLIST,
      getTouchedSize: () => 1, // 恒定 → 计数判据判停
      enabled: true,
      maxSelfRepair: 3,
      truncate: passthroughTruncate,
      probe: alwaysRed,
      observe: () => {},
    });
    expect(await followUp()).toHaveLength(1);
    expect(await followUp()).toEqual([]);
  });
});

describe('★ workspaceDigest —— 三条口径 (路径入指纹 / 缺席写 ∅ / 空集有确定值)', () => {
  test('内容相同但路径不同 → 指纹不同 (挪文件不算"没变")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-wsdigest-'));
    writeFileSync(join(dir, 'a.ts'), 'x');
    writeFileSync(join(dir, 'b.ts'), 'x');
    expect(workspaceDigest(dir, ['a.ts'])).not.toBe(workspaceDigest(dir, ['b.ts']));
  });

  test('文件被删 ≠ 从来没碰过它 (§NULL ≠ 0 ≠ 不适用)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omd-wsdigest-'));
    writeFileSync(join(dir, 'a.ts'), 'x');
    const withFile = workspaceDigest(dir, ['a.ts']);
    rmSync(join(dir, 'a.ts'));
    const deleted = workspaceDigest(dir, ['a.ts']); // 路径仍在写集里, 文件没了 → ∅
    const never = workspaceDigest(dir, []); // 压根没碰过
    expect(deleted).not.toBe(withFile);
    expect(deleted).not.toBe(never);
  });

  test('空写集有确定值 (不是 null —— 那会让判据退回计数那把尺子)', () => {
    expect(workspaceDigest('/nonexistent', [])).toBe(workspaceDigest('/other', []));
  });
});
