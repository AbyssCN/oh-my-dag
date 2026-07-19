import { describe, expect, test } from 'bun:test';
import type { ExecutorKind, PathMap, Ticket, TicketStatus, TicketType } from './types';

/**
 * 数据模型形状契约 (SDD §数据模型 verbatim): 字段不增不减, 枚举值不增。
 * 类型在运行时擦除 → 用全类型构造 (编译期 satisfies) + Object.keys (运行期) 双向锁形状。
 * TicketStatus 第五值 'delivered' 由 D-14 追认 (2026-07-20 owner 裁决, 原 SDD 四值模型漏列)。
 */

const TICKET_TYPES = ['research', 'grill', 'prototype', 'task'] as const satisfies readonly TicketType[];
const TICKET_STATUSES = ['open', 'blocked', 'ruled', 'delivered', 'escalated'] as const satisfies readonly TicketStatus[];
const EXECUTOR_KINDS = ['command', 'inproc', 'agent', 'map', 'primitive'] as const satisfies readonly ExecutorKind[];

describe('types (SDD §数据模型)', () => {
  test('TicketType = SDD 四值 (D-9)', () => {
    expect([...TICKET_TYPES].sort()).toEqual(['grill', 'prototype', 'research', 'task']);
  });

  test('TicketStatus = SDD 四值 + delivered 终态 (D-14)', () => {
    expect([...TICKET_STATUSES].sort()).toEqual(['blocked', 'delivered', 'escalated', 'open', 'ruled']);
  });

  test('ExecutorKind = SDD 五值 (不发明新 kind)', () => {
    expect([...EXECUTOR_KINDS].sort()).toEqual(['agent', 'command', 'inproc', 'map', 'primitive']);
  });

  test('Ticket 必填字段 = id/type/title/blockedBy/status, 不增不减', () => {
    const minimal: Ticket = { id: 't1', type: 'grill', title: '?', blockedBy: [], status: 'open' };
    expect(Object.keys(minimal).sort()).toEqual(['blockedBy', 'id', 'status', 'title', 'type']);
  });

  test('Ticket 可选字段 = ruling/executorKind/children/dNumber (SDD 列全)', () => {
    const full: Ticket = {
      id: 't2',
      type: 'task',
      title: '施工',
      blockedBy: ['t1'],
      status: 'ruled',
      ruling: '按 D-7 拆',
      executorKind: 'command',
      children: ['t3'],
      dNumber: 'D-7',
    };
    expect(Object.keys(full).sort()).toEqual([
      'blockedBy', 'children', 'dNumber', 'executorKind', 'id', 'ruling', 'status', 'title', 'type',
    ]);
  });

  test('PathMap 字段 = destination/slug/tickets/decisionsLog, 不增不减', () => {
    const map: PathMap = {
      destination: 'pathfinder 模式',
      slug: 'pathfinder-mode',
      tickets: [],
      decisionsLog: [{ ticketId: 't1', gist: '裁: 是' }],
    };
    expect(Object.keys(map).sort()).toEqual(['decisionsLog', 'destination', 'slug', 'tickets']);
    expect(Object.keys(map.decisionsLog[0]!).sort()).toEqual(['gist', 'ticketId']);
  });

  test('四票型 × 全 executorKind 均可构造 (类型驱动分派, D-9)', () => {
    const tickets: Ticket[] = TICKET_TYPES.flatMap((type, i) =>
      EXECUTOR_KINDS.map((executorKind, j) => ({
        id: `t${i}-${j}`, type, title: type, blockedBy: [] as string[], status: 'open' as const, executorKind,
      })),
    );
    expect(tickets).toHaveLength(20);
  });
});
