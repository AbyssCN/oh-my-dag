import { describe, expect, test } from 'bun:test';
import { MediaCrawlerProvider } from './mediacrawler';
import { ProviderError } from '../types';

// 注入 fetchImpl + sleepImpl → 单测零网络零等待 (NAS 关机时也必须绿)。

interface Call {
  url: string;
  body?: unknown;
}

/**
 * 假上游: 一次 start 就把 `appendOnStart` 追加进"文件", 之后 status 走 statusSeq。
 * 刻意保留上游的**累积**语义 —— 文件里的旧记录不会消失, 这是本 provider 要处理的真实形态。
 */
function fakeServer(opts: {
  initial?: Record<string, unknown>[];
  appendOnStart?: Record<string, unknown>[][];
  statusSeq?: string[];
  startStatus?: number;
}) {
  const records = [...(opts.initial ?? [])];
  const calls: Call[] = [];
  let startCount = 0;
  let statusCount = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes('/api/crawler/start')) {
      const status = opts.startStatus ?? 200;
      if (status === 200) records.push(...(opts.appendOnStart?.[startCount] ?? []));
      startCount += 1;
      return new Response(JSON.stringify({ status: 'ok' }), { status });
    }
    if (url.includes('/api/crawler/status')) {
      const seq = opts.statusSeq ?? ['idle'];
      const s = seq[Math.min(statusCount, seq.length - 1)]!;
      statusCount += 1;
      return new Response(JSON.stringify({ status: s, error_message: s === 'error' ? '登录态失效' : null }), {
        status: 200,
      });
    }
    if (url.includes('/api/data/files?')) {
      return new Response(JSON.stringify({ files: [{ path: 'zhihu/json/search_contents.json' }] }), { status: 200 });
    }
    if (url.includes('/api/data/files/')) {
      return new Response(JSON.stringify(records), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, sleepImpl: async () => {} };
}

const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  content_id: id,
  content_url: `https://www.zhihu.com/answer/${id}`,
  title: `标题${id}`,
  content_text: `正文${id}`,
  ...extra,
});

describe('MediaCrawlerProvider — search', () => {
  test('采集 → 只返回新增记录, 正文进 memo', async () => {
    const srv = fakeServer({ appendOnStart: [[rec('1'), rec('2')]] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://nas:8090', cookies: 'z_c0=x', ...srv });
    const r = await p.search('LangGraph', 5);
    expect(r.map((x) => x.url)).toEqual([
      'https://www.zhihu.com/answer/1',
      'https://www.zhihu.com/answer/2',
    ]);
    expect(r[0]!.title).toBe('标题1');
    expect(r[0]!.snippet).toContain('正文1');
    expect(p.corpusSize).toBe(2);
  });

  test('★ 文件累积: 第二次检索不许把上一次的语料当本次结果 (上游同日追加进同一文件)', async () => {
    const srv = fakeServer({ appendOnStart: [[rec('1'), rec('2')], [rec('3')]] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://nas:8090', ...srv });
    await p.search('第一次', 5);
    const second = await p.search('第二次', 5);
    expect(second.map((x) => x.url)).toEqual(['https://www.zhihu.com/answer/3']);
  });

  test('零新增 = 空数组, 不是错误 (关键词无结果也会正常结束)', async () => {
    const srv = fakeServer({ initial: [rec('old')], appendOnStart: [[]] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://nas:8090', ...srv });
    expect(await p.search('冷门词', 5)).toEqual([]);
  });

  test('maxResults 截断', async () => {
    const srv = fakeServer({ appendOnStart: [[rec('1'), rec('2'), rec('3')]] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://nas:8090', ...srv });
    expect((await p.search('x', 2)).length).toBe(2);
  });

  test('★ 并发调用内部串行 —— 上游单任务, 两个 start 不许交叠', async () => {
    const srv = fakeServer({ appendOnStart: [[rec('1')], [rec('2')]], statusSeq: ['running', 'idle'] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://nas:8090', ...srv });
    const [a, b] = await Promise.all([p.search('q1', 5), p.search('q2', 5)]);
    const starts = srv.calls.filter((c) => c.url.includes('/start'));
    expect(starts.length).toBe(2);
    // 第一个 start 之后必须先出现 status 轮询, 才允许第二个 start。
    const idx = srv.calls.findIndex((c) => c.url.includes('/start'));
    const second = srv.calls.findIndex((c, i) => i > idx && c.url.includes('/start'));
    expect(srv.calls.slice(idx + 1, second).some((c) => c.url.includes('/status'))).toBe(true);
    expect([...a, ...b].length).toBe(2);
  });

  test('cookies 有 → login_type=cookie; 无 → qrcode (容器里跑不了扫码, 让它响亮失败而非静默空跑)', async () => {
    const withCookie = fakeServer({ appendOnStart: [[]] });
    await new MediaCrawlerProvider({ baseUrl: 'http://n', cookies: 'z_c0=x', ...withCookie }).search('q', 1);
    expect((withCookie.calls.find((c) => c.url.includes('/start'))!.body as { login_type: string }).login_type).toBe('cookie');

    const without = fakeServer({ appendOnStart: [[]] });
    await new MediaCrawlerProvider({ baseUrl: 'http://n', ...without }).search('q', 1);
    expect((without.calls.find((c) => c.url.includes('/start'))!.body as { login_type: string }).login_type).toBe('qrcode');
  });

  test('start 非 200 → ProviderError (上游正忙时会拒)', async () => {
    const srv = fakeServer({ startStatus: 409 });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', ...srv });
    expect(p.search('q', 1)).rejects.toMatchObject({ provider: 'mediacrawler', status: 409 });
  });

  test('status=error → 抛, 带上游 error_message', async () => {
    const srv = fakeServer({ appendOnStart: [[]], statusSeq: ['error'] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', ...srv });
    expect(p.search('q', 1)).rejects.toThrow('登录态失效');
  });

  test('★ 永远 running → 超时抛, 不无限等 (上游有过"日志协程死掉状态卡住"的真缺陷)', async () => {
    const srv = fakeServer({ appendOnStart: [[]], statusSeq: ['running'] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', timeoutMs: 20, pollIntervalMs: 10, ...srv });
    expect(p.search('q', 1)).rejects.toThrow('采集超时');
  });

  test('前一次失败不拖垮后一次 (串行链不许被 rejection 卡死)', async () => {
    // 第一次采集报错 (什么也没落), 第二次才有产物 —— 验的是链不被 rejection 卡死。
    const srv = fakeServer({ appendOnStart: [[], [rec('1')]], statusSeq: ['error', 'idle'] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', ...srv });
    expect(p.search('q1', 1)).rejects.toThrow();
    expect((await p.search('q2', 1)).length).toBe(1);
  });
});

describe('MediaCrawlerProvider — fetch 的 detail 模式 (2026-08-07 补)', () => {
  const ZHIHU = 'https://zhuanlan.zhihu.com/p/123';

  // ★ 这条就是 detail 模式存在的理由:memo 里没有, 但 URL 归本平台管 → 直接按 URL 采一次。
  //   反向自检: 把 fetch 里的 `await this.detail([url])` 去掉 → 这条当场红。
  test('★ memo 未命中且归本平台 → 走 detail 采集并拿到正文', async () => {
    const { fetchImpl, calls, sleepImpl } = fakeServer({
      appendOnStart: [[{ content_id: 'p123', content_url: ZHIHU, title: '知乎标题', content_text: '知乎正文' }]],
    });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', fetchImpl, sleepImpl, cookies: 'ck' });
    const r = await p.fetch(ZHIHU);
    expect(r.text).toBe('知乎正文');
    expect(r.title).toBe('知乎标题');
    const start = calls.find((c) => c.url.includes('/api/crawler/start'));
    expect((start?.body as { crawler_type?: string })?.crawler_type).toBe('detail');
    expect((start?.body as { specified_ids?: string })?.specified_ids).toBe(ZHIHU);
  });

  // ★★ 护栏。一次 detail 是**分钟级**的真浏览器任务 —— 不看域名的话, 任何 memo 未命中的 URL
  //     (哪怕是个 GitHub README)都会起一次采集, 把整条 fetch 链从毫秒拖成分钟, 而调用方
  //     只会看到"这次抓取好慢"。反向自检: 把 ownsUrl 判断去掉 → 这条当场红。
  test('★★ 不归本平台的 URL 立即抛, **绝不触发采集**', async () => {
    const { fetchImpl, calls, sleepImpl } = fakeServer({});
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', fetchImpl, sleepImpl });
    await expect(p.fetch('https://github.com/x/y')).rejects.toThrow(/不归本平台/);
    expect(calls.filter((c) => c.url.includes('/api/crawler/start'))).toHaveLength(0);
  });

  test('解析不了的 URL 也不触发采集(不猜)', async () => {
    const { fetchImpl, calls, sleepImpl } = fakeServer({});
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', fetchImpl, sleepImpl });
    await expect(p.fetch('不是一个 URL')).rejects.toThrow();
    expect(calls.filter((c) => c.url.includes('/api/crawler/start'))).toHaveLength(0);
  });

  test('子域名算数(zhuanlan.zhihu.com 与 www.zhihu.com 都归 zhihu)', async () => {
    const { fetchImpl, calls, sleepImpl } = fakeServer({ appendOnStart: [[]] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', fetchImpl, sleepImpl });
    // 采不到正文 → 抛, 但**采集确实被触发了**(与上面那条"不触发"分得开)
    await expect(p.fetch('https://www.zhihu.com/question/1/answer/2')).rejects.toThrow(/没拿到正文/);
    expect(calls.filter((c) => c.url.includes('/api/crawler/start'))).toHaveLength(1);
  });
});

describe('MediaCrawlerProvider — fetch (只从 memo 供)', () => {
  test('采过的 URL → 全文', async () => {
    const srv = fakeServer({ appendOnStart: [[rec('1')]] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', ...srv });
    await p.search('q', 1);
    const r = await p.fetch('https://www.zhihu.com/answer/1');
    expect(r.text).toBe('正文1');
    expect(r.title).toBe('标题1');
  });

  /**
   * ⚠ 这条**原来断言的是"没采过就抛"**。2026-08-07 接了 detail 模式之后契约变了:
   * 归本平台的 URL 会**先去采一次**, 采不到才抛。"抛给 pool 降级"这一半没变 ——
   * 变的是"抛之前先试一次"。不归本平台的那半在上面那个 describe 里单独钉。
   */
  test('★ 采不到正文仍然抛, 让 pool 降级 (绝不回落到会撞登录墙的抓取)', async () => {
    const { fetchImpl, sleepImpl } = fakeServer({ appendOnStart: [[]] }); // 采了, 但没新增
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', fetchImpl, sleepImpl });
    expect(p.fetch('https://www.zhihu.com/answer/999')).rejects.toThrow(ProviderError);
  });
});
