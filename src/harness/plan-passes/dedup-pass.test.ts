/**
 * dedup-pass 测试 —— D-20 语义指纹图内去重 (契约: SDD v2 D-20 + INV-10)。
 */
import { describe, expect, test } from "bun:test";
import type { ConductorPlan } from "../conductor-plan";
import { dedupPass } from "./dedup-pass";

const plan = (
	nodes: ConductorPlan["nodes"],
	outputs?: string[],
): ConductorPlan => ({
	name: "t",
	nodes,
	...(outputs ? { outputs } : {}),
});

describe("dedupPass (D-20)", () => {
	test("无重复 → 恒等且 merged={}", () => {
		const p = plan({
			a: { goal: "调研 X" },
			b: { goal: "汇总", depends_on: ["a"] },
		});
		const { plan: out, merged } = dedupPass(p);
		expect(merged).toEqual({});
		expect(out).toBe(p); // 零 merge 原样返回 (零回归)
	});

	test("同 goal 同 deps 的两 leaf → 合并, 消费者 deps 重定向且无重复项", () => {
		const p = plan({
			a1: { goal: "调研 X", depends_on: ["seed"] },
			a2: { goal: "调研 X", depends_on: ["seed"] },
			seed: { command: "true", executor: "command" },
			sink: { goal: "汇总", depends_on: ["a1", "a2"] },
		});
		const { plan: out, merged } = dedupPass(p);
		expect(merged).toEqual({ a2: "a1" });
		expect(Object.keys(out.nodes).sort()).toEqual(["a1", "seed", "sink"]);
		// 消费者 depends_on: a2 → a1, 数组内去重。
		expect(out.nodes["sink"]!.depends_on).toEqual(["a1"]);
	});

	test("传递链 A1≡A2, B1(dep A1)≡B2(dep A2) → fixpoint 后 B 组也合并", () => {
		const p = plan({
			a1: { goal: "A" },
			a2: { goal: "A" },
			b1: { goal: "B", depends_on: ["a1"] },
			b2: { goal: "B", depends_on: ["a2"] },
		});
		const { plan: out, merged } = dedupPass(p);
		expect(merged).toEqual({ a2: "a1", b2: "b1" });
		expect(Object.keys(out.nodes).sort()).toEqual(["a1", "b1"]);
	});

	test("仅 output_path 不同 → 不判重 (写不同文件的两 agent 节点)", () => {
		const p = plan({
			w1: { executor: "agent", goal: "写模块", output_path: "src/x.ts" },
			w2: { executor: "agent", goal: "写模块", output_path: "src/y.ts" },
		});
		const { plan: out, merged } = dedupPass(p);
		expect(merged).toEqual({});
		expect(out).toBe(p);
	});

	test("executor:'map' 节点不参与 (v1 保守)", () => {
		const mapSpec = {
			lister: { goal: "列" },
			over: "items",
			itemVar: "it",
			template: { goal: "x" },
		};
		const p = plan({
			m1: { executor: "map", map: mapSpec },
			m2: { executor: "map", map: mapSpec },
		});
		const { plan: out, merged } = dedupPass(p);
		expect(merged).toEqual({});
		expect(out).toBe(p);
	});

	test("plan.outputs 引用被删 id → 重定向到保留 id (并去重)", () => {
		const p = plan(
			{
				a1: { goal: "A" },
				a2: { goal: "A" },
			},
			["a1", "a2"],
		);
		const { plan: out, merged } = dedupPass(p);
		expect(merged).toEqual({ a2: "a1" });
		expect(out.outputs).toEqual(["a1"]);
	});

	test("语义字段不同 (goal/persona/params 任一) → 不判重 (INV-10)", () => {
		const p = plan({
			g1: { goal: "A" },
			g2: { goal: "B" },
			pr1: {
				kind: "primitive",
				primitive: "parallel",
				params: { goals: ["x"] },
			},
			pr2: {
				kind: "primitive",
				primitive: "parallel",
				params: { goals: ["y"] },
			},
			pe1: { goal: "同", persona: "评论家" },
			pe2: { goal: "同", persona: "审计员" },
		});
		const { merged } = dedupPass(p);
		expect(merged).toEqual({});
	});

	test("SDD v2 调度/分配元数据不同 (tier/requires/cluster/attach_media/output_type) → 不判重 (INV-10)", () => {
		const p = plan({
			t1: { goal: "同", tier: "strong" },
			t2: { goal: "同", tier: "cheap" },
			q1: { goal: "quo", depends_on: ["t1", "t2"], requires: "all" },
			q2: { goal: "quo", depends_on: ["t1", "t2"], requires: 1 },
			c1: { goal: "簇", cluster: "fe" },
			c2: { goal: "簇", cluster: "be" },
			m1: { goal: "看", attach_media: true },
			m2: { goal: "看" },
			o1: { goal: "产", output_type: "structured" },
			o2: { goal: "产", output_type: "none" },
		});
		const { merged } = dedupPass(p);
		expect(merged).toEqual({});
	});

	test("缺省 executor 归一为 leaf: 省略 executor 与显式 leaf 同指纹 → 判重", () => {
		const p = plan({
			l1: { goal: "同" },
			l2: { executor: "leaf", goal: "同" },
		});
		const { plan: out, merged } = dedupPass(p);
		expect(merged).toEqual({ l2: "l1" });
		expect(Object.keys(out.nodes)).toEqual(["l1"]);
	});

	test("输入不被变异 (纯函数)", () => {
		const p = plan({
			a1: { goal: "A" },
			a2: { goal: "A" },
			sink: { goal: "S", depends_on: ["a1", "a2"] },
		});
		dedupPass(p);
		expect(p.nodes["sink"]!.depends_on).toEqual(["a1", "a2"]);
		expect(Object.keys(p.nodes).sort()).toEqual(["a1", "a2", "sink"]);
	});
});
