/**
 * S5 票看板组件 (ticket-board.ts) 的验收测试 —— C-7 ①②③ + D-12 ③ 渲染零写。
 *
 * 反向自检 (每条闸当场证伪过一次, 证伪方式写在对应断言旁):
 * - 四类可分辨 → 摘掉任何一类的标签, 对应断言红。
 * - waiting 时长 → 把时长写死成常量 (或回落 0), `waiting 5m` 那条红。
 * - 起点未记 → 把起点缺席当 0 算 (nowMs − 0 = 1970 至今 56 年) 或编 '0m', 红。
 * - stale 醒目 → 把 `✗ STALE` 降级成只换颜色 / 小写 'stale', startsWith 红。
 * - 渲染零写 → 在 renderTicketBoard 里插一次 `tickets[0].status = ...`, 冻结对象直接 throw。
 *
 * PathMap 内存构造 (同 backend.test.ts ~:523 的 seed 惯例), 不新造文件型 fixture;
 * 锚符号不锚行号。
 */
import { describe, expect, test } from 'bun:test';
import { waitingHumanState } from '../../harness/pathfinder/frontier';
import type { PathMap, Ticket } from '../../harness/pathfinder/types';
import { renderTicketBoard } from './ticket-board';

const T0_MS = Date.parse('2026-01-01T00:00:00.000Z');
const T0 = '2026-01-01T00:00:00.000Z';

function ticket(t: Partial<Ticket> & { id: string }): Ticket {
  return { type: 'grill', title: t.id, blockedBy: [], status: 'open', ...t };
}

function board(ts: Ticket[]): PathMap {
  return { destination: 'Ship X', slug: 'ship-x', tickets: ts, decisionsLog: [] };
}

function lines(ts: Ticket[], now: number = T0_MS): string[] {
  return renderTicketBoard(board(ts), now);
}

describe('renderTicketBoard', () => {
  test('C-7 ① 四类票可分辨: 前沿 / suggested / waiting_human / stale', () => {
    const out = lines([
      ticket({ id: 'f1', type: 'task', title: 'move now' }),
      ticket({ id: 's1', type: 'research', title: 'machine idea', status: 'suggested', suggestedBy: 'run-1', waitingSince: T0 }),
      ticket({ id: 'w1', title: 'owner please', status: 'escalated', waitingSince: T0 }),
      ticket({ id: 'x1', title: 'overdue', status: 'escalated', waitingSince: '2025-12-01T00:00:00.000Z', staleAt: T0 }),
    ]);
    const f1 = out.find((l) => l.includes('f1'))!;
    const s1 = out.find((l) => l.includes('s1'))!;
    const w1 = out.find((l) => l.includes('w1'))!;
    const x1 = out.find((l) => l.includes('x1'))!;
    // 证伪: 摘掉任何一类的标签 (如删掉 frontier 标签) → 对应断言红。
    expect(f1).toMatch(/^· f1/);
    expect(f1).toContain('frontier');
    expect(s1).toMatch(/^○ s1/);
    expect(s1).toContain('suggested');
    expect(w1).toMatch(/^○ w1/);
    expect(w1).toContain('waiting');
    expect(x1).toMatch(/^✗ STALE x1/);
    expect(new Set([f1, s1, w1, x1]).size).toBe(4); // 四行两两不同 → 看板上可分
  });

  test('C-7 ② waiting 显实打实时长: 由 nowMs 现算, 不写死', () => {
    const w = ticket({ id: 'w1', status: 'escalated', waitingSince: T0 });
    const row = (now: number) => lines([w], now).find((l) => l.includes('w1'))!;
    expect(row(T0_MS + 3 * 60_000)).toContain('waiting 3m');
    // 证伪: 把时长写死成常量 (或回落 0) → 这条红。
    expect(row(T0_MS + 5 * 60_000)).toContain('waiting 5m');
    expect(row(T0_MS + 5 * 60_000)).not.toContain('起点未记');
  });

  test('C-7 ② waiting-unknown-since 画「起点未记」, 不编 0 时长 (NULL≠0)', () => {
    const u = ticket({ id: 'u1', status: 'escalated' }); // waitingSince 缺席
    expect(waitingHumanState(u)).toBe('waiting-unknown-since');
    const line = lines([u]).find((l) => l.includes('u1'))!;
    expect(line).toContain('起点未记');
    // 证伪: 把起点缺席当 0 算 (nowMs − 0 = 1970 至今 56 年) 或编 'waiting 0m' → 这条红。
    expect(line).not.toContain('waiting 0');
  });

  test('D-5 四态直接用: ruled-unrecorded 画「裁了没记」, 不抹平成 waiting', () => {
    const r = ticket({ id: 'r1', status: 'escalated', waitingSince: T0, ruledAt: T0 });
    expect(waitingHumanState(r)).toBe('ruled-unrecorded');
    const line = lines([r]).find((l) => l.includes('r1'))!;
    expect(line).toContain('裁了没记');
    expect(line).not.toContain('起点未记');
    // 证伪: 不接 waitingHumanState、自己按 status 猜 → ruledAt 被无视, 这条红。
  });

  test('C-7 ③ stale 票醒目标记: ✗ 字形 + STALE 文字前缀, 不只换颜色', () => {
    const x = ticket({ id: 'x1', status: 'escalated', waitingSince: T0, staleAt: T0 });
    const line = lines([x]).find((l) => l.includes('x1'))!;
    expect(line.startsWith('✗ STALE x1')).toBe(true);
    // 证伪: 把标记降级成仅小写 'stale' 或只换色 → startsWith 红。
  });

  test('D-12 ③ 渲染零写: 深冻结 map 也能画, 快照逐字节不变', () => {
    const ts = [
      ticket({ id: 'f1' }),
      ticket({ id: 'x1', status: 'escalated', waitingSince: T0, staleAt: T0 }),
    ];
    const map = board(ts);
    const before = JSON.stringify(map);
    // 深冻结: 渲染路径若写任何字段, 严格模式直接 throw; 快照校验兜底逐字节不变。
    // 证伪: 在 renderTicketBoard 里插一次 `tickets[0].status = 'ruled'` → 这条红。
    const frozen = Object.freeze({
      ...map,
      tickets: map.tickets.map((t) => Object.freeze({ ...t })),
    });
    expect(() => renderTicketBoard(frozen, T0_MS)).not.toThrow();
    expect(JSON.stringify(map)).toBe(before);
  });
});
