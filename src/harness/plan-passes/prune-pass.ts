/**
 * src/harness/plan-passes/prune-pass —— D-2/4v2 死代码消除 (合并 v1 D-2+D-4)。
 * 契约来源: docs/plan/2026-07-25-dag-engine-fusion-refactor.md B 节 D-2/4v2 + INV-9 + G-3。
 *
 * 语义 (声明了才启用, 缺省 = 恒等 pass, 零回归):
 *  ① plan.outputs 未声明或空数组 → 原样返回 (INV-9)。
 *  ② keep 种子 = outputs 里的 id ∪ output_type ∈ {file, git} 节点 ∪ executor:'command' 节点
 *     (file/git = 副作用交付物, command = oracle 闸, 均不可剪)。
 *  ③ keep-set = 种子 + 其全体 depends_on 祖先闭包 (只追 plan.nodes 内存在的 id, 幻象 dep 忽略)。
 *  ④ 新 plan.nodes 只留 keep-set, 其余 id 进 pruned (字典序, 稳定输出); plan 其余字段原样保留。
 *
 * keep-set 对祖先封闭 ⇒ 被剪节点只被其它被剪节点引用, 无悬挂边。
 * 纯函数: 零 IO, 零 logger, 不变异输入 (浅拷贝重建 nodes)。
 */
import type { ConductorPlan } from "../conductor-plan";

/**
 * D-2/4v2 prune pass: 从 plan 剪出不被交付物/副作用/闸需要的死节点。
 * outputs 未声明 → 恒等 (同一对象返回, 零拷贝)。
 */
export function prunePass(plan: ConductorPlan): {
	plan: ConductorPlan;
	pruned: string[];
} {
	// ① INV-9 零回归恒等: 未声明交付物 → 不启用。
	if (!plan.outputs || plan.outputs.length === 0) return { plan, pruned: [] };

	// ② 种子: outputs ∪ file/git 副作用节点 ∪ command oracle 闸节点。
	const keep = new Set<string>();
	for (const id of plan.outputs) {
		// superRefine 已闸 outputs 引用存在性; 运行时仍防御幻象 id (弱模型不可信原则)。
		if (id in plan.nodes) keep.add(id);
	}
	for (const [id, node] of Object.entries(plan.nodes)) {
		if (node.output_type === "file" || node.output_type === "git") keep.add(id);
		if (node.executor === "command") keep.add(id);
	}

	// ③ 祖先闭包: BFS 沿 depends_on 向上, 只追 plan.nodes 内存在的 id (幻象 dep 忽略)。
	const queue = [...keep];
	while (queue.length > 0) {
		const id = queue.pop()!;
		for (const dep of plan.nodes[id]?.depends_on ?? []) {
			if (dep in plan.nodes && !keep.has(dep)) {
				keep.add(dep);
				queue.push(dep);
			}
		}
	}

	// ④ 重建 nodes (浅拷贝, 输入不变异); pruned 字典序稳定输出。
	const nodes: ConductorPlan["nodes"] = {};
	const pruned: string[] = [];
	for (const id of Object.keys(plan.nodes)) {
		if (keep.has(id)) nodes[id] = plan.nodes[id]!;
		else pruned.push(id);
	}
	pruned.sort();
	return { plan: { ...plan, nodes }, pruned };
}
