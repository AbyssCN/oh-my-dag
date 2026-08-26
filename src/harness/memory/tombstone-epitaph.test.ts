/**
 * 墓碑的两列证据 —— `deleted_reason` / `superseded_by` (2026-08-26)。
 *
 * ## 这个闸拦的是什么
 *
 * 改动前 `tombstoneByIdentity(ns, key, _reason)` 的 reason 带 `_` 前缀、一个字都没写出去。
 * 盘上只剩一个 `deleted_at`, 于是四种死法 (evolve 顶掉 / replace 顶掉 / shrink 剪掉 / 人 retract)
 * 全长一个样, 而且没有指向继任者的链 —— 一次写坏的自我进化回不去。
 *
 * ## 反向自检 (仓规: 新加的闸必须当场证伪一次)
 *
 * 把 `tombstoneByIdentity` 里的 `deleted_reason = ?` 改回不写, 「死因可查」那条立刻红;
 * 把 `superseded_by` 不写, 「按 id 回滚」整组红 (回滚要靠这条链找继任者)。
 * 「链断了就拒绝回滚」那条则守着另一侧: 它是唯一能红出「复活会造出两条 live 同 identity」的用例。
 */
import { describe, expect, test } from 'bun:test';
import { OmdMemory } from './store';

/** 同一 identity (situation+approach+scope) 的一条 omd.pattern —— value 不同即触发 supersede。 */
function pattern(outcome: 'worked' | 'failed', eventId: string) {
  return {
    namespace: 'omd.pattern',
    situation: 'leaf 判据反复红',
    approach: '先读判据本身再改产物',
    outcome,
    source_event_id: eventId,
    confidence: { level: 'agent_tentative', source_event_ids: [eventId], created_at: new Date() },
  };
}

async function seeded(): Promise<{ mem: OmdMemory; first: string; second: string }> {
  const mem = new OmdMemory();
  const a = await mem.writeFact(pattern('failed', 'ev-1'));
  const b = await mem.writeFact(pattern('worked', 'ev-2'));
  if (a.status !== 'written' || b.status !== 'written') {
    throw new Error(`seed 失败: ${JSON.stringify([a, b])}`); // 判词要带原文, 否则下一个人只看到 undefined
  }
  return { mem, first: a.id, second: b.id };
}

describe('墓志铭 — 死因与继任者落盘', () => {
  test('被顶掉的事实带死因 + 指向继任者的链', async () => {
    const { mem, first, second } = await seeded();
    const ep = mem.epitaph(first);
    expect(ep).not.toBeNull();
    expect(ep!.reason).toMatch(/^superseded:(evolve|replace)$/);
    expect(ep!.supersededBy).toBe(second);
  });

  test('活着的事实没有墓志铭 (null ≠ 有碑但没刻字)', async () => {
    const { mem, second } = await seeded();
    expect(mem.epitaph(second)).toBeNull();
  });

  test('不存在的 id 同样 null (不抛)', async () => {
    const { mem } = await seeded();
    expect(mem.epitaph('nope')).toBeNull();
  });
});

describe('按 id 回滚一次自我进化', () => {
  test('回滚后: 旧的活过来, 新的进墓且死因写明是被回滚顶掉的', async () => {
    const { mem, first, second } = await seeded();
    expect(mem.revertSupersession(first)).toBe(true);
    expect(mem.epitaph(first)).toBeNull(); // 活了
    const ep = mem.epitaph(second);
    expect(ep!.reason).toBe(`reverted-to:${first}`);
    // identity 上的 live 仍恰好一条 —— supersession 不变量没被回滚破坏。
    const live = mem.liveByIdentity('omd.pattern', mem.identityKeyOf(pattern('failed', 'ev-1') as never));
    expect(live).not.toBeNull();
    expect(live!.outcome).toBe('failed'); // ValidatedFact 有索引签名, 直接读即可
  });

  test('回滚之后 FTS 也跟着回去 (检索面与库面不许分裂)', async () => {
    const { mem, first } = await seeded();
    mem.revertSupersession(first);
    const hits = await mem.retrieve('判据反复红', 5);
    expect(hits.map((h) => h.id)).toContain(first);
  });

  test('反向: 继任者已经又被顶掉 → 链断, 拒绝回滚', async () => {
    const { mem, first } = await seeded();
    await mem.writeFact(pattern('failed', 'ev-3')); // 第三次写, 把 second 也顶掉
    expect(mem.revertSupersession(first)).toBe(false);
  });

  test('反向: 对一条活着的事实回滚 → false (无事可做)', async () => {
    const { mem, second } = await seeded();
    expect(mem.revertSupersession(second)).toBe(false);
  });
});
