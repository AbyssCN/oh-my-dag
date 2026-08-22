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
import { TruncatedText, visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, test } from 'bun:test';
import { waitingHumanState } from '../../harness/pathfinder/frontier';
import type { DispatchableTicket, PathMap, Ticket } from '../../harness/pathfinder/types';
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

  test('C-7 ② waiting-unknown-since draws "start not recorded", no fake 0 duration (NULL≠0)', () => {
    const u = ticket({ id: 'u1', status: 'escalated' }); // waitingSince 缺席
    expect(waitingHumanState(u)).toBe('waiting-unknown-since');
    const line = lines([u]).find((l) => l.includes('u1'))!;
    expect(line).toContain('start not recorded');
    // 证伪: 把起点缺席当 0 算 (nowMs − 0 = 1970 至今 56 年) 或编 'waiting 0m' → 这条红。
    expect(line).not.toContain('waiting 0');
  });

  test('D-5 four states used directly: ruled-unrecorded draws "ruled but unrecorded", not flattened to waiting', () => {
    const r = ticket({ id: 'r1', status: 'escalated', waitingSince: T0, ruledAt: T0 });
    expect(waitingHumanState(r)).toBe('ruled-unrecorded');
    const line = lines([r]).find((l) => l.includes('r1'))!;
    expect(line).toContain('ruled but unrecorded');
    expect(line).not.toContain('start not recorded');
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

// ── 片3 (docs/plan/2026-08-17-tui-视觉-w2-执行契约.md): 列宽治理, 先红 ─────────────
//
// 尚未实现的契约 (今天 renderTicketBoard 只有 (map, nowMs), 原文平铺不认列宽):
//  ① 第三参 `{ width }` = 组件 `render(width)` 拿到的实宽 —— 每一行按它现算, 逐行不溢出。
//  ② open question (ticketClass='question') 的长文平铺只呈现**一句**, 完整文本仅选中态
//    (`{ selectedId }`) 展开 —— 侧栏一行一票的密度不能被一张长问题票吃掉。
//  ③ 截断走 pi-tui 现成件 `TruncatedText` (全仓 0 用), 不手工 `slice + '...'`:
//    slice 按 code unit 切, 全角字符下切出来的行按列算是超宽的 (本条当场演示这个差)。

const Q_HEAD = 'HEADMARK';
const Q_TAIL = 'TAILMARK';
const Q_END = 'ENDMARK';
/** 一张 open question 票的长文: 第一句到 `?` 为止, 后面还有两句 (只在选中态该出现)。 */
const LONG_Q = `存储层选型 ${Q_HEAD} 该走 sqlite 还是 postgres? 写放大与并发写锁的取舍 ${Q_TAIL} 要先量过再定, 验收看 p99 写延迟与恢复时长 ${Q_END}`;
/** 全角超长串: 手工 slice 切它必溢出 (每字 2 列), pi-tui 按列切才不溢出。 */
const LONG_CJK = `存储层压测${'宽'.repeat(120)}`;

const rtrim = (s: string): string => s.replace(/\s+$/, '');
/** 去掉一切空白后比对: 断言不依赖换行/折行落在哪个空格上。 */
const squash = (ls: string[]): string => ls.join('').replace(/\s+/g, '');

function openQuestion(id: string, title: string): DispatchableTicket {
  return { ...ticket({ id, type: 'grill', title }), ticketClass: 'question' };
}

describe('renderTicketBoard 列宽治理 (片3)', () => {
  test('片3 ① render(80): 逐行 visibleWidth ≤ 80 (含最长标题 / stale 前缀 / open question)', () => {
    const ts = [
      ticket({ id: 'f1', type: 'task', title: LONG_CJK }),
      ticket({ id: 'x1', type: 'grill', title: LONG_CJK, status: 'escalated', waitingSince: T0, staleAt: T0 }),
      openQuestion('q1', LONG_Q),
    ];
    const flat = renderTicketBoard(board(ts), T0_MS, { width: 80 });
    expect(flat.length).toBeGreaterThan(3); // 表头 + 三票, 一票至少一行
    // 证伪: 任一行按原文平铺 (今天的实现就是) → 该行按列算 > 80, 这条逐行断言红。
    for (const [i, line] of flat.entries()) {
      expect(visibleWidth(line), `平铺行 ${i}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(80);
    }
    // 选中态展开出来的续行同样吃这把尺 (展开 ≠ 可以溢出)。
    const sel = renderTicketBoard(board(ts), T0_MS, { width: 80, selectedId: 'q1' });
    for (const [i, line] of sel.entries()) {
      expect(visibleWidth(line), `选中态行 ${i}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(80);
    }
  });

  test('片3 ② open question 平铺只一句, 完整长文仅选中态展开', () => {
    const q = openQuestion('q1', LONG_Q);
    // 宽 200 装得下整段 —— 这里不展开长文与"截断"无关, 是密度契约本身。
    // 证伪: 平铺行把整段画出来 → TAILMARK 出现, 红。
    const wide = renderTicketBoard(board([q]), T0_MS, { width: 200 });
    expect(wide.slice(1)).toHaveLength(1);
    expect(wide[1]!).toContain(Q_HEAD);
    expect(wide[1]!).not.toContain(Q_TAIL);
    // 窄列宽下仍是一票一行 (证伪: 窄宽下自动折成多行 → 长度 > 1, 红)。
    const narrow = renderTicketBoard(board([q]), T0_MS, { width: 40 });
    expect(narrow.slice(1)).toHaveLength(1);
    expect(visibleWidth(narrow[1]!)).toBeLessThanOrEqual(40);
    // 选中态才展开完整文本 (证伪: 选中态仍只画一句 → TAILMARK/ENDMARK 缺席, 红)。
    const sel = renderTicketBoard(board([q]), T0_MS, { width: 40, selectedId: 'q1' });
    expect(sel.slice(1).length).toBeGreaterThan(1);
    expect(squash(sel.slice(1))).toContain(Q_TAIL);
    expect(squash(sel.slice(1))).toContain(Q_END);
    for (const [i, line] of sel.entries()) {
      expect(visibleWidth(line), `选中态行 ${i}`).toBeLessThanOrEqual(40);
    }
  });

  test('片3 ③ 截断走 pi-tui TruncatedText: 全角超长串窄宽严格不溢出, 与手工 "..." 拼接不同', () => {
    const t = ticket({ id: 'z1', type: 'task', title: LONG_CJK });
    const NARROW = 32;
    const full = rtrim(renderTicketBoard(board([t]), T0_MS, { width: 400 })[1]!);
    expect(visibleWidth(full)).toBeGreaterThan(NARROW); // 前提: 这行确实需要截
    const cut = rtrim(renderTicketBoard(board([t]), T0_MS, { width: NARROW })[1]!);
    // 证伪: 自写按列切的截断器 (哪怕结果也不溢出) → 与 TruncatedText 逐字节比对必红;
    //       只有真接 pi-tui 这件现成件才绿。
    expect(cut).toBe(rtrim(new TruncatedText(full).render(NARROW)[0]!));
    expect(visibleWidth(cut)).toBeLessThanOrEqual(NARROW);
    // 手工 `slice + '...'` 按 code unit 切: 全角字符下切出来按列算是超宽的 —— 两者必不同。
    // 证伪: 实现改回手工拼接 → cut 等于 manual 且 visibleWidth > 32, 上下两条一起红。
    const manual = `${full.slice(0, NARROW - 3)}...`;
    expect(visibleWidth(manual)).toBeGreaterThan(NARROW);
    expect(cut).not.toBe(manual);
  });
});
