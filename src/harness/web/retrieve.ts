/**
 * src/harness/web/retrieve —— 确定性 web 检索+爬取 (零 LLM): search → fetch top-N → trafilatura 清洗 → 结构化 md。
 *
 * 单一真理源, 复用点:
 *   - `src/harness/research/web-fanout` 把 .markdown 当 groundTruth 喂 researchFanout (要综合判优的答案)
 *   - dag-research CLI (要内容, 全文落盘零丢失)
 *
 * 升级阶梯 (fetchRacing minChars): race 档并发竞速 → tail 档串行兜底, 空-but-200 也降级;
 * 全 provider 空/失败 → 收进 needsBrowserHarness (调用方升级为有登录态的浏览器手动接管)。
 */
import { CleaningFetchProvider } from './clean';
import { fetchRacing } from './fetch-racing';
import type { WebStack } from './index';
import type { PoolMode } from './pool';
import { normalizeUrl, type SearchResult } from './types';
import { classifySourceTier, orderForCrawl, type SourceTier } from './source-tier';
import { expandQueries, type QueryExpander } from './query-expand';
import type { SourceDistiller } from './distill-source';

export interface RetrieveOpts {
  /** 搜索模式: rotate / aggregate(全 provider 并行去重) / failover。默认 rotate。 */
  mode?: PoolMode;
  /** 检索取 N 条 (默认 8)。 */
  k?: number;
  /** 抓前 N 条正文 (默认 5; 0 = 只搜不抓)。 */
  crawl?: number;
  /** 正文 trim 后短于此视作空 → escalate (默认 200)。 */
  minChars?: number;
  /** true(默认) = 裸抓 + trafilatura 清洗; false = 用 provider 自带 markdown。 */
  clean?: boolean;
  /** true(默认) = crawl 槽位按信源档位 A→B→C 重排 (降权不灭口); false = 纯引擎相关性序。 */
  tierRank?: boolean;
  /**
   * query 改写器 (增益非链路): 给则检索前先扩展 → 原 query + 全部改写各搜一轮 → URL 去重。
   * 省略 = 单 query (现有行为不变)。爬取槽数不受影响 (成本天花板由 crawl 定)。测试注入替身。
   */
  expander?: QueryExpander;
  /**
   * per-source expert 蒸馏器 (增益非链路 · 零丢失红线): 给则清洗后正文 > distillThreshold 的**巨源**,
   * 喂 lens 的语料 (markdown) 里该源块换成「蒸馏精简视图 + 保留 url/标题 + 标注原文见附录」;
   * 原文**永远全量**留在 fullCorpus 附录 (绝不替代/删除)。省略 = 不蒸馏 (现有行为不变)。
   * 阈值门控 = 无巨源时零调用零成本。蒸馏失败 → warn + 该源 lens 语料退回全文, 不断链。测试注入替身。
   */
  distiller?: SourceDistiller;
  /** 触发蒸馏的清洗后正文字符阈值 (默认 30000; A/B 实测: 5 源中位 14k, 30k 只逮离群巨页)。 */
  distillThreshold?: number;
  /** 降级/告警回调 (改写失败退回单 query / 蒸馏失败退回全文时用)。默认静默。 */
  onWarn?: (msg: string) => void;
  signal?: AbortSignal;
}

/** 一个源的蒸馏视图 (只进 lens 语料; 原文全量另在 fullCorpus 附录, 零丢失红线)。 */
export interface DistilledView {
  extract: string;
  relevance: string;
  /** 蒸馏前清洗后正文字符数 (透明留痕 + stderr 记录)。 */
  origLen: number;
}

export interface RetrievedSource extends SearchResult {
  /** 清洗后全文 (抓取成功时)。 */
  body?: string;
  /** 实际服务的 fetch provider。 */
  provider?: string;
  /** 抓取失败/全空时的错误 (→ 该 url 进 needsBrowserHarness)。 */
  error?: string;
  /** 信源档位: A=一手/权威 B=默认(博客在此) C=已知农场/搬运。 */
  tier: SourceTier;
  /** 档位命中规则 (论文/政府/官方docs/自媒体农场...)。 */
  tierReason: string;
}

export interface RetrieveResult {
  query: string;
  /** 实际检索的 query 集 (原 query + 改写; 未扩展时 = [query])。透明留痕。 */
  queries: string[];
  mode: PoolMode;
  searchProviders: string[];
  sources: RetrievedSource[];
  /** 全 provider 空/失败的 url → 调用方升级人工/浏览器接管。 */
  needsBrowserHarness: string[];
  /**
   * **喂 lens 的语料** (fanout groundTruth): 检索命中全列 + 逐条正文, 巨源块换成蒸馏精简视图
   * (未开蒸馏 / 无巨源时 = 全文, 与 fullCorpus 同)。
   */
  markdown: string;
  /**
   * **全文语料附录** (零丢失红线): 检索命中全列 + 逐条清洗后**全文**, 永不蒸馏。--out 落盘用这份。
   * 无蒸馏发生时与 markdown 同引用 (省一次拼接)。
   */
  fullCorpus: string;
  /** 本轮触发蒸馏的源 (透明留痕; 空 = 无巨源 / 未开蒸馏)。dag-research stderr 记录用。 */
  distilled: { url: string; origLen: number; extractLen: number }[];
}

/** 跑一轮确定性检索+爬取。无网络可测: 注入 fake WebStack。 */
export async function retrieveWeb(
  stack: WebStack,
  query: string,
  opts: RetrieveOpts = {},
): Promise<RetrieveResult> {
  const mode: PoolMode = opts.mode ?? 'rotate';
  const k = opts.k ?? 8;
  const crawlN = opts.crawl ?? 5;
  const minChars = opts.minChars ?? 200;
  const clean = opts.clean ?? true;
  const tierRank = opts.tierRank ?? true;

  // query 扩展 (增益非链路): 原 query + 改写各搜一轮, 失败退回单 query。
  const queries = await expandQueries(query, opts.expander, {
    signal: opts.signal,
    onWarn: opts.onWarn,
  });
  const rounds = await Promise.all(
    queries.map((q) => stack.searchPool.search(q, k, { mode, signal: opts.signal })),
  );
  // 多轮结果按归一化 URL 去重 (保首现: 原 query 命中优先, 改写补召回); provider 并集去重。
  const seen = new Set<string>();
  const mergedResults: SearchResult[] = [];
  for (const round of rounds) {
    for (const r of round.results) {
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      mergedResults.push(r);
    }
  }
  const searchProviders = [...new Set(rounds.flatMap((r) => r.providers))];
  // 档位重排只决定谁吃 crawl 槽位 (A→B→C, 档内保留相关性序); 全部命中仍进索引。
  const ranked = tierRank ? orderForCrawl(mergedResults) : mergedResults;
  const toCrawl = ranked.slice(0, crawlN);
  const provs = clean
    ? stack.fetchProviders.map((fp) => new CleaningFetchProvider(fp, stack.cleaner))
    : stack.fetchProviders;
  const fetched = await Promise.allSettled(
    toCrawl.map((r) => fetchRacing(provs, r.url, { minChars, signal: opts.signal })),
  );

  const sources: RetrievedSource[] = ranked.map((r, i) => {
    const { tier, reason } = classifySourceTier(r.url);
    const base = { ...r, tier, tierReason: reason };
    const f = i < toCrawl.length ? fetched[i] : undefined;
    if (f?.status === 'fulfilled') return { ...base, body: f.value.result.text.trim(), provider: f.value.provider };
    if (f?.status === 'rejected') return { ...base, error: (f.reason as Error).message };
    return base;
  });
  const needsBrowserHarness = toCrawl
    .map((r, i) => ({ url: r.url, rejected: fetched[i]?.status === 'rejected' }))
    .filter((x) => x.rejected)
    .map((x) => x.url);

  // per-source 蒸馏 (增益非链路 · 零丢失红线): 巨源 (清洗后正文 > 阈值) 蒸馏出精简视图, 只进
  // 喂 lens 的语料 (markdown); 原文永远全量进 fullCorpus 附录。阈值门控 = 无巨源时零调用零成本。
  const distillThreshold = opts.distillThreshold ?? 30000;
  const views = new Map<number, DistilledView>();
  if (opts.distiller) {
    await Promise.all(
      sources.map(async (s, i) => {
        if (!s.body || s.body.length <= distillThreshold) return;
        try {
          const { relevance, extract } = await opts.distiller!(
            { body: s.body, title: s.title, url: s.url, question: query },
            opts.signal,
          );
          views.set(i, { extract, relevance, origLen: s.body.length });
        } catch (e) {
          // 蒸馏失败 → 该源 lens 语料退回全文 (不 set view), warn 不断链 (降级不断链)。
          opts.onWarn?.(`源蒸馏失败, lens 语料退回全文: ${s.url} — ${(e as Error).message}`);
        }
      }),
    );
  }
  const distilled = [...views.entries()].map(([i, v]) => ({
    url: sources[i]!.url,
    origLen: v.origLen,
    extractLen: v.extract.length,
  }));

  // markdown = 喂 lens 的语料 (巨源换蒸馏视图); fullCorpus = 全文附录 (永不蒸馏, 零丢失)。
  // 无蒸馏发生 → 两者同引用 (省一次拼接)。
  const markdown = buildMarkdown(query, mode, searchProviders, sources, toCrawl.length, clean, queries, views);
  const fullCorpus =
    views.size === 0
      ? markdown
      : buildMarkdown(query, mode, searchProviders, sources, toCrawl.length, clean, queries);

  return {
    query,
    queries,
    mode,
    searchProviders,
    sources,
    needsBrowserHarness,
    markdown,
    fullCorpus,
    distilled,
  };
}

/**
 * 结构化语料。
 * @param views 给则为**喂 lens 的语料**: views 命中的巨源块换蒸馏精简视图 (保留 url/标题, 标注原文见附录);
 *   省略/空则为**全文附录** (每源逐条全文, 零压缩, 零丢失红线)。
 */
export function buildMarkdown(
  query: string,
  mode: PoolMode,
  searchProviders: string[],
  sources: RetrievedSource[],
  crawled: number,
  clean: boolean,
  queries: string[] = [query],
  views?: Map<number, DistilledView>,
): string {
  const ok = sources.filter((s) => s.body).length;
  const md: string[] = [];
  md.push(`# 检索: ${query}`, '');
  md.push(
    `> mode=${mode} · search=${searchProviders.join('+')} · 命中 ${sources.length} · ` +
      `抓取 ${ok}/${crawled} · 清洗 ${clean ? 'trafilatura' : 'off'}` +
      (queries.length > 1 ? ` · 改写 ${queries.length - 1}` : ''),
    '',
  );
  if (queries.length > 1) {
    md.push(`> 检索 query (原+改写): ${queries.map((q) => `\`${q}\``).join(' · ')}`, '');
  }
  md.push(
    '> 信源档位: A=一手/权威(论文/政府/官方docs/源码仓库) B=默认(博客/媒体/社区) C=已知农场/搬运(降权不删)',
    '',
  );
  md.push('## 检索命中 (全部)', '');
  sources.forEach((s, i) => {
    md.push(`${i + 1}. **${s.title}** \`[${s.tier}·${s.tierReason}]\``, `   ${s.url}`);
    if (s.snippet) md.push(`   ${s.snippet}`);
    md.push('');
  });
  if (crawled > 0) {
    md.push('## 抓取正文 (清洗后, 逐条全文)', '');
    sources.slice(0, crawled).forEach((s, i) => {
      md.push(`### ${i + 1}. ${s.title} [${s.tier}·${s.tierReason}]`, `- url: ${s.url}`);
      const view = views?.get(i);
      if (view) {
        // 喂 lens 的语料: 巨源换蒸馏精简视图 (保留 url/标题行; 原文全文在 fullCorpus 附录)。
        md.push(
          `- provider: ${s.provider}`,
          `- ⓘ 已蒸馏: 原文 ${view.origLen} → extract ${view.extract.length} chars (原文全文见语料附录)`,
          `- 蒸馏相关性: ${view.relevance}`,
          '',
          '【蒸馏精简视图 · 供 lens 优先读; 原文全文见语料附录】',
          view.extract,
        );
      } else if (s.body) {
        md.push(`- provider: ${s.provider}`, '', s.body);
      } else {
        md.push(
          `- ⚠️ 全 provider 空/失败: ${s.error ?? '未抓取'}`,
          `- → 需人工/浏览器接管抓此 URL (反爬/登录墙)`,
        );
      }
      md.push('');
    });
  }
  return md.join('\n');
}
