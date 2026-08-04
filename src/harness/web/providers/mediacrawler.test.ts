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

describe('MediaCrawlerProvider — fetch (只从 memo 供)', () => {
  test('采过的 URL → 全文', async () => {
    const srv = fakeServer({ appendOnStart: [[rec('1')]] });
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', ...srv });
    await p.search('q', 1);
    const r = await p.fetch('https://www.zhihu.com/answer/1');
    expect(r.text).toBe('正文1');
    expect(r.title).toBe('标题1');
  });

  test('★ 没采过的 URL → 抛, 让 pool 降级 (绝不回落到会撞登录墙的抓取)', async () => {
    const p = new MediaCrawlerProvider({ baseUrl: 'http://n', fetchImpl: (async () => new Response('')) as unknown as typeof fetch });
    expect(p.fetch('https://www.zhihu.com/answer/999')).rejects.toThrow(ProviderError);
  });
});
