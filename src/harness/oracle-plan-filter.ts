/**
 * src/harness/oracle-plan-filter —— plan 内 command 节点与 oracle-cmd 等价或被其包含时过滤。
 *
 * conductor 规划的 plan 常含一个 "verify" command 节点 (如 "bun run typecheck && bun test"),
 * 与 oracle 已跑过的命令完全等价或为其子集 → 重跑 = 浪费 token + 时间。本模块在 plan 落地后、执行前移除这些节点。
 *
 * 过滤判定: 空白规范化后, command 与 oracle 相等 OR oracle 包含 command (command 是 oracle 子串)。
 * 注意: command 包含 oracle (command 是超集) 时不过滤 — conductor 额外加了步骤, 保留。
 *
 * 连通性策略 (最小无害边重连): 被删节点的下游 depends_on 重接到被删节点的父依赖;
 * 若被删节点无父依赖, 下游直接去掉该依赖 (变根)。选型理由: 保留下游节点的数据依赖拓扑,
 * 仅跳过中间的 oracle 等价/子集节点, 不引入新边也不改变语义顺序。
 */
import type { ConductorPlan } from './conductor-plan';

/** 规范化空白: 去首尾, 连续空白压成单空格。 */
function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * 移除 plan 中 command 与 oracleCmd 等价或被其包含 (空白规范化后) 的节点。
 * 下游 depends_on 重接到被删节点的父依赖 (最小无害边重连)。
 */
export function filterOracleCommandNodes(plan: ConductorPlan, oracleCmd: string): ConductorPlan {
  const normalizedOracle = normalizeWhitespace(oracleCmd);
  const ids = Object.keys(plan.nodes);
  const removeIds = new Set<string>();

  for (const id of ids) {
    const node = plan.nodes[id]!;
    if (node.executor === 'command' && node.command) {
      const normalizedCmd = normalizeWhitespace(node.command);
      if (normalizedCmd === normalizedOracle || normalizedOracle.includes(normalizedCmd)) {
        removeIds.add(id);
      }
    }
  }

  if (removeIds.size === 0) return plan;

  // 收集被删节点的上游 (用于重连下游)
  const parentsOf = (id: string): string[] =>
    (plan.nodes[id]?.depends_on ?? []).filter((d) => !removeIds.has(d));

  // 重连: 下游的 depends_on 中, 被删 id 替换为其父依赖
  const newNodes: typeof plan.nodes = {};
  for (const id of ids) {
    if (removeIds.has(id)) continue;
    const node = plan.nodes[id]!;
    const deps = node.depends_on ?? [];
    const hasRemovedDep = deps.some((d) => removeIds.has(d));
    if (!hasRemovedDep) {
      newNodes[id] = node;
      continue;
    }
    // 展开: 被删 dep → 其父依赖, 保留非被删 dep, 去重
    const expanded: string[] = [];
    const seen = new Set<string>();
    for (const dep of deps) {
      if (removeIds.has(dep)) {
        for (const p of parentsOf(dep)) {
          if (!seen.has(p)) { seen.add(p); expanded.push(p); }
        }
      } else {
        if (!seen.has(dep)) { seen.add(dep); expanded.push(dep); }
      }
    }
    newNodes[id] = { ...node, depends_on: expanded.length > 0 ? expanded : undefined };
  }

  return { ...plan, nodes: newNodes };
}
