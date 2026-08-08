/**
 * src/tui/render/dag-layers —— **画法 C · 分层依赖**(切片③,v5 第二节的字符网格退化版)。纯函数。
 *
 * 看得见:分层结构 · 依赖边 · fan-in 汇聚点。看不见:时间(那是画法 B 的活)。
 *
 * ## 层从哪来 —— 数据面的实情写在头行
 *
 * `planned` 事件**不带 deps**,只有 `expanded` 的子节点带(dag/types.ts:378-379)。
 * 所以层数 = `分裂深度 + 已知依赖` 能推出的最长链;planned 根节点全在 L0。
 * 这不是 Sugiyama 的完整拓扑 —— 头行写「按分裂/已知依赖分层」,不冒充全量拓扑。
 */
import type { DagSnapshot, TreeNode } from '../components/dag-tree';
import { TREE_MARK } from '../components/dag-tree';
import { fitLine } from './line';

/** 每个节点的层号:`max(父层+1, 已知依赖层+1)`,根 = 0。循环依赖按已算出的值封顶(不死循环)。 */
export function layerOf(nodes: readonly TreeNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const calc = (id: string): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (visiting.has(id)) return 0; // 循环边: 不跟着转圈
    visiting.add(id);
    const n = byId.get(id);
    let layer = 0;
    if (n) {
      if (n.parent && byId.has(n.parent)) layer = Math.max(layer, calc(n.parent) + 1);
      for (const d of n.deps) if (byId.has(d)) layer = Math.max(layer, calc(d) + 1);
    }
    visiting.delete(id);
    memo.set(id, layer);
    return layer;
  };
  for (const n of nodes) calc(n.id);
  return memo;
}

export function renderLayers(snap: DagSnapshot, o: { width: number; height: number }): string[] {
  if (snap.nodes.length === 0) return [];
  const layers = layerOf(snap.nodes);
  const maxLayer = Math.max(...layers.values());
  const out: string[] = [fitLine(`DAG ${snap.runLabel ?? '?'} · 分层依赖(按分裂/已知依赖分层)· ${maxLayer + 1} 层`, o.width)];
  for (let l = 0; l <= maxLayer; l++) {
    const members = snap.nodes.filter((n) => layers.get(n.id) === l);
    out.push(`L${l}`);
    for (const n of members) {
      const deps = n.deps.length > 0 ? `  <- ${n.deps.join(', ')}` : '';
      const fanIn = n.deps.length > 1 ? '  [fan-in]' : '';
      out.push(fitLine(`  ${TREE_MARK[n.status]} ${n.id} (${n.kind})${deps}${fanIn}`, o.width));
    }
  }
  if (out.length > o.height) return [...out.slice(0, Math.max(1, o.height - 1)), `… 还有 ${out.length - o.height + 1} 行`];
  return out;
}
