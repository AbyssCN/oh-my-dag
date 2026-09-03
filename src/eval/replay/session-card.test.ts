/**
 * session-card.test —— 校卡闸的判别力 (契约 INV-2 / GWT-2)。
 *
 * 「反向自检六连」= 六道闸各配一份已知违规样本。**下面的读数是真跑出来的**, 不是推的
 * (逐条把闸改成 `if (false)` 再跑本文件):
 *  · 摘 ⑤ touchesExcluded 判        → 1 fail (「五张坏卡同批」)
 *  · 摘 ⑥ dangling 判               → 1 fail (同上)
 *  · 摘 ④b 夜帽判                   → 1 fail (「Σ预算超夜帽」)
 *  · 摘 ⑦ accepted.length 判        → 1 fail (「超 3 卡」)
 *  · 摘 ④a 单卡帽判                 → 1 fail (「单卡超帽但不触夜帽」—— 这条用例就是为解开
 *      ④b 的遮蔽才存在: 原先 600 分钟的样本同时越两条帽, 摘掉 ④a 仍被 ④b 接住, 读数 0 fail)
 *  · 摘 ① substrate 显式判 → **0 fail** · 摘 ② mainObjective 显式判 → **0 fail**
 *      —— 这两道被 schema 的判别联合 / enum **双覆盖**: 显式闸摘掉后卡落到 ③, zod 的 issue
 *      path 逐字就是 `substrate` / `mainObjective`, reason 仍含关键词。两道都摘才红。
 *      留着显式闸的理由是判词面向提案席可读 (列出合法值 + 说清「一张卡只跑一个基质」),
 *      不是判别力 —— 这一行写在这里, 是为了下一个人不要误以为它是唯一防线。
 * 反面 (挡「闸做成恒真/恒拒」): 把 gateCards 改成恒返 `accepted: []` → 6 fail。
 *
 * ✎ 与契约 GWT-2 的用例形状差异 (已记 finding): maxCards 那一道需要**足量好卡**才触发,
 *   与另外五张坏卡放同一次调用会被前五道先剔掉 (闸顺序: 内容错先于排位错)。故拆成两次调用,
 *   六道闸仍逐条各红一次。
 */
import { describe, expect, test } from 'bun:test';
import {
  FITNESS_FIELDS,
  SESSION_CARD_VERSION,
  SessionCardSchema,
  gateCards,
  type CardGateCaps,
  type CandidateIdSource,
} from './session-card';

const CANDIDATES: CandidateIdSource = {
  items: [{ id: 'failed-runs:not-converged' }, { id: 'readout:speedup-null' }],
};

const CAPS: CardGateCaps = { maxCards: 3, nightBudgetMinutes: 480, sessionBudgetMinutes: 120 };

/** 一张合法的 S3 卡 (其余 fixture 都在它身上改一处 —— 单一变量)。S1/S2 已随 v1 于 2026-09-04 退役。 */
function goodEvolve(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id,
    substrate: 'S3',
    goal: '给 x 加一个字段',
    writeSet: ['src/harness/x.ts'],
    verify: 'bun test src/harness/x.test.ts',
    mainObjective: 'planValidityRate',
    objectiveRow: 'O3b',
    hypothesis: '给 conductor 加图式 few-shot 会抬 plan 合格率',
    evidenceRefs: ['failed-runs:not-converged'],
    successSignal: 'main 段 planValidityRate 相对 baseline 升且 held-out 不降',
    voidConditions: ['语料 hash 变化', '座位签名变化'],
    budgetMinutes: 60,
    ...over,
  };
}

/** 一张合法的 S3 卡。 */
function goodCode(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id,
    substrate: 'S3',
    mainObjective: 'speedupTheoreticalMedian',
    objectiveRow: 'O3a',
    hypothesis: 'durationMs 剔除规则修好后主尺不再全 null',
    evidenceRefs: ['readout:speedup-null'],
    successSignal: 'speedupTheoreticalMedian 非 null 的样本数 > 0',
    voidConditions: ['tsc 红'],
    budgetMinutes: 90,
    goal: '修 speedup 剔除规则',
    writeSet: ['src/harness/dag/engine-readout.ts'],
    verify: 'bun test src/harness/',
    ...over,
  };
}

describe('SessionCard schema', () => {
  test('版本常量与五维词表', () => {
    expect(SESSION_CARD_VERSION).toBe(1);
    expect(FITNESS_FIELDS).toContain('speedupTheoreticalMedian');
    expect(FITNESS_FIELDS).toHaveLength(5);
  });

  test('两张 S3 好卡过 schema (S1/S2 已退役, 见 bad-substrate)', () => {
    expect(SessionCardSchema.safeParse(goodEvolve('c1')).success).toBe(true);
    expect(SessionCardSchema.safeParse(goodCode('c2')).success).toBe(true);
  });

  test('S3 卡缺 goal/writeSet/verify → schema 拒 (基质专属槽必填)', () => {
    const r = SessionCardSchema.safeParse({ ...goodCode('c3'), writeSet: undefined });
    expect(r.success).toBe(false);
  });
});

describe('gateCards 六道闸 (INV-2 反向自检六连)', () => {
  test('好卡放行, accepted 保序', () => {
    const r = gateCards([goodEvolve('a'), goodCode('b')], CANDIDATES, CAPS);
    expect(r.rejected).toEqual([]);
    expect(r.accepted.map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('五张坏卡同批: accepted 为空, 五条 reason 各含自己的关键词', () => {
    const bad = [
      // ① 双基质 —— 判别键不是三个字面量之一
      goodEvolve('bad-substrate', { substrate: ['S1', 'S2'] }),
      // ② 主目标不在 fitness 五维
      goodEvolve('bad-main', { mainObjective: 'rewardMean' }),
      // ④ 单卡预算超帽 (夜帽 480 / 单卡帽 120)
      goodEvolve('bad-budget', { budgetMinutes: 600 }),
      // ⑤ S3 写集命中排除表
      goodCode('bad-writeset', { writeSet: ['src/eval/replay/fitness.ts'] }),
      // ⑥ evidenceRefs 指向不存在的 candidate id
      goodEvolve('bad-evidence', { evidenceRefs: ['sessions:this-id-does-not-exist'] }),
    ];
    const r = gateCards(bad, CANDIDATES, CAPS);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(5);
    const reasons = r.rejected.map((x) => x.reason);
    expect(reasons[0]).toContain('substrate');
    expect(reasons[1]).toContain('mainObjective');
    expect(reasons[2]).toContain('budget');
    expect(reasons[3]).toContain('excluded');
    expect(reasons[4]).toContain('evidenceRefs');
  });

  test('⑦ 超 3 卡: 第 4 张被拒, reason 含 maxCards', () => {
    const four = ['c1', 'c2', 'c3', 'c4'].map((id) => goodEvolve(id, { budgetMinutes: 30 }));
    const r = gateCards(four, CANDIDATES, CAPS);
    expect(r.accepted.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain('maxCards');
  });

  test('④a 单卡超帽但不触夜帽: 单卡帽这一道自己能红', () => {
    // 150 > sessionBudgetMinutes(120) 而 150 < nightBudgetMinutes(480) —— 只有 ④a 拦得住。
    const r = gateCards([goodEvolve('fat', { budgetMinutes: 150 })], CANDIDATES, CAPS);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('budget 超单卡帽');
  });

  test('④ Σ预算超夜帽: 第三张被拒, 前两张照收 (两侧都写)', () => {
    const caps: CardGateCaps = { maxCards: 3, nightBudgetMinutes: 200, sessionBudgetMinutes: 120 };
    const cards = [
      goodEvolve('p1', { budgetMinutes: 100 }),
      goodEvolve('p2', { budgetMinutes: 90 }),
      goodEvolve('p3', { budgetMinutes: 60 }),
    ];
    const r = gateCards(cards, CANDIDATES, caps);
    expect(r.accepted.map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(r.rejected[0]!.reason).toContain('budget');
  });

  test('maxCards 数 accepted 不数下标: 前面的坏卡不占额度', () => {
    const cards = [
      goodEvolve('x-bad', { mainObjective: 'nope' }),
      goodEvolve('k1', { budgetMinutes: 30 }),
      goodEvolve('k2', { budgetMinutes: 30 }),
      goodEvolve('k3', { budgetMinutes: 30 }),
    ];
    const r = gateCards(cards, CANDIDATES, CAPS);
    expect(r.accepted.map((c) => c.id)).toEqual(['k1', 'k2', 'k3']);
    expect(r.rejected).toHaveLength(1);
  });

  test('S3 写集不含排除表路径 → 放行 (⑤ 不是恒拒)', () => {
    const r = gateCards([goodCode('ok')], CANDIDATES, CAPS);
    expect(r.accepted).toHaveLength(1);
  });

  test('整份不是数组也不是 {cards:[…]} → 整份拒, 不抛', () => {
    const r = gateCards('随便写了一段话', CANDIDATES, CAPS);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
  });

  test('{cards:[…]} 包装也收 (提案席两种写法都见过)', () => {
    const r = gateCards({ cards: [goodEvolve('w')] }, CANDIDATES, CAPS);
    expect(r.accepted.map((c) => c.id)).toEqual(['w']);
  });

  test('空数组 → accepted 空 rejected 空 (无可跑卡不是失败, D-3)', () => {
    const r = gateCards([], CANDIDATES, CAPS);
    expect(r).toEqual({ accepted: [], rejected: [] });
  });
});
