/**
 * web-fanout 的 **账本恒等式闸**: 一次 web 研究里发生的每一发模型调用, 都必须出现在
 * `fanout.costStats` 里 —— Σ perModel[].calls === 真实调用次数。
 *
 * ## 这条闸修的是什么
 *
 * `usageLog` 是 `researchFanout` 的**局部量** (fanout.ts), 而 conductor 分解
 * (`authorFanoutSpec`) 与种子作者化 (`authorSeedQueries`) 都发生在 `researchFanout` **之前**,
 * 结构上在它的作用域外 —— 于是 `--council` 那一发 conductor (全程最贵的单发之一) 从来没进过账本。
 * 账本是量「执行择优有没有收益」的**尺子**: 低报成本 = 高估收益, 先修尺子再量。
 *
 * ## 反向自检 —— 去掉修复, 这些测试怎么红
 *
 * 把 `web-fanout.ts` 里传给 `researchFanout` 的 `priorUsage` 删掉 (或把 `onUsage` 回调摘了):
 * · 「conductor 那一发进账」当场红 —— `perModel['fake:conductor']` 变 undefined;
 * · 「种子作者化那一发进账」当场红 —— 恒等式差 1 发, 且 lens 座位的 `in` 少掉那 800;
 * · 「无 council 无种子」那条**不会**变 —— 它钉的是"本来就没有额外调用时账本零变化",
 *   修不修都该绿。它是这组里唯一一条**修复拿掉也绿**的, 故意留着当对照:
 *   没有它, 前两条可以靠"把某发重复计数"之类的错法凑对, 也分不清恒等式是不是本来就假。
 */
import { describe, expect, test } from 'bun:test';
import { assertResearchPoolsRetired, researchWebFanout, type WebFanoutOpts } from './web-fanout';
import { PassthroughCleaner } from '../web/clean';
import type { WebStack } from '../web';
import type { FetchProvider, FetchResult, SearchResult } from '../web/types';
import type { FanoutCostStats } from './fanout';
import type { ModelResponse } from '../../model/types';

const hit = (url: string): SearchResult => ({ title: url, url, snippet: '' });

/** 无网络 fake stack: 固定命中 2 源, 正文够长过 minChars。 */
function fakeStack(): WebStack {
  const fetchProvider: FetchProvider = {
    name: 'fakefetch',
    async fetch(url): Promise<FetchResult> {
      return { url, text: 'x'.repeat(300) };
    },
  };
  return {
    searchPool: {
      async search() {
        return {
          results: [hit('http://a.com/1'), hit('http://b.com/2')],
          providers: ['fake'],
          mode: 'rotate' as const,
        };
      },
    },
    fetchProviders: [fetchProvider],
    cleaner: new PassthroughCleaner(),
    quota: {},
  } as unknown as WebStack;
}

const CONDUCTOR_SPEC = {
  lenses: [{ key: 'L1', persona: 'p1', subAngles: ['a1'] }],
  synthesisFramings: [{ key: 'F1', framing: 'f1' }],
  judgeCriteria: [{ key: 'J1', criterion: 'c1' }],
};

const textOf = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c));

/**
 * 计数用 fake: 每发记一次。conductor / 种子作者化两发给可辨认的大 `in` ——
 * 既证明"它在账上", 也证明记的是**它自己的数**, 不是被叶子的数顶替。
 * conductor 认 system 消息 (这条路径上只有 authorFanoutSpec 发 system), 种子认 prompt 里的固定串。
 */
function countingCall(): { call: NonNullable<WebFanoutOpts['_callModel']>; calls: () => number } {
  let n = 0;
  const call: NonNullable<WebFanoutOpts['_callModel']> = async (req) => {
    n += 1;
    const isConductor = req.messages[0]?.role === 'system';
    const isSeedAuthor = textOf(req.messages[0]?.content).includes('互补角度');
    const parsed = isConductor ? CONDUCTOR_SPEC : isSeedAuthor ? { queries: ['种子一'] } : undefined;
    const usage = isConductor ? { in: 12_340, out: 567 } : isSeedAuthor ? { in: 800, out: 90 } : { in: 1, out: 1 };
    return { text: parsed ? JSON.stringify(parsed) : 'ok', parsed, usage, raw: {}, model: req.model, attempts: 1 } as ModelResponse;
  };
  return { call, calls: () => n };
}

/** 座位全 `fake:` 前缀 → withGoFallback 不重试、makeBudgetedCall 不排队; 发散池置空 → 不轮到真坐标。 */
function opts(over: Partial<WebFanoutOpts>, call: NonNullable<WebFanoutOpts['_callModel']>): WebFanoutOpts {
  return {
    lensModel: 'fake:lens',
    reasonModel: 'fake:reason',
    reduceModel: 'fake:reduce',
    judgeModel: 'fake:judge',
    graftModel: 'fake:graft',
    fusionModel: 'fake:fusion',
    divergePool: [],
    judgePool: [],
    _configuredPools: () => ({}), // #143 密封: 不读机器上的 config/env pools
    _callModel: call,
    ...over,
  };
}

const totalCalls = (cs: FanoutCostStats): number =>
  Object.values(cs.perModel).reduce((sum, m) => sum + m.calls, 0);

describe('researchWebFanout 账本恒等式: 每一发调用都进 costStats', () => {
  test('★ council 的 conductor 那一发进账 (且记的是它自己的 token 数)', async () => {
    const { call, calls } = countingCall();
    const r = await researchWebFanout(fakeStack(), 'q', opts({ council: true, conductorModel: 'fake:conductor' }, call));

    const conductor = r.fanout.costStats.perModel['fake:conductor'];
    expect(conductor).toBeDefined();
    expect(conductor!.calls).toBe(1);
    expect(conductor!.in).toBe(12_340);
    expect(conductor!.out).toBe(567);
    // 恒等式: 账上的调用数 === 真实发生的调用数 (既防漏记, 也防把 conductor 重复计进叶子)。
    expect(totalCalls(r.fanout.costStats)).toBe(calls());
  });

  test('★ 种子作者化那一发同样进账 (deep 档 authorSeeds; 它与 lens 同座, 靠 token 数辨认)', async () => {
    const { call, calls } = countingCall();
    const r = await researchWebFanout(fakeStack(), 'q', opts({ authorSeeds: true }, call));

    const lens = r.fanout.costStats.perModel['fake:lens'];
    expect(lens).toBeDefined();
    expect(lens!.in).toBeGreaterThanOrEqual(800); // 叶子每发 in=1, 只有种子那发是 800
    expect(totalCalls(r.fanout.costStats)).toBe(calls());
  });

  test('对照 (修复拿掉也该绿): 无 council 无种子 → 恒等式本来就成立, 账本零变化', async () => {
    const { call, calls } = countingCall();
    const r = await researchWebFanout(fakeStack(), 'q', opts({}, call));

    expect(r.fanout.costStats.perModel['fake:conductor']).toBeUndefined();
    expect(totalCalls(r.fanout.costStats)).toBe(calls());
  });
});

describe('#143 config.pools 退役闸 (座位是唯一真源的 research 半)', () => {
  const seats = { lens: 'prov:lens-seat', judge: 'prov:judge-seat' };

  test('池与座位不一致 → 红 (旧行为是池静默赢; 证伪: 把 assertResearchPoolsRetired 的 throw 改回 warn 即此条红)', () => {
    expect(() => assertResearchPoolsRetired({ lens: ['other:model'] }, seats)).toThrow(/#143.*lens/);
    expect(() => assertResearchPoolsRetired({ judge: ['other:model'] }, seats)).toThrow(/#143.*judge/);
    // 多坐标池即使**含**座位坐标也算不一致 —— 轮换行为与单座位不同, 不是"无差遗留"。
    expect(() => assertResearchPoolsRetired({ lens: ['prov:lens-seat', 'other:model'] }, seats)).toThrow(/#143/);
  });

  test('池与座位逐字一致 (单坐标) → 不红, 只警告催删 (今天盘上仓的形状, 不断人跑)', () => {
    expect(() => assertResearchPoolsRetired({ lens: ['prov:lens-seat'], judge: ['prov:judge-seat'] }, seats)).not.toThrow();
  });

  test('池缺席/空 → 闸无声', () => {
    expect(() => assertResearchPoolsRetired({}, seats)).not.toThrow();
    expect(() => assertResearchPoolsRetired({ lens: [], judge: [] }, seats)).not.toThrow();
  });

  test('接线: researchWebFanout 在花第一分钱之前就红 (零模型调用)', async () => {
    const { call, calls } = countingCall();
    await expect(
      researchWebFanout(fakeStack(), 'q', opts({ _configuredPools: () => ({ lens: ['fake-legacy:pool-model'] }) }, call)),
    ).rejects.toThrow(/#143/);
    expect(calls()).toBe(0);
  });
});
