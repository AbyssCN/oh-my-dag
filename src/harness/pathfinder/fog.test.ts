/**
 * fog 的可执行契约 (SDD `docs/plan/2026-08-06-omd-gui-sdd.md` §4 + §9.5)。
 *
 * 这块闸守的是**雾是真数据的编码**这件事本身:每一档都要有它自己的直接证据,
 * 且「等一等就浮出来」与「永远浮不出来」不许糊成一档。
 *
 * 反向自检见文件末尾两条 —— 一条证明档位判据会红,一条证明它不是恒真式。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { computeFog, type FogBand } from './fog';
import { parseMapMarkdown } from './map-store';
import type { PathMap, Ticket } from './types';

/** 造票工厂 (与 frontier.test.ts 同款, 默认 open + 无前置)。 */
function ticket(partial: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return { type: 'grill', title: partial.id, blockedBy: [], status: 'open', ...partial };
}
function mapOf(tickets: Ticket[]): PathMap {
  return { destination: 'D', slug: 'd', tickets, decisionsLog: [] };
}
/** 只取 id→band, 断言读起来才像话。 */
function bands(map: PathMap): Record<string, FogBand> {
  return Object.fromEntries(computeFog(map).cells.map((c) => [c.ticketId, c.band]));
}

describe('fog · 七档各有自己的直接证据', () => {
  test('clear / awaiting-owner / frontier / suggested 四档直接由 status 定', () => {
    const m = mapOf([
      ticket({ id: 'r', status: 'ruled' }),
      ticket({ id: 'd', status: 'delivered' }),
      ticket({ id: 'e', status: 'escalated' }),
      ticket({ id: 'o', status: 'open' }),
      ticket({ id: 's', status: 'suggested' }),
    ]);
    expect(bands(m)).toEqual({ r: 'clear', d: 'clear', e: 'awaiting-owner', o: 'frontier', s: 'suggested' });
  });

  test('near = 还差一层; deep = 还差两层以上 —— 档由 hops 推出, 不另定义', () => {
    // a(open) ← b ← c ← e     b 差 1 层, c 差 2 层, e 差 3 层
    const m = mapOf([
      ticket({ id: 'a', status: 'open' }),
      ticket({ id: 'b', status: 'open', blockedBy: ['a'] }),
      ticket({ id: 'c', status: 'open', blockedBy: ['b'] }),
      ticket({ id: 'e', status: 'open', blockedBy: ['c'] }),
    ]);
    const cells = Object.fromEntries(computeFog(m).cells.map((c) => [c.ticketId, c]));
    expect(cells.a!).toMatchObject({ band: 'frontier', hops: 0 });
    expect(cells.b!).toMatchObject({ band: 'near', hops: 1 });
    expect(cells.c!).toMatchObject({ band: 'deep', hops: 2 });
    expect(cells.e!).toMatchObject({ band: 'deep', hops: 3 });
  });

  test('多前置取**最深**的那条: 一条腿浅不代表能早动', () => {
    const m = mapOf([
      ticket({ id: 'a', status: 'open' }),
      ticket({ id: 'b', status: 'open', blockedBy: ['a'] }), // hops 1
      ticket({ id: 'z', status: 'open', blockedBy: ['a', 'b'] }), // max(0,1)+1 = 2
    ]);
    expect(computeFog(m).cells.find((c) => c.ticketId === 'z')).toMatchObject({ band: 'deep', hops: 2 });
  });

  test('suggested / escalated 前置算 0 层 —— 它们不欠**别的票**, 只欠 owner 一个动作', () => {
    const m = mapOf([
      ticket({ id: 's', status: 'suggested' }),
      ticket({ id: 'e', status: 'escalated' }),
      ticket({ id: 'x', status: 'open', blockedBy: ['s'] }),
      ticket({ id: 'y', status: 'open', blockedBy: ['e'] }),
    ]);
    expect(bands(m)).toMatchObject({ x: 'near', y: 'near' });
  });

  test('前置裁决后, 下游真的从雾里浮出来 (SDD §9.3 的那一条)', () => {
    const before = mapOf([
      ticket({ id: 'a', status: 'open' }),
      ticket({ id: 'b', status: 'open', blockedBy: ['a'] }),
      ticket({ id: 'c', status: 'open', blockedBy: ['b'] }),
    ]);
    expect(bands(before)).toEqual({ a: 'frontier', b: 'near', c: 'deep' });
    const after = mapOf([
      ticket({ id: 'a', status: 'ruled' }),
      ticket({ id: 'b', status: 'open', blockedBy: ['a'] }),
      ticket({ id: 'c', status: 'open', blockedBy: ['b'] }),
    ]);
    expect(bands(after)).toEqual({ a: 'clear', b: 'frontier', c: 'near' });
  });
});

describe('fog · 「永远浮不出来」不许被读成「等一等就好」', () => {
  test('悬空前置 (id 图上不存在) → unreachable/dangling, **不是** deep', () => {
    const m = mapOf([ticket({ id: 'b', status: 'open', blockedBy: ['nope'] })]);
    expect(computeFog(m).cells[0]).toMatchObject({ band: 'unreachable', hops: null, unreachableReason: 'dangling-prereq' });
  });

  test('环 → unreachable/cycle, 且**不死循环**', () => {
    const m = mapOf([
      ticket({ id: 'a', status: 'open', blockedBy: ['b'] }),
      ticket({ id: 'b', status: 'open', blockedBy: ['a'] }),
    ]);
    const cells = computeFog(m).cells;
    expect(cells.map((c) => c.band)).toEqual(['unreachable', 'unreachable']);
    expect(cells[0]!.unreachableReason).toBe('cycle');
  });

  test('挂在环下游的票也不可达 —— 不可达会沿依赖传播', () => {
    const m = mapOf([
      ticket({ id: 'a', status: 'open', blockedBy: ['b'] }),
      ticket({ id: 'b', status: 'open', blockedBy: ['a'] }),
      ticket({ id: 'c', status: 'open', blockedBy: ['a'] }),
    ]);
    expect(bands(m).c).toBe('unreachable');
  });

  test('hops 在 clear / unreachable 上是 null(不适用), **不是 0**', () => {
    const m = mapOf([
      ticket({ id: 'r', status: 'ruled' }),
      ticket({ id: 'x', status: 'open', blockedBy: ['nope'] }),
    ]);
    const cells = Object.fromEntries(computeFog(m).cells.map((c) => [c.ticketId, c]));
    // 0 = 现在就能动; null = 这个数对这一档没有意义。糊成一个就再也分不开 (仓规第一条)。
    expect(cells.r!.hops).toBeNull();
    expect(cells.x!.hops).toBeNull();
  });
});

describe('fog · phantom (children 声明了但票还没长出来)', () => {
  test('去重 + 保首次出现序; 已存在的 child 不算 phantom', () => {
    const m = mapOf([
      ticket({ id: 'p1', children: ['c-new', 'c-have', 'c-new'] }),
      ticket({ id: 'p2', children: ['c-new', 'c-other'] }),
      ticket({ id: 'c-have' }),
    ]);
    expect(computeFog(m).phantoms).toEqual(['c-new', 'c-other']);
  });

  test('没有 children 的图 → phantoms 空数组 (不是 undefined)', () => {
    expect(computeFog(mapOf([ticket({ id: 'a' })])).phantoms).toEqual([]);
  });
});

describe('fog · 反向自检 (证明这块闸会红, 也证明它不是恒真式)', () => {
  test('恒真式检查: 同一张图上七档并非全都恒定 —— 换一个 status 档就变', () => {
    // 一条闸永远绿比没有闸更坏。这一条钉的是「band 真的跟着数据动」。
    const asOpen = bands(mapOf([ticket({ id: 'a', status: 'open' })])).a;
    const asRuled = bands(mapOf([ticket({ id: 'a', status: 'ruled' })])).a;
    const asEsc = bands(mapOf([ticket({ id: 'a', status: 'escalated' })])).a;
    expect(new Set([asOpen, asRuled, asEsc]).size).toBe(3);
  });

  test('★ 证伪方式(写给下一个改这个文件的人)', () => {
    // 把 fog.ts 里 `d.hops === 1 ? 'near' : 'deep'` 改成恒 'deep' → 上面
    //   「near = 还差一层」那条当场红。
    // 把 unreachable 那一支删掉、让它落进 deep → 「悬空前置」「环」两条当场红。
    // 把 hops 在 clear 上改成 0 → 「hops 是 null 不是 0」那条当场红。
    // 三处都验过 (2026-08-06)。这条 test 自己只钉一件事: 上面那些判据确实各自独立。
    const m = mapOf([
      ticket({ id: 'a', status: 'open' }),
      ticket({ id: 'b', status: 'open', blockedBy: ['a'] }),
      ticket({ id: 'c', status: 'open', blockedBy: ['b'] }),
      ticket({ id: 'x', status: 'open', blockedBy: ['nope'] }),
      ticket({ id: 'r', status: 'ruled' }),
    ]);
    // 五张票落到五个**不同**的档 —— 任何一处判据塌成另一处, 这个集合就会缩水。
    expect(new Set(computeFog(m).cells.map((c) => c.band)).size).toBe(5);
  });
});

describe('fog · 验收图 (SDD §9.1 —— 最容易被跳过的那一条)', () => {
  // 为什么必须有这张图: 三张真图今天全是 ruled/delivered, 七档里五档一张票都没有。
  // 没有这张验收图,「雾图做好了」与「五档从没被渲染过」在演示里长得一模一样。
  //
  // ⚠ 它**刻意不放进 docs/plan/pathfinder/**: 那个目录是真相源, 且
  // `aggregateSuggestionAcceptance` 会扫全目录 —— 塞一张含 suggested 票的夹具进去,
  // 读数板的 pending 会凭空多一张, 那是拿假数据污染真读数。
  const md = readFileSync(new URL('./fog-acceptance.fixture.md', import.meta.url), 'utf8');

  test('走**真解析器**(不是手搓对象): 七档各占一格, 一档都不少', () => {
    const fog = computeFog(parseMapMarkdown(md));
    const seen = new Set(fog.cells.map((c) => c.band));
    const all: FogBand[] = ['clear', 'awaiting-owner', 'frontier', 'suggested', 'near', 'deep', 'unreachable'];
    for (const b of all) expect(seen).toContain(b);
    expect(seen.size).toBe(all.length);
  });

  test('两种不可达成因都在图上 (合并成一档不等于把成因也并掉)', () => {
    const reasons = computeFog(parseMapMarkdown(md))
      .cells.map((c) => c.unreachableReason)
      .filter(Boolean);
    expect(new Set(reasons)).toEqual(new Set(['dangling-prereq', 'cycle']));
  });

  test('phantom 那一格也有真样本 (children 声明了、票还没长出来)', () => {
    expect(computeFog(parseMapMarkdown(md)).phantoms).toEqual(['child-not-yet']);
  });
});
