/**
 * src/harness/plan-passes/evidence-pass —— pass 管线 ③ evidence: 证据链结构闸 (SDD 2026-07-25 S2)。
 * 契约来源: docs/plan/2026-07-25-skills-compile-evidence-gate.md D-2/D-3 + S2 契约段。
 *
 * 语义: 节点引用的 agent 模板卡声明 evidence:'ui-pixels' ⇒ 该节点必须存在后代链
 *   [executor:'command' 渲染节点 → attach_media:true 审查 leaf]。
 * 缺链 → 程序化补挂 (修复优先); 补不出来 (无可渲染目标) → 抛错拒 plan (D-2「地板不可绕」)。
 *
 * **为什么闸只查结构不查语义**: 「这个 command 真的截了图吗」在规划期不可判 (命令串是任意脚本)。
 * 结构闸只保证「有渲染步 + 有看图的尾」; 命令没真打印图片路径这一半由执行期 leaf-media 的
 * MEDIA-2 (解析到但没附上的引用全部留痕) 兜。两层各司其职, 别在这里做启发式猜命令。
 *
 * **管线位置 (对 SDD「planFilters 链尾」的回流修正)**: 实装在 dedup 之后、**stamp 之前**。
 * SDD 写「链尾」时没考虑本 pass 会**新增节点** —— 排在 stamp 后, 补挂的 attach_media 审查 leaf
 * 拿不到 stamp 分配的多模态池模型 (D-14v2 的「非多模态模型看不见图」正是它要防的事), 证据链会
 * 补了等于没补。故: 改图形状的 pass 必须在 stamp 之前。
 *
 * 纯函数: 零 IO / 零 logger / 不变异输入 (日志在接线层, 同 INV-8)。
 *
 * Invariants:
 *  EVD-1 零回归恒等: 无 evidence 卡命中 → 返回原 plan 引用 (同 INV-9)。
 *  EVD-2 幂等: 补挂后的 plan 再过一次本 pass = 恒等 (链已存在 → 不重复补)。
 *  EVD-3 补挂即满足: 补完自检一次, 仍不满足 → 抛错 (拒 plan), 不放行「补了个假的」。
 *  EVD-4 不越界: 无 evidence 卡的节点一个字段都不碰。
 */
import type { AgentTemplate } from "../agent-templates";
import type { ConductorPlan } from "../conductor-plan";

type PlanNode = ConductorPlan["nodes"][string];

/** 本 pass 认识的证据类 (v1 唯一; 词表真源在 agent-templates.KNOWN_EVIDENCE_CLASSES)。 */
const UI_PIXELS = "ui-pixels";

/** 补挂的审查 leaf 复用的内置审查卡名 (注册表里没有就不挂, 见 patchChain)。 */
const UI_REVIEWER_TEMPLATE = "ui-reviewer";

/** 可直接喂给 omd-render 的产物后缀 (静态页); 其余后缀无法当渲染目标。 */
const RENDERABLE_EXT = /\.(html?|htm)$/i;

export interface EvidencePassResult {
	plan: ConductorPlan;
	/** 补挂的节点 id (字典序; 空 = 未改图)。 */
	patched: string[];
	/**
	 * D-11 挖矿信号「无卡命中」: goal 看着是 UI 活、却没引用任何模板卡的节点 id。
	 * 纯日志用 (不改行为) —— S4 卡自扩的前置数据: 哪些活反复出现却没人给它卡。
	 */
	noCardHits: string[];
	/** D-11 图形状指纹 (确定性): 节点数/边数/executor 多重集。与 goal + oracle 结果凑三元组。 */
	shape: string;
}

/**
 * S2 证据闸。templates = 注册表 (name → 卡), 由接线层注入 (本 pass 不读盘)。
 * @throws 命中 evidence 卡但无法补出渲染目标时抛错 (fail-closed 拒 plan)。
 */
export function evidencePass(
	plan: ConductorPlan,
	opts: { templates: Map<string, AgentTemplate> },
): EvidencePassResult {
	const ids = Object.keys(plan.nodes);
	const shape = shapeOf(plan);
	const noCardHits = ids.filter((id) => !plan.nodes[id]!.template && looksLikeUiWork(plan.nodes[id]!)).sort();

	// ① 命中: 引用的卡声明 evidence:'ui-pixels' 的节点 (EVD-4 其余节点不碰)。
	// attach_media 节点排除: 它是**看**像素的一端 (审查 leaf), 不是产 UI 的一端 —— 若也算命中,
	// 补挂的审查节点自己又要一条链, 递归自噬 (卡词表哪天给 ui-reviewer 加 evidence 就会踩到)。
	const hits = ids.filter((id) => {
		const n = plan.nodes[id]!;
		if (n.attach_media === true) return false;
		return n.template !== undefined && opts.templates.get(n.template)?.evidence === UI_PIXELS;
	});
	if (hits.length === 0) return { plan, patched: [], noCardHits, shape }; // EVD-1

	// ② 逐个命中节点验链; 缺链的攒补丁 (EVD-2: 已有链的原样跳过)。
	const nodes: ConductorPlan["nodes"] = { ...plan.nodes };
	const patched: string[] = [];
	for (const id of hits) {
		if (hasEvidenceChain(nodes, id)) continue;
		patched.push(...patchChain(nodes, id, opts.templates.has(UI_REVIEWER_TEMPLATE)));
	}
	if (patched.length === 0) return { plan, patched: [], noCardHits, shape }; // EVD-1 恒等

	// ③ EVD-3 补挂即满足自检: 补完仍缺链 = 补挂逻辑有洞, 宁可拒 plan 也不放行假证据链。
	const next: ConductorPlan = { ...plan, nodes };
	const stillMissing = hits.filter((id) => !hasEvidenceChain(nodes, id));
	if (stillMissing.length > 0) {
		throw new Error(
			`evidence-pass: 补挂后仍缺 ui-pixels 证据链: ${stillMissing.join(", ")} (闸不可绕, 见 SDD S2/D-2)`,
		);
	}
	patched.sort();
	return { plan: next, patched, noCardHits, shape };
}

/**
 * 节点 id 是否已有 [command 渲染后代 → attach_media 审查后代] 链。
 * 只查结构 (见文件头「为什么闸只查结构」): 任一 command 后代 R, 且 R 有 attach_media 后代 ⇒ 成立。
 */
function hasEvidenceChain(nodes: ConductorPlan["nodes"], id: string): boolean {
	for (const r of descendantsOf(nodes, id)) {
		if (nodes[r]!.executor !== "command") continue;
		for (const v of descendantsOf(nodes, r)) {
			if (nodes[v]!.attach_media === true) return true;
		}
	}
	return false;
}

/** 传递闭包: 所有 (直接/间接) 依赖 id 的节点。幻象 dep 自然被忽略 (只走 nodes 内的边)。 */
function descendantsOf(nodes: ConductorPlan["nodes"], id: string): string[] {
	const out = new Set<string>();
	const queue = [id];
	while (queue.length > 0) {
		const cur = queue.pop()!;
		for (const [nid, n] of Object.entries(nodes)) {
			if (out.has(nid) || nid === id) continue;
			if ((n.depends_on ?? []).includes(cur)) {
				out.add(nid);
				queue.push(nid);
			}
		}
	}
	return [...out];
}

/**
 * 给节点 id 补 [渲染 command → attach_media 审查 leaf] 两节点, 就地写进 nodes, 返回新 id。
 * 渲染目标取该节点声明的 output_path (须是可渲染后缀) —— 取不到就没有可截图的东西,
 * 抛错拒 plan (D-2: 采集是地板; 与其挂一个必然失败的命令假装有证据链, 不如让 owner/conductor 补 output_path)。
 */
function patchChain(nodes: ConductorPlan["nodes"], id: string, hasUiReviewer: boolean): string[] {
	const node = nodes[id]!;
	const target = node.output_path;
	if (!target || !RENDERABLE_EXT.test(target)) {
		throw new Error(
			`evidence-pass: 节点 '${id}' 的卡声明 evidence:'${UI_PIXELS}' 但缺可渲染目标 ` +
				`(output_path=${target ?? "(未声明)"}) —— 补不出渲染步。修法: 给该节点声明 .html 产物的 output_path, ` +
				`或显式画出 [executor:'command' 渲染节点 → attach_media:true 审查 leaf] 后代链。`,
		);
	}
	const renderId = freshId(nodes, `${id}-render`);
	const reviewId = freshId(nodes, `${id}-pixel-review`);
	const renderNode: PlanNode = {
		goal: `渲染 ${target} 截图, 打印产物图片路径 (证据采集步, 由 evidence-pass 补挂)`,
		executor: "command",
		command: `bun run scripts/omd-render.ts ${target} --out .omd/render/${renderId}`,
		depends_on: [id],
	};
	const reviewNode: PlanNode = {
		goal:
			`看 ${target} 的真实像素 (层级/间距/状态), 判它是否达到交付标准; ` +
			`只依据截图判断, 不复述代码 (证据审查步, 由 evidence-pass 补挂)`,
		// 复用既有 ui-reviewer 卡的审查清单 (层级/布局/可读性/状态/一致性/slop), 别让补挂节点裸奔。
		// 注册表里没有这张卡时不挂 (执行期 TPL-2 会拒未知卡名) —— 装饰 fail-open, 链本身仍 fail-closed。
		...(hasUiReviewer ? { template: UI_REVIEWER_TEMPLATE } : {}),
		attach_media: true,
		depends_on: [renderId],
		requires: "all",
	};
	nodes[renderId] = renderNode;
	nodes[reviewId] = reviewNode;
	return [renderId, reviewId];
}

/** id 去重 (补挂 id 与既有 id 撞车时加数字后缀)。 */
function freshId(nodes: ConductorPlan["nodes"], base: string): string {
	if (!(base in nodes)) return base;
	for (let i = 2; ; i++) {
		const cand = `${base}-${i}`;
		if (!(cand in nodes)) return cand;
	}
}

/** D-11 挖矿信号: goal/id 看着是 UI 活 (纯启发式, 只进日志不改行为)。 */
function looksLikeUiWork(node: PlanNode): boolean {
	const text = `${node.goal ?? ""} ${node.output_path ?? ""}`;
	return /\b(ui|ux|html|css|component|page|frontend|screenshot|视觉|界面|页面|组件|前端)\b/i.test(text);
}

/** D-11 图形状指纹 (确定性, 与 goal + oracle 结果凑三元组喂 S4 挖矿)。 */
function shapeOf(plan: ConductorPlan): string {
	const ids = Object.keys(plan.nodes);
	const edges = ids.reduce((n, id) => n + (plan.nodes[id]!.depends_on ?? []).length, 0);
	const kinds = new Map<string, number>();
	for (const id of ids) {
		const n = plan.nodes[id]!;
		const k = n.kind === "primitive" ? `primitive:${n.primitive ?? "?"}` : (n.executor ?? "leaf");
		kinds.set(k, (kinds.get(k) ?? 0) + 1);
	}
	const kindStr = [...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => `${k}=${c}`).join(",");
	return `n${ids.length}/e${edges}/${kindStr}`;
}
