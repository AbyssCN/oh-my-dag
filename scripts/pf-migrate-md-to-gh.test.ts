/**
 * scripts/pf-migrate-md-to-gh.test —— 迁移件纯核的闸 (零 gh 零盘)。
 *
 * 三条闸各自的**证伪方式** (本仓纪律: 一条永远绿的闸不是闸):
 *  - 拓扑序: 把 planMigration 里的 Kahn 换成 `map.tickets` 原序 → 「前置排在它前面」当场红。
 *  - 成环/悬空: 去掉两处 throw → 对应用例从 toThrow 变成静默产出半张计划。
 *  - diffMaps: 把 cmp 的 `!==` 写成 `===` → 「状态搬错要被抓到」变绿而它不该绿。
 */
import { describe, expect, test } from 'bun:test';
import { diffMaps, normalizeDerived, planMigration, remap, ticketBody, ticketsNeedingRuling } from './pf-migrate-md-to-gh';
import type { PathMap, Ticket } from '../src/harness/pathfinder/types';

const tk = (id: string, over: Partial<Ticket> = {}): Ticket => ({ id, type: 'task', title: `票 ${id}`, blockedBy: [], status: 'open', ...over });
const mk = (tickets: Ticket[], over: Partial<PathMap> = {}): PathMap => ({ destination: '目的地', slug: 'm', tickets, decisionsLog: [], ...over });

describe('planMigration — 拓扑序', () => {
  test('每张票的前置都排在它前面 (addTicket 建原生依赖时前置必须已存在)', () => {
    const map = mk([tk('c', { blockedBy: ['b'] }), tk('a'), tk('b', { blockedBy: ['a'] })]);
    const pos = new Map(planMigration(map).order.map((p) => [p.ticket.id, p.order]));
    expect(pos.get('a')!).toBeLessThan(pos.get('b')!);
    expect(pos.get('b')!).toBeLessThan(pos.get('c')!);
  });

  test('同一张图跑两次出同一份计划 (可重放, 迁移中断能续)', () => {
    const map = mk([tk('c', { blockedBy: ['a'] }), tk('a'), tk('b', { blockedBy: ['a'] })]);
    const ids = () => planMigration(map).order.map((p) => p.ticket.id);
    expect(ids()).toEqual(ids());
  });

  test('成环 → throw 且点名环上的票 (不产半张计划)', () => {
    const map = mk([tk('a', { blockedBy: ['b'] }), tk('b', { blockedBy: ['a'] })]);
    expect(() => planMigration(map)).toThrow(/成环/);
  });

  test('悬空前置 → throw 且点名那条边', () => {
    const map = mk([tk('a', { blockedBy: ['幽灵'] })]);
    expect(() => planMigration(map)).toThrow(/幽灵/);
  });
});

describe('planMigration — 迁移前的硬拦', () => {
  test('已裁但无判词文本 → 报出票 id (gh 侧靠判词评论读回 ruled, 没文本会读成 open)', () => {
    const map = mk([tk('a', { status: 'ruled' }), tk('b', { status: 'ruled', ruling: '就这么定' }), tk('c', { status: 'delivered' })]);
    expect(planMigration(map).ruledWithoutText).toEqual(['a', 'c']);
  });

  test('损耗表数的是 gh 读不回来的字段, 不是全部字段', () => {
    const map = mk([tk('a', { dNumber: 'D-7', ruledAt: '2026-08-01T00:00:00Z' }), tk('b', { dispatch: { runId: 'r1', startedAt: 'x' } })], {
      suggestionsLog: [{ ticketId: 'a', outcome: 'added', at: 'x', runId: 'r' } as never],
    });
    expect(planMigration(map).losses).toMatchObject({ dNumber: 1, dispatch: 1, ruledAt: 1, suggestionsLog: 1 });
  });
});

describe('ticketBody — 回溯锚', () => {
  test('Origin-id 必留 (新 id 是 issue number, 旧语义 id 只活在这一行)', () => {
    expect(ticketBody(tk('task-ticket-writeset'), 'omd-mcp-server')).toContain('Origin-id: task-ticket-writeset');
  });

  test('可往返字段落 parseAnchor 认得的 `^Key: value$` 形状', () => {
    const body = ticketBody(tk('a', { suggestedBy: 'run-42', fingerprint: 'abc', waitingSince: '2026-08-11T00:00:00Z' }), 'm');
    expect(body).toMatch(/^Suggested-by: run-42$/m);
    expect(body).toMatch(/^Fingerprint: abc$/m);
    expect(body).toMatch(/^Waiting-since: 2026-08-11T00:00:00Z$/m);
  });

  test('Blocked-by 不由本函数写 (legacy 由 addTicket 拼, native 压根不写正文 — D-C 单真相)', () => {
    expect(ticketBody(tk('a', { blockedBy: ['b'] }), 'm')).not.toContain('Blocked-by');
  });
});

describe('ticketsNeedingRuling — 按判词有无挑, 不按状态挑', () => {
  // 证伪: 换回 `status === 'ruled' || status === 'delivered'` → 第一条红 (escalated 那张漏掉)。
  test('escalated 且带判词的票也要发判词 (裁过又被升人, escalate 不清 ruling)', () => {
    const map = mk([tk('a', { status: 'escalated', ruling: '判过了才升的人' }), tk('b', { status: 'ruled', ruling: 'x' }), tk('c', { status: 'open' })]);
    expect(ticketsNeedingRuling(map).map((t) => t.id)).toEqual(['a', 'b']);
  });

  test('没判词的终态票不发空评论', () => {
    expect(ticketsNeedingRuling(mk([tk('a', { status: 'ruled' })]))).toEqual([]);
  });
});

describe('normalizeDerived — 比对前的 open/blocked 归一', () => {
  // 证伪: 把 main() 里的 diffMaps(normalizeDerived(truth), readBack) 换回 diffMaps(truth, ...)
  // → 首次真机迁移的那 3 张票 (t3/t4/t6) 立刻假红。这条闸就是那次读数的固化。
  test('前置未裁的 open 票 → 归一成 blocked (md 存的是陈旧字面值, 不随前置回写)', () => {
    const map = mk([tk('g4'), tk('p1', { status: 'delivered', ruling: 'x' }), tk('t3', { status: 'open', blockedBy: ['g4', 'p1'] })]);
    expect(normalizeDerived(map).tickets.find((t) => t.id === 't3')!.status).toBe('blocked');
  });

  test('前置全裁的 open 票保持 open', () => {
    const map = mk([tk('a', { status: 'ruled', ruling: 'x' }), tk('b', { status: 'open', blockedBy: ['a'] })]);
    expect(normalizeDerived(map).tickets.find((t) => t.id === 'b')!.status).toBe('open');
  });

  test('终态票不被归一动 (只归一 open/blocked 两态, 别把 ruled 洗掉)', () => {
    const map = mk([tk('a', { status: 'ruled', ruling: 'x' }), tk('s', { status: 'suggested' }), tk('e', { status: 'escalated' }), tk('d', { status: 'delivered', ruling: 'y' })]);
    expect(normalizeDerived(map).tickets.map((t) => t.status)).toEqual(['ruled', 'suggested', 'escalated', 'delivered']);
  });
});

describe('remap + diffMaps — 回读校验', () => {
  const idMap = new Map([
    ['a', '#11'],
    ['b', '#12'],
  ]);

  test('remap 同时换票 id 与 blockedBy 里的引用 (漏后者 = 边全断)', () => {
    const out = remap(mk([tk('a'), tk('b', { blockedBy: ['a'] })]), idMap, '5');
    expect(out.tickets.map((t) => t.id)).toEqual(['#11', '#12']);
    expect(out.tickets[1]!.blockedBy).toEqual(['#11']);
  });

  test('逐票一致 → 空清单', () => {
    const want = remap(mk([tk('a', { executorKind: 'agent' })]), idMap, '5');
    expect(diffMaps(want, want)).toEqual([]);
  });

  test('状态/执行器/边搬错都要被抓到', () => {
    const want = remap(mk([tk('a', { status: 'ruled', ruling: 'x', executorKind: 'agent' })]), idMap, '5');
    const got = { ...want, tickets: [{ ...want.tickets[0]!, status: 'open' as const, executorKind: undefined, blockedBy: ['#99'] }] };
    expect(diffMaps(want, got).map((d) => d.field).sort()).toEqual(['blockedBy', 'executorKind', 'status']);
  });

  test('票缺失 / 多出来都点名 (两个方向都查, 只查一边会漏)', () => {
    const want = remap(mk([tk('a'), tk('b')]), idMap, '5');
    const got = { ...want, tickets: [want.tickets[0]!, { ...want.tickets[1]!, id: '#99' }] };
    const fields = diffMaps(want, got);
    expect(fields).toContainEqual({ ticketId: '#12', field: '整票', want: '存在', got: '缺失' });
    expect(fields).toContainEqual({ ticketId: '#99', field: '整票', want: '不存在', got: '多出来了' });
  });

  test('判词只比有无 (gh 侧洗过署名, 逐字节比会假红)', () => {
    const want = remap(mk([tk('a', { status: 'ruled', ruling: '判词\nCo-Authored-By: X' })]), idMap, '5');
    const got = { ...want, tickets: [{ ...want.tickets[0]!, ruling: '判词' }] };
    expect(diffMaps(want, got)).toEqual([]);
  });
});
