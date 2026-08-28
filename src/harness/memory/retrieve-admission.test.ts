/**
 * **准入与排序分开**(2026-08-28)—— RRF 管排序,合流管准入。
 *
 * ## 为什么不能拿 RRF 分数当相关性
 *
 * RRF 只编码名次:任何查询的第一名恒是 `1/(60+1) = 0.0164`,不管库里有没有一条真相关的。
 * 所以「给 rrf 加个下限」这条路结构上走不通 —— 下面第一条测试把这件事钉死。
 *
 * 反向自检(实跑):
 *  - 把 `admitted` 的过滤去掉(恒等) ⇒ 「无关查询召回 0 条」当场红;
 *  - 把 `AGREEMENT_TOP_N` 调到 100 ⇒ 同上(实测 N≥20 才开始泄漏,100 必泄);
 *  - 把合流条件从"两条腿"改成"任一条腿" ⇒ 同上。
 */
import { describe, expect, test } from 'bun:test';
import { AGREEMENT_TOP_N, createOmdMemory } from './store';
import { UNIVERSAL_SAFEGUARD } from '../../memory/safeguards/namespaces';

const fact = (situation: string, approach: string) => ({
  namespace: 'omd.pattern',
  situation,
  approach,
  outcome: 'worked' as const,
  source_doc_id: `doc-${situation.slice(0, 8)}`,
  confidence: { level: 'agent_tentative' as const, source_event_ids: ['ev-1'], created_at: new Date() },
});

async function seeded() {
  const m = createOmdMemory({ path: ':memory:', safeguard: UNIVERSAL_SAFEGUARD });
  await m.writeFact(fact('平铺图 直通v2 无内环轮 STALLED', '加 maxRounds 无效, 看切片节点 RED GREEN accept'));
  await m.writeFact(fact('嵌套图 有内环轮 STALLED 未收敛', '加 maxRounds 后 resume 再给几轮'));
  await m.writeFact(fact('spec 契约 未落盘 下游拿不到', 'spec 节点 output_type 设为 file'));
  return m;
}

describe('准入 ≠ 排序', () => {
  test('★ RRF 分数量不出相关性 —— 任何查询的第一名都是同一个数', async () => {
    const m = await seeded();
    const rel = await m.retrieve('平铺图 直通v2 STALLED 内环轮', 3, { agreementTopN: null });
    const irr = await m.retrieve('红烧肉 火候 冰糖', 3, { agreementTopN: null });
    // 闸关掉时两个查询都召回得到东西, 而且**头名分数一样** —— 这就是"下限切不动"的现场。
    expect(rel.length).toBeGreaterThan(0);
    if (irr.length > 0) {
      // 名次决定分数:两边第一名的 rrf 落在同一量级, 无法用一个阈值分开
      expect(Math.abs(rel[0]!.rrf - irr[0]!.rrf)).toBeLessThan(0.02);
    }
    m.close();
  });

  test('★ 相关查询照常召回(闸不能把有用的一起切掉)', async () => {
    const m = await seeded();
    const hits = await m.retrieve('平铺图 直通v2 STALLED 内环轮 maxRounds', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain('平铺图');
    m.close();
  });

  test('★ 无关查询召回 0 条(这是本闸的全部目的)', async () => {
    const m = await seeded();
    expect(await m.retrieve('红烧肉 火候 冰糖 老抽', 5)).toEqual([]);
    expect(await m.retrieve('括号 嵌套 深度 匹配', 5)).toEqual([]);
    m.close();
  });

  test('闸可关 —— 关掉就是旧行为(注入真语义 embedder 时要用)', async () => {
    const m = await seeded();
    const off = await m.retrieve('红烧肉 火候 冰糖 老抽', 5, { agreementTopN: null });
    const on = await m.retrieve('红烧肉 火候 冰糖 老抽', 5);
    expect(on.length).toBe(0);
    expect(off.length).toBeGreaterThanOrEqual(on.length); // 关掉只会更宽, 不会更窄
    m.close();
  });

  test('单腿命中不算数 —— 只有词法或只有向量都不收', async () => {
    const m = await seeded();
    const hits = await m.retrieve('平铺图 直通v2 STALLED 内环轮', 10);
    for (const h of hits) {
      expect(h.vecRank).toBeDefined();
      expect(h.bmRank).toBeDefined();
      expect(h.vecRank!).toBeLessThanOrEqual(AGREEMENT_TOP_N);
      expect(h.bmRank!).toBeLessThanOrEqual(AGREEMENT_TOP_N);
    }
    m.close();
  });

  test('★ bmScore 真的被填上了(类型里躺了很久, 从没有值)', async () => {
    const m = await seeded();
    const hits = await m.retrieve('平铺图 直通v2 STALLED 内环轮', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0]!.bmScore).toBe('number');
    m.close();
  });
});
