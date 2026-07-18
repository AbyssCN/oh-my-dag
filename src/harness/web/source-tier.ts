/**
 * src/harness/web/source-tier —— 确定性信源分层 (零 LLM)。
 *
 * 三档语义 (the owner 定调"避自媒体二手, 取论文/一手, 但博客也有高质量分析"):
 *   A = 一手/权威 — 论文库/标准/政府监管/官方 docs/源码仓库。抓取预算优先花在这。
 *   B = 默认中性 — 博客/媒体/社区/问答全留这档。**不画硬边界**: 高质量分析大量住博客,
 *       域名判不了文章质量, 由综合层 (research lens "来源可信度") 或调用方读全文裁。
 *   C = 已知内容农场/搬运/SEO 壳 — 仅明确惯犯域降档。
 *
 * 机制 = **降权不灭口** (零丢失原则): 只影响 crawl 槽位分配 (A→B→C 稳定排序, 档内保留
 * 引擎相关性序), 索引仍全量列出并标档, 调用方可见可救。不是过滤器。
 */
import type { SearchResult } from './types';

export type SourceTier = 'A' | 'B' | 'C';

export interface TierVerdict {
  tier: SourceTier;
  /** 命中的规则 (host/类别), 索引标注 + 测试可断言。 */
  reason: string;
}

/** host 后缀匹配 (含子域): 'arxiv.org' 命中 arxiv.org 与 export.arxiv.org。 */
const A_SUFFIX: Array<[string, string]> = [
  // 论文 / 预印本 / 学术出版
  ['arxiv.org', '论文'],
  ['doi.org', '论文'],
  ['openreview.net', '论文'],
  ['aclanthology.org', '论文'],
  ['acm.org', '论文'],
  ['ieee.org', '论文'],
  ['nature.com', '论文'],
  ['science.org', '论文'],
  ['sciencedirect.com', '论文'],
  ['springer.com', '论文'],
  ['nih.gov', '论文'],
  ['ssrn.com', '论文'],
  ['semanticscholar.org', '论文'],
  ['biorxiv.org', '论文'],
  ['medrxiv.org', '论文'],
  ['jmlr.org', '论文'],
  ['mlr.press', '论文'],
  ['neurips.cc', '论文'],
  // 标准
  ['ietf.org', '标准'],
  ['rfc-editor.org', '标准'],
  ['w3.org', '标准'],
  ['iso.org', '标准'],
  ['ecma-international.org', '标准'],
  ['whatwg.org', '标准'],
  ['unicode.org', '标准'],
  // 政府 / 监管 / 国际组织
  ['europa.eu', '政府/监管'],
  ['oecd.org', '政府/监管'],
  ['imf.org', '政府/监管'],
  ['worldbank.org', '政府/监管'],
  // 一手代码 / 仓库 (issues/releases/源码 = 项目自身的一手记录)
  ['github.com', '源码仓库'],
  ['githubusercontent.com', '源码仓库'],
  ['gitlab.com', '源码仓库'],
  // 官方文档托管
  ['readthedocs.io', '官方docs'],
  ['learn.microsoft.com', '官方docs'],
  ['developer.mozilla.org', '官方docs'],
];

/** host 前缀启发: 厂商自家文档域 (docs.python.org / developer.apple.com ...)。 */
const A_PREFIX: Array<[string, string]> = [
  ['docs.', '官方docs'],
  ['developer.', '官方docs'],
];

/** 明确内容农场 / 搬运 / SEO 壳 (惯犯域, 保守收录; 混合质量平台如 medium/zhihu/cnblogs 留 B)。 */
const C_SUFFIX: Array<[string, string]> = [
  ['baijiahao.baidu.com', '自媒体农场'],
  ['sohu.com', '自媒体农场'],
  ['toutiao.com', '自媒体农场'],
  ['163.com', '自媒体农场'],
  ['csdn.net', '搬运聚合'],
  ['jianshu.com', '搬运聚合'],
  ['51cto.com', '搬运聚合'],
  ['iteye.com', '搬运聚合'],
  ['w3schools.com', 'SEO教程壳'],
  ['tutorialspoint.com', 'SEO教程壳'],
  ['geeksforgeeks.org', 'SEO教程壳'],
  ['scribd.com', '搬运聚合'],
  ['slideshare.net', '搬运聚合'],
  ['coursehero.com', '答案农场'],
  ['chegg.com', '答案农场'],
  ['brainly.com', '答案农场'],
  ['pinterest.com', '搬运聚合'],
];

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function suffixHit(host: string, table: Array<[string, string]>): [string, string] | undefined {
  return table.find(([sfx]) => host === sfx || host.endsWith(`.${sfx}`));
}

/** 按 URL 域名/路径确定性分档。判不出 → B (默认中性, 博客在此)。 */
export function classifySourceTier(url: string): TierVerdict {
  const host = hostOf(url);
  if (!host) return { tier: 'B', reason: '无法解析' };
  // *.gov / *.gov.<cc> 顶级政府域
  const parts = host.split('.');
  if (parts.includes('gov')) return { tier: 'A', reason: '政府/监管' };
  const a = suffixHit(host, A_SUFFIX);
  if (a) return { tier: 'A', reason: a[1] };
  const ap = A_PREFIX.find(([pfx]) => host.startsWith(pfx));
  if (ap) return { tier: 'A', reason: ap[1] };
  const c = suffixHit(host, C_SUFFIX);
  if (c) return { tier: 'C', reason: c[1] };
  return { tier: 'B', reason: '默认' };
}

const TIER_RANK: Record<SourceTier, number> = { A: 0, B: 1, C: 2 };

/**
 * crawl 槽位分配序: A→B→C 稳定排序 (档内保留引擎相关性序)。
 * 只重排不删除 — C 档在前档不足时仍会被抓。
 */
export function orderForCrawl<T extends SearchResult>(sources: T[]): T[] {
  return sources
    .map((s, i) => ({ s, i, rank: TIER_RANK[classifySourceTier(s.url).tier] }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .map((x) => x.s);
}
