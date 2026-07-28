/**
 * test/core/mcp-research-node.test.ts — `executor:'research'` 节点的生产执行器 (D-6, P1)。
 *
 * 钉 INV-GOAL-2 的证据口径: 节点的 `sources` = **真抓到正文**的 URL,不是"搜到的候选"。
 * 经 _webStack / _webFanout 注入口测,不打真检索、不打 live 模型。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultResearchRunner } from '../../src/mcp/assemble';

/** 检索命中 3 条, 其中 2 条真抓到正文 (第 3 条只有标题 = 没抓下来)。 */
const fakeWebResult = () =>
  ({
    question: 'q',
    retrieval: {
      sources: [
        { url: 'https://a.example/doc', body: '正文 A' },
        { url: 'https://b.example/doc', body: '正文 B' },
        { url: 'https://c.example/doc' }, // 搜到但没抓下来
      ],
      markdown: '语料',
    },
    // deep 档: 种子 query 各自也检索 (第 2 个源真抓到)
    seedRetrievals: [
      { sources: [{ url: 'https://seed.example/doc', body: '种子正文' }, { url: 'https://seed.example/miss' }] },
    ],
    fanout: {
      final: '研究终稿',
      lensChampions: [],
      synthCandidates: [],
      judgeCritiques: [],
      fusionAnalysis: '',
      leafCount: 7,
      roundsRun: 2,
      // 轮 2 的 probe 补抓 (缺料 URL) —— 多轮研究**新增**的证据就在这里
      secondPass: [{ round: 2, gaps: [{ key: 'gap-1' }], probedUrls: ['https://probe.example/spec'] }],
      costStats: {
        totalUsd: 0,
        totalSavingsUsd: 0,
        perModel: { 'p:m': { calls: 7, in: 900, out: 300, cacheHit: 0, cacheHitRate: 0, costUsd: 0 } },
      },
    },
  }) as never;

const fakeStack = (() => ({ searchPool: {}, fetchProviders: [], cleaner: {}, quota: {} })) as never;

describe("executor:'research' 生产执行器 (D-6)", () => {
  test('sources = 真抓到正文的 URL (搜到没抓下来的不算痕迹)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-rnode-'));
    const runner = createDefaultResearchRunner({
      cwd,
      env: { TAVILY_API_KEY: 'x' } as NodeJS.ProcessEnv,
      _webStack: fakeStack,
      _webFanout: (async () => fakeWebResult()) as never,
    })!;
    const r = await runner({ question: '怎么做增量复用' });
    // 三个抓取面都算: 主检索 2 条 + 种子检索 1 条 + 轮 2 probe 补抓 1 条 (搜到没抓下来的都不算)
    expect(r.sources).toEqual([
      'https://a.example/doc',
      'https://b.example/doc',
      'https://seed.example/doc',
      'https://probe.example/spec',
    ]);
    expect(r.text).toBe('研究终稿');
    // usage = 整轮各模型 in/out 之和 (一个 research 节点 = 几十次调用, 账本别记成 1 次)
    expect(r.usage).toEqual({ in: 900, out: 300 });
  });

  test('报告落盘且带来源段 (宽出: 节点输出只带终稿)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-rnode-'));
    const runner = createDefaultResearchRunner({
      cwd,
      env: { TAVILY_API_KEY: 'x' } as NodeJS.ProcessEnv,
      _webStack: fakeStack,
      _webFanout: (async () => fakeWebResult()) as never,
    })!;
    const r = await runner({ question: 'q' });
    expect(existsSync(r.reportPath!)).toBe(true);
    const report = readFileSync(r.reportPath!, 'utf8');
    expect(report).toContain('## 来源 (真抓到正文)');
    expect(report).toContain('https://a.example/doc');
    expect(report).not.toContain('https://c.example/doc');
    // 多轮档的"第二轮到底干了什么"要留在报告里, 不只活在日志
    expect(report).toContain('## 轮次留痕 (共 2 轮)');
    expect(report).toContain('第 2 轮');
    expect(report).toContain('gap-1');
    expect(report).toContain('https://probe.example/spec');
  });

  test('内环有界: rounds 透传, 缺省 1 轮', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-rnode-'));
    let opts: { rounds?: number; k?: number; anchors?: { label: string; text: string }[] } = {};
    const mk = () =>
      createDefaultResearchRunner({
        cwd,
        env: { TAVILY_API_KEY: 'x' } as NodeJS.ProcessEnv,
        _webStack: fakeStack,
        _webFanout: (async (_s: unknown, _q: string, o: typeof opts) => {
          opts = o;
          return fakeWebResult();
        }) as never,
      })!;
    await mk()({ question: 'q' });
    expect(opts.rounds).toBe(1);
    await mk()({ question: 'q', rounds: 3, k: 2, groundTruth: '上游产出' });
    expect(opts.rounds).toBe(3);
    expect(opts.k).toBe(2);
    // 上游输出当锚点进 groundTruth 之首 (防幻觉 + 对 prompt cache 友好)
    expect(opts.anchors?.[0]?.text).toBe('上游产出');
  });

  // 无搜索 provider 就没有"真 web" —— 宁可不挂 runner 让节点响亮失败, 也不退化成没有 web 的 leaf。
  test('无 search provider → 不挂 runner (返 undefined)', () => {
    const runner = createDefaultResearchRunner({
      cwd: mkdtempSync(join(tmpdir(), 'omd-rnode-')),
      env: {} as NodeJS.ProcessEnv,
      _webStack: (() => {
        throw new Error('no search provider');
      }) as never,
    });
    expect(runner).toBeUndefined();
  });
});

// ── dag_research 与 research 节点走**同一条 web 管线** (不再有"纯模型档"分身) ──────
describe('dag_research 旗标落到 web 管线', () => {
  test('council:false → 固定档 (省一次分解调用); 默认自适应出镜头', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-rnode-'));
    let opts: { council?: boolean; authorSeeds?: boolean; mode?: string } = {};
    const mk = () =>
      createDefaultResearchRunner({
        cwd,
        env: { TAVILY_API_KEY: 'x' } as NodeJS.ProcessEnv,
        _webStack: fakeStack,
        _webFanout: (async (_s: unknown, _q: string, o: typeof opts) => {
          opts = o;
          return fakeWebResult();
        }) as never,
      })!;
    await mk()({ question: 'q' });
    expect(opts.council).toBe(true);
    await mk()({ question: 'q', council: false });
    expect(opts.council).toBe(false);
  });

  test('deep → 种子作者化 + provider 池全并行 (super 旗标的落点)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omd-rnode-'));
    let opts: { authorSeeds?: boolean; mode?: string } = {};
    const runner = createDefaultResearchRunner({
      cwd,
      env: { TAVILY_API_KEY: 'x' } as NodeJS.ProcessEnv,
      _webStack: fakeStack,
      _webFanout: (async (_s: unknown, _q: string, o: typeof opts) => {
        opts = o;
        return fakeWebResult();
      }) as never,
    })!;
    await runner({ question: 'q', deep: true });
    expect(opts.authorSeeds).toBe(true);
    expect(opts.mode).toBe('aggregate');
  });
});
