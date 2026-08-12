/**
 * src/harness/plan-passes/trigger-pass —— pass 管线:卡触发的审核补挂 (SDD 2026-08-11 卡与profile分工 D-9/D-10/D-11)。
 *
 * 语义: 卡声明 `trigger: { writeSetGlob }` ⇒ 本次 plan 的写集与该 glob 相交时, 程序化补挂**一个**
 *   引用该卡的审核节点, `depends_on` = 命中的那些节点。不相交 → 一个都不补。
 *
 * **为什么是机械补挂, 不是"让 conductor 记得挑"** (D-9, 有实例支撑):
 * `ui-reviewer` 卡判据完整、写好就摆在词表里, 但**今天是孤儿** —— evidence-pass 明写不补 attach_media
 * 审查 leaf, 于是这张卡能不能上场全看 conductor 这一回记不记得挑它。而"指望 conductor 记得标"正是本仓
 * 反复吃亏的形态: evidence-pass 自己的注释就写着「做成机械规则而不是指望 conductor 记得标 tier」。
 * 一条规则只要有"想起来才生效"的分支, 它的真实覆盖率就不是规则说了算, 是那一发的运气说了算。
 *
 * **advisory 的实现是结构性的, 不是新字段** (O-2 owner 裁: 补挂节点不上关键路径):
 * 补挂节点**不被任何既有节点 depends_on** —— 于是它红了也没有下游可级联, 对图的推进为零影响。
 * 刻意**不**新增 `advisory: true` 之类的 schema 字段: 那要连带改引擎的成败判定, 属于本 SDD 写集之外;
 * 而"没人依赖你"已经把 advisory 这件事表达完整了。
 *
 * **管线位置**: 与 evidence-pass 同规, 排在 **stamp 之前** (D-11)。本 pass 会**新增节点**,
 * 排在 stamp 后补挂的节点拿不到档位模型 → 补了等于白补 (evidence-pass 那条回流修正买来的规则, 推广之)。
 *
 * 纯函数: 零 IO / 零 logger / 不变异输入 (日志在接线层, 同 INV-8)。glob 匹配走 `Bun.Glob` (纯匹配, 不碰盘)。
 *
 * Invariants:
 *  TRG-1 零回归恒等: 无卡带 trigger, 或写集不相交 → 返回**原 plan 引用** (同 EVD-1)。
 *  TRG-2 幂等: 补挂后的 plan 再过一次本 pass = 恒等 (图上已有该卡的节点 → 不重复补)。
 *  TRG-3 不越界: 未命中的节点一个字段都不碰 (只新增节点, 从不改既有节点)。
 *  TRG-4 确定性: 卡按 name 字典序处理, depends_on 按 id 字典序 —— 同输入必得同输出 (指纹可比)。
 */
import type { AgentTemplate } from '../agent-templates';
import type { ConductorPlan } from '../conductor-plan';

type PlanNode = ConductorPlan['nodes'][string];

export interface TriggerPassResult {
	plan: ConductorPlan;
	/** 补挂的节点 id (字典序; 空 = 未改图)。 */
	attached: string[];
	/**
	 * 已命中写集、但**因为图上已有该卡的节点而没补**的卡名 (TRG-2 幂等路径)。
	 * 单独记而不是并进 attached: 「这次没补是因为已经有了」与「这次没补是因为没命中」是两件事,
	 * 压成一个空数组事后就分不开了 (本仓「NULL ≠ 0 ≠ 不适用」那条)。
	 */
	alreadyPresent: string[];
}

/**
 * 卡触发闸。templates = 注册表 (name → 卡), 由接线层注入 (本 pass 不读盘)。
 * 不抛错:补不出来就是不补 —— 审核是 advisory, 没有"补了个假的"这种失败模式要防 (对照 EVD-3)。
 */
export function triggerPass(
	plan: ConductorPlan,
	opts: { templates: Map<string, AgentTemplate> },
): TriggerPassResult {
	// 带 trigger 的卡, 按 name 字典序 (TRG-4)。
	const triggered = [...opts.templates.values()]
		.filter((t): t is AgentTemplate & { trigger: { writeSetGlob: string } } => Boolean(t.trigger?.writeSetGlob))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (triggered.length === 0) return { plan, attached: [], alreadyPresent: [] }; // TRG-1

	const ids = Object.keys(plan.nodes).sort();
	let nodes: ConductorPlan['nodes'] | undefined; // 惰性拷贝: 真要补时才建, 否则保住原引用 (TRG-1)
	const attached: string[] = [];
	const alreadyPresent: string[] = [];

	for (const card of triggered) {
		const glob = new Bun.Glob(card.trigger.writeSetGlob);
		const hits = ids.filter((id) => writeSetOf(plan.nodes[id]!).some((p) => glob.match(p)));
		if (hits.length === 0) continue;
		// TRG-2 幂等: 图上已经有引用这张卡的节点 (conductor 自己挑了, 或上一遍本 pass 补的) → 不重复补。
		if (ids.some((id) => plan.nodes[id]!.template === card.name)) {
			alreadyPresent.push(card.name);
			continue;
		}
		nodes ??= { ...plan.nodes };
		const id = freshId(nodes, `${card.name}-triggered`);
		nodes[id] = {
			goal:
				`按 ${card.name} 卡审核本次写集中命中 ${card.trigger.writeSetGlob} 的产物 (由 trigger-pass 按写集机械补挂, ` +
				`advisory:只报不拦, 无人依赖本节点)。`,
			executor: 'agent',
			template: card.name,
			// D-12 一卡一档: 卡给判据骨架 (进前缀), **同名 profile 给装配位** (seat / tools /
			// outputSchema / ledgerPath —— 都不进前缀)。只挂卡不挂档的话, 这个节点会拿 agent 座位
			// 的通用模型跑设计审核, 而 design-review 档特意配的是能看图的座位 —— 那正是"补了个半拉子"。
			// 同名档不存在时装配点 fail-open (warn-once), 不在这里校验: 本 pass 手上没有档案表。
			profile: card.name,
			// 刻意**不写 tier** (SEAT-1, stamp-pass:100 `if (!n.tier) return null`): 无 tier =
			// 回落 executor 对应的座位, 而座位由上面那个 profile 覆盖。写 tier 反而会让 stamp 从池里
			// 盖一个模型、把档里配的座位顶掉 —— 那是 SEAT-1 明令禁止的静默覆盖。
			depends_on: hits,
			requires: 'all',
		} satisfies PlanNode;
		attached.push(id);
	}

	if (!nodes || attached.length === 0) return { plan, attached: [], alreadyPresent }; // TRG-1 恒等
	attached.sort();
	return { plan: { ...plan, nodes }, attached, alreadyPresent };
}

/**
 * 一个节点的写集 = `write_set` ∪ `output_path`。
 *
 * 两个都取是因为它们各自都不全: `write_set` 是 ex-ante 声明, **刻意没进 conductor prompt**
 * (只收手写 plan 的声明), 所以机器画的图上基本是空的; `output_path` 反过来是 conductor 常写的,
 * 但只表达"主产物"一个。只认前者 → 机器图上这条闸等于没接;只认后者 → 手写图上漏掉多产物节点。
 * 两个都没有 = 这个节点不参与触发判定 (它没声明自己写什么, 猜不出来也不该猜)。
 */
function writeSetOf(node: PlanNode): string[] {
	const out = node.write_set ? [...node.write_set] : [];
	if (node.output_path) out.push(node.output_path);
	return out;
}

/** id 去重 (补挂 id 与既有 id 撞车时加数字后缀)。与 evidence-pass 同款。 */
function freshId(nodes: ConductorPlan['nodes'], base: string): string {
	if (!(base in nodes)) return base;
	for (let i = 2; ; i++) {
		const cand = `${base}-${i}`;
		if (!(cand in nodes)) return cand;
	}
}
