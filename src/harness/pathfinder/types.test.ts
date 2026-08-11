import { describe, expect, test } from 'bun:test';
import { declaredTicketClass, isRulingTicket } from './types';
import type {
  DispatchableTicket,
  ExecutorKind,
  PathMap,
  RulingTicket,
  Ticket,
  TicketClass,
  TicketStatus,
  TicketType,
} from './types';

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

/**
 * D-3 票语义三类 (SDD `docs/plan/2026-08-11-control-plane-unification.md`, INV-2)。
 * 这里锁的是**类型层的分家**: 裁决票进得了地图, 进不了派发口。
 * G-6 反向自检写在各 test 里 —— 类型层那条靠 `@ts-expect-error` (改宽即 TS2578 红)。
 */
const TICKET_CLASSES = ['question', 'task', 'ruling'] as const satisfies readonly TicketClass[];

describe('D-3 票语义三类 + 裁决票分家 (INV-2)', () => {
  const base: Ticket = { id: 't1', type: 'grill', title: '定 schema', blockedBy: [], status: 'open' };
  const ruling: RulingTicket = { ...base, id: 'g9', ticketClass: 'ruling' };

  test('TicketClass = 问题票/任务票/裁决票 三值 (不抹平)', () => {
    expect([...TICKET_CLASSES].sort()).toEqual(['question', 'ruling', 'task']);
  });

  test('裁决票**是** Ticket (进得了 PathMap.tickets) —— 闸不许把它挡在地图外', () => {
    const map: PathMap = { destination: 'X', slug: 'x', tickets: [ruling], decisionsLog: [] };
    expect(map.tickets[0]!.id).toBe('g9');
    expect(isRulingTicket(map.tickets[0]!)).toBe(true);
  });

  test('裁决票**不是** DispatchableTicket (类型层拒, @ts-expect-error 钉死)', () => {
    // 证伪 (G-6): 把 DispatchableTicket 的 ticketClass 域放宽到 TicketClass (含 'ruling'),
    // 这行就不再报错 → @ts-expect-error 变 TS2578「未使用的抑制」→ tsc 当场红。
    // @ts-expect-error INV-2: 'ruling' 不在 DispatchableClass 域内。
    const smuggled: DispatchableTicket = ruling;
    expect(smuggled.id).toBe('g9');
  });

  test('未标类的存量票**是** DispatchableTicket (存量语义不变: 一行不改照旧可派)', () => {
    const legacy: DispatchableTicket = base; // 无 ticketClass → 收得进 (无 @ts-expect-error 即证)
    expect(declaredTicketClass(legacy)).toBeUndefined();
  });

  test('declaredTicketClass: 「没标类」= undefined, 与显式 task 分开 (NULL≠0)', () => {
    // 证伪: 若实现把缺省填成 'task', 这两行读数相同 —— 「这张票没标」与「标了任务票」
    // 就此抹平, 后续再也分不开 (本仓 NULL≠0 那条踩过的形状)。
    expect(declaredTicketClass(base)).toBeUndefined();
    expect(declaredTicketClass({ ...base, ticketClass: 'task' } as Ticket)).toBe('task');
    expect(declaredTicketClass(ruling)).toBe('ruling');
  });

  test('declaredTicketClass: 词表外的值原样返回给闸判 (真相文件人可手改, 不静默归零)', () => {
    // 证伪: 若实现把词表外的值归成 undefined, 手滑的 'rulingg' 就变"未标类"= 可派 —— 越权静默发生。
    expect(declaredTicketClass({ ...base, ticketClass: 'rulingg' } as unknown as Ticket)).toBe('rulingg');
    expect(isRulingTicket({ ...base, ticketClass: 'rulingg' } as unknown as Ticket)).toBe(false);
  });
});
