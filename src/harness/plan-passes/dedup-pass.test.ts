/**
 * dedup-pass 测试 —— D-20 语义指纹图内去重 (契约: SDD v2 D-20 + INV-10)。
 */
import { describe, expect, test } from "bun:test";
import { PlanSchema, type ConductorPlan } from "../conductor-plan";
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

	test("指纹对 PlanNode 每个 schema 字段敏感 (INV-10 完备性闸, zod 内省防漏)", () => {
		// 教训 (2026-07-25): dedup 首版指纹漏 tier/requires 等新 schema 字段 — spec 级漏项人审才抓到。
		// 此闸把该错误类变成确定性测试红: schema 加新字段而没在此表决定其指纹归属 → 立即失败。
		const shape = (
			PlanSchema.shape.nodes as unknown as {
				valueType: { shape: Record<string, unknown> };
			}
		).valueType.shape;
		// map = 整节点不参与判重 (D-20 v1 保守), 无指纹归属可言。
		// agent = SAMPO roster 指派, omd executor-dag 不消费且每轮随机 → 刻意排除
		// (入键会系统性打空 D-21 跨轮复用, 见 semantic-key.ts 注)。
		// postcondition / leaf 2026-07-28 加入 (空旋钮全仓扫): 引擎零消费者, 明示已撤, zod 留容忍。
		// 零消费者字段入键 = 纯噪声打空跨轮复用 (与 agent 同一形态)。要重新入键, 先给它一个消费者。
		// content_bytes (g1, 2026-08-04) = 体量**提示** (消费者是规划期的 leaf-tier-gate, 不是执行):
		// 两节点只差体量预估 = 同一件活, 判重合并正确; 入键反而让预估抖动打空 D-21 (同 agent 教训)。
		const EXCLUDED = new Set(["map", "agent", "postcondition", "leaf", "content_bytes"]);
		// 每字段一对「仅此字段不同」的取值 (B 可为 undefined = 字段省略)。
		const pairs: Record<string, [unknown, unknown]> = {
			skill: ["s1", "s2"],
			mcp: [["t"], ["t:poke"]],
			goal: ["g1", "g2"],
			args: [{ a: 1 }, { a: 2 }],
			depends_on: [["d1"], ["d2"]],
			output_type: ["structured", "none"],
			output_path: ["p1", "p2"],
			output_schema: [{ x: 1 }, { x: 2 }],
			executor: ["leaf", "agent"],
			command: ["c1", "c2"],
			expect_exit: [0, 1],
			max_nodes: [4, 8],
			max_rounds: [1, 3],
			judge_final: [true, false],
			// D-Q: 开不开检测者协议决定这个节点的输出是"一段文字"还是"一份能铸毒票 + 让环
			// BLOCKED 退出的裁决" → 语义 (同 judge_final)。
			detector: [true, false],
			kind: ["primitive", undefined],
			primitive: ["parallel", "judge"],
			params: [{ p: 1 }, { p: 2 }],
			creative: [true, false],
			persona: ["评论家", "审计员"],
			template: ["t1", "t2"],
			model: ["m1", "m2"],
			max_retry: [1, 2],
			requires: ["all", 1],
			cluster: ["fe", "be"],
			tier: ["strong", "cheap"],
			attach_media: [true, false],
			write_set: [["a.ts"], ["b.ts"]],
			research: [{ rounds: 1 }, { rounds: 2 }],
			thinking: ["low", "xhigh"],
		};
		for (const key of Object.keys(shape)) {
			if (EXCLUDED.has(key)) continue;
			if (!(key in pairs))
				throw new Error(
					`PlanNode 新字段 "${key}" 无指纹敏感性用例 — 决定它是否语义字段, 补进 dedup 指纹与本表 (INV-10)`,
				);
			const [a, b] = pairs[key]!;
			const p = plan({
				n1: { goal: "base", [key]: a } as ConductorPlan["nodes"][string],
				n2: { goal: "base", [key]: b } as ConductorPlan["nodes"][string],
			});
			const { merged } = dedupPass(p);
			if (Object.keys(merged).length > 0)
				throw new Error(`字段 "${key}" 不同仍被判重 — 指纹漏字段 (INV-10)`);
		}
		// 控制组: 全同 → 判重 (证明上面不是恒 no-merge 的空转断言)。
		const same = dedupPass(
			plan({ n1: { goal: "base" }, n2: { goal: "base" } }),
		);
		expect(same.merged).toEqual({ n2: "n1" });
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
