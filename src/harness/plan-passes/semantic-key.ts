/**
 * src/harness/plan-passes/semantic-key —— 节点语义键的**单一真源** (SDD v2 D-20/D-21, INV-10)。
 *
 * 两个消费方共用同一字段序列化 (改一处两处同步, zod 完备性测试盯住它):
 *  - dedup-pass (D-20): 图内去重 — fieldsKey + remap 后的 dep **id**。
 *  - escalation 跨轮复用 (D-21): Merkle 指纹 — fieldsKey + 前驱**指纹**递归
 *    (对节点 id 重命名不敏感 → 新旧 plan 跨图可匹配)。
 *
 * 纯函数: 零 IO、零 logger、不变异输入。
 */
import type { ConductorPlan } from "../conductor-plan";
import type { LeafResult } from "../executor-dag-types";

type PlanNode = ConductorPlan["nodes"][string];

/** 缺省字段占位 (undefined 与漏填归一 — 弱模型漏填 ≈ 空)。 */
const NONE = "·";

/**
 * 节点**除依赖外**全部语义字段的稳定序列化 (INV-10: 任一语义字段变化都须改变此键)。
 * 字段完备性由 dedup-pass.test 的 zod 内省闸盯住 (schema 加字段而未决定归属 → 测试红)。
 */
export function nodeFieldsKey(node: PlanNode): string {
	return JSON.stringify([
		node.agent ?? NONE,
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
		// map spec 也是语义 (D-21 复用要对 map 节点保守但正确; dedup 层面 map 整节点被排除)。
		node.map ? JSON.stringify(node.map) : NONE,
	]);
}

/**
 * Merkle 语义指纹 (D-21): fp(n) = hash(fieldsKey(n) + sorted(前驱 fp))。
 * id 不入指纹 → 新旧 plan 重命名节点仍可匹配; 幻象 dep (id 不存在) 按占位记入
 * (与执行器「视为已满足」一致但保留其存在痕迹)。返回 id → fp。
 */
export function merkleFingerprints(plan: ConductorPlan): Map<string, string> {
	const fp = new Map<string, string>();
	const visiting = new Set<string>();
	const visit = (id: string): string => {
		const memo = fp.get(id);
		if (memo !== undefined) return memo;
		if (visiting.has(id)) return "∞cycle"; // 环防御 (建图闸之外的纯函数自保)
		visiting.add(id);
		const node = plan.nodes[id]!;
		const depFps = (node.depends_on ?? [])
			.map((d) => (plan.nodes[d] ? visit(d) : `ghost:${d}`))
			.sort();
		const v = Bun.hash(`${nodeFieldsKey(node)}|${depFps.join(",")}`).toString(36);
		visiting.delete(id);
		fp.set(id, v);
		return v;
	};
	for (const id of Object.keys(plan.nodes)) visit(id);
	return fp;
}

/**
 * 跨轮复用集 (D-21/G-21): 新 plan 里「语义指纹与上轮某 **done** 节点匹配, 且全部前驱
 * 也可复用」的节点 → 直接注入上轮输出, 零 LLM。
 * 前驱须同为可复用: 复用的输出是由上轮前驱输出喂出来的 — 新前驱若要重跑 (语义变了),
 * 本节点吃到的输入就变了, 不可复用 (Merkle 匹配保证语义同构, 前驱闭包保证数据一致)。
 * 上轮 failed/skipped 节点不入池 (败果不复用)。
 */
export function computeReuse(
	plan: ConductorPlan,
	prior: { plan: ConductorPlan; results: Record<string, LeafResult> },
): Map<string, LeafResult> {
	const priorFp = merkleFingerprints(prior.plan);
	const priorByFp = new Map<string, LeafResult>();
	for (const [id, f] of priorFp) {
		const r = prior.results[id];
		if (r && r.status === "done" && !priorByFp.has(f)) priorByFp.set(f, r);
	}
	const newFp = merkleFingerprints(plan);
	const reuse = new Map<string, LeafResult>();
	const reusable = new Map<string, boolean>();
	const check = (id: string): boolean => {
		const memo = reusable.get(id);
		if (memo !== undefined) return memo;
		reusable.set(id, false); // 环/自引用防御下界
		const hit = priorByFp.get(newFp.get(id)!);
		const deps = (plan.nodes[id]!.depends_on ?? []).filter((d) => plan.nodes[d]);
		const ok = !!hit && deps.every((d) => check(d));
		reusable.set(id, ok);
		if (ok && hit) reuse.set(id, hit);
		return ok;
	};
	for (const id of Object.keys(plan.nodes)) check(id);
	return reuse;
}
