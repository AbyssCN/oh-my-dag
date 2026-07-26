import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebTools } from './web';

// web 能力递到图外。红线: 原文零丢失 (落盘) + context 零污染 (stdout 只回索引)。
// fetchedUrls 是 research 第二轮那个确定性探测器的原料 —— 它必须准。

const SOURCES = [
  { url: 'https://a.example/1', title: 'A', body: '正文A', tier: 'A', provider: 'plain' },
  { url: 'https://b.example/2', title: 'B', tier: 'B', error: '403' }, // 搜到没抓到
];
const deps = (cwd: string) => ({
  cwd,
  retrieve: async () => ({
    queries: ['q', 'q 改写'],
    searchProviders: ['searxng'],
    sources: SOURCES,
    fullCorpus: '# 全文语料\n很长很长'.repeat(50),
    needsBrowserHarness: ['https://b.example/2'],
  }),
  distill: async (lens: 'expert' | 'challenger') =>
    lens === 'expert' ? { relevance: 'r-e', extract: 'x-e' } : { relevance: 'r-c', extract: 'x-c' },
});
const tool = (cwd: string, n: string) => createWebTools(deps(cwd) as never).find((t) => t.name === n)!;
const call = (t: ReturnType<typeof tool>, a: unknown) =>
  (t.handler as never as (x: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>)(a);

describe('omd_web', () => {
  test('全文落盘, stdout 只回索引 (context 零污染)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-web-'));
    const r = await call(tool(cwd, 'omd_web'), { query: '测试 查询' });
    const path = /全文语料 \(零丢失, 按需 Read\): (\S+)/.exec(r.content[0]!.text)![1]!;
    expect(readFileSync(path, 'utf8').length).toBeGreaterThan(500);
    expect(r.content[0]!.text.length).toBeLessThan(900); // stdout 远小于语料
  });

  test('fetchedUrls 只含**真有正文**的源 (搜到没抓到不算)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-web-'));
    const r = await call(tool(cwd, 'omd_web'), { query: 'q' });
    const urls = JSON.parse(/fetchedUrls: (\[.*\])/.exec(r.content[0]!.text)![1]!) as string[];
    expect(urls).toEqual(['https://a.example/1']);
  });

  test('抓不动的源进 needsBrowserHarness 并留痕, 不静默消失', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-web-'));
    const t = (await call(tool(cwd, 'omd_web'), { query: 'q' })).content[0]!.text;
    expect(t).toContain('needsBrowserHarness');
    expect(t).toContain('403'); // 索引里带错因
  });

  test('空 query → isError', async () => {
    expect((await call(tool(mkdtempSync(join(tmpdir(), 'omd-web-')), 'omd_web'), { query: '  ' })).isError).toBe(true);
  });
});

describe('omd_distill', () => {
  test('默认 both —— 对偶才有增益', async () => {
    const t = (await call(tool('.', 'omd_distill'), { text: '料' })).content[0]!.text;
    expect(t).toContain('===== expert =====');
    expect(t).toContain('===== challenger =====');
  });

  test('单 lens 可指定', async () => {
    const t = (await call(tool('.', 'omd_distill'), { text: '料', lens: 'challenger' })).content[0]!.text;
    expect(t).toContain('challenger');
    expect(t).not.toContain('===== expert =====');
  });

  test('一个 lens 挂了照回另一个, 但**留痕**不静默吞 (蒸馏是增益不是链路)', async () => {
    const tools = createWebTools({
      cwd: '.',
      retrieve: (async () => ({})) as never,
      distill: (async (lens: string) => {
        if (lens === 'expert') throw new Error('boom');
        return { relevance: 'r', extract: 'x' };
      }) as never,
    });
    const t = (await call(tools.find((x) => x.name === 'omd_distill')!, { text: '料' })).content[0]!.text;
    expect(t).toContain('expert (失败)');
    expect(t).toContain('boom');
    expect(t).toContain('x'); // challenger 仍然出结果
  });

  test('空 text → isError', async () => {
    expect((await call(tool('.', 'omd_distill'), { text: '' })).isError).toBe(true);
  });
});
