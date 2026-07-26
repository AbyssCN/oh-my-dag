import { test, expect, describe } from 'bun:test';
import { buildSecondPassProbe, extractCitedUrls } from '../../src/harness/research/web-fanout';
import type { WebStack } from '../../src/harness/web';

// probe 只碰 fetchProviders + cleaner → 最小 fake stack (searchPool/quota 不参与, 断言型 cast)。
function makeStack(bodies: Record<string, string>): WebStack {
  return {
    fetchProviders: [
      {
        name: 'fake',
        fetch: async (url: string) => {
          const text = bodies[url];
          if (text === undefined) throw new Error(`404: ${url}`);
          return { url, text };
        },
      },
    ],
    cleaner: { name: 'passthrough', clean: async (html: string) => ({ text: html }) },
  } as unknown as WebStack;
}

const LONG = (tag: string): string => `${tag} ` + 'x'.repeat(300); // 过 200 chars 壳渣闸

describe('extractCitedUrls — 确定性引用抽取', () => {
  test('抽 http(s), 去重, 剥尾部标点; 非 URL 文本忽略', () => {
    const urls = extractCitedUrls(
      '见 https://a.example/doc. 与 https://a.example/doc 重复; 另 http://b.example/p?x=1, 完。ftp://no',
    );
    expect(urls).toEqual(['https://a.example/doc', 'http://b.example/p?x=1']);
  });
});

describe('buildSecondPassProbe — 引用集∪点名集 − 已抓集', () => {
  test('只抓缺的: 已抓 URL 不重抓; digest 引用 + gap 点名合并; 语料按源分节', async () => {
    const stack = makeStack({
      'https://miss.example/a': LONG('A-BODY'),
      'https://named.example/b': LONG('B-BODY'),
    });
    const probe = buildSecondPassProbe(stack, ['https://done.example/x'], { probeCrawl: 5 });
    const y = await probe({
      round: 1,
      digest: '冠军引用了 https://done.example/x 和 https://miss.example/a 两个来源',
      gaps: [{ key: 'g1', question: 'q', why: 'w', urls: ['https://named.example/b'] }],
    });
    expect(y.fetchedUrls).toEqual(['https://miss.example/a', 'https://named.example/b']);
    expect(y.newCorpus).toContain('## https://miss.example/a');
    expect(y.newCorpus).toContain('A-BODY');
    expect(y.newCorpus).toContain('B-BODY');
  });

  test('全部已抓 → 空产出, 零 fetch', async () => {
    let fetches = 0;
    const stack = makeStack({});
    stack.fetchProviders[0]!.fetch = async () => {
      fetches++;
      throw new Error('不该被调');
    };
    const probe = buildSecondPassProbe(stack, ['https://done.example/x']);
    const y = await probe({ round: 1, digest: '只引用 https://done.example/x', gaps: [] });
    expect(y).toEqual({});
    expect(fetches).toBe(0);
  });

  test('每源字符上限: 巨源截断带显式标记 (成本闸, 不静默丢)', async () => {
    const stack = makeStack({ 'https://huge.example/t': 'H'.repeat(50_000) });
    const probe = buildSecondPassProbe(stack, [], { maxCharsPerSource: 1_000 });
    const y = await probe({ round: 1, digest: '引 https://huge.example/t', gaps: [] });
    expect(y.newCorpus!.length).toBeLessThan(1_200); // 1k 正文 + 节头 + 标记
    expect(y.newCorpus).toContain('[probe 截断: 原文 50000 chars');
  });

  test('probeCrawl 钳制上限; 抓失败的 URL 静默跳过不断链且跨轮不重试', async () => {
    const stack = makeStack({ 'https://ok.example/1': LONG('OK1') });
    const probe = buildSecondPassProbe(stack, [], { probeCrawl: 2 });
    const y1 = await probe({
      round: 1,
      digest: '引 https://ok.example/1 https://dead.example/2 https://over.example/3',
      gaps: [],
    });
    // cap=2: 只试前两个; dead 失败被跳过, 语料只有 ok
    expect(y1.fetchedUrls).toEqual(['https://ok.example/1']);
    expect(y1.newCorpus).not.toContain('dead.example');
    // 第二轮: 已试过的 (含失败的 dead) 不再重试, over 这次进得来
    const y2 = await probe({
      round: 2,
      digest: '还是 https://ok.example/1 https://dead.example/2 https://over.example/3',
      gaps: [],
    });
    expect(y2).toEqual({}); // over.example 抓不到 (fake 无此 body) → 全失败 → 空产出
  });
});
