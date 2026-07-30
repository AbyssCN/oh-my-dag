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
		// ⚠ `agent` (SAMPO roster) 刻意排除: omd executor-dag 不消费它 (按 executor/model 分流,
		// schema 注释明示), 且 conductor 每轮随机指派 → 入键 = 纯噪声, 系统性打空 D-21 跨轮复用
		// (2026-07-25 实证: 重规划 diff 唯一漂移就是 agent)。宿主宏观引擎路径不经本 pass。
		// ⚠ `postcondition` / `leaf` 同 `agent` 一并排除 (2026-07-28 空旋钮全仓扫): 引擎零消费者。
		// postcondition 此前更糟 —— 两个 conductor prompt 都在明示它、还主动指导「对正确性敏感的
		// 节点补 postcondition」, 而没有任何地方检查它 (是"验证"的样子, 不是验证)。明示已撤,
		// zod 层留容忍 (旧 plan 兼容), 但不该再进指纹: 零消费者字段入键 = 纯噪声打空跨轮复用。
		node.executor ?? "leaf",
		node.kind ?? NONE,
		node.primitive ?? NONE,
		node.template ?? NONE,
		node.model ?? NONE,
		node.goal ?? NONE,
		node.command ?? NONE,
		// D-K: expect_exit 是语义 —— 同一条命令期望绿 (0) 与期望红 (1) 是**相反**的验收,
		// 不入键会让 verify-red 与 verify-green 两个节点判重 / 跨轮复用串味。
		node.expect_exit ?? NONE,
		node.skill ?? NONE,
		node.output_path ?? NONE,
		node.persona ?? NONE,
		node.creative ?? NONE,
		node.output_schema ? JSON.stringify(node.output_schema) : NONE,
		node.args ? JSON.stringify(node.args) : NONE,
		node.params ? JSON.stringify(node.params) : NONE,
		node.output_type ?? NONE,
		node.tier ?? NONE,
		// S-T: 推理档入键 —— 但理由要改口 (2026-07-29 实测, `docs/plan/2026-07-29-p2d-empirics.md` 三):
		// 原记述是"不同档 = 不同的执行, 成本与质量都不同"。在**当前主力家族 deepseek 上这是假的**:
		// 200 次配对实测, low 与 high 在输出量 (t=0.84) 与正确率上都读不出差, 而两条同配置臂之间
		// 的差还更大 (t=1.92) —— 官方口径就是 low/medium 等同 high。
		// 仍然入键的理由换成: 档位在**认档的家族** (mimo 词表实测认 low/medium/high) 上确实是语义,
		// 而指纹要对所有家族成立。代价是 deepseek 上两个只差档位的节点白白不判重 —— 可接受:
		// 显式写 thinking 的节点本来就少 (它刻意不进 conductor prompt, 是手写 plan 的逃生口)。
		node.thinking ?? NONE,
		node.cluster ?? NONE,
		node.requires ?? NONE,
		node.attach_media ?? NONE,
		// D-11: max_retry 留在键里是因为它**真影响执行** (重试次数不同 = 不同的执行与成本)。
		// 同批的 on_failure / fallback 已从 schema 删除 —— 它们零消费者却入键 = 纯噪声打空跨轮复用,
		// 与 `agent` 字段被排除的是同一个形态。
		node.max_retry ?? NONE,
		// D-6: research 旋钮是语义 (同问题跑 1 轮 vs 4 轮 = 不同深度的执行, 成本与产出都不同)。
		node.research ? JSON.stringify(node.research) : NONE,
		// map spec 也是语义 (D-21 复用要对 map 节点保守但正确; dedup 层面 map 整节点被排除)。
		node.map ? JSON.stringify(node.map) : NONE,
		// D-B/D-D: conductor 节点的子图硬顶是语义 —— 顶不同 = 允许展开的范围不同 = 不同的执行。
		node.max_nodes ?? NONE,
		// D-A: 内环轮数同理 (跑 1 轮 vs 跑 3 轮 = 不同深度的执行, 成本与产出都不同; 同 research.rounds)。
		node.max_rounds ?? NONE,
		// D-F: 终轮必判也是语义 —— 开了就多一次 judge 调用, 且**产出多一条裁决** (LeafResult.converged),
		// 而调用方拿它当"整体目标成了吗"的答案。判重把两者合成一个 = 悄悄吞掉某一方要的那条裁决。
		node.judge_final ?? NONE,
		// D-Q: detector 是语义 —— 同一个节点开不开检测者协议, 决定它的输出是"一段文字"还是
		// "一份能铸毒票、能让环 BLOCKED 退出的裁决"。判重把两者合成一个 = 吞掉那份裁决 (同 judge_final)。
		node.detector ?? NONE,
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
 *
 * **D-4 毒集 (P1.5)**: `poisoned` 里的指纹一律不入复用池 —— 那是 review/judge 拒过的产出。
 * 状态闸 (`status === 'done'`) 只挡得住"跑挂了"的机器失败; 挡不住"跑完了但产出是错的"。
 * 后者只有 judge 说得出, 故经 DeltaTicket 从外层带进来。
 *
 * **前向闭包是免费的**, 不需要额外 BFS: 毒一个指纹 → 该节点 `hit` 落空 → 其全部下游的
 * `deps.every(check)` 连锁失败 → 自动整条下游重跑。下面那行 `ok = !!hit && deps.every(check)`
 * 就是污染闭包的逆否形式 (研究报告的 `compute_tainted_set` 因此不移植)。
 */
export function computeReuse(
	plan: ConductorPlan,
	prior: { plan: ConductorPlan; results: Record<string, LeafResult> },
	poisoned?: ReadonlySet<string>,
): Map<string, LeafResult> {
	const priorFp = merkleFingerprints(prior.plan);
	// INV-P2-5 制品级毒 (D-12): 被拒节点**写过**的文件是可疑制品; 上一轮**读过**它们的节点,
	// 哪怕自己没被点名、指纹也没变, 一样不入池 —— 它的产出是吃着一份已判为坏的输入做出来的。
	// 为什么现有的前驱闭包兜不住: 闭包顺的是**图上的边**, 而这条读根本没有边 (有边就是普通下游,
	// 早被 `deps.every(check)` 扫掉了)。图外读正是 D-12 的 `filesRead` 让它可见的那条通道。
	const poisonedArtifacts = new Set<string>();
	if (poisoned?.size) {
		for (const [id, f] of priorFp) {
			if (!poisoned.has(f)) continue;
			for (const p of prior.results[id]?.filesTouched ?? []) poisonedArtifacts.add(p);
		}
	}
	const readsPoisoned = (r: LeafResult): boolean =>
		poisonedArtifacts.size > 0 && (r.filesRead ?? []).some((p) => poisonedArtifacts.has(p));
	const priorByFp = new Map<string, LeafResult>();
	for (const [id, f] of priorFp) {
		const r = prior.results[id];
		if (poisoned?.has(f)) continue; // D-4: 被拒产出不入池 (哪怕 status='done')
		if (r && r.status === "done" && !readsPoisoned(r) && !priorByFp.has(f)) priorByFp.set(f, r);
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
