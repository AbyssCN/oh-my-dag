import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTemplate } from "../agent-templates";
import type { ConductorPlan } from "../conductor-plan";
import { stampPass } from "./stamp-pass";
import { triggerPass } from "./trigger-pass";

// C-5 (SDD 2026-08-11 卡与profile分工 D-9/D-10): 触发是**机械的** —— 写集与 glob 相交就补,
// 不看 conductor 有没有想起来标。不相交 → 恒等 (连对象引用都不换)。
//
// 反向自检 (2026-08-12 实跑, 三条各证伪一次):
//  · 把命中判据改成「节点自己声明了 template 才补」(即"conductor 没标就不补") → 测试 1 红;
//  · 删掉 hits.length===0 的 continue (无脑补) → 测试 3 红 (恒等断言 toBe 失败);
//  · 删掉幂等分支 (图上已有该卡也照补) → 测试 4 红 (attached 多出一个)。

const FE_GLOB = "**/*.{tsx,jsx,css,html,vue,svelte}";

const templates = new Map<string, AgentTemplate>([
	["design-review", { name: "design-review", description: "前端设计审核", trigger: { writeSetGlob: FE_GLOB }, body: "…" }],
	["code-reviewer", { name: "code-reviewer", description: "通用代码审查", body: "…" }], // 无 trigger: 永不参与
]);

const plan = (nodes: ConductorPlan["nodes"]): ConductorPlan => ({ name: "t", nodes }) as ConductorPlan;

describe("trigger-pass 机械补挂 (C-5)", () => {
	test("写集命中 glob → 补挂一个引用该卡的审核节点, depends_on = 命中节点", () => {
		const p = plan({
			fe: { goal: "写设置页", executor: "agent", output_path: "web/src/pages/Settings.tsx" },
			be: { goal: "写接口", executor: "agent", output_path: "src/serve/read-api.ts" },
		});
		const r = triggerPass(p, { templates });

		expect(r.attached).toEqual(["design-review-triggered"]);
		const node = r.plan.nodes["design-review-triggered"]!;
		expect(node.template).toBe("design-review");
		expect(node.executor).toBe("agent");
		// 只依赖命中的那个 —— 没命中的后端节点不该被拉进来。
		expect(node.depends_on).toEqual(["fe"]);
		// advisory (O-2): 没有任何既有节点依赖补挂节点 → 它红了也没有下游可级联。
		for (const id of ["fe", "be"]) {
			expect(r.plan.nodes[id]!.depends_on ?? []).not.toContain("design-review-triggered");
		}
		// 纯函数: 原 plan 不被变异 (TRG-3 也顺带验了 —— 既有节点一个字段都没动)。
		expect(Object.keys(p.nodes)).toEqual(["fe", "be"]);
		expect(p.nodes["fe"]).toEqual({ goal: "写设置页", executor: "agent", output_path: "web/src/pages/Settings.tsx" });
	});

	test("写集口径 = write_set ∪ output_path (只认一个就会在另一半图上漏)", () => {
		// 机器画的图基本只有 output_path; 手写图才声明 write_set。两个都要认。
		const viaWriteSet = triggerPass(
			plan({ n: { goal: "改样式", executor: "agent", write_set: ["src/a.ts", "web/src/theme.css"] } }),
			{ templates },
		);
		expect(viaWriteSet.attached).toEqual(["design-review-triggered"]);
		expect(viaWriteSet.plan.nodes["design-review-triggered"]!.depends_on).toEqual(["n"]);

		// 两个都没有 → 不参与判定 (没声明写什么就不猜)。
		const silent = triggerPass(plan({ n: { goal: "只读分析", executor: "leaf" } }), { templates });
		expect(silent.attached).toEqual([]);
	});

	test("TRG-1 写集不相交 → 一个都不补, 且返回**原 plan 引用** (恒等, 不是内容相等)", () => {
		const p = plan({
			be: { goal: "写接口", executor: "agent", output_path: "src/serve/read-api.ts" },
			doc: { goal: "写文档", executor: "agent", output_path: "docs/plan/x.md" },
		});
		const r = triggerPass(p, { templates });
		expect(r.attached).toEqual([]);
		expect(r.plan).toBe(p); // 引用相等: 未改图就不该产生新对象 (下游指纹/缓存靠这条)
	});

	test("TRG-2 幂等: 图上已有该卡的节点 → 不重复补, 但记进 alreadyPresent", () => {
		const p = plan({
			fe: { goal: "写设置页", executor: "agent", output_path: "web/src/pages/Settings.tsx" },
		});
		const once = triggerPass(p, { templates });
		expect(once.attached).toEqual(["design-review-triggered"]);
		expect(once.alreadyPresent).toEqual([]);

		// 补挂后的 plan 再过一遍 = 恒等。
		const twice = triggerPass(once.plan, { templates });
		expect(twice.attached).toEqual([]);
		expect(twice.plan).toBe(once.plan);
		// 「这次没补是因为已经有了」与「因为没命中」分开记 —— 压成同一个空数组事后就分不开。
		expect(twice.alreadyPresent).toEqual(["design-review"]);
	});

	test("无卡带 trigger → 恒等 (词表里全是普通卡时本 pass 是零成本的)", () => {
		const p = plan({ fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" } });
		const noTrigger = new Map([["code-reviewer", templates.get("code-reviewer")!]]);
		const r = triggerPass(p, { templates: noTrigger });
		expect(r.attached).toEqual([]);
		expect(r.plan).toBe(p);
	});

	test("补挂节点挂了同名 profile 且**不写 tier** (D-12 一卡一档 + SEAT-1)", () => {
		const r = triggerPass(plan({ fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" } }), { templates });
		const node = r.plan.nodes["design-review-triggered"]!;
		// 只挂卡不挂档 = 拿 agent 座位的通用模型去跑设计审核, 而档里特意配了能看图的座位。
		expect(node.profile).toBe("design-review");
		// 写 tier 会让 stamp 从池里盖模型、顶掉档里的座位 —— SEAT-1 明令禁止的静默覆盖。
		expect(node.tier).toBeUndefined();
	});

	test("C-6 顺序决定结果: 改图的 pass 排在 stamp 之后, 补挂节点就在 stamp 的视野之外", () => {
		const p = plan({ fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" } });
		const pools = { strong: ["s:strong"], mid: ["s:mid"], cheap: ["s:cheap"], multimodal: ["s:mm"] };
		const stampOpts = { pools, familyOf: (c: string) => c.split(":")[0]!, templateHasModel: () => false };

		// ⚠ SDD 原文把 C-6 写成「补挂节点**带有** stamp 分配的 model」—— 那个前提已被 SEAT-1 推翻:
		// stamp-pass:100 `if (!n.tier) return null`, 无 tier 的节点是**故意**不 stamp 的 (让它回落
		// executor/profile 座位)。而补挂节点正是无 tier 的 (上一条测试钉了)。照原文写这条闸会得到
		// 「两种顺序下 model 都是 undefined」—— 一个在任何干预下都不动的数, 量的是尺子不是被测物。
		// 故改成量真正的不变量: **stamp 能不能看见这个节点**。给它一个显式 tier 让 stamp 的行为可观测。
		const tiered = (src: ConductorPlan): ConductorPlan => {
			const nodes = { ...src.nodes };
			const n = nodes["design-review-triggered"];
			if (n) nodes["design-review-triggered"] = { ...n, tier: "cheap" };
			return { ...src, nodes };
		};

		// 正序 (生产接线) trigger → stamp: 节点在 stamp 之前就存在 → 被盖上模型。
		const right = stampPass(tiered(triggerPass(p, { templates }).plan), stampOpts).plan;
		expect(right.nodes["design-review-triggered"]!.model).toBe("s:cheap");

		// 错序 stamp → trigger: 补挂发生在 stamp 之后 → stamp 从没见过它 → 无模型。
		// 这一半自己就是反向自检: 它成立即证明"错序会坏", 不必再去手改一次生产接线。
		const wrong = tiered(triggerPass(stampPass(p, stampOpts).plan, { templates }).plan);
		expect(wrong.nodes["design-review-triggered"]!.model).toBeUndefined();
	});

	test("C-6 生产接线里 trigger 确实排在 stamp 之前 (钉的是真实顺序, 不是原理)", () => {
		// 上一条证明"顺序决定结果", 这一条证明"我们的顺序是对的" —— 两条缺一条都留着洞:
		// 只证原理 → 接线写反了没人知道; 只证接线 → 有人调换顺序时看不出为什么不能调。
		const src = readFileSync(join(import.meta.dir, "..", "..", "mcp", "assemble.ts"), "utf8");
		const iTrigger = src.indexOf("triggerPass(p,");
		const iStamp = src.indexOf("stampPass(p,");
		expect(iTrigger).toBeGreaterThan(-1); // 接线不见了 → 红 (整条闸没接上也是一种失效)
		expect(iStamp).toBeGreaterThan(-1);
		// 反向自检 (2026-08-12 实跑): 把 assemble.ts 里 trigger 那个 filter 挪到 stamp 之后 →
		//   红,`Expected: < 26687` / `Received: 27347` (字节偏移随文件长度变, 数值本身不是判据)。
		expect(iTrigger).toBeLessThan(iStamp);
	});

	test("id 撞车 → 加后缀, 不覆盖既有节点", () => {
		const p = plan({
			"design-review-triggered": { goal: "同名的既有节点 (无 template)", executor: "command", command: "echo hi" },
			fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" },
		});
		const r = triggerPass(p, { templates });
		expect(r.attached).toEqual(["design-review-triggered-2"]);
		// 既有同名节点原样活着。
		expect(r.plan.nodes["design-review-triggered"]!.command).toBe("echo hi");
	});
});
