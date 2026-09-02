/**
 * triage.test —— INV-3「分诊解析 fail-closed 到 ticket」(GWT-3)。
 *
 * 反向自检 (逐条, 撤掉判据 → 该条当场红):
 *   · `TriageEntrySchema` 的 `reason` 改成 `.optional()` → 「缺字段整条回退」那条红
 *     (这正是盘上实测 M3 两轮不填可选字段的那个坑)。
 *   · 去掉 `expected.has(entry.itemId)` 那道 → 「编出来的 id 不进 entries」那条红。
 *   · 去掉末尾「期望集缺席也进 fallback」那一路 → 「漏答的 id 不被读成没问题」那条红。
 *   · 去掉 `reproAllowed` 那道 → 「reproCmd 不合白名单也回退」那条红。
 */
import { describe, expect, test } from 'bun:test';
import { TriageEntrySchema, fallbackToTickets, parseTriageBatch } from './triage';

const IDS = ['todo:a', 'todo:b'];
const good = (id: string, disposition = 'delete'): Record<string, string> => ({
  itemId: id,
  disposition,
  reason: '无任何引用',
  reproCmd: 'ugrep -c -F foo src',
});

describe('INV-3 GWT-3 两段坏输入都进 fallback', () => {
  test('坏 JSON → entries 空, fallback = 全部期望 id', () => {
    const r = parseTriageBatch('这不是 JSON, 是一段散文 [ { 半截', IDS);
    expect(r.entries).toEqual([]);
    expect(r.fallback.sort()).toEqual([...IDS].sort());
  });

  test('含未知 itemId 的合法 JSON → entries 空, fallback 含编出来的 id 与漏答的 id', () => {
    const r = parseTriageBatch(JSON.stringify([good('todo:编出来的')]), IDS);
    expect(r.entries).toEqual([]);
    expect(r.fallback).toContain('todo:编出来的');
    expect(r.fallback).toContain('todo:a');
    expect(r.fallback).toContain('todo:b');
  });

  test('整批塌时错误原文经返回值交出去 (吞异常不吞证据)', () => {
    // 有方括号但里面不是合法 JSON → 走 JSON.parse 那条; 连方括号都没有 → 走"找不到数组"那条。
    expect(parseTriageBatch('[ { 半截 ]', IDS).parseError).toContain('JSON.parse 失败');
    expect(parseTriageBatch('我判断不了这批。', IDS).parseError).toContain('找不到 JSON 数组');
    // 好输入不该带判词 —— parseError 缺席 = 这批没塌, 不是"塌了但没记"。
    expect(parseTriageBatch(JSON.stringify(IDS.map((id) => good(id))), IDS).parseError).toBeUndefined();
  });

  test('完全没有数组 (只有一句话) → 全部回退', () => {
    expect(parseTriageBatch('我判断不了这批。', IDS).fallback.sort()).toEqual([...IDS].sort());
  });

  test('JSON 是对象不是数组 → 全部回退', () => {
    expect(parseTriageBatch('{"itemId":"todo:a"}', IDS).entries).toEqual([]);
  });
});

describe('四字段必填 (M3 不填可选字段的实测对策)', () => {
  test('缺 reason → 整条回退, 且 fallback 记得住是哪条', () => {
    const bad = { itemId: 'todo:a', disposition: 'delete', reproCmd: 'ugrep -c -F foo src' };
    const r = parseTriageBatch(JSON.stringify([bad, good('todo:b')]), IDS);
    expect(r.entries.map((e) => e.itemId)).toEqual(['todo:b']);
    expect(r.fallback).toEqual(['todo:a']);
  });

  test('disposition 不在三值域内 → 回退', () => {
    const r = parseTriageBatch(JSON.stringify([good('todo:a', 'maybe')]), IDS);
    expect(r.entries).toEqual([]);
    expect(r.fallback).toContain('todo:a');
  });

  test('空 reason 串等于没分诊 → 回退', () => {
    expect(TriageEntrySchema.safeParse({ ...good('todo:a'), reason: '' }).success).toBe(false);
  });
});

describe('reproCmd 白名单接进解析路径 (fail-closed)', () => {
  test('前缀不合法 → 该条回退, 不进 entries', () => {
    const r = parseTriageBatch(JSON.stringify([{ ...good('todo:a'), reproCmd: 'rm -rf src' }]), IDS);
    expect(r.entries).toEqual([]);
    expect(r.fallback).toContain('todo:a');
  });
});

describe('好输入照常放行', () => {
  test('两条全合法 → entries 两条, fallback 空', () => {
    const r = parseTriageBatch(JSON.stringify(IDS.map((id) => good(id))), IDS);
    expect(r.entries).toHaveLength(2);
    expect(r.fallback).toEqual([]);
  });

  test('```json 围栏里的数组也认', () => {
    const raw = `分诊如下:\n\`\`\`json\n${JSON.stringify(IDS.map((id) => good(id)))}\n\`\`\`\n完毕。`;
    expect(parseTriageBatch(raw, IDS).entries).toHaveLength(2);
  });
});

describe('回退 → ticket 是确定性的', () => {
  test('每条都变成 ticket, reason 说明是回退不是判断', () => {
    const t = fallbackToTickets(['todo:a'], '解析失败');
    expect(t[0]!.disposition).toBe('ticket');
    expect(t[0]!.reason).toContain('回退');
    expect(t[0]!.itemId).toBe('todo:a');
  });
});
