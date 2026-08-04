/**
 * F2 宽扇出·调研格 — 核实清单 (r2 设计片1; 预制冻结, 跑前不改 INV-R2-2)。
 *
 * 评分 (机器化下限档, 替"人工按清单勾"): 每题 1 分 = 答案**点对出处文件** 且 **含 ≥1 个接地关键词**。
 * 关键词全部经 raw 原文逐字核过 (f2-registry.test 的存在性自检钉死) —— 清单先于任何一臂跑冻结。
 */
export interface F2Item {
  id: string;
  question: string;
  /** 答案必含其一 (逐字, 大小写不敏感)。 */
  acceptKeywords: string[];
  /** 出处必须点到这个文件 (文件名子串匹配)。 */
  sourceFile: string;
}

export const F2_SOURCE_DIR = 'docs/reference/agentic-graph-2026-08/raw';

export const F2_ITEMS: F2Item[] = [
  { id: 'q1', question: 'AI co-scientist 里新假设进入锦标赛时的初始 Elo 分是多少?', acceptKeywords: ['1200'], sourceFile: 'co-scientist-2502.18864.txt' },
  { id: 'q2', question: 'IBM survey 主张结构性改动 (拓扑变更) 的裁决该基于什么, 而不是模型的自由判断?', acceptKeywords: ['evidence', 'structural'], sourceFile: 'ibm-survey-2603.22386.txt' },
  { id: 'q3', question: '哪篇论文对比了 LangGraph 编排与 in-context 执行在已知流程任务上的失败率?一句话给出方向性结论。', acceptKeywords: ['in-context', 'LangGraph'], sourceFile: 'counter-incontext-2604.27891.txt' },
  { id: 'q4', question: 'HLER 用什么前置检查大幅提升了实验方案的可行率?', acceptKeywords: ['feasibility', 'dataset'], sourceFile: 'hler-2603.07444.txt' },
  { id: 'q5', question: 'HierFlow 的核心主张是按什么分配预算而不是平摊?', acceptKeywords: ['budget', 'allocation'], sourceFile: 'hierflow-2607.21609.txt' },
  { id: 'q6', question: 'TreeSeeker 消融实验里去掉哪两个操作导致分数明显下降?', acceptKeywords: ['EXPLORE', 'PRUNE'], sourceFile: 'treeseeker-2606.11662.txt' },
  { id: 'q7', question: 'SGH 对 plan 的哪个性质有硬性约束?该约束对哪类任务失效(其自述局限)?', acceptKeywords: ['immutable', 'exploratory'], sourceFile: 'sgh-2604.11378.txt' },
  { id: 'q8', question: 'GraphRAG-bench 那篇里, 简单检索任务上图结构带来的主要成本体现在哪个量的膨胀?', acceptKeywords: ['prompt length', 'token'], sourceFile: 'graphrag-bench-2506.05690.txt' },
];

/**
 * 评分器: answers = {id → 自由文本回答(含出处)}。
 *
 * `hit` 是**官方分**(判据 INV-R2-2 冻结, 一个字没改): 关键词 ∧ 出处 都中才算 1 分。
 *
 * `kwHit` / `srcHit` 是 2026-08-04 加的**分项读数**, 判据本身不动 —— 加它的理由是实测:
 * 总分在 n=3 上**全在噪声里**(同一对同配置两跑 8/8 vs 5/8, 差 3 分; 而当时的臂间均值差
 * 只有 2.67 分), 而同一批跑的**出处分项**却给出了 0/8 → 24/24 的定向变化, 远超噪声。
 * 也就是说: **两个维度捆成一个数会把能看见的信号淹掉**。要判"某次改动有没有效",
 * 分项比总分可靠得多 —— 本程的两个修复正是靠出处分项才判得出来。
 */
export function scoreF2(answers: Record<string, string>): {
  hit: number;
  total: number;
  misses: string[];
  /** 关键词(逐字锚点)命中数。 */
  kwHit: number;
  /** 出处(点对文件名)命中数。 */
  srcHit: number;
} {
  let hit = 0;
  let kwHit = 0;
  let srcHit = 0;
  const misses: string[] = [];
  for (const item of F2_ITEMS) {
    const a = (answers[item.id] ?? '').toLowerCase();
    const kw = item.acceptKeywords.some((k) => a.includes(k.toLowerCase()));
    const src = a.includes(item.sourceFile.toLowerCase().replace('.txt', '')) || a.includes(item.sourceFile.toLowerCase());
    if (kw) kwHit++;
    if (src) srcHit++;
    if (kw && src) hit++;
    else misses.push(`${item.id}: 关键词${kw ? '✓' : '✗'} 出处${src ? '✓' : '✗'}`);
  }
  return { hit, total: F2_ITEMS.length, misses, kwHit, srcHit };
}
