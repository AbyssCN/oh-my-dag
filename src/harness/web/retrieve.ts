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
import type { SearchResult } from './types';
import { classifySourceTier, orderForCrawl, type SourceTier } from './source-tier';

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
  signal?: AbortSignal;
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
  mode: PoolMode;
  searchProviders: string[];
  sources: RetrievedSource[];
  /** 全 provider 空/失败的 url → 调用方升级人工/浏览器接管。 */
  needsBrowserHarness: string[];
  /** 结构化语料 (检索命中全列 + 逐条清洗后全文); 既是 CLI 落盘内容, 也是 fanout 的 groundTruth。 */
  markdown: string;
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

  const sr = await stack.searchPool.search(query, k, {
    mode,
    signal: opts.signal,
  });
  // 档位重排只决定谁吃 crawl 槽位 (A→B→C, 档内保留相关性序); 全部命中仍进索引。
  const ranked = tierRank ? orderForCrawl(sr.results) : sr.results;
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

  return {
    query,
    mode,
    searchProviders: sr.providers,
    sources,
    needsBrowserHarness,
    markdown: buildMarkdown(query, mode, sr.providers, sources, toCrawl.length, clean),
  };
}

/** 结构化语料 (检索命中 + 逐条全文, 零压缩)。 */
export function buildMarkdown(
  query: string,
  mode: PoolMode,
  searchProviders: string[],
  sources: RetrievedSource[],
  crawled: number,
  clean: boolean,
): string {
  const ok = sources.filter((s) => s.body).length;
  const md: string[] = [];
  md.push(`# 检索: ${query}`, '');
  md.push(
    `> mode=${mode} · search=${searchProviders.join('+')} · 命中 ${sources.length} · ` +
      `抓取 ${ok}/${crawled} · 清洗 ${clean ? 'trafilatura' : 'off'}`,
    '',
  );
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
      if (s.body) {
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
