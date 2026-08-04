/**
 * G1 散雾·探索格 — 盲评清单 (r2 设计片1; 预制冻结)。
 *
 * 锚 = 本仓**已知真实的改进方向** (2026-08-04 交接 19 的欠账清单) —— 臂独立审视代码能不能
 * 撞上同一批, 命中数即"发现质量"的下限读数; 臂发现清单外的新方向由人工二读 (记 extra, 不进自动分)。
 */
export interface G1Anchor {
  id: string;
  /** 方向描述 (人读)。 */
  direction: string;
  /** 臂答案命中其一即算 (小写子串)。 */
  keywords: string[];
  /** 接地证物 (registry.test 验存在性)。 */
  groundedIn: string;
}

export const G1_TARGET = 'src/harness/pathfinder/';

export const G1_ANCHORS: G1Anchor[] = [
  { id: 'a1', direction: 'gh 后端缺 suggested 态映射 (S-1 片e 欠账)', keywords: ['suggested', 'path:suggested'], groundedIn: 'docs/plan/2026-08-04-s1-suggested-tickets.md' },
  { id: 'a2', direction: 'proximity threshold 0.60 未标定 (拍脑袋档)', keywords: ['threshold', '0.6', '标定'], groundedIn: 'docs/plan/2026-08-04-r1-novelty-collapse-spec.md' },
  { id: 'a3', direction: 'CLI omd-path 是 md-only 与 MCP 后端感知不一致', keywords: ['omd-path', '不一致', 'resolvebackend'], groundedIn: 'scripts/omd-path.ts' },
  { id: 'a4', direction: '中文未分词在 hashEmbed 词袋空间语义近邻失效', keywords: ['中文', '分词', 'tokeniz'], groundedIn: 'src/harness/pathfinder/proximity.ts' },
  { id: 'a5', direction: 'escalated/resumable 回流路无 live 覆盖 (只有单测)', keywords: ['escalated', 'live', '冒烟'], groundedIn: 'src/harness/pathfinder/afk-hook.ts' },
  { id: 'a6', direction: 'research 自展开预算是纯计数 (C3 未接坍塌判据)', keywords: ['预算', 'research', '自展开', 'c3'], groundedIn: 'src/harness/pathfinder/dispatch.ts' },
  { id: 'a7', direction: '票无 body 字段 — md 票表达力受限 (指纹只到 title 级)', keywords: ['body', '指纹', 'fingerprint'], groundedIn: 'src/harness/pathfinder/types.ts' },
];

/** 评分: answerText = 臂的完整回答。返回命中的锚 id。 */
export function scoreG1(answerText: string): { hits: string[]; total: number } {
  const a = answerText.toLowerCase();
  const hits = G1_ANCHORS.filter((an) => an.keywords.some((k) => a.includes(k.toLowerCase()))).map((an) => an.id);
  return { hits, total: G1_ANCHORS.length };
}
