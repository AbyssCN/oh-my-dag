/**
 * G2 散雾·多日格 — 预埋失效点清单 (r2 设计片1; 注入变化 = 「proximity threshold 默认 0.60 → 0.75」)。
 *
 * 失效点 = 依赖 0.60 的既有结论; 臂在第二段必须识别出来。评分 = 识别数/预埋数 (关键词档)。
 */
export interface G2Invalidation {
  id: string;
  conclusion: string;
  keywords: string[];
  groundedIn: string;
}

export const G2_CHANGE = 'proximity 的 cosine 阈值默认从 0.60 提到 0.75 (连边更难)';

export const G2_INVALIDATIONS: G2Invalidation[] = [
  { id: 'v1', conclusion: '语义去重会更少命中 — deduped-semantic 率下降, 重复建议更易漏入图', keywords: ['去重', 'semantic', '漏'], groundedIn: 'src/harness/pathfinder/suggest.ts' },
  { id: 'v2', conclusion: '簇数普遍变多、坍塌更难触发 — hasCollapsed 灵敏度下降', keywords: ['坍塌', '簇', 'collaps'], groundedIn: 'src/harness/pathfinder/proximity.ts' },
  { id: 'v3', conclusion: 'r1 spec 未决第 1 条的 0.60 标定计划作废 (标定目标变了)', keywords: ['标定', 'spec', '未决'], groundedIn: 'docs/plan/2026-08-04-r1-novelty-collapse-spec.md' },
  { id: 'v4', conclusion: '既有测试里 cosine≈0.75 的边界用例 (deploy 词组对) 落在新阈值刀口上, 需重核', keywords: ['测试', '边界', 'deploy'], groundedIn: 'src/harness/pathfinder/suggested.test.ts' },
];

export function scoreG2(answerText: string): { hits: string[]; total: number } {
  const a = answerText.toLowerCase();
  return { hits: G2_INVALIDATIONS.filter((v) => v.keywords.some((k) => a.includes(k.toLowerCase()))).map((v) => v.id), total: G2_INVALIDATIONS.length };
}
