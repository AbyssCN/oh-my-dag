/**
 * ticket-guard (INV-BOX-1) —— 裁决入口唯一守卫的契约。
 *
 * 钉 SDD 片 6 INV-BOX-1 两条 GWT:
 *   · `canRule` 在 suggested 票上 `#226` / `226` 两种写法**同拒** (今天 #226 被拒, 裸 226
 *     直接裁掉并写了 gh —— 这条 GWT 就是那处漂的证伪);
 *   · `canConfirm` 对同一张图 `#226` / `226` 两种写法**同过** (今天裸 id 在 #206 前报「票不存在」)。
 *
 * 反向自检 (实跑过):
 *   · 把 `canRule` 里 suggested 判断挪到 `canConfirm` → GWT-1 红 (confirm 拒掉自己的合法目标)
 *   · 把 `canConfirm` 里 suggested 判断搬过来 → GWT-2 红 (confirm 拒掉 suggested)
 *   · 把 `resolveTicketId` 改成只精确匹配 → GWT-1 + GWT-2 全红 (裸 id 找不到)
 *   · 把 `reason` 模板里「先 map_confirm」改成「先确认」 → GWT-1 红 (关键指引丢失)
 */
import { describe, expect, test } from 'bun:test';
import type { PathMap, Ticket } from './types';
import { canConfirm, canRule, resolveTicketId } from './ticket-guard';

const t = (over: Partial<Ticket> & { id: string }): Ticket => ({
  type: 'task',
  title: `票 ${over.id}`,
  blockedBy: [],
  status: 'open',
  ...over,
});

/** GWT 用图: 一张 suggested 票 (`#226`) + 一张普通 open 票 (`t1`)。 */
const fixture = (): PathMap => ({
  destination: 'guard 测试图',
  slug: 'guard',
  tickets: [
    t({ id: '#226', status: 'suggested', suggestedBy: 'run-7' }),
    t({ id: 't1', status: 'open' }),
  ],
  decisionsLog: [],
});

describe('INV-BOX-1 GWT-1 · canRule 在 suggested 上 #226 / 226 同拒', () => {
  test('#226 → { ok: false }, reason 点名「先 map_confirm」', () => {
    const r = canRule(fixture(), '#226');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('先 map_confirm');
    expect(r.reason).toContain('#226');
  });

  test('裸 226 → { ok: false }, reason 点名「先 map_confirm」 (证 #206 那处漂)', () => {
    const r = canRule(fixture(), '226');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('先 map_confirm');
    expect(r.reason).toContain('#226');
  });

  test('reason 字面照 MCP: 「票 \"#226\" 是机器建议 (suggested) — 先 map_confirm accept/reject, 确认后才可裁决」', () => {
    const r = canRule(fixture(), '226');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('票 "#226" 是机器建议 (suggested) — 先 map_confirm accept/reject, 确认后才可裁决');
  });
});

describe('INV-BOX-1 GWT-2 · canConfirm 对 #226 / 226 同过 (证 #206 前裸 id 报「不存在」)', () => {
  test('#226 → { ok: true, id: "#226" }', () => {
    const r = canConfirm(fixture(), '#226');
    expect(r).toEqual({ ok: true, id: '#226' });
  });

  test('裸 226 → { ok: true, id: "#226" }', () => {
    const r = canConfirm(fixture(), '226');
    expect(r).toEqual({ ok: true, id: '#226' });
  });
});

describe('canRule · 其它路径', () => {
  test('open 票裸 id → { ok: true }, id 不变', () => {
    expect(canRule(fixture(), 't1')).toEqual({ ok: true, id: 't1' });
  });

  test('open 票精确 id → { ok: true }', () => {
    expect(canRule(fixture(), '#226').ok).toBe(false); // #226 是 suggested, 先证这条作对照
    const m: PathMap = { destination: 'd', slug: 's', tickets: [t({ id: 't1' })], decisionsLog: [] };
    expect(canRule(m, 't1')).toEqual({ ok: true, id: 't1' });
  });

  test('找不到 → { ok: false }, reason 字面照 MCP: 「找不到票 "X" — map_tickets 看现有票 (gh 后端的 id 形如 #206)」', () => {
    const r = canRule(fixture(), '999');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('找不到票 "999" — map_tickets 看现有票 (gh 后端的 id 形如 #206)');
  });

  test('null map → { ok: false }, reason 含「找不到票」(读路都没票可认, 别走找一次的回路)', () => {
    const r = canRule(null, 't1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('找不到票');
  });

  test('空串 / 全空白 → { ok: false }', () => {
    expect(canRule(fixture(), '').ok).toBe(false);
    expect(canRule(fixture(), '   ').ok).toBe(false);
  });
});

describe('canConfirm · 其它路径', () => {
  test('找不到 → { ok: false } 同 canRule 措辞', () => {
    const r = canConfirm(fixture(), '999');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('找不到票 "999" — map_tickets 看现有票 (gh 后端的 id 形如 #206)');
  });

  test('null map → { ok: false }', () => {
    expect(canConfirm(null, 't1').ok).toBe(false);
  });

  test('suggested 票是合法目标 (不被挡) — confirm 的存在意义', () => {
    expect(canConfirm(fixture(), '#226')).toEqual({ ok: true, id: '#226' });
  });
});

describe('resolveTicketId · 直接出口', () => {
  test('#226 与 226 同解', () => {
    expect(resolveTicketId(fixture(), '#226')).toBe('#226');
    expect(resolveTicketId(fixture(), '226')).toBe('#226');
  });

  test('md 形式 (t1) 精确匹配', () => {
    expect(resolveTicketId(fixture(), 't1')).toBe('t1');
  });

  test('前后空白被 trim', () => {
    expect(resolveTicketId(fixture(), '  t1  ')).toBe('t1');
  });

  test('null map / 空串 → null', () => {
    expect(resolveTicketId(null, 't1')).toBeNull();
    expect(resolveTicketId(fixture(), '')).toBeNull();
    expect(resolveTicketId(fixture(), '   ')).toBeNull();
  });

  test('认不出 → null (不模糊前缀, 猜错票比认不出坏得多)', () => {
    expect(resolveTicketId(fixture(), '99')).toBeNull(); // 既不是 #99 也不是 99
    expect(resolveTicketId(fixture(), 't')).toBeNull(); // 不前缀匹配 t1
  });
});