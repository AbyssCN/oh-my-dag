import { describe, expect, test } from 'bun:test';
import { computeFrontier, deriveStatus } from './frontier';
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
