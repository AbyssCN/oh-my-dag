/**
 * test/core/reduce-slim —— 契约「reduce 吃索引」的五条不变量。
 *
 * 契约:`docs/plan/2026-08-28-reduce吃索引-执行契约.md`
 * 读数:`docs/research/2026-08-28-脊柱语料瘦身-AB读数.md` §4.12(E-7:lens 段削 30.8%)
 *
 * ## 为什么默认关(这条决定了本文件的第一条断言最重要)
 *
 * 成本收益是硬的(lens 段 422,923 → 292,518 token),**质量侧没有一把站得住的尺子量过** ——
 * E-7 原本的第二条判据 faithfulness 已被证伪(同对象同 prompt 两次判分 0.81 / 0.53,
 * 跨度 0.28,而各臂之间的全部差异只有 0.11)。所以 INV-1(关 = 零回归)是本片的主闸。
 *
 * ## 反向自检(改实装让它红,才算这些断言活着)
 * ① 把开关默认值改成开 → INV-1 红;② 只改注释不改 prompt → INV-2 红;
 * ③ 顺手把 gen 也换成索引 → INV-3 红;④ 为 reduce 另写一版索引构造 → INV-4 红。
 */
import { test, expect, describe, afterEach } from 'bun:test';
import {
  buildCorpusIndex,
  reduceSlimEnabled,
  researchFanout,
  type ResearchFanoutConfig,
} from '../../src/harness/research/fanout';

/** 语料正文里的独有串 —— 它不是标题行, 所以**不会**出现在索引里, 于是能判"这一发吃的是全文还是索引"。 */
const BODY = 'CORPUS-BODY-ONLY-MARKER';

/** 抓全量 prompt(既有 research-fanout.test 只留前 40 字符, 判不了本片的断言)。 */
function makeFake(): { fake: ResearchFanoutConfig['_callModel']; seen: string[] } {
  const seen: string[] = [];
  const fake = (async (req: { model: string; messages: { content: string }[] }) => {
    const p = req.messages[0]!.content;
    seen.push(p);
    let text = 'X';
    if (p.includes('sub-angle:')) text = 'GEN';
    else if (p.includes('首席 judge')) text = 'CHAMPION';
    else if (p.includes('<framing>')) text = 'SYNTH';
    else if (p.includes('评判维度【')) text = 'CRIT';
    else if (p.includes('据 panel')) text = 'FINAL';
    return { text, model: req.model, usage: { in: 1, out: 1 } };
  }) as unknown as ResearchFanoutConfig['_callModel'];
  return { fake, seen };
}

const cfg = (call: ResearchFanoutConfig['_callModel']): ResearchFanoutConfig => ({
  question: 'Q?',
  groundTruth: `# 标题行\n\n${BODY} 这是正文, 不是标题, 所以索引里不该有它。`,
  lenses: [{ key: 'a', persona: 'pa', subAngles: ['a1', 'a2'], abstraction: 'ABS' }],
  synthesisFramings: [{ key: 'min', framing: 'fmin' }],
  judgeCriteria: [{ key: 'correct', criterion: 'correctness' }],
  lensModel: 'fake:flash',
  reasonModel: 'fake:pro',
  _callModel: call,
});

/** reduce 那一发:prompt 里含「首席 judge」的那条。 */
const reduceOf = (seen: string[]): string => seen.find((p) => p.includes('首席 judge'))!;
/** gen 那几发。 */
const gensOf = (seen: string[]): string[] => seen.filter((p) => p.includes('sub-angle:'));

const ORIG = process.env['OMD_REDUCE_SLIM'];
afterEach(() => {
  if (ORIG === undefined) delete process.env['OMD_REDUCE_SLIM'];
  else process.env['OMD_REDUCE_SLIM'] = ORIG;
});

describe('reduce 吃索引 —— 开关本身', () => {
  test('INV-1/2 开关口径: 只有 "1" 算开, 其余(含未设)一律关', () => {
    expect(reduceSlimEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(reduceSlimEnabled({ OMD_REDUCE_SLIM: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(reduceSlimEnabled({ OMD_REDUCE_SLIM: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(reduceSlimEnabled({ OMD_REDUCE_SLIM: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('reduce 吃索引 —— 接线', () => {
  test('INV-1 开关关(默认) = reduce 吃全文, 零回归', async () => {
    delete process.env['OMD_REDUCE_SLIM'];
    const { fake, seen } = makeFake();
    await researchFanout(cfg(fake));
    const reduce = reduceOf(seen);
    expect(reduce).toContain(BODY); // 全文正文在场
    expect(reduce).not.toContain('<corpus-index'); // 索引不在场
  });

  test('INV-2 开关开 = reduce 吃索引, 全文正文不在场', async () => {
    process.env['OMD_REDUCE_SLIM'] = '1';
    const { fake, seen } = makeFake();
    await researchFanout(cfg(fake));
    const reduce = reduceOf(seen);
    expect(reduce).toContain('<corpus-index');
    expect(reduce).not.toContain(BODY);
  });

  test('INV-3 gen 在两种开关状态下都吃全文 —— 它是语料的第一次读, 拿掉是断链不是省钱', async () => {
    for (const state of [undefined, '1'] as const) {
      if (state === undefined) delete process.env['OMD_REDUCE_SLIM'];
      else process.env['OMD_REDUCE_SLIM'] = state;
      const { fake, seen } = makeFake();
      await researchFanout(cfg(fake));
      const gens = gensOf(seen);
      expect(gens.length).toBeGreaterThan(0);
      expect(gens.every((g) => g.includes(BODY))).toBe(true);
      expect(gens.every((g) => !g.includes('<corpus-index'))).toBe(true);
    }
  });

  test('INV-4 索引是同一份实现 —— reduce 的索引块与 buildCorpusIndex 对同一语料的产出逐字相同', async () => {
    process.env['OMD_REDUCE_SLIM'] = '1';
    const { fake, seen } = makeFake();
    const c = cfg(fake);
    await researchFanout(c);
    const reduce = reduceOf(seen);
    // 首轮无 second-pass 追加 ⇒ corpus === groundTruth(fanout 的 head 构造, 无 stablePrefix)
    const expected = buildCorpusIndex(c.groundTruth);
    expect(reduce.startsWith(expected)).toBe(true);
  });
});
