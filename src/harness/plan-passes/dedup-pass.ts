/**
 * src/harness/plan-passes/dedup-pass —— D-20 语义指纹图内去重 (吸收 TFFInfer GraphNodeSemanticKey)。
 *
 * 契约来源: SDD v2 docs/plan/2026-07-25-dag-engine-fusion-refactor.md §B D-20 + INV-10。
 *  - 指纹对节点 id 重命名不敏感 (id 不入指纹), 对任何语义字段变化敏感 (INV-10)。
 *  - 同指纹组保字典序最小 id, 消费者 depends_on 与 plan.outputs 重定向到保留者。
 *  - executor:'map' 节点不参与 (运行时展开身份复杂, v1 保守)。
 *  - output_path 在指纹内 ⇒ 写不同文件的两个 agent 节点不判重。
 *
 * 纯函数: 零 IO、零 logger、不变异输入 (返回新 plan)。
 */
import type { ConductorPlan } from "../conductor-plan";

type PlanNode = ConductorPlan["nodes"][string];

/** 缺省字段占位 (undefined 与 '' 都归一到这里, 不影响语义区分 —— 弱模型漏填 ≈ 空)。 */
const NONE = "·";

/**
 * 节点语义指纹 (D-20): executor ?? 'leaf' + 全部语义字段 + sorted depends_on (已应用当前 merged)。
 * 对象字段 (output_schema/args/params) 走 JSON.stringify; id 不入指纹。
 */
function fingerprint(node: PlanNode, remap: (id: string) => string): string {
	const deps = (node.depends_on ?? []).map(remap).sort();
	return JSON.stringify([
		node.executor ?? "leaf",
		node.kind ?? NONE,
		node.primitive ?? NONE,
		node.template ?? NONE,
		node.model ?? NONE,
		node.goal ?? NONE,
		node.command ?? NONE,
		node.skill ?? NONE,
		node.output_path ?? NONE,
		node.persona ?? NONE,
		node.creative ?? NONE,
		node.output_schema ? JSON.stringify(node.output_schema) : NONE,
		node.args ? JSON.stringify(node.args) : NONE,
		node.params ? JSON.stringify(node.params) : NONE,
		// SDD v2 调度/分配元数据同为语义字段 (INV-10): tier 决定档位、requires 决定 quorum、
		// attach_media 决定媒体注入、cluster 决定链亲和边界 — 任一不同都不是"同一个工作"。
		node.output_type ?? NONE,
		node.tier ?? NONE,
		node.cluster ?? NONE,
		node.requires ?? NONE,
		node.attach_media ?? NONE,
		node.on_failure ?? NONE,
		node.max_retry ?? NONE,
		node.fallback ?? NONE,
		node.postcondition ? JSON.stringify(node.postcondition) : NONE,
		node.leaf ? JSON.stringify(node.leaf) : NONE,
		deps,
	]);
}

/**
 * 图内去重 (迭代到 fixpoint): 每轮按 id 字典序分组指纹 → 组内保最小 id;
 * 轮末把剩余节点 depends_on 与 plan.outputs 经 merged 重映射 (映射后数组内去重)。
 * 本轮无新 merge → 停; 轮数有界 (每轮至少删 1 节点, ≤节点数)。
 * 传递重复 (A1≡A2, B1 dep A1, B2 dep A2) 在 A 组合并重映射后的下一轮 B 组也合并。
 *
 * @returns merged[被删 id] = 保留 id (链已压缩到最终保留者)。
 */
export function dedupPass(plan: ConductorPlan): {
	plan: ConductorPlan;
	merged: Record<string, string>;
} {
	const merged: Record<string, string> = {};
	/** 跟随 merged 链到最终保留 id (跨轮保留者可能再被更小 id 吸收 → 需压缩)。 */
	const remap = (id: string): string => {
		let cur = id;
		const seen = new Set<string>();
		for (;;) {
			const next = merged[cur];
			if (next === undefined || seen.has(cur)) return cur;
			seen.add(cur);
			cur = next;
		}
	};

	let nodes: Record<string, PlanNode> = { ...plan.nodes };
	for (;;) {
		// map 节点不参与判重, 但保留在图内 (其 deps 照样被重映射)。
		const ids = Object.keys(nodes)
			.filter((id) => nodes[id]!.executor !== "map")
			.sort();
		const byFp = new Map<string, string[]>();
		for (const id of ids) {
			const fp = fingerprint(nodes[id]!, remap);
			const group = byFp.get(fp);
			if (group) group.push(id);
			else byFp.set(fp, [id]);
		}
		let roundMerged = 0;
		for (const group of byFp.values()) {
			if (group.length < 2) continue;
			const keep = group[0]!; // ids 字典序遍历入组 → 组首即最小 id
			for (const dup of group.slice(1)) {
				merged[dup] = keep;
				delete nodes[dup];
				roundMerged++;
			}
		}
		if (roundMerged === 0) break;
		// 轮末: 压缩 merged 链 + 重映射剩余节点 deps (映射后数组内去重)。
		for (const k of Object.keys(merged)) merged[k] = remap(k);
		const next: Record<string, PlanNode> = {};
		for (const [id, node] of Object.entries(nodes)) {
			next[id] = node.depends_on
				? { ...node, depends_on: [...new Set(node.depends_on.map(remap))] }
				: node;
		}
		nodes = next;
	}

	// 零 merge → 恒等 (INV-9 式零回归: 原 plan 原样返回, deps 不做无谓去重)。
	if (Object.keys(merged).length === 0) return { plan, merged };

	const out: ConductorPlan = { ...plan, nodes };
	if (plan.outputs) out.outputs = [...new Set(plan.outputs.map(remap))];
	return { plan: out, merged };
}
