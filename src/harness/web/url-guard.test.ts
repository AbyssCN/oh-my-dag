/**
 * src/harness/web/url-guard —— SSRF 入口闸 (C1, 2026-08-25 台账)。
 *
 * - **INV-2** GWT-3: 私网/环回/链路本地 URL + 域名解析到私网 → fetchRacing 抛, 文案含 `SSRF`, provider 调用为 0;
 * - **INV-2** GWT-4: 域名解析到公网 → assertPublicUrl 不抛;
 * - **INV-2** GWT-5: scheme 非 http(s) (file/ftp) → 抛;
 * - **INV-3** GWT-6: buildSecondPassProbe 在 link-local URL 与公网 URL 混跑时, 不抛, 公网进 newCorpus, link-local 不入 fetchedUrls。
 *
 * ## 反向自检 (写在测试注释)
 * - 删 `await assertPublicUrl(...)` 在 fetchRacing 头部 → GWT-3 fake provider 计数从 0 变 1, 同时 fetchRacing 不再抛;
 * - 把 GWT-3 的 `expect(e.message).toContain('SSRF')` 改成 `expect(true).toBe(true)` → 不测也能绿, 失去语义;
 * - 把 GWT-6 的 link-local URL 改成公网 URL → GWT-6 的 `fetchedUrls` 会含两条, 失去"单边过滤"语义;
 * - 把 `resolver` 默认走真 DNS → GWT-4 在断网/CI 红, 测试不可密封。
 */
import { describe, expect, test } from 'bun:test';
import { fetchRacing } from './fetch-racing';
import { assertPublicUrl, type AssertPublicUrlOpts } from './url-guard';
import type { FetchProvider, FetchResult } from './types';
import { buildSecondPassProbe } from '../research/web-fanout';
import type { ResearchGap } from '../research/fanout';
import { PassthroughCleaner } from './clean';
import type { WebStack } from './index';

/* ─── helpers ─────────────────────────────────────── */

/** 计数型 fake fetch provider: 每次 fetch 自增计数, 返长正文 (过 minChars)。 */
function countingProvider(): { provider: FetchProvider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      name: 'fakecount',
      async fetch(): Promise<FetchResult> {
        n++;
        return { url: '', text: 'x'.repeat(300) };
      },
    },
    calls: () => n,
  };
}

/** 注入式 resolver — 测试密封, 不打真 DNS。 */
function fixedResolver(byHost: Record<string, string[]>): AssertPublicUrlOpts['resolver'] {
  return async (host: string) => (byHost[host] ?? []).map((a) => ({ address: a }));
}

/* ─── assertPublicUrl 直接测 ─────────────────────────── */

describe('assertPublicUrl — IP 字面', () => {
  test('GWT-3 169.254.169.254 (link-local) → 抛 + 文案含 SSRF', async () => {
    await expect(
      assertPublicUrl('http://169.254.169.254/meta', {
        resolver: fixedResolver({}),
      }),
    ).rejects.toThrow(/SSRF/);
  });

  test('127.0.0.1 (loopback) → 抛', async () => {
    await expect(
      assertPublicUrl('http://127.0.0.1/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('10.0.0.5 (RFC1918) → 抛', async () => {
    await expect(
      assertPublicUrl('http://10.0.0.5/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('192.168.1.1 (RFC1918) → 抛', async () => {
    await expect(
      assertPublicUrl('http://192.168.1.1/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('100.64.0.1 (CGNAT) → 抛', async () => {
    await expect(
      assertPublicUrl('http://100.64.0.1/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('0.0.0.0 (unspecified) → 抛', async () => {
    await expect(
      assertPublicUrl('http://0.0.0.0/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('::1 (IPv6 loopback) → 抛', async () => {
    await expect(
      assertPublicUrl('http://[::1]/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('fc00::1 (IPv6 ULA) → 抛', async () => {
    await expect(
      assertPublicUrl('http://[fc00::1]/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('fe80::1 (IPv6 link-local) → 抛', async () => {
    await expect(
      assertPublicUrl('http://[fe80::1]/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('::ffff:127.0.0.1 (v4-mapped loopback) → 抛 (还原为 v4 复判)', async () => {
    await expect(
      assertPublicUrl('http://[::ffff:127.0.0.1]/', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('localhost (字面) → 抛', async () => {
    await expect(
      assertPublicUrl('http://localhost:8080/x', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('LOCALHOST (大写) → 抛 (大小写不敏感)', async () => {
    await expect(
      assertPublicUrl('http://LOCALHOST/x', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('非 IP 字面公网 IP → 不抛', async () => {
    await expect(
      assertPublicUrl('http://93.184.216.34/', { resolver: fixedResolver({}) }),
    ).resolves.toBeUndefined();
  });
});

describe('assertPublicUrl — 域名解析', () => {
  test('GWT-4 域名解析到 93.184.216.34 (公网 IP) → 不抛', async () => {
    await expect(
      assertPublicUrl('http://example.com/', {
        resolver: fixedResolver({ 'example.com': ['93.184.216.34'] }),
      }),
    ).resolves.toBeUndefined();
  });

  test('域名解析到 10.0.0.5 (RFC1918) → 抛', async () => {
    await expect(
      assertPublicUrl('http://internal.test/', {
        resolver: fixedResolver({ 'internal.test': ['10.0.0.5'] }),
      }),
    ).rejects.toThrow(/SSRF/);
  });

  test('域名解析到 127.0.0.1 (loopback) → 抛', async () => {
    await expect(
      assertPublicUrl('http://x.test/', {
        resolver: fixedResolver({ 'x.test': ['127.0.0.1'] }),
      }),
    ).rejects.toThrow(/SSRF/);
  });

  test('域名解析到多条地址, 其中一条私网 → 抛 (任一命中即拒)', async () => {
    await expect(
      assertPublicUrl('http://multi.test/', {
        resolver: fixedResolver({
          'multi.test': ['93.184.216.34', '10.0.0.5'],
        }),
      }),
    ).rejects.toThrow(/SSRF/);
  });

  // 解析失败/零地址 = 放行 (验收裁决, run 960c5107): 解析失败不是私网证据 —— 真实 fetch 同样
  // 够不着, 放行不构成绕过; 拒会砸离线/假域名场景 (当次 3 条既有 probe 测试红)。
  test('DNS lookup 返空 → 放行 (不是私网证据)', async () => {
    await expect(
      assertPublicUrl('http://empty.test/', {
        resolver: fixedResolver({ 'empty.test': [] }),
      }),
    ).resolves.toBeUndefined();
  });

  test('DNS lookup 自身抛错 → 放行 (真实 fetch 同样解析不了, 不构成绕过)', async () => {
    await expect(
      assertPublicUrl('http://broken.test/', {
        resolver: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('assertPublicUrl — scheme 闸', () => {
  test('GWT-5 file:///etc/passwd → 抛', async () => {
    await expect(
      assertPublicUrl('file:///etc/passwd', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('GWT-5 ftp://x → 抛', async () => {
    await expect(
      assertPublicUrl('ftp://x', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('javascript: → 抛', async () => {
    await expect(
      assertPublicUrl('javascript:alert(1)', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('data: → 抛', async () => {
    await expect(
      assertPublicUrl('data:text/plain,hello', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });

  test('非法 URL 字面 → 抛', async () => {
    await expect(
      assertPublicUrl('not-a-url', { resolver: fixedResolver({}) }),
    ).rejects.toThrow(/SSRF/);
  });
});

/* ─── fetchRacing 闸位 ──────────────────────────── */

describe('fetchRacing — SSRF 闸位 (C1, 单一入口)', () => {
  test('GWT-3 link-local IP 169.254.169.254 → 抛 + 文案含 SSRF + provider 调用为 0', async () => {
    const { provider, calls } = countingProvider();
    await expect(
      fetchRacing([provider], 'http://169.254.169.254/meta', {
        minChars: 0,
        resolver: fixedResolver({}),
      }),
    ).rejects.toThrow(/SSRF/);
    expect(calls()).toBe(0);
  });

  test('GWT-3 localhost 字面 → 抛 + provider 调用为 0', async () => {
    const { provider, calls } = countingProvider();
    await expect(
      fetchRacing([provider], 'http://localhost:8080/x', {
        minChars: 0,
        resolver: fixedResolver({}),
      }),
    ).rejects.toThrow(/SSRF/);
    expect(calls()).toBe(0);
  });

  test('GWT-3 127.0.0.1 loopback → 抛 + provider 调用为 0', async () => {
    const { provider, calls } = countingProvider();
    await expect(
      fetchRacing([provider], 'http://127.0.0.1/', {
        minChars: 0,
        resolver: fixedResolver({}),
      }),
    ).rejects.toThrow(/SSRF/);
    expect(calls()).toBe(0);
  });

  test('GWT-3 域名解析到 10.0.0.5 → 抛 + provider 调用为 0 (resolver 注入)', async () => {
    const { provider, calls } = countingProvider();
    await expect(
      fetchRacing([provider], 'http://internal.test/', {
        minChars: 0,
        resolver: fixedResolver({ 'internal.test': ['10.0.0.5'] }),
      }),
    ).rejects.toThrow(/SSRF/);
    expect(calls()).toBe(0);
  });

  test('公网域名 (解析到 93.184.216.34) → 不抛 + provider 正常被调用', async () => {
    const { provider, calls } = countingProvider();
    const result = await fetchRacing([provider], 'http://example.com/', {
      minChars: 0,
      resolver: fixedResolver({ 'example.com': ['93.184.216.34'] }),
    });
    expect(result.provider).toBe('fakecount');
    expect(calls()).toBeGreaterThan(0);
  });

  test('file:///etc/passwd → 抛 (scheme 闸)', async () => {
    const { provider, calls } = countingProvider();
    await expect(
      fetchRacing([provider], 'file:///etc/passwd', {
        minChars: 0,
        resolver: fixedResolver({}),
      }),
    ).rejects.toThrow(/SSRF/);
    expect(calls()).toBe(0);
  });
});

/* ─── buildSecondPassProbe 集成 (INV-3 GWT-6) ──────────── */

/** 计数 fake fetch provider: 每 URL 都返 300 chars (过 minChars=200)。 */
function probeFetchProvider(): FetchProvider {
  return {
    name: 'fakeprobe',
    async fetch(url): Promise<FetchResult> {
      return { url, text: 'x'.repeat(300) };
    },
  };
}

describe('buildSecondPassProbe — SSRF 闸拒不断链 (INV-3)', () => {
  test('GWT-6 link-local URL + 公网 IP URL 混跑 → 不抛, 公网进 newCorpus, link-local 不入 fetchedUrls', async () => {
    // 公网用 IP 字面 (不经 DNS), 让 fake provider 在不依赖真 DNS 的前提下被闸放行。
    // link-local 字面直接被 IP 字面闸拒。
    const stages: string[] = [];
    const stack: WebStack = {
      searchPool: {
        async search() {
          return { results: [], providers: ['fake'], mode: 'rotate' as const };
        },
        setMode: () => {},
        setDefault: () => {},
        toggle: () => {},
        status: () => [],
      } as unknown as WebStack['searchPool'],
      fetchProviders: [probeFetchProvider()],
      cleaner: new PassthroughCleaner(),
      quota: {} as never,
    } as unknown as WebStack;
    const probe = buildSecondPassProbe(stack, [], {
      onStage: (s, d) => stages.push(`${s}:${d}`),
    });
    const gap = (urls: string[]): ResearchGap => ({
      key: 'g',
      question: 'q',
      why: 'w',
      urls,
    });
    const y = await probe({
      round: 0,
      digest: '',
      gaps: [gap(['http://169.254.169.254/meta', 'http://93.184.216.34/'])],
    });

    // 不抛
    expect(y).toBeDefined();
    // 公网 IP 字面那条进 fetchedUrls, link-local 不进
    expect(y.fetchedUrls).toBeDefined();
    expect(y.fetchedUrls).toContain('http://93.184.216.34/');
    expect(y.fetchedUrls).not.toContain('http://169.254.169.254/meta');
    // onStage 留痕: link-local 失败跳过 (不静默吞)
    expect(stages.some((s) => s.includes('169.254.169.254') && s.includes('失败'))).toBe(true);
  });
});
