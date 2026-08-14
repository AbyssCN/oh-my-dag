/**
 * plan/graph-cycle —— 依赖图找环的**单一真源** (2026-08-14, issue #25 分支)。
 *
 * 此前这段 DFS 只活在 `conductor-expand.ts` 里, 专供运行时子图; 而顶层图的环由
 * `dag/planner.topoLevels` 在 `executePlan` 入口抛错兜住 —— 也就是说**同一件事有两份实现,
 * 且两份的出口完全不同**: 子图是 fail-closed 拒整份并带判词, 顶层是抛一个异常穿出整个 run。
 *
 * 抽出来是为了让第三个消费者 (`PlanSchema` 的 superRefine) 用上同一份: 环在 schema 层就判死,
 * conductor 路径于是走既有的「plan 无效 → 带精确错误重问 conductor」重试环 (有界, maxPlanRetries),
 * 而不是在执行入口抛一个没人接的异常。`topoLevels` 那道保留作兜底 —— 运行期挂进图的子节点
 * (map/conductor 展开) 不过 schema, 那条路仍需要它。
 *
 * 纯函数: 零 IO、零模型、零依赖 (连 ConductorPlan 类型都不 import —— 它反过来 import 本模块,
 * 类型依赖会绕成环)。
 */

/** 找一条环 (DFS 三色)。**图外引用不算边** —— 指向不存在的 id 不构成依赖关系, 环的判定与它无关。 */
export function findGraphCycle(
  nodes: Readonly<Record<string, { depends_on?: readonly string[] } | undefined>>,
): string[] | null {
  const state = new Map<string, 0 | 1 | 2>(); // 0/未访 1/在栈 2/完成
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of nodes[id]?.depends_on ?? []) {
      // 图外引用不是边。⚠ 实测这一行删掉**不改变任何判定** (幽灵 id 没有出边, 走一遍照样返 null) ——
      // 它管的是明确性与一次无谓递归, 别把它当成一道闸 (2026-08-14 反向自检读数, 见测试文件头注)。
      if (!(d in nodes)) continue;
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of Object.keys(nodes)) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}
