import { describe, expect, test } from 'bun:test';
import {
  computeFrontier,
  deriveStatus,
  isWaitingHumanStatus,
  markWaitingHuman,
  sweepWaitingHuman,
  waitingHumanState,
  WAITING_HUMAN_TIMEOUT_MS,
} from './frontier';
import type { PathMap, Ticket } from './types';

/** 造票的便捷工厂 (默认 open + 无前置)。 */
function ticket(partial: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'grill', title: partial.id, blockedBy: [], status: 'open', ...partial };
}
function mapOf(tickets: Ticket[]): PathMap {
  return { destination: 'D', slug: 'd', tickets, decisionsLog: [] };
}

describe('frontier', () => {
  test('无前置的 open 票直接进前沿', () => {
    const m = mapOf([ticket({ id: 'a' }), ticket({ id: 'b' })]);
    expect(computeFrontier(m).map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  test('blocked → 前置裁决后解锁进前沿', () => {
    const before = mapOf([
      ticket({ id: 'a', status: 'open' }),
      ticket({ id: 'b', blockedBy: ['a'] }),
    ]);
    // a 未裁 → b 不在前沿
    expect(computeFrontier(before).map((t) => t.id)).toEqual(['a']);
    // a 裁决 → b 解锁
    const after = mapOf([
      ticket({ id: 'a', status: 'ruled', ruling: 'yes' }),
      ticket({ id: 'b', blockedBy: ['a'] }),
    ]);
    expect(computeFrontier(after).map((t) => t.id)).toEqual(['b']);
  });

  test('ruled / escalated 票不在前沿', () => {
    const m = mapOf([
      ticket({ id: 'a', status: 'ruled' }),
      ticket({ id: 'b', status: 'escalated' }),
      ticket({ id: 'c', status: 'open' }),
    ]);
    expect(computeFrontier(m).map((t) => t.id)).toEqual(['c']);
  });

  test('多前置: 全裁才解锁', () => {
    const m = mapOf([
      ticket({ id: 'a', status: 'ruled' }),
      ticket({ id: 'b', status: 'open' }),
      ticket({ id: 'c', blockedBy: ['a', 'b'] }),
    ]);
    expect(computeFrontier(m).map((t) => t.id)).toEqual(['b']); // c 仍缺 b
  });

  test('自展开: children 不 block parent (children 开着 parent 照进前沿)', () => {
    const m = mapOf([
      ticket({ id: 'parent', type: 'research', children: ['kid1', 'kid2'] }),
      ticket({ id: 'kid1', status: 'open' }),
      ticket({ id: 'kid2', status: 'open' }),
    ]);
    // parent 的 blockedBy 为空 → children 开着也不影响
    expect(computeFrontier(m).map((t) => t.id)).toContain('parent');
  });

  test('未知 blockedBy id 容忍 (当作未满足, 不崩)', () => {
    const m = mapOf([ticket({ id: 'a', blockedBy: ['ghost'] })]);
    expect(() => computeFrontier(m)).not.toThrow();
    expect(computeFrontier(m)).toEqual([]); // ghost 永不 ruled → a 永 blocked
  });

  test('环容忍: A↔B 互相 block 不死循环', () => {
    const m = mapOf([
      ticket({ id: 'a', blockedBy: ['b'] }),
      ticket({ id: 'b', blockedBy: ['a'] }),
    ]);
    expect(() => computeFrontier(m)).not.toThrow();
    expect(computeFrontier(m)).toEqual([]); // 谁都没裁 → 谁都不在前沿
  });
});

describe('deriveStatus', () => {
  test('前置全裁 → open, 否则 blocked', () => {
    const ruled = new Set(['a']);
    expect(deriveStatus(ticket({ id: 'x', blockedBy: ['a'] }), ruled)).toBe('open');
    expect(deriveStatus(ticket({ id: 'y', blockedBy: ['a', 'z'] }), ruled)).toBe('blocked');
    expect(deriveStatus(ticket({ id: 'z' }), ruled)).toBe('open'); // 无前置
  });

  test('已 ruled / escalated 原样返回', () => {
    const ruled = new Set<string>();
    expect(deriveStatus(ticket({ id: 'x', status: 'ruled' }), ruled)).toBe('ruled');
    expect(deriveStatus(ticket({ id: 'y', status: 'escalated' }), ruled)).toBe('escalated');
  });

  test('未知前置当作未满足 → blocked', () => {
    expect(deriveStatus(ticket({ id: 'x', blockedBy: ['ghost'] }), new Set())).toBe('blocked');
  });
});

// ── D-5 / G-5: waiting_human = 带有限超时的一等状态 ─────────────────────────────
// 反向自检总纲 (本仓惯例: 每条闸都要证明它真的会红) —— 每组"该升级"臂都配一个
// "不该升级"对照臂, 两臂同一把尺子。实跑证伪见各 test 内注释。

const T0 = '2026-08-08T00:00:00.000Z';
const H = 3600_000;
/** T0 之后 h 小时的 ISO 时刻。 */
const at = (h: number): string => new Date(Date.parse(T0) + h * H).toISOString();

/** 造一张"在等人裁"的票 (默认 escalated + 已记进入时刻 T0)。 */
function waiting(partial: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'grill', title: partial.id, blockedBy: [], status: 'escalated', waitingSince: T0, ...partial };
}

describe('D-5 waiting_human —— 挂在现状的两个"等人"出口上, 不发明平行状态机', () => {
  test('等人 = suggested ∪ escalated (fog.ts 早就把这两态并作"只差 owner 一个动作")', () => {
    expect(isWaitingHumanStatus('suggested')).toBe(true);
    expect(isWaitingHumanStatus('escalated')).toBe(true);
    // 反向臂: 其余状态一律不算等人 —— 否则 open 票也会被 72h 判超时, 尺子就废了。
    for (const s of ['open', 'blocked', 'ruled', 'delivered'] as const) expect(isWaitingHumanStatus(s)).toBe(false);
  });

  test('缺省超时 = 72h (O-1 未裁前的探索值, 可由调用方覆盖)', () => {
    expect(WAITING_HUMAN_TIMEOUT_MS).toBe(72 * H);
  });

  test('markWaitingHuman: 打进入戳, 并清掉上一轮的 stale 标 (新等待窗口不顺延旧标)', () => {
    const t = waiting({ id: 'a', waitingSince: T0, staleAt: at(72) });
    markWaitingHuman(t, at(100));
    expect(t.waitingSince).toBe(at(100));
    expect(t.staleAt).toBeUndefined(); // 反向自检: 不清的话下一轮永远不会再升级 (幂等闸把它挡掉)
  });
});

describe('G-5 超时升级 —— 超 72h 触发, 台账可读', () => {
  test('G-5 超 72h 的等人票 → 标 stale + 台账留痕 (谁超时 / 等了多久 / 何时标的)', () => {
    const t = waiting({ id: 'esc-1' });
    const m = mapOf([t]);
    const fired = sweepWaitingHuman(m, { now: at(73) });
    expect(fired).toEqual([{ ticketId: 'esc-1', waitingSince: T0, waitedMs: 73 * H, at: at(73) }]);
    expect(t.staleAt).toBe(at(73)); // 何时标的
    expect(m.waitingLog).toEqual([{ ticketId: 'esc-1', waitingSince: T0, waitedMs: 73 * H, at: at(73) }]);
  });

  test('G-5 反向自检: 71h59m 的同一张票不升级 —— 阈值真的在判, 不是恒真', () => {
    // 实跑证伪: 把 sweep 里的 `waitedMs < timeoutMs` 去掉 → 本例转红 (fired 长度 1)。
    const t = waiting({ id: 'esc-1' });
    const m = mapOf([t]);
    expect(sweepWaitingHuman(m, { now: at(71.9833) })).toEqual([]);
    expect(t.staleAt).toBeUndefined();
    expect(m.waitingLog).toBeUndefined(); // 没触发就不该有台账行 (空数组也不写)
  });

  test('可配超时: timeoutMs 覆盖缺省 72h (1h 阈值下 2h 的票就超)', () => {
    const m = mapOf([waiting({ id: 'esc-1' })]);
    expect(sweepWaitingHuman(m, { now: at(2), timeoutMs: 1 * H }).map((e) => e.ticketId)).toEqual(['esc-1']);
  });

  test('不在等人的票永不被升级 (open/ruled 票带着旧戳也一样)', () => {
    const m = mapOf([
      { ...waiting({ id: 'open-1' }), status: 'open' },
      { ...waiting({ id: 'ruled-1' }), status: 'ruled', ruling: 'done' },
    ]);
    expect(sweepWaitingHuman(m, { now: at(999) })).toEqual([]);
  });

  test('幂等: 二次 sweep 不重复标 stale, 台账不重复长', () => {
    const m = mapOf([waiting({ id: 'esc-1' })]);
    expect(sweepWaitingHuman(m, { now: at(73) })).toHaveLength(1);
    expect(sweepWaitingHuman(m, { now: at(200) })).toEqual([]); // 已标过 → 不再触发
    expect(m.waitingLog).toHaveLength(1);
    expect(m.tickets[0]!.staleAt).toBe(at(73)); // 首次标的时刻不被覆写
  });
});

describe('G-5 NULL≠0 —— 「没人裁」/「裁了没记」/「没记进入时刻」三件事不许抹平', () => {
  test('G-5 NULL≠0 反向自检 (epoch 陷阱): 没记进入时刻的等人票不当成 0 时刻', () => {
    // 若实现把缺席的 waitingSince 当 0 (1970), 这张票会立刻"超时 56 年" → 本例转红。
    // 实跑证伪: 把 waitingHumanState 的 since===undefined 分支改成 `since = 0` → fired 长度 1, 红。
    const t = waiting({ id: 'no-stamp', waitingSince: undefined });
    const m = mapOf([t]);
    expect(waitingHumanState(t)).toBe('waiting-unknown-since');
    expect(sweepWaitingHuman(m, { now: at(9999) })).toEqual([]); // fail-safe: 不知道等了多久就不升级
    expect(t.staleAt).toBeUndefined();
  });

  test('G-5 NULL≠0: 「没记进入时刻」≠「不在等人」—— 两者是不同的读数', () => {
    // 另一侧的抹平: 把无戳的等人票判成 not-waiting, 它就从"待人的活"里静默消失了。
    expect(waitingHumanState(waiting({ id: 'a', waitingSince: undefined }))).toBe('waiting-unknown-since');
    expect(waitingHumanState({ ...waiting({ id: 'b' }), status: 'open' })).toBe('not-waiting');
    // 坏戳 (真相文件人可手改) 归入同一类: 同样是"算不出等了多久", 同样不升级。
    expect(waitingHumanState(waiting({ id: 'c', waitingSince: 'yesterday-ish' }))).toBe('waiting-unknown-since');
  });

  test('G-5 NULL≠0: 「没人裁」不得被记成「裁了没记」(有进入戳 + 无裁决戳 = 没人裁)', () => {
    // 实跑证伪: 把 waitingHumanState 里 ruledAt 的判断去掉并一律返回 'ruled-unrecorded' → 本例转红。
    const t = waiting({ id: 'nobody-ruled' });
    expect(t.ruledAt).toBeUndefined();
    expect(waitingHumanState(t)).toBe('waiting');
    const m = mapOf([t]);
    expect(sweepWaitingHuman(m, { now: at(73) }).map((e) => e.ticketId)).toEqual(['nobody-ruled']); // 该催的还得催
  });

  test('G-5 NULL≠0: 「裁了没记」(ruledAt ≥ waitingSince 却仍挂等人态) 可读, 且不催人', () => {
    // 人已经裁了, 只是状态没落回盘 —— 催他没意义, 但这条读数必须留着 (盘上有裂缝)。
    // 实跑证伪: 把 'ruled-unrecorded' 并进 'waiting' → sweep 会把它一起升级, 本例转红。
    const t = waiting({ id: 'ruled-lost', ruledAt: at(1), ruling: '就按方案 B' });
    expect(waitingHumanState(t)).toBe('ruled-unrecorded');
    const m = mapOf([t]);
    expect(sweepWaitingHuman(m, { now: at(999) })).toEqual([]);
  });

  test('G-5 NULL≠0: 上一轮等待的旧裁决不算「裁了没记」(ruledAt < waitingSince → 仍是没人裁)', () => {
    // 票被裁过 → 又重新升人 (backend.escalate 不清 ruling)。判据是**时刻先后**, 不是"有没有判词"。
    const t = waiting({ id: 'reopened', ruling: '上一轮的判词', ruledAt: at(-10), waitingSince: T0 });
    expect(waitingHumanState(t)).toBe('waiting');
    expect(sweepWaitingHuman(mapOf([t]), { now: at(73) })).toHaveLength(1);
  });
});

describe('D-5 提醒钩子 —— 只留接口, 本切片不实装任何通道 (O-1 未裁)', () => {
  test('超时票逐张回调一次, 未超时的不回调', () => {
    const seen: string[] = [];
    const m = mapOf([waiting({ id: 'old' }), waiting({ id: 'fresh', waitingSince: at(72.5) })]);
    sweepWaitingHuman(m, { now: at(73), notify: (e) => seen.push(e.ticketId) });
    expect(seen).toEqual(['old']);
  });

  test('钩子抛错不回滚已写的 stale 标 (fail-open 吞异常, 但证据留在 stderr)', () => {
    const m = mapOf([waiting({ id: 'esc-1' })]);
    const fired = sweepWaitingHuman(m, {
      now: at(73),
      notify: () => {
        throw new Error('通道炸了');
      },
    });
    expect(fired).toHaveLength(1);
    expect(m.tickets[0]!.staleAt).toBe(at(73)); // 通道的死活不许影响盘上真源 (INV-1)
    expect(m.waitingLog).toHaveLength(1);
  });
});
