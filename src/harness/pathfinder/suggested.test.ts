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
    expect(region).toEqual({ slice: ['t1'], goals: [] }); // s1 不在; 且 region 非 null — 雾中带不挡路
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

// ── 片 b: suggest/confirm 纯核 + 工具面 (GWT-2~8) ────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySuggestions, computeFingerprint, confirmSuggestion } from './suggest';
import { resolveBackend } from './backend';
import { saveMap } from './maps';
import { createPathfinderTools } from '../../mcp/tools/pathfinder';

const AT = '2026-08-04T12:00:00Z';

describe('applySuggestions (GWT-2/6/7)', () => {
  const base = (): PathMap => ({ destination: 'd', slug: 'm', tickets: [], decisionsLog: [] });

  test('GWT-2: 缺 suggestedBy → 整批响亮拒绝, 报错含字段名', () => {
    expect(() =>
      applySuggestions(base(), [{ type: 'task', title: 'x', suggestedBy: '' }], { at: AT }),
    ).toThrow(/suggestedBy/);
  });

  test('正常入图: suggested 态 + 溯源 + 指纹', () => {
    const m = base();
    const r = applySuggestions(m, [{ type: 'research', title: '查一下 X', suggestedBy: 'run-1' }], { at: AT });
    expect(r.added).toHaveLength(1);
    const tk = m.tickets[0]!;
    expect(tk.status).toBe('suggested');
    expect(tk.suggestedBy).toBe('run-1');
    expect(tk.fingerprint).toBe(computeFingerprint('research', '查一下 X'));
    expect(tk.id).toBe('s1');
  });

  test('GWT-6: 指纹撞任意状态既有票 → 不入图, deduped 留痕指向撞上的票', () => {
    const m = base();
    m.tickets.push({ id: 't9', type: 'task', title: '同一件事', blockedBy: [], status: 'delivered', fingerprint: computeFingerprint('task', '同一件事') });
    const r = applySuggestions(m, [{ type: 'task', title: '同一件事', suggestedBy: 'run-2' }], { at: AT });
    expect(r.added).toHaveLength(0);
    expect(r.deduped).toEqual([{ draftTitle: '同一件事', hitTicketId: 't9' }]);
    expect(m.suggestionsLog).toEqual([{ ticketId: 't9', outcome: 'deduped', at: AT, runId: 'run-2' }]);
    expect(m.tickets).toHaveLength(1); // 没多票
  });

  test('GWT-7: perRunCap=5 时 8 条只进 5, 摘要念出「丢弃 3」', () => {
    const m = base();
    const drafts = Array.from({ length: 8 }, (_, i) => ({ type: 'task' as const, title: `建议 ${i}`, suggestedBy: 'run-3' }));
    const r = applySuggestions(m, drafts, { at: AT, perRunCap: 5 });
    expect(r.added).toHaveLength(5);
    expect(r.dropped).toBe(3);
    expect(r.summary).toContain('丢弃 3');
  });

  test('pendingCap: 图上已有 20 张 pending → 新建议全丢弃且摘要说明', () => {
    const m = base();
    for (let i = 0; i < 20; i++) m.tickets.push({ id: `s${i + 1}`, type: 'task', title: `旧建议 ${i}`, blockedBy: [], status: 'suggested', suggestedBy: 'r0', fingerprint: computeFingerprint('task', `旧建议 ${i}`) });
    const r = applySuggestions(m, [{ type: 'task', title: '新的', suggestedBy: 'run-4' }], { at: AT, pendingCap: 20 });
    expect(r.added).toHaveLength(0);
    expect(r.dropped).toBe(1);
    expect(r.summary).toContain('丢弃 1');
  });
});

describe('confirmSuggestion (GWT-3/4/5)', () => {
  const withSugg = (): PathMap => {
    const m: PathMap = { destination: 'd', slug: 'm', tickets: [], decisionsLog: [] };
    applySuggestions(m, [{ type: 'task', title: '待确认', suggestedBy: 'run-9' }], { at: AT });
    return m;
  };

  test('GWT-3: accept → open + accepted 行; 二次 confirm 同票 → throw (幂等拒绝)', () => {
    const m = withSugg();
    const e = confirmSuggestion(m, 's1', 'accept', { at: AT });
    expect(e).toEqual({ ticketId: 's1', outcome: 'accepted', at: AT, runId: 'run-9' });
    expect(m.tickets[0]!.status).toBe('open');
    expect(() => confirmSuggestion(m, 's1', 'accept', { at: AT })).toThrow(/suggested/);
  });

  test('GWT-4: accept + 改题 → edited 且 title 已换', () => {
    const m = withSugg();
    const e = confirmSuggestion(m, 's1', 'accept', { at: AT, title: '改后题' });
    expect(e.outcome).toBe('edited');
    expect(m.tickets[0]!.title).toBe('改后题');
  });

  test('GWT-5: reject → 票移除但台账有 rejected 行 (拒绝不是无痕)', () => {
    const m = withSugg();
    confirmSuggestion(m, 's1', 'reject', { at: AT });
    expect(m.tickets).toHaveLength(0);
    expect(m.suggestionsLog!.some((x) => x.ticketId === 's1' && x.outcome === 'rejected')).toBe(true);
  });
});

describe('工具面: map_confirm + map_rule 挡 suggested (GWT-8)', () => {
  const wireTmp = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sugg-'));
    const m: PathMap = { destination: '图', slug: 'm1', tickets: [], decisionsLog: [] };
    applySuggestions(m, [{ type: 'task', title: '机器建议', suggestedBy: 'run-7' }], { at: AT });
    saveMap(m, cwd);
    const tools = createPathfinderTools({
      cwd,
      env: { OMD_PATH_BACKEND: 'md' },
      models: { conductorModel: 'x', leafModel: 'x' },
      agentRunner: (async () => ({ text: '', usage: { in: 0, out: 0 } })) as never,
      commandRunner: (async () => ({ text: '', usage: { in: 0, out: 0 }, exitCode: 0 })) as never,
      resolveBackend: (c) => resolveBackend(c, { env: { OMD_PATH_BACKEND: 'md' } }),
    });
    const call = async (name: string, args: Record<string, unknown>) =>
      (await tools.find((t) => t.name === name)!.handler(args, {} as never)) as { content: { text: string }[]; isError?: boolean };
    return { cwd, call };
  };

  test('GWT-8: map_rule 打 suggested 票 → isError 含 confirm, 状态不变', async () => {
    const { cwd, call } = wireTmp();
    const r = await call('path_rule', { ticketId: 's1', ruling: '直接裁' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('map_confirm');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('map_confirm accept 走通并渲染新状态; 再 rule 就许了', async () => {
    const { cwd, call } = wireTmp();
    const c = await call('map_confirm', { ticketId: 's1', action: 'accept' });
    expect(c.isError).not.toBe(true);
    expect(c.content[0]!.text).toContain('accepted');
    const r = await call('path_rule', { ticketId: 's1', ruling: '现在可以裁了' });
    expect(r.isError).not.toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ── r1 片2: C1 语义档 (GWT-R1-3) ─────────────────────────────────────────────

describe('C1 语义去重 (GWT-R1-3)', () => {
  const base = (): PathMap => ({ destination: 'd', slug: 'm', tickets: [], decisionsLog: [] });

  test('草稿与既有票语义近邻 → 不入图, deduped-semantic 留痕指向撞上的票', () => {
    const m = base();
    m.tickets.push({ id: 't1', type: 'task', title: 'deploy the api server', blockedBy: [], status: 'open' });
    const r = applySuggestions(m, [{ type: 'task', title: 'deploy api server now', suggestedBy: 'run-c1' }], { at: AT });
    expect(r.added).toHaveLength(0);
    expect(r.deduped).toEqual([{ draftTitle: 'deploy api server now', hitTicketId: 't1' }]);
    expect(m.suggestionsLog).toEqual([{ ticketId: 't1', outcome: 'deduped-semantic', at: AT, runId: 'run-c1' }]);
  });

  test('semanticThreshold=0 关语义档 → 近邻照常入图 (只留指纹档)', () => {
    const m = base();
    m.tickets.push({ id: 't1', type: 'task', title: 'deploy the api server', blockedBy: [], status: 'open' });
    const r = applySuggestions(m, [{ type: 'task', title: 'deploy api server now', suggestedBy: 'run-c1' }], { at: AT, semanticThreshold: 0 });
    expect(r.added).toHaveLength(1);
  });

  test('语义无关草稿正常入图 (智能档不误杀)', () => {
    const m = base();
    m.tickets.push({ id: 't1', type: 'task', title: 'deploy the api server', blockedBy: [], status: 'open' });
    const r = applySuggestions(m, [{ type: 'research', title: 'database migration plan', suggestedBy: 'run-c1' }], { at: AT });
    expect(r.added).toHaveLength(1);
  });

  test('deduped-semantic 过 md 序列化往返', () => {
    const m = base();
    m.suggestionsLog = [{ ticketId: 't1', outcome: 'deduped-semantic', at: AT, runId: 'r1' }];
    const back = parseMapMarkdown(renderMapMarkdown(m));
    expect(back.suggestionsLog).toEqual(m.suggestionsLog);
  });
});
