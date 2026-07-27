/**
 * src/harness/plan-passes/stamp-pass —— pass 管线 ③ stamp: node.model 计划期分配。
 * 契约来源: docs/plan/2026-07-25-dag-engine-fusion-refactor.md (SDD v2) B 节 D-16/17/22 + INV-7/9/11。
 *
 * 管线位置: parsePlan 校验 → ① prune → ② dedup → ③ stamp (本件) → (未来: node-fusion) → 执行。
 * stamp 先于任何融合: 可融判据含「同模型」, 没 stamp 就没判据。
 *
 * 纯函数: 零 IO / 零 logger / 不变异输入 / 零随机 (全确定性 — 同输入逐字段同输出)。
 * pools/familyOf 由接线层从 role-models/auto-assign 注入, 本 pass 不读配置。
 *
 * Invariants:
 *  INV-7  sibling 跨家族分散: 同一消费者下 ≥2 个待 stamp 同档 deps 按 familyOf 轮转 ≥2 家族。
 *  INV-9  零回归: 目标池全空 → 恒等 (一个都不 stamp, 返回原 plan)。
 *  INV-11 链上模型切换最小化: 单消费者链同档继承上游模型; 切换只在 cluster 边界/档位跳变 (D-22)。
 */
import type { ConductorPlan } from "../conductor-plan";
import { topoLevels } from "../executor-dag-planner";
import { rotateFamilies } from "../../model/family-rotate";

/** 四池模型坐标 (接线层注入; 坐标形如 'provider:model', familyOf 给家族)。 */
export interface StampPools {
	strong: string[];
	mid: string[];
	cheap: string[];
	multimodal: string[];
	/**
	 * **强档多模态池** (2026-07-26 owner: "verifier 需要多模态 SOTA 就该用 gpt sol")。
	 * 此前 attach_media 一律走 multimodal 池, tier 被能力约束整个盖掉 —— 于是「判 UI 的裁判」
	 * 永远只能是池里那几个中档模型, `tier:'strong'` 对看图节点是死字。
	 * 现在: attach_media + tier:'strong' 且本池非空 → 走本池; 否则仍走 multimodal。
	 * 空 = 关掉这条分支 (零回归)。
	 */
	multimodalStrong?: string[];
}

type PoolKey = keyof StampPools;

/** 节点的目标池 (key + 坐标列表); null = 本节点不 stamp。 */
type Target = { key: PoolKey; coords: string[] };

export function stampPass(
	plan: ConductorPlan,
	opts: {
		pools: StampPools;
		familyOf: (coord: string) => string;
		/**
		 * 卡是否**真的**钉了模型。省略 = 一律认为钉了 (老行为)。
		 * 为什么需要它: 本 pass 手上没有模板注册表, 早先对「有 template 的节点」一律让路 —— 结果卡上
		 * 没写 model 时该节点既没被 stamp 也没有卡模型, 直接掉到静态 leafModel, **node.tier 被静默丢掉**
		 * (conductor 写 tier:'strong' 是哑弹)。注入这个谓词后只对真钉了模型的卡让路。
		 */
		templateHasModel?: (name: string) => boolean;
	},
): { plan: ConductorPlan; stamped: Record<string, string> } {
	const { pools, familyOf } = opts;
	const ids = Object.keys(plan.nodes);
	const idSet = new Set(ids);
	const stamped: Record<string, string> = {};

	// 拓扑处理序 (Kahn; 幻象 dep 视为已满足, 与执行器同容忍)。
	const order = topoLevels(plan).flat();

	// ① 跳过判定 + ② 档位选池 (D-16/17)。
	const targetOf = (id: string): Target | null => {
		const n = plan.nodes[id]!;
		if (n.model) return null; // 已钉模型 (TPL-3 显式最高优先)
		// 卡真钉了模型才让路; 没钉的卡照常按 tier 选池 (否则 node.tier 是哑弹, 见 templateHasModel 注)。
		if (n.template && (opts.templateHasModel?.(n.template) ?? true)) return null;
		if (n.executor === "command" || n.executor === "map") return null; // 无模型调用 / 运行时展开
		if (n.kind === "primitive") return null; // 原语节点模型由 primitive 层自理
		// 多模态 = 能力硬约束, 优先于 tier 档位偏好 (非多模态模型看不见图)。
		if (n.attach_media === true) {
			// 强档看图节点先看 multimodalStrong (判 UI 的裁判也该能配 SOTA)。
			// **二次审查自动升档** (2026-07-26 owner): 祖先链里已经有过 attach_media 节点 = 这一层是
			// "弱多模态看过之后还要再审" —— 那正是需要真判断的一层, 不该再落回廉价视觉模型。
			// 做成机械规则而不是指望 conductor 记得标 tier: 弱 conductor 漏标的代价是整条证据链降级。
			if ((n.tier === "strong" || hasMediaAncestor(id)) && (pools.multimodalStrong?.length ?? 0) > 0) {
				return { key: "multimodalStrong", coords: pools.multimodalStrong! };
			}
			// ⚠ 回落 mid 是有代价的: mid 主力 mimo-v2.5-pro 实测**没有图像端点** (HTTP 404
			// "No endpoints found that support image input")。多模态池为空时这条会把看图节点送进
			// 一个文本模型 → 节点必然失败。宁可让它失败得响亮, 也不要以为"回落了就没事"。
			return pools.multimodal.length > 0
				? { key: "multimodal", coords: pools.multimodal }
				: { key: "mid", coords: pools.mid }; // D-14v2
		}
		const key: PoolKey = n.tier ?? "mid"; // D-17: tier 显式覆盖, 缺省 mid 地板
		return { key, coords: pools[key] };
	};

	/** 祖先链里是否已有 attach_media 节点 (二次审查判据; 只走 nodes 内的真实边, 幻象 dep 忽略)。 */
	const hasMediaAncestor = (id: string): boolean => {
		const seen = new Set<string>([id]);
		const queue = [...(plan.nodes[id]?.depends_on ?? [])];
		while (queue.length > 0) {
			const cur = queue.pop()!;
			if (!idSet.has(cur) || seen.has(cur)) continue;
			seen.add(cur);
			if (plan.nodes[cur]!.attach_media === true) return true;
			queue.push(...(plan.nodes[cur]!.depends_on ?? []));
		}
		return false;
	};

	// resolved: 节点 → 已定模型 (原有 model + 本 pass 已 stamp)。
	const resolved = new Map<string, string>();
	for (const id of ids) {
		const m = plan.nodes[id]!.model;
		if (m) resolved.set(id, m);
	}
	const assigned = new Set<string>(); // 本 pass 已 stamp 的节点
	const assign = (id: string, coord: string) => {
		resolved.set(id, coord);
		assigned.add(id);
		stamped[id] = coord;
	};

	// 真实消费者索引 (dep → consumers; 只数真实边)。
	const consumersOf = new Map<string, string[]>();
	for (const id of ids) {
		for (const d of plan.nodes[id]!.depends_on ?? []) {
			if (idSet.has(d)) consumersOf.set(d, [...(consumersOf.get(d) ?? []), id]);
		}
	}

	// ④ 链亲和 (D-22/INV-11): 恰 1 真实 dep P + N 是 P 唯一消费者 + P 已定模型 ∈ N 目标池 + cluster 相同
	// → N 继承 P 模型 (provider prompt-cache 命中; 「跨设备 MemCpy」= 换模型 = 冷发全部上下文)。
	const tryChainAffinity = (id: string, t: Target): boolean => {
		const n = plan.nodes[id]!;
		const realDeps = (n.depends_on ?? []).filter((d) => idSet.has(d));
		if (realDeps.length !== 1) return false;
		const p = realDeps[0]!;
		if ((consumersOf.get(p) ?? []).length !== 1) return false; // N 须为 P 唯一消费者
		const pm = resolved.get(p);
		if (!pm || !t.coords.includes(pm)) return false; // 上游模型须 ∈ N 目标池 (同档)
		if (plan.nodes[p]!.cluster !== n.cluster) return false; // cluster 边界允许切换 (双方 undefined = 相同)
		assign(id, pm);
		return true;
	};

	// ⑤ sibling 跨家族分散预分组 (INV-7): 按消费者拓扑序, ≥2 个待 stamp 同档真实 deps 成组;
	// 同一节点被多消费者共享 → 首次 (拓扑序最先的消费者) 胜。
	const spreadGroupOf = new Map<string, { key: PoolKey; members: string[] }>();
	const claimed = new Set<string>();
	for (const c of order) {
		const byPool = new Map<PoolKey, string[]>();
		for (const d of plan.nodes[c]!.depends_on ?? []) {
			if (!idSet.has(d) || claimed.has(d)) continue;
			const t = targetOf(d);
			if (!t || t.coords.length === 0) continue;
			byPool.set(t.key, [...(byPool.get(t.key) ?? []), d]);
		}
		for (const [key, members] of byPool) {
			if (members.length < 2) continue;
			for (const m of members) {
				claimed.add(m);
				spreadGroupOf.set(m, { key, members });
			}
		}
	}

	// familyOf 结果缓存 (纯函数假定, 避免重复调用)。
	const familyCache = new Map<string, string>();
	const fam = (coord: string): string => {
		let f = familyCache.get(coord);
		if (f === undefined) {
			f = familyOf(coord);
			familyCache.set(coord, f);
		}
		return f;
	};

	// ⑥ 全局 per-tier 轮转计数器 (sibling 组未覆盖的其余节点)。
	const counters = new Map<PoolKey, number>();

	// 主循环: 拓扑序逐节点, 规则优先级 ④ 链亲和 > ⑤ sibling 分散 > ⑥ 轮转。
	for (const id of order) {
		if (assigned.has(id)) continue;
		const t = targetOf(id);
		if (!t || t.coords.length === 0) continue; // INV-9: 选中池为空 → 不 stamp
		if (tryChainAffinity(id, t)) continue;

		const g = spreadGroupOf.get(id);
		if (g) {
			// 跨家族散布统一走 rotateFamilies (与 research 同一真源)。链亲和成员优先, 不占轮转槽。
			// 均匀权重下 SWRR ≡ 老 fams[i%len] 轮转 + 家族内游标 → 行为不变 (INV-7)。
			const rotated = rotateFamilies(pools[g.key] ?? [], g.members.length, { familyOf: fam });
			let ri = 0;
			for (const m of g.members) {
				if (assigned.has(m)) continue;
				const mt = targetOf(m)!;
				if (tryChainAffinity(m, mt)) continue;
				assign(m, rotated[ri]!);
				ri++;
			}
			continue;
		}

		const i = counters.get(t.key) ?? 0;
		assign(id, t.coords[i % t.coords.length]!);
		counters.set(t.key, i + 1);
	}

	// INV-9: 零 stamp → 恒等 (返回原 plan 引用)。否则浅拷 nodes, 只替换被 stamp 节点 (输入零变异)。
	if (assigned.size === 0) return { plan, stamped };
	const nodes = { ...plan.nodes };
	for (const id of assigned) nodes[id] = { ...nodes[id]!, model: stamped[id]! };
	return { plan: { ...plan, nodes }, stamped };
}
