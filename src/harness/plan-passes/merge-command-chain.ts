/**
 * src/harness/plan-passes/merge-command-chain —— #153② 验收尾链机械合并(墙钟杠杆 2 的确定性半)。
 *
 * 事故形状 (issue #153, run 50e48b27): conductor 把验收尾巴画成
 * `gate_types → gate_tests → gate_build` 直线 —— 串行 command 链上跨节点是纯亏:
 * 付全部 fan-in 摘要/重装配代价, 换不回任何并行收益; 且每个节点红都可能各自触发一轮
 * 升级重规划。command 叶本就支持 `a && b` 链 (每环独立判红, command-leaf 既有语义),
 * 所以这条链**机械合并成一条 && 命令节点**是语义保持的: 同样逐环执行、首红即停。
 *
 * 判据 (宁窄勿宽, 条件不满足 = 恒等):
 *  可并节点 = executor:'command' ∧ 有 command ∧ expect_exit 缺省或 0 (verify-red 节点不并,
 *  合并会改「哪一环期望红」的语义) ∧ 非 detector ∧ 无产物声明 (output_path/file) ∧ 无 write_set。
 *  链 = n1→…→nk (k≥2), 其中 n2..nk 的 depends_on 恰为 [前一环], n1..n(k-1) 的消费者恰为
 *  [后一环] 且不在 plan.outputs 里 (中间环被图外引用 = 不并)。
 *  合并入 nk (下游依赖零触碰): command = 逐环 ` && ` 串联, goal 同串, depends_on = n1 的。
 *
 * 含「修」的尾链 (agent 修复节点夹在闸之间) 这里**刻意不碰** —— 那要合成单 agent 内环
 * (查→修→再查), 是规划期形状, 由 conductor prompt 的 acceptance-tail 规则管 (同 issue ②)。
 * 纯函数: 零 IO 零 logger, 不变异输入; 留证由调用方 (applyPlanFilters) 响亮打日志。
 */
import type { ConductorPlan } from '../conductor-plan';

type PlanNode = ConductorPlan['nodes'][string];

/** 可并进 && 链的节点判据 (文件头「判据」节)。 */
function mergeable(n: PlanNode): boolean {
  return (
    n.executor === 'command' &&
    typeof n.command === 'string' &&
    n.command.trim().length > 0 &&
    (n.expect_exit === undefined || n.expect_exit === 0) &&
    n.detector !== true &&
    n.output_type !== 'file' &&
    n.output_type !== 'git' &&
    !n.output_path &&
    (!n.write_set || n.write_set.length === 0)
  );
}

/**
 * 串行 command 链机械合并。无链可并 → 恒等 (同一对象返回, 零拷贝)。
 * merged 每项 = { into: 存活节点 id, absorbed: 被吸收的上游环 id (链序) }。
 */
export function mergeCommandChains(plan: ConductorPlan): {
  plan: ConductorPlan;
  merged: Array<{ into: string; absorbed: string[] }>;
} {
  const nodes = plan.nodes;
  const outputs = new Set(plan.outputs ?? []);
  // 消费者表: id → 依赖它的节点 id 列表。
  const consumers = new Map<string, string[]>();
  for (const [id, n] of Object.entries(nodes)) {
    for (const dep of n.depends_on ?? []) {
      if (dep in nodes) (consumers.get(dep) ?? consumers.set(dep, []).get(dep)!).push(id);
    }
  }
  /** id 是否能当「中间/起始环」被吸收: 可并 ∧ 唯一消费者是 next ∧ 不被图外引用。 */
  const absorbable = (id: string, next: string): boolean => {
    const n = nodes[id];
    const cs = consumers.get(id) ?? [];
    return n !== undefined && mergeable(n) && cs.length === 1 && cs[0] === next && !outputs.has(id);
  };

  // 找链尾: nk 可并, 且 depends_on 恰为一个可吸收的前环。向上回溯到链头。
  const absorbed = new Set<string>();
  const merged: Array<{ into: string; absorbed: string[] }> = [];
  const rewrites = new Map<string, PlanNode>();
  for (const [id, n] of Object.entries(nodes)) {
    if (!mergeable(n)) continue;
    const deps = n.depends_on ?? [];
    const dep0 = deps[0];
    if (deps.length !== 1 || dep0 === undefined || !absorbable(dep0, id)) continue;
    // id 自己若是别的链的中间环, 会被那条链从尾部吸走 —— 只从「不被吸收的尾」起链,
    // 即 id 的消费者里没有能把它吸走的下一环。
    const cs = consumers.get(id) ?? [];
    const nextNode = cs.length === 1 && cs[0] !== undefined ? nodes[cs[0]] : undefined;
    const swallowedByNext =
      nextNode !== undefined && mergeable(nextNode) && (nextNode.depends_on ?? []).length === 1 && !outputs.has(id);
    if (swallowedByNext) continue;
    // 回溯收链: [头 … 尾前一环], 链序。
    const chain: string[] = [];
    let cur = dep0;
    for (;;) {
      chain.unshift(cur);
      const up = nodes[cur]?.depends_on ?? [];
      const up0 = up[0];
      if (up.length === 1 && up0 !== undefined && absorbable(up0, cur)) cur = up0;
      else break;
    }
    for (const c of chain) absorbed.add(c);
    const links = [...chain, id];
    const linkNodes = links.map((l) => nodes[l]).filter((x): x is PlanNode => x !== undefined);
    // C-1: 合并记录挂到存活节点上 (链序, 与 `merged[].absorbed` 同值), 让
    // summarizeResults 不用改签名就拿得到 (D-1)。`absorbed_from` 仅出现在
    // 参与合并的尾节点; 未参与合并的节点不带这一字段 (INV-2, NULL ≠ 0 ≠ 不适用)。
    rewrites.set(id, {
      ...n,
      absorbed_from: chain,
      goal: linkNodes.map((x) => x.goal ?? '').filter(Boolean).join(' && '),
      command: linkNodes.map((x) => (x.command ?? '').trim()).filter(Boolean).join(' && '),
      depends_on: nodes[chain[0]!]?.depends_on ?? [],
    });
    merged.push({ into: id, absorbed: chain });
  }
  if (merged.length === 0) return { plan, merged };

  const nextNodes: Record<string, PlanNode> = {};
  for (const [id, n] of Object.entries(nodes)) {
    if (absorbed.has(id)) continue;
    nextNodes[id] = rewrites.get(id) ?? n;
  }
  return { plan: { ...plan, nodes: nextNodes }, merged };
}
