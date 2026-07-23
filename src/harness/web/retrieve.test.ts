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
