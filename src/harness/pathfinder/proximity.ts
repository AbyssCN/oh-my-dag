/**
 * src/harness/pathfinder/proximity —— 新颖性坍塌判据纯核(r1 片1,契约
 * docs/plan/2026-08-04-r1-novelty-collapse-spec.md)。
 *
 * 谱系:co-scientist 的 proximity 图(embedding→HNSW→Leiden,簇数不增=该收敛)——
 * **降尺度**到本仓设计点(<10k 条,`memory/embed.ts` 头注为证):阈值边 + 并查集连通分量,
 * O(n²) cosine。尺度长过 ~10k 再在 `ProximityOpts.embed`/聚类一处注入位升级。
 *
 * INV-R1-1:确定性零 LLM —— 默认 embed = hashEmbed(确定性词袋投影),同输入恒同簇数。
 * INV-R1-3:输出是建议不是命令 —— 本模块只算数,终止权在引擎的轮数/预算闸。
 *
 * ⚠ 已知边界:hashEmbed 的 tokenizer 按非字母数字切分,**未分词的中文整句会成为单 token**,
 *   中文近似句可能各自成簇(词袋重叠为零)。语义 embed 经 `embed` 注入位替换可解;
 *   threshold 默认 0.60 是词袋空间的初始档(spec 未决:待真图票面标定)。
 */
import { hashEmbed } from '../memory/embed';

export interface ProximityOpts {
  /** 文本 → 向量。默认 hashEmbed(确定性零依赖);语义档在此注入。 */
  embed?: (text: string) => number[];
  /** cosine ≥ threshold 连边。默认 0.60。 */
  threshold?: number;
}

/** cosine 相似度(零向量 → 0,不 NaN)。 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 并查集 find(路径压缩)。 */
function find(parent: number[], x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]!]!;
    x = parent[x]!;
  }
  return x;
}

/**
 * 文本集 → 簇数。阈值边 + 连通分量。
 * 空集 → 0;threshold 高到不可能连边 → n(每条自成一簇,GWT-R1-4 的退化=「全新颖」,不崩)。
 */
export function clusterCount(texts: string[], opts: ProximityOpts = {}): number {
  const embed = opts.embed ?? ((t: string) => hashEmbed(t));
  const threshold = opts.threshold ?? 0.6;
  const n = texts.length;
  if (n === 0) return 0;
  const vecs = texts.map(embed);
  const parent = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosine(vecs[i]!, vecs[j]!) >= threshold) {
        const ri = find(parent, i);
        const rj = find(parent, j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }
  const roots = new Set<number>();
  for (let i = 0; i < n; i++) roots.add(find(parent, i));
  return roots.size;
}

/**
 * C1 用:text 与 candidates 里第一条 cosine ≥ threshold 的下标(无 → null)。
 * 「加入后不产生新簇」⇔「与任一既有条目连边」——单条加入时二者等价,且这版还能报出撞上了谁
 * (INV-S1-4 同族:语义去重也要留痕指向撞上的票)。
 */
export function semanticHit(text: string, candidates: string[], opts: ProximityOpts = {}): number | null {
  const embed = opts.embed ?? ((t: string) => hashEmbed(t));
  const threshold = opts.threshold ?? 0.6;
  const v = embed(text);
  for (let i = 0; i < candidates.length; i++) {
    if (cosine(v, embed(candidates[i]!)) >= threshold) return i;
  }
  return null;
}

/**
 * 坍塌判定(INV-R1-2):簇数序列**最后 k 个增量全部 ≤0** → true。
 * k 默认 2;序列不足 k+1 个观测 → false(单轮不增不算——可能是慢,不是干)。
 *
 * ⚠ spec 的 GWT-R1-2 初版例子 [3,5,5]→true 与 INV-R1-2 自相矛盾(只有一次非增),
 *   实装按 INV(契约赢),spec 例子已勘误为 [3,5,5,5]→true。
 */
export function hasCollapsed(clusterCounts: number[], k = 2): boolean {
  if (k <= 0) return false;
  const n = clusterCounts.length;
  if (n < k + 1) return false;
  for (let i = n - k; i < n; i++) {
    if (clusterCounts[i]! - clusterCounts[i - 1]! > 0) return false;
  }
  return true;
}
