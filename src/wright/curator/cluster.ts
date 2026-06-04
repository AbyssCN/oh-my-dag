/**
 * src/wright/curator/cluster — 通用相似度聚类原语 (Phase 2b: 消除 purify/curate DEDUP duplication)。
 *
 * cosine + 贪心单链聚类。**原住 src/dream/purify.ts, 2026-06-03 抽到 curator 作通用核** —— dream/purify
 * 与 wright/curate 的 DEDUP 曾各持一份逐字相同的聚类逻辑; 现两者都 import 此处。purify 反向消费 curator
 * 原语 = "purify 正成为 curator-adapter" 的迁移方向 (Phase 2b)。纯数学零依赖, 无 import cycle。
 */

/** 两等长向量余弦。任一零范数 → 0。 */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 贪心单链聚类: 对每个向量, 与任一更早的、cos>threshold 的向量归同簇 (并查 root)。
 * 返回簇列表 (每簇 = 原始 index 数组, 保序)。singleton 也作单元素簇返回; 调用方自决如何选 survivor。
 *
 * O(n²) — 与 purify 原实现逐字等价 (PURIFY 证过的聚类不变量)。
 */
export function clusterByCosine(vectors: number[][], threshold: number): number[][] {
  const clusterOf = new Map<number, number>(); // idx → cluster root idx
  for (let i = 0; i < vectors.length; i++) {
    for (let j = 0; j < i; j++) {
      const root = clusterOf.get(j) ?? j;
      if (cosine(vectors[i]!, vectors[j]!) > threshold) {
        clusterOf.set(i, root);
        break;
      }
    }
  }
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < vectors.length; i++) {
    const root = clusterOf.get(i) ?? i;
    const arr = clusters.get(root) ?? [];
    arr.push(i);
    clusters.set(root, arr);
  }
  return [...clusters.values()];
}
