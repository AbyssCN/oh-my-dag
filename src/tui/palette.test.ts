/**
 * L1 判据:`Ctrl+K` 去哪(2026-08-22)。
 *
 * ## 每条闸的证伪方式(本仓纪律:一条永远绿的闸比没有闸更坏)
 *
 * 逐条当场证伪过一次,做法写在各 test 的注释里 —— 想复验就照做,改回来即可。
 */
import { describe, expect, test } from 'bun:test';
import type { TuiSessionMeta } from './backend';
import { paletteOptions, parsePaletteValue } from './palette';

const S = (id: string, title: string, updatedAt: number): TuiSessionMeta => ({ id, title, updatedAt });
const NOW = 1_800_000_000_000;

describe('paletteOptions', () => {
  test('★ 会话按最近使用倒序 —— 「Ctrl+K 再 Enter = 接上一条」靠的就是这个序', () => {
    // 证伪:把 palette.ts 的 `byRecency` 换回 `[...input.sessions]`(不排序) → 本条红。
    const rows = paletteOptions({
      sessions: [S('s-old', '老的', NOW - 86_400_000), S('s-new', '新的', NOW - 60_000)],
      currentSession: 's-fresh',
      maps: [],
      liveRun: null,
      now: NOW,
    });
    expect(rows.map((r) => r.value)).toEqual(['session:s-new', 'session:s-old']);
  });

  test('★ 主标签是**标题**不是 id —— 人是靠「那次聊的是什么」找会话的', () => {
    // 证伪:把 label 换成 s.id → 本条红。这与 sessions.ts:102 那三条 owner 点名同一件事。
    const [row] = paletteOptions({
      sessions: [S('s-1787309805', '了解 outputstyle 和 omd-plain 输出格式', NOW - 7_200_000)],
      currentSession: 's-other',
      maps: [],
      liveRun: null,
      now: NOW,
    });
    expect(row?.label).toContain('了解 outputstyle');
    // id 与相对时间降到副列 —— 仍然搜得到(dialog 的 matching 吃 label/value/description 三段)。
    expect(row?.description).toBe('s-1787309805 · 2h ago');
  });

  test('当前会话标 `*` —— 与 formatSessions / sessionPickerOptions 同一个记号', () => {
    const [row] = paletteOptions({
      sessions: [S('s-1', 'x', NOW)],
      currentSession: 's-1',
      maps: [],
      liveRun: null,
      now: NOW,
    });
    expect(row?.label.startsWith('* ')).toBe(true);
  });

  test('★ 没标题写 `(no title)`,没记时间写 `—` —— NULL ≠ 0,不写「刚刚」', () => {
    // 证伪:把 `relTime` 换成 `${(now - updatedAt)/1000}s 前` → `updatedAt: 0` 会画成
    // 「1800000000s 前」或「0s 前」,本条红。这是 sessions.ts:85 那条纪律的下游。
    const [row] = paletteOptions({
      sessions: [S('s-1', '', 0)],
      currentSession: 'other',
      maps: [],
      liveRun: null,
      now: NOW,
    });
    expect(row?.label).toContain('(no title)');
    expect(row?.description).toBe('s-1 · —');
  });

  test('★ 无源恒缺席:没在跑图就**没有活图那一行**,不画一个 0 节点的空行', () => {
    // 证伪:把 palette.ts 的 `if (input.liveRun)` 删掉并恒画一行 → 本条红。
    const rows = paletteOptions({ sessions: [], currentSession: 'x', maps: [], liveRun: null, now: NOW });
    expect(rows).toEqual([]);
  });

  test('活图行带节点数与在跑数;顺序照稿:会话 → 活图 → 地图', () => {
    const rows = paletteOptions({
      sessions: [S('s-1', 'a', NOW)],
      currentSession: 'x',
      maps: [{ slug: '214', destination: 'OMD TUI 观测面', frontierCount: 9, openCount: 11 }],
      liveRun: { label: '78f1951c', nodes: 8, running: 1 },
      now: NOW,
    });
    expect(rows.map((r) => r.value)).toEqual(['session:s-1', 'run:', 'map:214']);
    expect(rows[1]?.description).toBe('8 nodes · 1 running');
    expect(rows[2]?.label).toContain('OMD TUI 观测面');
    expect(rows[2]?.description).toBe('map 214 · frontier 9 · open 11');
  });

  test('地图没写 destination 时退回 slug —— 不画一行空白', () => {
    const rows = paletteOptions({
      sessions: [],
      currentSession: 'x',
      maps: [{ slug: 'tui-work', destination: '', frontierCount: 0, openCount: 0 }],
      liveRun: null,
      now: NOW,
    });
    expect(rows[0]?.label).toContain('tui-work');
  });
});

describe('parsePaletteValue', () => {
  test('三种去处各自解得出', () => {
    expect(parsePaletteValue('session:s-1')).toEqual({ kind: 'session', id: 's-1' });
    expect(parsePaletteValue('map:214')).toEqual({ kind: 'map', slug: '214' });
    expect(parsePaletteValue('run:')).toEqual({ kind: 'run' });
  });

  test('★ 认不出返回 null —— 调用方什么都不做,不猜一个去处', () => {
    // 证伪:让 parsePaletteValue 对未知串回落成 `{kind:'session', id:value}` → 本条红,
    // 而那正是「按 Enter 跳去一条不存在的会话」的来法。
    expect(parsePaletteValue('nope')).toBeNull();
    expect(parsePaletteValue('session:')).toBeNull();
    expect(parsePaletteValue('map:')).toBeNull();
    expect(parsePaletteValue('')).toBeNull();
  });

  test('round-trip:paletteOptions 产的每个 value 都解得出', () => {
    const rows = paletteOptions({
      sessions: [S('s-1', 'a', NOW), S('s-2', 'b', NOW - 1)],
      currentSession: 's-1',
      maps: [{ slug: '214', destination: 'd', frontierCount: 1, openCount: 2 }],
      liveRun: { label: 'r', nodes: 1, running: 0 },
      now: NOW,
    });
    for (const r of rows) expect(parsePaletteValue(r.value)).not.toBeNull();
  });
});
