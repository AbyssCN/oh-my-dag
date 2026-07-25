/**
 * semantic-key 测试 —— D-21 Merkle 指纹 + 跨轮复用集 (G-21) + 与 dedup 共享字段序列化。
 */
import { describe, expect, test } from "bun:test";
import type { ConductorPlan } from "../conductor-plan";
import type { LeafResult } from "../executor-dag-types";
import { merkleFingerprints, computeReuse } from "./semantic-key";

const plan = (nodes: ConductorPlan["nodes"]): ConductorPlan => ({ name: "t", nodes });

const done = (id: string, output: string): LeafResult => ({
	id,
	status: "done",
	kind: "inproc",
	output,
	deps: [],
	usage: { in: 1, out: 1 },
});

describe("merkleFingerprints", () => {
	test("id 重命名不改指纹 (语义寻址)", () => {
		const a = plan({ x: { goal: "研究" }, y: { goal: "汇总", depends_on: ["x"] } });
		const b = plan({ n1: { goal: "研究" }, n2: { goal: "汇总", depends_on: ["n1"] } });
		const fa = merkleFingerprints(a);
		const fb = merkleFingerprints(b);
		expect(fa.get("x")).toBe(fb.get("n1")!);
		expect(fa.get("y")).toBe(fb.get("n2")!);
	});

	test("前驱语义变化沿链传播 (Merkle)", () => {
		const a = plan({ x: { goal: "研究 A" }, y: { goal: "汇总", depends_on: ["x"] } });
		const b = plan({ x: { goal: "研究 B" }, y: { goal: "汇总", depends_on: ["x"] } });
		expect(merkleFingerprints(a).get("y")).not.toBe(merkleFingerprints(b).get("y")!);
	});

	test("幻象 dep 留痕不炸", () => {
		const p = plan({ a: { goal: "x", depends_on: ["ghost"] } });
		expect(merkleFingerprints(p).get("a")).toBeDefined();
	});
});

describe("computeReuse (G-21)", () => {
	const priorPlan = plan({
		r1: { goal: "研究甲" },
		r2: { goal: "研究乙" },
		synth: { goal: "汇总", depends_on: ["r1", "r2"] },
	});
	const priorResults: Record<string, LeafResult> = {
		r1: done("r1", "out-r1"),
		r2: done("r2", "out-r2"),
		synth: done("synth", "out-synth"),
	};

	test("重规划 80% 未变: 未变节点全复用, 变化子图不复用", () => {
		// 新 plan: r1/r2 语义同 (id 换名), synth goal 变了。
		const next = plan({
			a1: { goal: "研究甲" },
			a2: { goal: "研究乙" },
			synth2: { goal: "汇总并修复上轮遗漏", depends_on: ["a1", "a2"] },
		});
		const reuse = computeReuse(next, { plan: priorPlan, results: priorResults });
		expect(reuse.get("a1")?.output).toBe("out-r1");
		expect(reuse.get("a2")?.output).toBe("out-r2");
		expect(reuse.has("synth2")).toBe(false);
	});

	test("前驱闭包: 前驱语义变 → 本节点即使字段全同也不复用", () => {
		const next = plan({
			r1: { goal: "研究甲·改" }, // 变了
			r2: { goal: "研究乙" },
			synth: { goal: "汇总", depends_on: ["r1", "r2"] }, // 字段与上轮全同
		});
		const reuse = computeReuse(next, { plan: priorPlan, results: priorResults });
		expect(reuse.has("r1")).toBe(false);
		expect(reuse.get("r2")?.output).toBe("out-r2");
		expect(reuse.has("synth")).toBe(false); // Merkle: 前驱 fp 变 → synth fp 变
	});

	test("上轮 failed/skipped 不入复用池", () => {
		const results: Record<string, LeafResult> = {
			...priorResults,
			r1: { ...done("r1", "x"), status: "failed" },
		};
		const reuse = computeReuse(priorPlan, { plan: priorPlan, results });
		expect(reuse.has("r1")).toBe(false);
		expect(reuse.has("synth")).toBe(false); // 前驱不可复用 → 级联不可复用
		expect(reuse.get("r2")?.output).toBe("out-r2");
	});

	test("全同 plan → 全复用", () => {
		const reuse = computeReuse(priorPlan, { plan: priorPlan, results: priorResults });
		expect(reuse.size).toBe(3);
	});
});
