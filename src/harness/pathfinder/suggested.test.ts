/**
 * S-1 suggested 态 — 片 a 契约测试 (docs/plan/2026-08-04-s1-suggested-tickets.md)。
 *
 * 钉 GWT-1 (INV-S1-1 三处消费点) + 序列化往返 + 旧图兼容:
 *  - frontier / readyRegion / slice 编译 三处都看不见 suggested 票;
 *  - suggested 票**不阻塞**已散尽区域的交付 (雾中带不挡路);
 *  - md/db 双向往返带 suggestedBy/fingerprint/suggestionsLog;
 *  - 无新字段的旧图照常读 (向后兼容)。
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PathMap, Ticket } from './types';
import { computeFrontier, deriveStatus } from './frontier';
import { parseMapMarkdown, renderMapMarkdown, saveMapDb, loadMapDb } from './map-store';
import { compileSlice } from './slice-compiler';
import { readyRegion } from '../../mcp/tools/pathfinder';

const t = (over: Partial<Ticket> & { id: string }): Ticket => ({
  type: 'task',
  title: `票 ${over.id}`,
  blockedBy: [],
  status: 'open',
  ...over,
});

/** 一张图: t1 已裁 (可交付区域), s1 suggested (带溯源+指纹), t2 open。 */
const mapWithSuggested = (): PathMap => ({
  destination: '测试图',
  slug: 'sugg-map',
  tickets: [
    t({ id: 't1', status: 'ruled', ruling: '干活' }),
    t({ id: 's1', status: 'suggested', suggestedBy: 'run-42', fingerprint: 'f'.repeat(64) }),
    t({ id: 't2', status: 'open' }),
  ],
  decisionsLog: [],
  suggestionsLog: [{ ticketId: 's0', outcome: 'rejected', at: '2026-08-04T00:00:00Z', runId: 'run-41' }],
});

describe('GWT-1 · INV-S1-1: suggested 无执行力', () => {
  test('frontier 不含 suggested (哪怕它零前置)', () => {
    const f = computeFrontier(mapWithSuggested()).map((x) => x.id);
    expect(f).not.toContain('s1');
    expect(f).toContain('t2'); // 对照: 同样零前置的 open 票在前沿
  });

  test('readyRegion 不含 suggested, 且 suggested 在图上不阻塞区域交付', () => {
    const region = readyRegion(mapWithSuggested());
    expect(region).toEqual(['t1']); // s1 不在; 且 region 非 null — 雾中带不挡路
  });

  test('slice 编译只吃 region 票 — suggested 编不进图', () => {
    const map = mapWithSuggested();
    const plan = compileSlice(map, ['t1']);
    expect(Object.keys(plan.nodes ?? {})).toEqual(['t1']);
  });

  test('deriveStatus: suggested 恒 suggested, 不推导成 open/blocked', () => {
    const s1 = mapWithSuggested().tickets[1]!;
    expect(deriveStatus(s1, new Set(['t1']))).toBe('suggested');
    expect(deriveStatus(s1, new Set())).toBe('suggested');
  });
});

describe('序列化往返 (md 真相源 + db 索引)', () => {
  test('md roundtrip: parse(render(m)) ≡ m — 新字段与台账全保', () => {
    const m = mapWithSuggested();
    const back = parseMapMarkdown(renderMapMarkdown(m));
    expect(back.tickets.find((x) => x.id === 's1')).toEqual(m.tickets[1]!);
    expect(back.suggestionsLog).toEqual(m.suggestionsLog!);
    // 幂等: 再 render 一遍 byte-stable
    expect(renderMapMarkdown(back)).toBe(renderMapMarkdown(m));
  });

  test('db roundtrip: save → load 带新列; 台账 JSON 原样', () => {
    const db = new Database(':memory:');
    const m = mapWithSuggested();
    saveMapDb(m, db);
    const back = loadMapDb(db, 'sugg-map');
    expect(back.tickets.find((x) => x.id === 's1')).toEqual(m.tickets[1]!);
    expect(back.suggestionsLog).toEqual(m.suggestionsLog!);
    db.close();
  });

  test('旧图兼容: 无新字段/无台账段的 md 照常读, suggestionsLog 字段缺省', () => {
    const legacy = renderMapMarkdown({ destination: '老图', slug: 'legacy', tickets: [t({ id: 't1' })], decisionsLog: [] });
    const back = parseMapMarkdown(legacy);
    expect(back.tickets).toHaveLength(1);
    expect('suggestionsLog' in back).toBe(false);
  });

  test('台账行不污染 decisionsLog (行首 `- log:` 与 `- [id]` 形状区分)', () => {
    const back = parseMapMarkdown(renderMapMarkdown(mapWithSuggested()));
    expect(back.decisionsLog).toEqual([]);
  });
});
