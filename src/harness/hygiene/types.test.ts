/**
 * hygiene/types.test —— INV-2「棘轮只升红」(GWT-2) + counts 键集合完整性。
 *
 * 反向自检 (逐条):
 *   · 把 `ratchet` 里的 `if (n <= b) continue` 改成 `if (n < b)` → 「持平不算升」那条当场红。
 *   · 把 `added` 的差集换成 `nowIds` 恒返回 → 「baseIds 给了就走真差集」那条红。
 *   · 从 `HYGIENE_SOURCES` 里删掉任意一个类 → 「counts 键集合 = 12 类」那条红。
 */
import { describe, expect, test } from 'bun:test';
import {
  BIG_FILE_LINE_THRESHOLD,
  HYGIENE_SOURCES,
  MAX_ITEMS_PER_LEAF,
  STALE_PLAN_DAYS,
  emptyCounts,
  ratchet,
  renderRatchet,
  type HygieneItem,
  type HygieneScan,
} from './types';

const item = (id: string, source: HygieneItem['source']): HygieneItem => ({
  id,
  source,
  summary: id,
  evidence: [id],
});

const scan = (items: HygieneItem[]): HygieneScan => {
  const counts = emptyCounts();
  for (const i of items) counts[i.source] += 1;
  return { version: 1, generatedAt: '2026-09-02T00:00:00Z', sha: 'deadbee', counts, items, errors: [] };
};

describe('INV-2 棘轮只升红 (GWT-2)', () => {
  const base = { ...emptyCounts(), todo: 23 };
  const baseIds = { todo: Array.from({ length: 23 }, (_, i) => `todo:old-${i}`) };
  const now24 = scan([...baseIds.todo.map((id) => item(id, 'todo')), item('todo:brand-new', 'todo')]);

  test('now 24 > base 23 → ok=false, rose 指名那一类', () => {
    const v = ratchet(base, now24, baseIds);
    expect(v.ok).toBe(false);
    expect(v.rose).toHaveLength(1);
    expect(v.rose[0]!.source).toBe('todo');
    expect(v.rose[0]!.base).toBe(23);
    expect(v.rose[0]!.now).toBe(24);
  });

  test('baseIds 给了 → added 是真差集, 只含新增那一项', () => {
    const v = ratchet(base, now24, baseIds);
    expect(v.rose[0]!.added).toEqual(['todo:brand-new']);
  });

  test('baseIds 缺席 → 做不了差集, 退化为列当前全部 (不编造差)', () => {
    const v = ratchet(base, now24);
    expect(v.rose[0]!.added).toHaveLength(24);
    expect(v.rose[0]!.added).toContain('todo:brand-new');
  });

  test('now 22 < base 23 → ok', () => {
    const v = ratchet(base, scan(baseIds.todo.slice(0, 22).map((id) => item(id, 'todo'))), baseIds);
    expect(v.ok).toBe(true);
    expect(v.rose).toEqual([]);
  });

  test('持平不算升 (23 → 23 → ok)', () => {
    const v = ratchet(base, scan(baseIds.todo.map((id) => item(id, 'todo'))), baseIds);
    expect(v.ok).toBe(true);
  });

  test('多类同时升 → rose 逐类列出', () => {
    const v = ratchet({ ...emptyCounts(), todo: 0, debt: 0 }, scan([item('todo:a', 'todo'), item('debt:b', 'debt')]));
    expect(v.rose.map((r) => r.source).sort()).toEqual(['debt', 'todo']);
  });

  test('renderRatchet 判词带类名与新增 id (人读面)', () => {
    const text = renderRatchet(ratchet(base, now24, baseIds));
    expect(text).toContain('todo');
    expect(text).toContain('23 → 24');
    expect(text).toContain('todo:brand-new');
    expect(renderRatchet({ ok: true, rose: [] })).toContain('OK');
  });
});

describe('counts 键集合完整', () => {
  test('emptyCounts 覆盖全部 12 类且都是 0', () => {
    const c = emptyCounts();
    expect(Object.keys(c).sort()).toEqual([...HYGIENE_SOURCES].sort());
    expect(HYGIENE_SOURCES).toHaveLength(12);
    expect(Object.values(c).every((n) => n === 0)).toBe(true);
  });
});

describe('阈值走常量不写字面', () => {
  test('三个阈值有导出值 (miners/链构造引用同一份)', () => {
    expect(BIG_FILE_LINE_THRESHOLD).toBeGreaterThan(0);
    expect(STALE_PLAN_DAYS).toBeGreaterThan(0);
    expect(MAX_ITEMS_PER_LEAF).toBeGreaterThan(0);
  });
});
