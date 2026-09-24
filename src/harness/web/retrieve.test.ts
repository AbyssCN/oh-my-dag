/**
 * web/retrieve 测试 —— query 扩展在检索层的接线 (Task B): 多轮搜索去重 · 爬取槽不超 · 改写失败降级。
 * 注入 fake WebStack (无网络) + fake expander (无模型)。
 */
import { describe, expect, test } from 'bun:test';
import { retrieveWeb } from './retrieve';
import { PassthroughCleaner } from './clean';
import type { WebStack } from './index';
import type { FetchProvider, FetchResult, SearchResult } from './types';
import type { QueryExpander } from './query-expand';
import type { SourceDistiller } from './distill-source';

function hit(url: string): SearchResult {
  return { title: url, url, snippet: '' };
}

/** 每 url 定制正文长度 (蒸馏阈值测试用: 巨源 vs 小源)。search 命中 = bodies 全部 key。 */
function bodyStack(bodies: Record<string, string>): WebStack {
  const fetchProvider: FetchProvider = {
    name: 'fakefetch',
    async fetch(url): Promise<FetchResult> {
      return { url, text: bodies[url] ?? 'x'.repeat(300) };
    },
  };
  return {
    searchPool: {
      async search() {
        return { results: Object.keys(bodies).map(hit), providers: ['fake'], mode: 'rotate' as const };
      },
    },
    fetchProviders: [fetchProvider],
    cleaner: new PassthroughCleaner(),
    quota: {},
  } as unknown as WebStack;
}

/** perQuery: query → 命中列表。fetchProvider 计数爬取次数。 */
function fakeStack(
  perQuery: Record<string, SearchResult[]>,
  fetchCounter?: { n: number },
): WebStack {
  const fetchProvider: FetchProvider = {
    name: 'fakefetch',
    async fetch(url): Promise<FetchResult> {
      if (fetchCounter) fetchCounter.n++;
      return { url, text: 'x'.repeat(300) }; // 够长, 过 minChars
    },
  };
  return {
    searchPool: {
      async search(q: string) {
        return { results: perQuery[q] ?? [], providers: ['fake'], mode: 'rotate' as const };
      },
    },
    fetchProviders: [fetchProvider],
    cleaner: new PassthroughCleaner(),
    quota: {},
  } as unknown as WebStack;
}

describe('retrieveWeb query 扩展', () => {
  test('原 query + 改写多轮 → URL 去重 (保首现顺序)', async () => {
    const stack = fakeStack({
      q0: [hit('http://a.com/x'), hit('http://b.com/y')],
      q1: [hit('http://b.com/y'), hit('http://c.com/z')], // b 与 q0 重
    });
    const expander: QueryExpander = async () => ['q1'];
    const r = await retrieveWeb(stack, 'q0', { expander, crawl: 0 });
    expect(r.queries).toEqual(['q0', 'q1']);
    expect(r.sources.map((s) => s.url)).toEqual([
      'http://a.com/x',
      'http://b.com/y',
      'http://c.com/z',
    ]);
  });

  test('爬取槽数不超 crawl (成本天花板不变), 即便扩展后 URL 变多', async () => {
    const counter = { n: 0 };
    const stack = fakeStack(
      {
        q0: [hit('http://a.com/1'), hit('http://a.com/2')],
        q1: [hit('http://a.com/3'), hit('http://a.com/4')],
        q2: [hit('http://a.com/5'), hit('http://a.com/6')],
      },
      counter,
    );
    const expander: QueryExpander = async () => ['q1', 'q2'];
    const r = await retrieveWeb(stack, 'q0', { expander, crawl: 2, minChars: 1, clean: false });
    expect(r.sources.length).toBe(6); // 索引全列
    expect(counter.n).toBe(2); // 只爬 2 个槽
  });

  test('改写失败 → 退回单 query, warn, 不断链', async () => {
    let warned = '';
    const stack = fakeStack({ q0: [hit('http://a.com/x')] });
    const boom: QueryExpander = async () => {
      throw new Error('模型不可用');
    };
    const r = await retrieveWeb(stack, 'q0', {
      expander: boom,
      crawl: 0,
      onWarn: (m) => (warned = m),
    });
    expect(r.queries).toEqual(['q0']);
    expect(r.sources.map((s) => s.url)).toEqual(['http://a.com/x']);
    expect(warned).toContain('模型不可用');
  });

  test('无 expander → 单 query (现有行为不变)', async () => {
    const stack = fakeStack({ q0: [hit('http://a.com/x')] });
    const r = await retrieveWeb(stack, 'q0', { crawl: 0 });
    expect(r.queries).toEqual(['q0']);
  });
});

describe('retrieveWeb 分层感知爬取预算 (成本敏感: 爬数直乘 fanout 账单)', () => {
  // arxiv.org = tier-A (论文); blogN.example = tier-B (默认)。orderForCrawl 会把 A 排前。
  const A = (i: number) => hit(`https://arxiv.org/abs/${i}`);
  const B = (i: number) => hit(`http://blog${i}.example/x`);

  /** 单轮命中固定列表 (无扩展) + fetch 计数。 */
  function tierStack(hits: SearchResult[], counter: { n: number }): WebStack {
    const fetchProvider: FetchProvider = {
      name: 'fakefetch',
      async fetch(url): Promise<FetchResult> {
        counter.n++;
        return { url, text: 'x'.repeat(300) };
      },
    };
    return {
      searchPool: {
        async search() {
          return { results: hits, providers: ['fake'], mode: 'rotate' as const };
        },
      },
      fetchProviders: [fetchProvider],
      cleaner: new PassthroughCleaner(),
      quota: {},
    } as unknown as WebStack;
  }

  test('query A: 候选 3 tier-A → target=5 (底线) → 爬 3A+2B (不变, 便宜)', async () => {
    const counter = { n: 0 };
    // 3 A + 4 B = 7 候选; 未显式 crawl → clamp(3, 5, 8) = 5。
    const hits = [A(1), A(2), A(3), B(1), B(2), B(3), B(4)];
    const r = await retrieveWeb(tierStack(hits, counter), 'q0', { clean: false, minChars: 1 });
    expect(counter.n).toBe(5); // 爬 5 槽
    expect(r.sources.length).toBe(7); // 索引全列
    // ranked A→B: 前 3 是 A, 第 4/5 是 B, 且这 5 条有正文; 其余 (2 条 B) 无正文。
    expect(r.sources.slice(0, 3).map((s) => s.tier)).toEqual(['A', 'A', 'A']);
    expect(r.sources.slice(3, 5).map((s) => s.tier)).toEqual(['B', 'B']);
    expect(r.sources.filter((s) => s.body).length).toBe(5); // 恰 3A+2B 被抓
    expect(r.sources.slice(5).every((s) => !s.body)).toBe(true); // 尾部 B 未抓
    expect(r.crawlBudget).toBe('分层预算: tier-A=3 → 爬 5/上限8');
  });

  test('query B: 候选 10 tier-A → target=8 (上限封顶) → 爬 8A (从 5 升到 8, 权威源不被挤)', async () => {
    const counter = { n: 0 };
    // 10 A + 2 B = 12 候选; 未显式 crawl → clamp(10, 5, 8) = 8。
    const hits = [...Array.from({ length: 10 }, (_, i) => A(i)), B(1), B(2)];
    const r = await retrieveWeb(tierStack(hits, counter), 'q0', { clean: false, minChars: 1 });
    expect(counter.n).toBe(8); // 上限封顶爬 8
    expect(r.sources.length).toBe(12);
    // 被抓的 8 条全是 tier-A (ranked A 排前, 10 个 A 里取前 8)。
    const crawled = r.sources.filter((s) => s.body);
    expect(crawled.length).toBe(8);
    expect(crawled.every((s) => s.tier === 'A')).toBe(true);
    expect(r.crawlBudget).toBe('分层预算: tier-A=10 → 爬 8/上限8');
  });

  test('边界 floor: 5 tier-A → clamp(5,5,8)=5', async () => {
    const counter = { n: 0 };
    const hits = [...Array.from({ length: 5 }, (_, i) => A(i)), B(1), B(2), B(3)];
    const r = await retrieveWeb(tierStack(hits, counter), 'q0', { clean: false, minChars: 1 });
    expect(counter.n).toBe(5);
    expect(r.crawlBudget).toBe('分层预算: tier-A=5 → 爬 5/上限8');
  });

  test('边界 ceil: 8 tier-A → clamp(8,5,8)=8; 9 tier-A → clamp(9,5,8)=8', async () => {
    const c8 = { n: 0 };
    const h8 = Array.from({ length: 8 }, (_, i) => A(i));
    const r8 = await retrieveWeb(tierStack(h8, c8), 'q0', { clean: false, minChars: 1 });
    expect(c8.n).toBe(8);
    expect(r8.crawlBudget).toBe('分层预算: tier-A=8 → 爬 8/上限8');

    const c9 = { n: 0 };
    const h9 = Array.from({ length: 9 }, (_, i) => A(i));
    const r9 = await retrieveWeb(tierStack(h9, c9), 'q0', { clean: false, minChars: 1 });
    expect(c9.n).toBe(8); // 9 也封在 8
    expect(r9.crawlBudget).toBe('分层预算: tier-A=9 → 爬 8/上限8');
  });

  test('底线兜底: 0 tier-A (全 B) → clamp(0,5,8)=5 (权威源少也保底抓 5)', async () => {
    const counter = { n: 0 };
    const hits = [B(1), B(2), B(3), B(4), B(5), B(6)];
    const r = await retrieveWeb(tierStack(hits, counter), 'q0', { clean: false, minChars: 1 });
    expect(counter.n).toBe(5);
    expect(r.crawlBudget).toBe('分层预算: tier-A=0 → 爬 5/上限8');
  });

  test('自定 floor/ceil: crawlFloor=2 crawlCeil=4, 3 tier-A → clamp(3,2,4)=3', async () => {
    const counter = { n: 0 };
    const hits = [A(1), A(2), A(3), B(1), B(2)];
    const r = await retrieveWeb(tierStack(hits, counter), 'q0', {
      clean: false,
      minChars: 1,
      crawlFloor: 2,
      crawlCeil: 4,
    });
    expect(counter.n).toBe(3);
    expect(r.crawlBudget).toBe('分层预算: tier-A=3 → 爬 3/上限4');
  });

  test('向后兼容: 显式 --crawl 3 覆盖分层感知 (爬 3, 即便 tier-A 有 10)', async () => {
    const counter = { n: 0 };
    const hits = [...Array.from({ length: 10 }, (_, i) => A(i)), B(1)];
    const r = await retrieveWeb(tierStack(hits, counter), 'q0', {
      clean: false,
      minChars: 1,
      crawl: 3,
    });
    expect(counter.n).toBe(3); // 显式数说了算, 不走分层
    expect(r.crawlBudget).toBe('显式指定: 爬 3');
  });

  test('向后兼容: 显式 --crawl 0 = 只搜不抓 (即便一堆 tier-A)', async () => {
    const counter = { n: 0 };
    const hits = [A(1), A(2), A(3), A(4), A(5)];
    const r = await retrieveWeb(tierStack(hits, counter), 'q0', {
      clean: false,
      minChars: 1,
      crawl: 0,
    });
    expect(counter.n).toBe(0); // 一个都不爬
    expect(r.sources.length).toBe(5); // 但索引仍全列
    expect(r.crawlBudget).toBe('显式指定: 爬 0');
  });
});

describe('retrieveWeb per-source 蒸馏 (零丢失不变量重中之重)', () => {
  const HUGE_URL = 'http://big.com/page';
  const SMALL_URL = 'http://small.com/page';
  const HUGE = 'H'.repeat(40000); // > 30000 阈值 → 触发蒸馏
  const SMALL = 's'.repeat(1000); // < 阈值 → 不触发
  const EXTRACT = 'DISTILLED-EXTRACT-机制要点';

  /** 计数 + 吐固定 extract 的蒸馏替身 (永不真调模型)。 */
  function countingDistiller(counter: { n: number }): SourceDistiller {
    return async () => {
      counter.n++;
      return { relevance: '相关', extract: EXTRACT };
    };
  }

  test('不变量: 蒸馏触发时, fullCorpus 附录仍含该源原文全文 (逐字节 superset)', async () => {
    const stack = bodyStack({ [HUGE_URL]: HUGE });
    const counter = { n: 0 };
    const r = await retrieveWeb(stack, 'q', {
      clean: false,
      distiller: countingDistiller(counter),
    });
    // 红线: 蒸馏发生 (extract 进了 lens 语料), 但原文全量在附录 —— 逐字节 superset。
    expect(counter.n).toBe(1);
    expect(r.markdown).toContain(EXTRACT); // lens 语料 = 精简视图
    expect(r.markdown).not.toContain(HUGE); // lens 语料里巨源已换掉, 不含全文
    expect(r.fullCorpus).toContain(HUGE); // 附录 = 全文, 零丢失
    expect(r.fullCorpus).not.toContain(EXTRACT); // 附录永不蒸馏
  });

  test('不变量: 未开蒸馏时 markdown===fullCorpus, 全文都在 (行为不变)', async () => {
    const stack = bodyStack({ [HUGE_URL]: HUGE });
    const r = await retrieveWeb(stack, 'q', { clean: false }); // 无 distiller
    expect(r.markdown).toBe(r.fullCorpus); // 同引用
    expect(r.fullCorpus).toContain(HUGE);
    expect(r.distilled).toEqual([]);
  });

  test('阈值: <30k 源不触发蒸馏 (零模型调用, distiller call count 0)', async () => {
    const stack = bodyStack({ [SMALL_URL]: SMALL });
    const counter = { n: 0 };
    const r = await retrieveWeb(stack, 'q', {
      clean: false,
      distiller: countingDistiller(counter),
    });
    expect(counter.n).toBe(0); // 阈值门控 = 零调用零成本
    expect(r.distilled).toEqual([]);
    expect(r.markdown).toBe(r.fullCorpus); // 无蒸馏 → 同引用
    expect(r.fullCorpus).toContain(SMALL);
  });

  test('触发: >30k 源 → lens 语料含蒸馏 extract + 保留 url; 附录仍全文', async () => {
    const stack = bodyStack({ [HUGE_URL]: HUGE, [SMALL_URL]: SMALL });
    const counter = { n: 0 };
    const r = await retrieveWeb(stack, 'q', {
      clean: false,
      distiller: countingDistiller(counter),
    });
    expect(counter.n).toBe(1); // 只巨源触发, 小源不动
    // lens 语料: 巨源换 extract, 保留 url; 小源保持全文。
    expect(r.markdown).toContain(EXTRACT);
    expect(r.markdown).toContain(HUGE_URL); // url 保留 (可溯源)
    expect(r.markdown).toContain(SMALL); // 小源仍全文
    expect(r.markdown).not.toContain(HUGE);
    // 附录: 两源都全文。
    expect(r.fullCorpus).toContain(HUGE);
    expect(r.fullCorpus).toContain(SMALL);
    // 留痕。
    expect(r.distilled).toEqual([{ url: HUGE_URL, origLen: 40000, extractLen: EXTRACT.length }]);
  });

  test('降级: 蒸馏器抛错 → 该源 lens 语料退回全文, 不断链 + warn', async () => {
    const stack = bodyStack({ [HUGE_URL]: HUGE });
    let warned = '';
    const boom: SourceDistiller = async () => {
      throw new Error('蒸馏模型不可用');
    };
    const r = await retrieveWeb(stack, 'q', {
      clean: false,
      distiller: boom,
      onWarn: (m) => (warned = m),
    });
    // 退回全文: lens 语料含巨源全文 (未被 extract 替换); 结果仍完整 (不断链)。
    expect(r.markdown).toContain(HUGE);
    expect(r.fullCorpus).toContain(HUGE);
    expect(r.distilled).toEqual([]); // 未成功蒸馏
    expect(warned).toContain('蒸馏模型不可用');
  });

  test('--no-distill 等价: 无 distiller 即便有巨源也不蒸馏', async () => {
    const stack = bodyStack({ [HUGE_URL]: HUGE });
    const r = await retrieveWeb(stack, 'q', { clean: false }); // 模拟 --no-distill (不传 distiller)
    expect(r.markdown).toContain(HUGE); // 巨源全文, 未蒸馏
    expect(r.distilled).toEqual([]);
  });

  test('自定阈值: distillThreshold 抬高 → 巨源也不触发', async () => {
    const stack = bodyStack({ [HUGE_URL]: HUGE });
    const counter = { n: 0 };
    const r = await retrieveWeb(stack, 'q', {
      clean: false,
      distiller: countingDistiller(counter),
      distillThreshold: 50000, // 40k < 50k → 不触发
    });
    expect(counter.n).toBe(0);
    expect(r.markdown).toContain(HUGE);
  });
});

/**
 * 知乎自动开社媒语料 (2026-09-25): query 带「知乎/zhihu」→ 额外经 socialCorpus 在站内搜一次。
 * 怎么让它红: 删掉 retrieve.ts 里 ZHIHU_RE 那段 → ①② 红; 把 +social 爬取加额改回原预算 → ③ 红。
 */
describe('retrieveWeb 知乎 → MediaCrawler', () => {
  function socialStack(calls: string[], opts: { fail?: boolean } = {}): WebStack {
    const base = fakeStack({
      '知乎 大模型': [hit('http://a.com/1'), hit('http://b.com/2'), hit('http://c.com/3')],
      'kimi 评测': [hit('http://a.com/1')],
    });
    return {
      ...base,
      socialCorpus: {
        name: 'mediacrawler',
        async search(q: string) {
          calls.push(q);
          if (opts.fail) throw new Error('风控');
          return [hit('https://www.zhihu.com/question/1'), hit('https://zhuanlan.zhihu.com/p/2')];
        },
        cached: (url: string) => ({ url, text: `登录态全文 ${url} `.repeat(20) }),
      },
    } as unknown as WebStack;
  }

  test('① query 带「知乎」→ 去掉平台词后站内搜一次, 结果并入且排在爬取最前', async () => {
    const calls: string[] = [];
    const r = await retrieveWeb(socialStack(calls), '知乎 大模型', { crawl: 1 });
    expect(calls).toEqual(['大模型']);
    expect(r.searchProviders).toContain('mediacrawler');
    expect(r.sources.slice(0, 2).map((s) => s.url)).toEqual([
      'https://www.zhihu.com/question/1',
      'https://zhuanlan.zhihu.com/p/2',
    ]);
  });

  test('② 不带知乎 → 不调 (分钟级, 绝不进普通检索)', async () => {
    const calls: string[] = [];
    await retrieveWeb(socialStack(calls), 'kimi 评测', { crawl: 0 });
    expect(calls).toEqual([]);
  });

  test('③ 知乎命中不占常规爬取预算 (memo 已有正文, 零成本)', async () => {
    const r = await retrieveWeb(socialStack([]), '知乎 大模型', { crawl: 1 });
    expect(r.sources.filter((s) => s.body).length).toBe(3); // 2 知乎 + 1 常规
  });

  test('采集挂了 → warn 不断链, 常规结果照返', async () => {
    const warns: string[] = [];
    const r = await retrieveWeb(socialStack([], { fail: true }), '知乎 大模型', {
      crawl: 0,
      onWarn: (m) => warns.push(m),
    });
    expect(r.sources.length).toBe(3);
    expect(warns.join()).toContain('风控');
  });
});

test('知乎命中的正文取 MediaCrawler 采集时的全文, 不进竞速 (jina 会拿登录墙截断版抢赢)', async () => {
  const counter = { n: 0 };
  const base = fakeStack({ '知乎 x': [hit('http://a.com/1')] }, counter);
  const stack = {
    ...base,
    socialCorpus: {
      name: 'mediacrawler',
      search: async () => [hit('https://www.zhihu.com/question/1')],
      cached: (url: string) => ({ url, text: '登录态全文'.repeat(50) }),
    },
  } as unknown as WebStack;
  const r = await retrieveWeb(stack, '知乎 x', { crawl: 1, clean: false });
  const z = r.sources.find((s) => s.url.includes('zhihu'))!;
  expect(z.provider).toBe('mediacrawler');
  expect(z.body).toContain('登录态全文');
  expect(counter.n).toBe(1); // 只有常规那条走了 fetch
});
