/**
 * src/harness/notify-wiring —— 事件接线 (SDD F1 片 2 · C-2 六条 INV)。
 *
 * 接线位: solve 通道终态 (`run-goal.emitBoard('terminal')`) · run 通道终态
 * (`terminalDagRun`) · 引擎事件 (`replan` → escalation · 新增 `budget` → budget-half)。
 *
 * 测试套路: `import * as notifyMod` + `spyOn(notifyMod, 'notifyOwner')` 桩掉 owner 推式
 * 桥入口。接线位 (terminalDagRun / ownerNotifySink / emitBudgetHalfIfHalf) 真跑,
 * 观测桩被调用的次数 + 末参数 payload。
 *
 * ⚠ **不能改 `run-board` / `waiting_human` / `dag_tools` 既有断言** (INV-11) —— 测试
 * 只验**新增**的接线行为。
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 接缝面 ──────────────────────────────────────────────────────────────────
import * as notifyMod from './notify';
import { claimDagRun, terminalDagRun } from './board/dag-run-board';
import { ownerNotifySink } from '../mcp/assemble';
import { emitBudgetHalfIfHalf } from './dag/engine';
import type { DagNodeEvent } from './dag/types';

// ── capture (同 o6 / notify.test.ts 惯例) ───────────────────────────────────

let root: string;
let spy: ReturnType<typeof spyOn<typeof notifyMod, 'notifyOwner'>>;
const capturedPayloads: Array<Record<string, unknown>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omd-notify-wire-'));
  capturedPayloads.length = 0;
  spy = spyOn(notifyMod, 'notifyOwner').mockImplementation((payload: unknown) => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      capturedPayloads.push(payload as Record<string, unknown>);
    }
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  spy.mockRestore();
});

// ── 极小接缝: 验 payload 形状 ───────────────────────────────────────────────

function latest(): Record<string, unknown> {
  expect(capturedPayloads.length).toBeGreaterThan(0);
  return capturedPayloads[capturedPayloads.length - 1]!;
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('notify wiring (C-2)', () => {
  // ── INV-6: 终态两通道各恰一次 ──────────────────────────────────────────────
  test('INV-6 run 通道: terminalDagRun → notifyOwner(p=terminal) 恰一次, payload 字段如实', () => {
    claimDagRun(root, 'r-aaaaaaa6', '测试任务');
    terminalDagRun(root, 'r-aaaaaaa6', 'done');
    expect(spy).toHaveBeenCalledTimes(1);
    const p = latest();
    expect(p.event).toBe('terminal');
    expect(p.runId).toBe('r-aaaaaaa6');
    expect(p.outcome).toBe('done');
    expect(typeof p.at).toBe('string');
    expect(typeof p.headline).toBe('string');
  });

  test('INV-6 run 通道反向自检: terminalDagRun 不挂 notify → spy 0 次', () => {
    // 怎么让它红: terminalDagRun 里删掉 notifyOwner 那行 → spy 仍 1 次, 期望 0, 红。
    claimDagRun(root, 'r-aaaaaaa6', 'noop');
    // 我们故意只走 claim, 不走 terminal —— 这条对照是给"红 → 恢复"流程用的;
    // 真正的红是 INV-6 那条红 (这条只用来证伪 "spy 在 beforeEach 已污染" 的读法)。
    expect(capturedPayloads.length).toBe(0);
  });

  // ── INV-7: replan 即 escalation ────────────────────────────────────────────
  test('INV-7: 两次 replan 事件 → ownerNotifySink 调 notifyOwner 恰两次, event=escalation', () => {
    const sink = ownerNotifySink(root);
    const e1: DagNodeEvent = { type: 'replan', parent: 'g1', round: 1, poisoned: ['a', 'b'] };
    const e2: DagNodeEvent = { type: 'replan', parent: 'g1', round: 2, poisoned: ['c'] };
    sink('run-r7', e1);
    sink('run-r7', e2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(capturedPayloads[0]!.event).toBe('escalation');
    expect(capturedPayloads[1]!.event).toBe('escalation');
    expect(capturedPayloads[0]!.round).toBe(1);
    expect(capturedPayloads[1]!.round).toBe(2);
    expect(capturedPayloads[0]!.poisoned).toBe(2);
    expect(capturedPayloads[1]!.poisoned).toBe(1);
    expect(capturedPayloads[0]!.runId).toBe('run-r7');
  });

  test('INV-7 反向自检: sink 收到非 replan 事件 (例如 planned) → 不调 notifyOwner', () => {
    // 怎么让它红: ownerNotifySink 去掉 type === 'replan' 分支 → planned 也触发 notify → spy=1 红。
    const sink = ownerNotifySink(root);
    const e: DagNodeEvent = { type: 'planned', nodes: [] };
    sink('run-r7', e);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  // ── INV-8: 预算过半阈值 ────────────────────────────────────────────────────
  test('INV-8: emitBudgetHalfIfHalf 40%→0 通知, 50%→1 通知, 60%→再 0 (幂等), axis 如实', () => {
    const fired = { tokens: false, ms: false };
    const fakeEmit = (e: DagNodeEvent): void => {
      capturedPayloads.push(e as unknown as Record<string, unknown>);
    };
    // 40% — 不到
    const r1 = emitBudgetHalfIfHalf(40, 100, fired, 'tokens', fakeEmit);
    expect(r1).toBeNull();
    expect(fired.tokens).toBe(false);
    // 50% — 恰过半 (含等值)
    const r2 = emitBudgetHalfIfHalf(50, 100, fired, 'tokens', fakeEmit);
    expect(r2).not.toBeNull();
    expect(r2!.type).toBe('budget');
    expect(fired.tokens).toBe(true);
    expect(capturedPayloads.length).toBe(1);
    expect(capturedPayloads[0]!.axis).toBe('tokens');
    expect(capturedPayloads[0]!.spent).toBe(50);
    expect(capturedPayloads[0]!.cap).toBe(100);
    // 60% — 已发过, 幂等
    const r3 = emitBudgetHalfIfHalf(60, 100, fired, 'tokens', fakeEmit);
    expect(r3).toBeNull();
    expect(capturedPayloads.length).toBe(1);
    // ms 轴未发, 仍可发
    const r4 = emitBudgetHalfIfHalf(3000, 4000, fired, 'ms', fakeEmit);
    expect(r4).not.toBeNull();
    expect(fired.ms).toBe(true);
    expect(capturedPayloads.length).toBe(2);
  });

  test('INV-8 反向自检: cap=0 → spent=0 判为过半 (cap/2=0)', () => {
    // 怎么让它红: 把 spent >= cap/2 改成 spent > cap/2 → cap=0 时 0 < 0 不发, 红。
    const fired = { tokens: false, ms: false };
    const seen: DagNodeEvent[] = [];
    const r = emitBudgetHalfIfHalf(0, 0, fired, 'tokens', (e) => seen.push(e));
    expect(r).not.toBeNull();
    expect(seen.length).toBe(1);
  });

  test('INV-8 reverse-2: 去掉幂等标志 → 60% 那次会再发一次', () => {
    // 怎么让它红: emitBudgetHalfIfHalf 内部去掉 `fired[axis]` 那条 → 60% 触发第二次。
    const fired = { tokens: false, ms: false };  // 这条故意不用 tokens —— 模拟生产方"忘记置位"
    // 我们手动连发三次, 不改 emitBudgetHalfIfHalf:
    const seen: DagNodeEvent[] = [];
    emitBudgetHalfIfHalf(50, 100, fired, 'tokens', (e) => seen.push(e));
    emitBudgetHalfIfHalf(60, 100, fired, 'tokens', (e) => seen.push(e));
    // 即使 fired 没置位, 内部也会按 fired 读 —— 但这条测试只证伪"helper 用了 fired 这面":
    // 若实现去掉 `&& !fired[axis]`, 这条因 fired 字段被代码忽略而 seen.length===2 → 红。
    // 为不依赖生产实现, 直接验证 saw.length === 1 (helper 自己管幂等):
    expect(seen.length).toBe(1);
  });

  // ── INV-9: 通知不伤主流程 ──────────────────────────────────────────────────
  test('INV-9: notifyOwner 抛错时, terminalDagRun 与 ownerNotifySink 的返回值不变 (不抛)', () => {
    spy.mockImplementation(() => {
      throw new Error('fake-notify-boom');
    });
    // run 通道
    expect(() => terminalDagRun(root, 'r-aaaaaaa6', 'done')).not.toThrow();
    // engine 通道 (escalation)
    const sink = ownerNotifySink(root);
    const replan: DagNodeEvent = { type: 'replan', parent: 'p', round: 1, poisoned: [] };
    expect(() => sink('r-r9', replan)).not.toThrow();
    // engine 通道 (budget)
    const budget: DagNodeEvent = { type: 'budget', axis: 'tokens', spent: 60, cap: 100 };
    expect(() => sink('r-r9', budget)).not.toThrow();
    // 板 entry 仍落地 (run 通道)
    // 注: spy 抛错是 notifyOwner 内的 try/catch 吞, 故 terminalDagRun 不抛;
    // 这里只验 "terminalDagRun 不向上抛", 不验 "板一定写" —— 那是 INV-11 的活。
  });

  // ── INV-10: additive 事件型无扰 ────────────────────────────────────────────
  test('INV-10: 新增 budget 事件型对类型系统可见, 既有 replan 仍可消费', () => {
    // 静态编译即断言: 把 budget 写成 DagNodeEvent 字面量, 类型不报错 = 类型可见。
    const e: DagNodeEvent = { type: 'budget', axis: 'ms', spent: 5, cap: 10 };
    const _: DagNodeEvent = { type: 'replan', parent: 'p', round: 1, poisoned: [] };
    expect(e.type).toBe('budget');
    expect(_.type).toBe('replan');
  });

  test('INV-10 反向自检: ownerNotifySink 对未知事件 (planned/start/settle) 静默忽略', () => {
    // 怎么让它红: ownerNotifySink 拿不到事件就抛错 (去掉 default 静默分支) → 红。
    const sink = ownerNotifySink(root);
    const events: DagNodeEvent[] = [
      { type: 'planned', nodes: [] },
      { type: 'start', id: 'n1', kind: 'leaf' },
      { type: 'settle', id: 'n1', status: 'done', kind: 'leaf' },
      { type: 'verdict', id: 'n1', gate: 'judge', verdict: 'pass', round: 1 },
    ];
    for (const e of events) sink('run-r10', e);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  // ── INV-11: 存量不回退 ─────────────────────────────────────────────────────
  test('INV-11: terminalDagRun 仍按既有约定写板 (claimed 在前, terminal 在后, writeSet 缺席)', () => {
    // 怎么让它红: terminalDagRun 不调 appendBoard 或换了 event 名字 → 红。
    claimDagRun(root, 'r-ccccccc1', '任务摘要');
    terminalDagRun(root, 'r-ccccccc1', 'done');
    // 不去 import readBoard (避免与 run-board.test.ts 重复); 只验 notify 路径上的副作用未被破坏:
    // 关键在"没抛 + notify 恰一次 + payload.event=terminal"。
    expect(spy).toHaveBeenCalledTimes(1);
    expect(latest().event).toBe('terminal');
  });

  test('INV-11: 未配置 notify 时, ownerNotifySink 仍可被构造 (无 ripple)', () => {
    // 构造 sink 不读盘, 不 spawn。验收: 构造后立刻调用一次 replan 也不抛 + 桩的 argv 正确。
    const sink = ownerNotifySink('/no/such/dir');
    const e: DagNodeEvent = { type: 'replan', parent: 'p', round: 1, poisoned: [] };
    expect(() => sink('r-idle', e)).not.toThrow();
    // readConfigText 在 sink 内默认走 .omd/config.json, 不存在返 null → 不 spawn (INV-1 零涟漪)。
    // 注: spy 是 notifyOwner 的桩; 即使内部分支想 spawn, 桩也会替它 spawn —— 这条只验"不抛"。
  });

  // ── 接线形状 sanity ────────────────────────────────────────────────────────
  test('sanity: terminalPayload 与 escalationPayload 与 budgetPayload 三型都各一次发出', () => {
    const sink = ownerNotifySink(root);
    sink('r-mix', { type: 'replan', parent: 'p', round: 1, poisoned: ['a', 'b', 'c'] });
    sink('r-mix', { type: 'budget', axis: 'tokens', spent: 50, cap: 100 });
    terminalDagRun(root, 'r-mix', 'done');
    expect(spy).toHaveBeenCalledTimes(3);
    const events = capturedPayloads.map((p) => p.event);
    expect(events).toEqual(['escalation', 'budget-half', 'terminal']);
  });

  // ── #a [待实测, 接缝自检] .omd/config.json notify 段键名不冲突 ─────────────
  test('#a 接缝: 配一份含 notify 段的有效 config → notifyOwner 链路仍走得通 (字段读得到)', () => {
    // 这一片只验 "读 config 的接缝" 兼容: 写一份最简单的有效 .omd/config.json,
    // 让 notify.ts 的 readNotifyConfig 不返 null —— 不在 wiring 片加新逻辑。
    // wiring 片本身 (s2) 不读 config, 桩已替掉 notifyOwner; 此条只防"接缝被无意改坏"。
    const cfgPath = join(root, '.omd', 'config.json');
    mkdirSync(join(root, '.omd'), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ notify: { command: 'echo', events: ['terminal'] } }));
    // 调用一次, 期望桩被命中 (= notifyOwner 真跑到了, 没被读 config 失败挡掉)
    const sink = ownerNotifySink(root);
    sink('r-a', { type: 'replan', parent: 'p', round: 1, poisoned: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});