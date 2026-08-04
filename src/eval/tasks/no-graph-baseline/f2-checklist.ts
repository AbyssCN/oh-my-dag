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

// ─────────────────────────────────────────────────────────────────────────────
// 第三维: **引文可逐字定位** (2026-08-04 加的新尺 —— 老两维读数照旧分开写)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 任务文本明写「答案要在原文里**可逐字定位**」,而此前评分器**从来没查过这件事** ——
 * 它只查 `acceptKeywords` 子串,那是**逐字接地的代理指标**,不是逐字接地本身。
 * 代理指标的问题在本程实测到了:出处维度饱和后 `总分 ≡ 关键词分`,而关键词维度噪声主导,
 * 于是整把尺失去判别力。这一维直接查真东西:**答案里引的那句话,在它自己声明的那个文件里吗?**
 *
 * 判据(确定性,零 LLM,拿不准不算命中):
 *   · 从答案里抠 ≥20 字符的引号片段(三种引号,同 observers.extractQuotedSpans 的量级);
 *   · 空白归一(原文有换行/多空格,引文往往被压成一行)后做子串比对;
 *   · **只要有一段能在所声明的 sourceFile 里找到** → 该题这一维命中。
 *
 * ⚠ **加这一维必然让数变难看**(它比关键词严格得多)——那正是它有用的原因:
 * 拒绝加尺子才是作弊。读数按「老两维 + 新增维」分开报,别合并。
 */
const normWS = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** 从一段回答里抠够长的引号片段(≥minLen,空白归一后计长)。 */
export function quotedSpans(answer: string, minLen = 20): string[] {
  const out: string[] = [];
  for (const re of [/"([^"\n]+)"/g, /[“]([^”\n]+)[”]/g, /`([^`\n]+)`/g]) {
    for (const m of answer.matchAll(re)) {
      const s = normWS(m[1] ?? '');
      if (s.length >= minLen) out.push(s);
    }
  }
  return out;
}

/**
 * 逐字定位维度评分。`readSource(fileName)` 返回该语料原文;读不到 → 该题**不算命中也不算失败**
 * (记进 `unreadable`,与"引不出来"分开 —— 仓规 NULL ≠ 0 ≠ 不适用)。
 */
export function scoreF2Grounding(
  answers: Record<string, string>,
  readSource: (fileName: string) => string | null,
): { hit: number; total: number; noQuote: string[]; notFound: string[]; unreadable: string[] } {
  let hit = 0;
  const noQuote: string[] = [];
  const notFound: string[] = [];
  const unreadable: string[] = [];
  for (const item of F2_ITEMS) {
    const spans = quotedSpans(answers[item.id] ?? '');
    if (spans.length === 0) {
      noQuote.push(item.id);
      continue;
    }
    const raw = readSource(item.sourceFile);
    if (raw === null) {
      unreadable.push(item.id);
      continue;
    }
    const hay = normWS(raw);
    if (spans.some((s) => hay.includes(s))) hit++;
    else notFound.push(item.id);
  }
  return { hit, total: F2_ITEMS.length, noQuote, notFound, unreadable };
}
