import type { ConductorPlan } from './conductor-plan';
import type { ModelUsage } from '../model/gateway';

/**
 * 拓扑分层 (Kahn): level k = 所有依赖都在 level <k 的节点。环 → 抛错 (conductor 应产 DAG)。
 * 未知 dep 引用按"已满足"处理 (宽容, conductor 偶发引用不存在节点不应卡死整图)。
 */
export function topoLevels(plan: ConductorPlan): string[][] {
  const ids = Object.keys(plan.nodes);
  const idSet = new Set(ids);
  const placed = new Set<string>();
  const levels: string[][] = [];
  while (placed.size < ids.length) {
    const layer = ids.filter(
      (id) =>
        !placed.has(id) &&
        (plan.nodes[id]!.depends_on ?? []).every((d) => !idSet.has(d) || placed.has(d)),
    );
    if (layer.length === 0) {
      throw new Error(`executor-dag: dependency cycle among [${ids.filter((i) => !placed.has(i)).join(', ')}]`);
    }
    layer.forEach((id) => placed.add(id));
    levels.push(layer);
  }
  return levels;
}

/** 单个 leaf 的执行 prompt: 节点目标/skill/args + 已完成前驱的输出 (fan-in context)。 */
export function buildLeafPrompt(
  id: string,
  node: ConductorPlan['nodes'][string],
  depResults: Record<string, string>,
): string {
  const parts: string[] = [`[omd leaf: ${id}]`];
  // 专家框定前置 (persona conditioning, 同 fanout 技法): 把弱 executor 拉进专家区。conductor 仅对吃
  // 专家视角的 leaf 设 (research/judgement/design/drafting), 缺省则无 (机械/file/command 节点不需)。
  if (node.persona) parts.push(`<persona>${node.persona}</persona>`);
  if (node.goal) parts.push(`Goal: ${node.goal}`);
  if (node.skill) parts.push(`Skill: ${node.skill}`);
  if (node.args && Object.keys(node.args).length > 0) parts.push(`Args: ${JSON.stringify(node.args)}`);
  const deps = node.depends_on ?? [];
  if (deps.length > 0) {
    const ctx = deps
      .filter((d) => depResults[d] !== undefined)
      .map((d) => `### ${d}\n${depResults[d]}`)
      .join('\n\n');
    if (ctx) parts.push(`Predecessor outputs:\n${ctx}`);
  }
  // 治 meta 碎话 + 省 output (Nick: leaf 不需要太多 output) + 治 genre 塌缩/捏造 (2026-06-03 高并发验证
  // 发现: "设计/拆步" 类任务被 leaf 当成 "执行一遍" 演 + 捏数据填空 → 显式禁止)。
  parts.push(
    "\nProduce this step's deliverable directly. If the goal is to design / describe / analyze / plan / draft, " +
      'OUTPUT that content — do NOT simulate performing the step, and do NOT fabricate data, results, or inputs you ' +
      'were not given. A one-line confirmation is only for when the deliverable actually went to a file/tool. ' +
      'No preamble, no meta-commentary, no restating the inputs. Be concise.',
  );
  return parts.join('\n');
}

/** ModelUsage 累加 (跨 plan/verify 尝试合计成本)。 */
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return { in: a.in + b.in, out: a.out + b.out, cacheHit: (a.cacheHit ?? 0) + (b.cacheHit ?? 0) };
}
