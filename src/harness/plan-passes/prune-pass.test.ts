/**
 * src/harness/plan-passes/prune-pass.test —— D-2/4v2 prune pass 契约测试。
 * 契约来源: docs/plan/2026-07-25-dag-engine-fusion-refactor.md B 节 D-2/4v2 + INV-9 + G-3。
 */
import { describe, expect, test } from "bun:test";
import type { ConductorPlan } from "../conductor-plan";
import { prunePass } from "./prune-pass";

/** 构造最小合法 plan 的测试夹具。 */
function makePlan(
	nodes: ConductorPlan["nodes"],
	outputs?: string[],
): ConductorPlan {
	return { name: "t", nodes, ...(outputs === undefined ? {} : { outputs }) };
}

describe("prunePass (D-2/4v2)", () => {
	// G-3: Given outputs 未声明; Then plan 原样 (恒等, INV-9 零回归)。
	test("outputs 未声明 → 恒等且 pruned=[]", () => {
		const plan = makePlan({ A: { goal: "a" }, B: { goal: "b" } });
		const { plan: out, pruned } = prunePass(plan);
		expect(out).toBe(plan); // 同一对象, 零拷贝
		expect(pruned).toEqual([]);
	});

	test("outputs 空数组 → 恒等且 pruned=[]", () => {
		const plan = makePlan({ A: { goal: "a" } }, []);
		const { plan: out, pruned } = prunePass(plan);
		expect(out).toBe(plan);
		expect(pruned).toEqual([]);
	});

	// G-3: Given outputs=[X], 节点 Y 非 X 祖先、非 file/git、非 command; Then Y 剪出, X 及祖先保留。
	test("outputs=[X] → 孤儿 leaf Y 被剪, X 及祖先链保留", () => {
		const plan = makePlan(
			{
				ROOT: { goal: "root" },
				MID: { goal: "mid", depends_on: ["ROOT"] },
				X: { goal: "x", depends_on: ["MID"] },
				Y: { goal: "orphan leaf" },
			},
			["X"],
		);
		const { plan: out, pruned } = prunePass(plan);
		expect(Object.keys(out.nodes).sort()).toEqual(["MID", "ROOT", "X"]);
		expect(pruned).toEqual(["Y"]);
		// passthrough 字段原样保留
		expect(out.name).toBe("t");
		expect(out.outputs).toEqual(["X"]);
	});

	// D-2/4v2: file/git = 副作用交付物, command = oracle 闸, 无消费者也不剪 (含其祖先)。
	test("file 产出节点与 command 节点即使无消费者也不剪 (含祖先)", () => {
		const plan = makePlan(
			{
				SRC: { goal: "src" },
				WRITER: {
					goal: "w",
					executor: "agent",
					output_type: "file",
					output_path: "/tmp/o",
					depends_on: ["SRC"],
				},
				GATE: { executor: "command", command: "bun run typecheck" },
				X: { goal: "x" },
				DEAD: { goal: "dead" },
			},
			["X"],
		);
		const { plan: out, pruned } = prunePass(plan);
		expect(Object.keys(out.nodes).sort()).toEqual([
			"GATE",
			"SRC",
			"WRITER",
			"X",
		]);
		expect(pruned).toEqual(["DEAD"]);
	});

	test("output_type=git 节点同样不可剪", () => {
		const plan = makePlan(
			{
				GIT: { executor: "agent", output_type: "git", goal: "commit" },
				DEAD: { goal: "dead" },
			},
			[],
		);
		// outputs 空数组 → 恒等 (不参与本断言)
		expect(prunePass(plan).pruned).toEqual([]);
		const { pruned } = prunePass(makePlan({ ...plan.nodes }, ["GIT"]));
		expect(pruned).toEqual(["DEAD"]);
	});

	// 幻象 dep (depends_on 引用不存在 id) 不抛错, 直接忽略。
	test("幻象 dep 不抛错", () => {
		const plan = makePlan(
			{
				X: { goal: "x", depends_on: ["GHOST"] },
				DEAD: { goal: "dead", depends_on: ["GHOST2"] },
			},
			["X"],
		);
		const { plan: out, pruned } = prunePass(plan);
		expect(Object.keys(out.nodes)).toEqual(["X"]);
		expect(pruned).toEqual(["DEAD"]);
	});

	// 纯函数契约: 输入不变异。
	test("输入对象未被变异", () => {
		const plan = makePlan(
			{
				X: { goal: "x" },
				Y: { goal: "orphan" },
			},
			["X"],
		);
		prunePass(plan);
		expect(Object.keys(plan.nodes).sort()).toEqual(["X", "Y"]); // 原 plan.nodes 仍含被剪的 Y
	});

	test("pruned 按字典序稳定输出", () => {
		const plan = makePlan(
			{
				X: { goal: "x" },
				zeta: { goal: "z" },
				alpha: { goal: "a" },
				mid: { goal: "m" },
			},
			["X"],
		);
		const { pruned } = prunePass(plan);
		expect(pruned).toEqual(["alpha", "mid", "zeta"]);
	});
});
