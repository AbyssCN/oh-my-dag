/**
 * 缺口回搜第三腿 (B1) —— 单元闸。钉 `buildSecondPassProbe` 的回搜行为:
 *
 * - **INV-1** GWT-1: 回搜有界 —— gaps 含 N 条去重后不同的 webQueries 且 probeSearch=2, 真 search 调用恰为 2 次;
 * - **INV-1** GWT-2: 跨轮不重 —— 同一 query (trim+小写归一) 跨轮不重搜;
 * - **INV-2** GWT-3: 单 query 抛错 → 该 query 跳过, 其他腿产出不受影响 (fail-open 对齐种子检索);
 * - **INV-3** GWT-4: 回搜命中带正文的 URL → `fetchedUrls` 收录 + `searchedQueries` 含该 query;
 * - **INV-5** GWT-6: gaps 不含 webQueries → search 调用为 0。
 *
 * ## 反向自检 (每条写在测试注释): 删 / 改以下任一项, 对应 GWT 红
 *
 * - 删 `searchedSet` 去重 → GWT-1 一次返回 3 调用而非 2, GWT-2 第二轮不增加新调用;
 * - 把 `searchedQueries` 从 ProbeYield 拿掉 → GWT-4 拿到的 searchedQueries 为 undefined;
 * - 取消单 query try/catch → GWT-3 整腿抛错而非只丢 bad 那一 query;
 * - 把 search 调用挪到 gap.analysis 之前 → GWT-6 也会有调用 (因为已经测不到这点)。
 *   这里依赖: 已生成测试断言只看 search 调用次数, 不靠"看似正常"来挑错。
 */
import { describe, expect, test } from 'bun:test';
import { buildSecondPassProbe } from './web-fanout';
import type { ResearchGap } from './fanout';
import { PassthroughCleaner } from '../web/clean';
import type { WebStack } from '../web';
import type { FetchProvider, FetchResult, SearchResult } from '../web/types';
import type { PoolSearchResult } from '../web/pool';

const hit = (url: string): SearchResult => ({ title: url, url, snippet: '' });

/** 计数 + 按 query 派发的 fake searchPool: 每条 query 记录一次, 返该 query 的命中 + 带 bodied URL。 */
function countingSearchPool(
  byQuery: Record<string, Array<{ url: string; body: string }>>,
): { pool: WebStack['searchPool']; calls: () => Array<{ q: string; k: number }> } {
  const calls: Array<{ q: string; k: number }> = [];
  const search = async (
    query: string,
    maxResults?: number,
  ): Promise<PoolSearchResult> => {
    calls.push({ q: query, k: maxResults ?? 0 });
    const hits = byQuery[query] ?? [];
    return {
      results: hits.map((h) => hit(h.url)),
      providers: ['fake'],
      mode: 'rotate',
    };
  };
  return {
    pool: {
      search,
      setMode: () => {},
      setDefault: () => {},
      toggle: () => {},
      status: () => [],
    } as unknown as WebStack['searchPool'],
    calls: () => calls,
  };
}

/** 直抓腿 fake fetch provider: 每个 URL 按表返 FetchResult; 未命中走 dummy (够长过 minChars=1)。 */
function fakeFetchByUrl(byUrl: Record<string, string> = {}): FetchProvider {
  return {
    name: 'fakefetch',
    async fetch(url: string): Promise<FetchResult> {
      return { url, text: byUrl[url] ?? 'x'.repeat(300) };
    },
  };
}

/** search 提供 `byQuery`, fetch provider 返 byUrl; 同时暴露 searchCalls 用于断言。 */
function fakeStack(
  byQuery: Record<string, Array<{ url: string; body: string }>>,
  byUrl: Record<string, string> = {},
): { stack: WebStack; searchCalls: () => Array<{ q: string; k: number }> } {
  const { pool, calls } = countingSearchPool(byQuery);
  return {
    stack: {
      searchPool: pool,
      fetchProviders: [fakeFetchByUrl(byUrl)],
      cleaner: new PassthroughCleaner(),
      quota: {} as never,
    } as unknown as WebStack,
    searchCalls: calls,
  };
}

/** 把 search hit 包装成 retrieveWeb 会用的 (url, body) — body 长度要过 minChars 默认 200。 */
const body = (s: string): Array<{ url: string; body: string }> => [{ url: s, body: 'x'.repeat(300) }];

const gaps = (...ws: ResearchGap[]): ResearchGap[] => ws;

/** 单条 gap: webQueries 是该缺口点名的回搜 query 集合。 */
const gap = (webQueries: string[], urls: string[] = [], repoQueries: string[] = []): ResearchGap => ({
  key: 'g',
  question: 'q',
  why: 'w',
  ...(urls.length ? { urls } : {}),
  ...(repoQueries.length ? { repoQueries } : {}),
  ...(webQueries.length ? { webQueries } : {}),
});

describe('buildSecondPassProbe 回搜腿 (B1) — 有界 / 跨轮不重 / fail-open / 留痕 / 缺省', () => {
  test('★ GWT-1 INV-1: 3 条去重后不同的 webQueries + probeSearch=2 → 真 search 调用恰 2 次, 第 3 条未出现', async () => {
    // 三个不同 query, 每条配一条命中; 取默认值 probeSearch=2。
    const { stack, searchCalls } = fakeStack({
      q1: body('https://a.test/1'),
      q2: body('https://a.test/2'),
      q3: body('https://a.test/3'),
    });
    const probe = buildSecondPassProbe(stack, [], {});
    const yield_ = await probe({ round: 0, digest: '', gaps: gaps(gap(['q1', 'q2', 'q3'])) });

    const calls = searchCalls();
    expect(calls.length).toBe(2);
    // 第 3 条没出现过 (也不在任意一次调用参数里)
    expect(calls.map((c) => c.q)).not.toContain('q3');
    // 留痕 + 产出齐 (回搜至少搜了, 就有 searchedQueries)
    expect(yield_.searchedQueries).toBeDefined();
    expect(yield_.searchedQueries!.length).toBe(2);
    expect(yield_.fetchedUrls).toBeDefined();
    // 拿到的两条都带 bodied URL
    expect(yield_.fetchedUrls!.sort()).toEqual(['https://a.test/1', 'https://a.test/2']);
  });

  test('★ GWT-2 INV-1: 第 1 轮已搜过 "q1", 第 2 轮 gaps 再含 "q1" + "q2" → search 只为 "q2" 增加新调用', async () => {
    // 跨轮持久: alreadySearched 在 2 轮间传递。两轮加起来的总调用: 1 (r1 q1) + 1 (r2 q2)。
    const { stack, searchCalls } = fakeStack({
      q1: body('https://a.test/q1'),
      q2: body('https://a.test/q2'),
    });
    const probe1 = buildSecondPassProbe(stack, [], { probeSearch: 1 });
    const y1 = await probe1({ round: 0, digest: '', gaps: gaps(gap(['q1'])) });
    expect(y1.searchedQueries).toEqual(['q1']);

    // 第 2 轮: 跨轮过滤集 = r1 用过的 query。复用同一个 searchedSet (跨轮持久纪律)。
    const probe2 = buildSecondPassProbe(stack, [], { alreadySearched: y1.searchedQueries });
    const y2 = await probe2({ round: 1, digest: '', gaps: gaps(gap(['q1', 'q2'])) });
    expect(searchCalls().length).toBe(2); // r1 q1 + r2 q2, q1 没重搜
    expect(searchCalls().map((c) => c.q)).toEqual(['q1', 'q2']);
    expect(y2.searchedQueries).toEqual(['q2']);
  });

  test('★ 跨轮大小写/空白归一: "Q1" 与 " q1 " 视为同一 query', async () => {
    // trim + 小写归一: 第 1 轮 "Q1", 第 2 轮 " q1 " 算重复, 不重搜。
    const { stack, searchCalls } = fakeStack({ q1: body('https://a.test/q1') });
    const probe1 = buildSecondPassProbe(stack, [], { probeSearch: 1 });
    await probe1({ round: 0, digest: '', gaps: gaps(gap(['Q1'])) });
    const probe2 = buildSecondPassProbe(stack, [], { alreadySearched: ['Q1'] });
    const y2 = await probe2({ round: 1, digest: '', gaps: gaps(gap([' q1 '])) });
    expect(searchCalls().length).toBe(1); // 只 q1 (归一后) 一次
    expect(y2.searchedQueries).toBeUndefined(); // 已被上一轮搜过, 本轮无新搜
  });

  test('★ GWT-3 INV-2: q-bad 抛错 + q-ok 返带正文 → newCorpus 含 q-ok 的回搜节头, 不抛', async () => {
    // searchPool.search 对 "q-bad" 抛错, 对 "q-ok" 返命中。用 isThrow 在 searchPool 内部派发。
    const calls: Array<{ q: string; k: number }> = [];
    const stack: WebStack = {
      searchPool: {
        async search(q: string, k?: number): Promise<PoolSearchResult> {
          calls.push({ q, k: k ?? 0 });
          if (q === 'q-bad') throw new Error('provider down');
          return {
            results: [hit('https://a.test/ok')],
            providers: ['fake'],
            mode: 'rotate',
          };
        },
        setMode: () => {},
        setDefault: () => {},
        toggle: () => {},
        status: () => [],
      } as unknown as WebStack['searchPool'],
      fetchProviders: [fakeFetchByUrl({ 'https://a.test/ok': 'x'.repeat(300) })],
      cleaner: new PassthroughCleaner(),
      quota: {} as never,
    } as unknown as WebStack;
    const stages: string[] = [];
    const probe = buildSecondPassProbe(stack, [], {
      onStage: (s, d) => stages.push(`${s}:${d}`),
    });
    // 不应抛
    const y = await probe({ round: 0, digest: '', gaps: gaps(gap(['q-bad', 'q-ok'])) });
    expect(calls.length).toBe(2); // 两条都试了
    expect(y.searchedQueries).toEqual(['q-bad', 'q-ok']);
    // q-ok 的回搜正文进了 newCorpus
    expect(y.newCorpus).toBeDefined();
    expect(y.newCorpus!).toContain('https://a.test/ok');
    expect(y.fetchedUrls).toEqual(['https://a.test/ok']);
    // 失败也留痕 (onStage 不许吞)
    expect(stages.some((s) => s.includes('q-bad') && s.includes('跳过'))).toBe(true);
  });

  test('★ GWT-4 INV-3: 回搜抓到的带正文 URL → fetchedUrls 收录 + searchedQueries 含该 query', async () => {
    const { stack, searchCalls } = fakeStack({
      q1: body('https://x.test/a'),
    });
    const probe = buildSecondPassProbe(stack, []);
    const y = await probe({ round: 0, digest: '', gaps: gaps(gap(['q1'])) });

    expect(searchCalls().length).toBe(1);
    expect(searchCalls()[0]!.q).toBe('q1');
    expect(y.fetchedUrls).toEqual(['https://x.test/a']);
    expect(y.searchedQueries).toEqual(['q1']);
    // 回搜节头含 URL (可被消费方溯源)
    expect(y.newCorpus).toContain('https://x.test/a');
  });

  test('★ GWT-6 INV-5: gaps 只含 urls/repoQueries 不含 webQueries → search 调用为 0 次', async () => {
    // 纯直抓腿: gap 没有 webQueries, searchPool 调用必须为 0 (回搜门未开)。
    const { stack, searchCalls } = fakeStack({}, { 'https://known.test/a': 'x'.repeat(300) });
    const probe = buildSecondPassProbe(stack, []);
    const y = await probe({
      round: 0,
      digest: '',
      gaps: gaps(gap([], ['https://known.test/a'], ['someSymbol'])),
    });
    expect(searchCalls().length).toBe(0);
    // 直抓腿仍正常产出
    expect(y.fetchedUrls).toEqual(['https://known.test/a']);
    // 回搜腿空空, 不留 searchedQueries (留痕空集合不污染)
    expect(y.searchedQueries).toBeUndefined();
  });

  test('INV-1 probeSearch=1 调闸值: 3 条不同 query → search 调用恰 1 次', async () => {
    // 显式 probeSearch=1 把上限压到 1, 验证 opt 真实透传到去重+截断逻辑。
    const { stack, searchCalls } = fakeStack({
      q1: body('https://a.test/1'),
      q2: body('https://a.test/2'),
      q3: body('https://a.test/3'),
    });
    const probe = buildSecondPassProbe(stack, [], { probeSearch: 1 });
    const y = await probe({ round: 0, digest: '', gaps: gaps(gap(['q1', 'q2', 'q3'])) });
    expect(searchCalls().length).toBe(1);
    expect(searchCalls()[0]!.q).toBe('q1');
    expect(y.searchedQueries).toEqual(['q1']);
  });

  test('INV-2 fail-open: 全部 query 都抛错 → 不抛, 只在 onStage 留痕', async () => {
    const stack: WebStack = {
      searchPool: {
        async search(): Promise<PoolSearchResult> {
          throw new Error('all down');
        },
        setMode: () => {},
        setDefault: () => {},
        toggle: () => {},
        status: () => [],
      } as unknown as WebStack['searchPool'],
      fetchProviders: [fakeFetchByUrl()],
      cleaner: new PassthroughCleaner(),
      quota: {} as never,
    } as unknown as WebStack;
    const stages: string[] = [];
    const probe = buildSecondPassProbe(stack, [], { onStage: (s, d) => stages.push(`${s}:${d}`) });
    const y = await probe({ round: 0, digest: '', gaps: gaps(gap(['q-any'])) });
    // 不抛
    expect(y.newCorpus).toBeUndefined();
    expect(y.fetchedUrls).toBeUndefined();
    // 留痕走 onStage
    expect(stages.some((s) => s.includes('回搜') && s.includes('跳过'))).toBe(true);
    // searchedQueries 仍记 (调用方能看见"我们试过了") —— 已搜过的事实被 attempt 过。
    expect(y.searchedQueries).toEqual(['q-any']);
  });
});
