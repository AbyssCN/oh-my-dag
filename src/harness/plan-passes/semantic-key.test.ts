/**
 * semantic-key 测试 —— D-21 Merkle 指纹 + 跨轮复用集 (G-21) + 与 dedup 共享字段序列化。
 */
import { describe, expect, test } from "bun:test";
import type { ConductorPlan } from "../conductor-plan";
import type { LeafResult } from "../dag/types";
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

/**
 * S-43: **基线测量型节点只量一次**(图鉴 `docs/silent-failures.md` S-43)。
 *
 * `expect_exit` 非 0 的节点验的是「**实装前**这条测试会不会红」,而"实装前"按定义在一个 run 里
 * 只存在一次。replan 之后重跑它,不是量得不准 —— 是它要量的那个时刻已经不存在了。
 * run 14b49f79 实盘:轮 1 三条 red 闸全绿(exit 1,证伪成立),impl 熔断前把 244 行实装留在树上,
 * 轮 2 重跑同样的闸读到 exit 0 → 判 `assert-failed` → verifier 据此说「实装未完成」。全错。
 *
 * 为什么它们会被重跑:`nodeFieldsKey` 把 `goal` 入指纹,而 replan 时 conductor 会重写 goal 措辞 →
 * 指纹变 → 复用落空 → 重跑。**指纹机制没坏,坏的是"这类节点可以重测"这个前提。**
 */
describe("computeReuse · S-43 基线测量型节点只量一次", () => {
	const redPlan = plan({
		tests: { goal: "写测试" },
		red: { goal: "证伪: 跑新测试, 必须红", executor: "command", command: "bun test x.test.ts", expect_exit: 1, depends_on: ["tests"] },
		impl: { goal: "实装", depends_on: ["red"] },
	});
	const redResults: Record<string, LeafResult> = {
		tests: done("tests", "测试已写"),
		red: done("red", "exit 1 = 红, 证伪成立"),
		impl: { ...done("impl", "半成品"), status: "failed" },
	};

	test("★ 上轮 done + 命令逐字未变, 但 replan 改写了 goal → 仍复用 (不重跑, 不重测已消失的基线)", () => {
		// 证伪: 删掉 computeReuse 末尾那段 S-43 复用 → 本条红 (reuse.has('red') === false),
		// 读到的正是实盘那个错值 —— 闸被重跑, 而树上已经有实装。
		const next = plan({
			tests: { goal: "写测试" },
			// conductor 重规划惯例:措辞改了,命令一个字没动。
			red: { goal: "证伪(重规划轮): 跑新测试, 必须红", executor: "command", command: "bun test x.test.ts", expect_exit: 1, depends_on: ["tests"] },
			impl: { goal: "实装(补上轮未完成部分)", depends_on: ["red"] },
		});
		const reuse = computeReuse(next, { plan: redPlan, results: redResults });
		expect(reuse.get("red")?.output).toBe("exit 1 = 红, 证伪成立");
		expect(reuse.has("impl")).toBe(false); // 上轮 failed, 照常重跑
	});

	test("命令变了 → 不复用 (旧读数不许冒充新命令的读数)", () => {
		const next = plan({
			tests: { goal: "写测试" },
			red: { goal: "证伪: 跑新测试, 必须红", executor: "command", command: "bun test 另一个.test.ts", expect_exit: 1, depends_on: ["tests"] },
			impl: { goal: "实装", depends_on: ["red"] },
		});
		expect(computeReuse(next, { plan: redPlan, results: redResults }).has("red")).toBe(false);
	});

	test("被 judge 点名 (毒集) → 不复用, 必须重跑 (闸本身写错了那一路)", () => {
		const priorFp = merkleFingerprints(redPlan);
		const next = plan({
			tests: { goal: "写测试" },
			red: { goal: "证伪(重规划轮)", executor: "command", command: "bun test x.test.ts", expect_exit: 1, depends_on: ["tests"] },
			impl: { goal: "实装", depends_on: ["red"] },
		});
		const reuse = computeReuse(next, { plan: redPlan, results: redResults }, new Set([priorFp.get("red")!]));
		expect(reuse.has("red")).toBe(false);
	});

	test("expect_exit 缺席/为 0 的普通节点不吃这条 (规则不外溢)", () => {
		const next = plan({
			tests: { goal: "写测试(措辞改了)" }, // 无 expect_exit → 指纹变就该重跑
			red: { goal: "证伪", executor: "command", command: "bun test x.test.ts", expect_exit: 1, depends_on: ["tests"] },
			impl: { goal: "实装", depends_on: ["red"] },
		});
		expect(computeReuse(next, { plan: redPlan, results: redResults }).has("tests")).toBe(false);
	});
});
