/**
 * src/harness/notify —— owner 推式桥的接缝面 (SDD F1 片 1 · C-1 五条 INV)。
 *
 * 五条 INV 各自一条用例; 录入面 = `notifyOwner(payload, deps?)`, 出口 = 调用方递 deps
 * (readConfigText / spawn / now) 三件套 —— 全 stub, 零 fs / 零 child_process 真调。
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type EscalationPayload,
  NOTIFY_EVENTS,
  notifyOwner,
  type OwnerNotifyEvent,
  type TerminalPayload,
} from './notify';
import { setCoreLogger, type CoreLogger } from './logger';

// ── capture logger (同 o6-vacuous-verify.gate.test.ts 惯例) ─────────────────

interface CapturedLog { msg: string; fields: Record<string, unknown> }
const captured: CapturedLog[] = [];
const captureLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => {
    const f = o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    captured.push({ msg: m ?? '', fields: f });
  },
  warn: (o, m) => {
    const f = o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    captured.push({ msg: m ?? '', fields: f });
  },
  error: (o, m) => {
    const f = o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    captured.push({ msg: m ?? '', fields: f });
  },
};
/** ⚠ 同 o6 那只注释: bun 跨测试文件复用进程 —— 只清数组不换回, 假 logger 会**留给后面每一个**。 */
const consoleLogger: CoreLogger = {
  debug: () => {},
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : ''),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : ''),
  error: (o, m) => console.error(m ?? '', o),
};
beforeEach(() => { captured.length = 0; setCoreLogger(captureLogger); });
afterEach(() => { captured.length = 0; setCoreLogger(consoleLogger); });

// ── spawn 替身: 记每次调用 ──────────────────────────────────────────────────

interface SpawnCall { argv: string[] }
function makeRecordingSpawn(opts?: { throwOnCall?: boolean; neverSettle?: boolean }) {
  const calls: SpawnCall[] = [];
  const spawn = (argv: string[]) => {
    calls.push({ argv });
    if (opts?.throwOnCall) throw new Error('fake-spawn-boom');
    // 永不 settle 的句柄: 返回一个不会 resolve 的 Promise / 没监听 exit 的 handle,
    // 测试用同步超时截断 (INV-5)。bun:test 默认 5s 兜底 —— 比 5s 短就够。
    return { pid: 99999 };
  };
  return { spawn, calls };
}

// ── 端到端 fixture: 一份最小可用配置 ────────────────────────────────────────

const CFG_TERMINAL: TerminalPayload = {
  event: 'terminal', runId: 'r-1', at: '2026-08-25T00:00:00.000Z',
  outcome: 'done', headline: 'ok',
};

function validCfg(events?: ReadonlyArray<string>) {
  return JSON.stringify({ notify: { command: 'echo notify', events } });
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('notifyOwner (C-1)', () => {
  // ── INV-1 未配置零涟漪 ─────────────────────────────────────────────────────
  test('INV-1: 无 notify 配置 → spawn 0 次, 0 新日志行', () => {
    const { spawn, calls } = makeRecordingSpawn();
    for (const event of NOTIFY_EVENTS) {
      const payload =
        event === 'terminal' ? { ...CFG_TERMINAL, event } :
        event === 'escalation' ? { event: 'escalation' as const, runId: 'r', at: 't', round: 1, poisoned: 0 } :
        { event: 'budget-half' as const, runId: 'r', at: 't', axis: 'tokens' as const, spent: 1, cap: 2 };
      notifyOwner(payload, { readConfigText: () => null, spawn });
    }
    expect(calls.length).toBe(0);
    expect(captured.length).toBe(0);
  });

  test('INV-1b: 配置存在但无 notify 段 → spawn 0 次, 0 新日志行', () => {
    const { spawn, calls } = makeRecordingSpawn();
    notifyOwner(CFG_TERMINAL, {
      readConfigText: () => JSON.stringify({ roles: { foo: 'bar' } }),
      spawn,
    });
    expect(calls.length).toBe(0);
    expect(captured.length).toBe(0);
  });

  test('INV-1c: 调用方不递 readConfigText (接线位空) → spawn 0 次, 0 新日志行', () => {
    const { spawn, calls } = makeRecordingSpawn();
    notifyOwner(CFG_TERMINAL, { spawn });
    expect(calls.length).toBe(0);
    expect(captured.length).toBe(0);
  });

  // ── INV-2 payload 单 argv 元素 ─────────────────────────────────────────────
  test('INV-2: 配置 command + 一次 terminal → argv 末元素经 JSON.parse 成功, event=terminal, argv[2] 不含 payload 内容', () => {
    const { spawn, calls } = makeRecordingSpawn();
    notifyOwner(CFG_TERMINAL, {
      readConfigText: () => validCfg(),
      spawn,
    });
    expect(calls.length).toBe(1);
    const argv = calls[0]!.argv;
    expect(argv[0]).toBe('sh');
    expect(argv[1]).toBe('-c');
    // argv[2] = command 拼接占位 —— 不该含 payload 的内容
    expect(argv[2]).toBe('echo notify "$@"');
    // 末元素 = payloadJson, 整段 JSON.parse 通
    const parsed = JSON.parse(argv[argv.length - 1]!) as Record<string, unknown>;
    expect(parsed.event).toBe('terminal');
    expect(parsed.runId).toBe('r-1');
    expect(parsed.outcome).toBe('done');
    expect(argv[3]).toBe('omd-notify');
  });

  // ── INV-3 坏形状与非法事件项只 warn 不炸 ─────────────────────────────────
  test('INV-3a: 缺 command → warn 一次, spawn 0 次', () => {
    const { spawn, calls } = makeRecordingSpawn();
    notifyOwner(CFG_TERMINAL, {
      readConfigText: () => JSON.stringify({ notify: { events: ['terminal'] } }),
      spawn,
    });
    expect(calls.length).toBe(0);
    expect(captured.length).toBe(1);
    expect(captured[0]!.msg).toContain('command');
  });

  test('INV-3b: command 非字符串 → warn 一次, spawn 0 次', () => {
    const { spawn, calls } = makeRecordingSpawn();
    notifyOwner(CFG_TERMINAL, {
      readConfigText: () => JSON.stringify({ notify: { command: 12345 } }),
      spawn,
    });
    expect(calls.length).toBe(0);
    expect(captured.length).toBe(1);
  });

  test('INV-3c: events 含非法名 + 合法名 → 合法名那次 spawn 恰 1 次, warn 恰 1 行 (非法名那条)', () => {
    const { spawn, calls } = makeRecordingSpawn();
    notifyOwner(CFG_TERMINAL, {
      readConfigText: () => validCfg(['terminal', 'BOGUS_EVENT']),
      spawn,
    });
    expect(calls.length).toBe(1);
    expect(captured.length).toBe(1);
    expect(captured[0]!.msg).toContain('BOGUS_EVENT');
  });

  test('INV-3d: events 只列非法名 → 合法事件也照样发 (缺省 = 三类全发, 白名单只过滤非法)', () => {
    const { spawn, calls } = makeRecordingSpawn();
    notifyOwner(CFG_TERMINAL, {
      readConfigText: () => validCfg(['BOGUS_ONLY']),
      spawn,
    });
    // 白名单全非法 = 当作未配白名单; 合法事件 terminal 不被该次白名单拒 (D-8: 缺省三类全发, 非法项 warn 后忽略)
    // 见 D-4 ② 口径: 合法项照用 —— 这里"合法项"是 NOTIFY_EVENTS 中的项, 不在白名单里的项照发(因为白名单等于不过滤)。
    expect(calls.length).toBe(1);
    expect(captured.length).toBe(1);
    expect(captured[0]!.msg).toContain('BOGUS_ONLY');
  });

  // ── INV-4 fail-open 不吞证据 ───────────────────────────────────────────────
  test('INV-4: spawn 抛错 → 入口正常返回, 证据行恰 1 行含 runId 与 event', () => {
    const { spawn, calls } = makeRecordingSpawn({ throwOnCall: true });
    expect(() =>
      notifyOwner(CFG_TERMINAL, { readConfigText: () => validCfg(), spawn }),
    ).not.toThrow();
    expect(calls.length).toBe(1);
    expect(captured.length).toBe(1);
    expect(captured[0]!.fields.runId).toBe('r-1');
    expect(captured[0]!.fields.event).toBe('terminal');
    // 错误原文透出
    expect(JSON.stringify(captured[0]!.fields)).toContain('fake-spawn-boom');
  });

  // ── INV-5 不等待完成 ───────────────────────────────────────────────────────
  test('INV-5: spawn 句柄永不 settle → 入口同步返回 (单测 5s 兜底内绿)', () => {
    const { spawn, calls } = makeRecordingSpawn();
    // 不 await 任何东西; 同步调完即返回
    const ret = notifyOwner(CFG_TERMINAL, { readConfigText: () => validCfg(), spawn });
    expect(ret).toBeUndefined();
    expect(calls.length).toBe(1);
    // 没等到 exit —— 不该有任何"等 exit"的痕迹, 也没 promise/then 留给调用方
  });

  // ── payload 三类各一次可达 ────────────────────────────────────────────────
  test('三类 payload 各一次 → spawn 3 次, 末元素 event 字段各自正确', () => {
    const { spawn, calls } = makeRecordingSpawn();
    const terminal: TerminalPayload = { event: 'terminal', runId: 'r1', at: 't', outcome: 'done', headline: 'h' };
    const escalation: EscalationPayload = { event: 'escalation', runId: 'r2', at: 't', round: 3, poisoned: 2 };
    const budget = { event: 'budget-half' as const, runId: 'r3', at: 't', axis: 'tokens' as const, spent: 5, cap: 10 };
    notifyOwner(terminal, { readConfigText: () => validCfg(), spawn });
    notifyOwner(escalation, { readConfigText: () => validCfg(), spawn });
    notifyOwner(budget, { readConfigText: () => validCfg(), spawn });
    expect(calls.length).toBe(3);
    const events = calls.map(c => (JSON.parse(c.argv[c.argv.length - 1]!) as Record<string, unknown>).event);
    expect(events).toEqual(['terminal', 'escalation', 'budget-half']);
  });
});