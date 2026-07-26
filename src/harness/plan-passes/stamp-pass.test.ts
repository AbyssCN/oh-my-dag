/**
 * stamp-pass 测试 —— 契约: SDD v2 B 节 D-16/17/22 + INV-7/9/11, GWT G-6/G-22。
 * familyOf fake: 坐标冒号前缀作家族 ('kimi:k2' → 'kimi')。
 */
import { describe, expect, it, test } from "bun:test";
import type { ConductorPlan } from "../conductor-plan";
import { stampPass, type StampPools } from "./stamp-pass";

const fam = (coord: string): string => coord.split(":")[0]!;

const pools = (over: Partial<StampPools> = {}): StampPools => ({
	strong: [],
	mid: [],
	cheap: [],
	multimodal: [],
	...over,
});

describe("stamp-pass (D-16/17/22 · INV-7/9/11)", () => {
	it("INV-9: 全空池 → 恒等且 stamped={}", () => {
		const plan: ConductorPlan = {
			name: "p",
			nodes: { a: { goal: "x" }, b: { goal: "y", depends_on: ["a"] } },
		};
		const { plan: out, stamped } = stampPass(plan, {
			pools: pools(),
			familyOf: fam,
		});
		expect(out).toBe(plan); // 恒等 = 同引用
		expect(stamped).toEqual({});
	});

	it("显式 model / template / command / map / primitive 不被覆盖不被 stamp", () => {
		const plan: ConductorPlan = {
			name: "p",
			nodes: {
				hasModel: { goal: "g", model: "x:y" },
				hasTpl: { goal: "g", template: "card" },
				cmd: { executor: "command", command: "echo hi" },
				mp: {
					executor: "map",
					map: {
						lister: { command: "echo []" },
						over: "items",
						itemVar: "it",
						template: { goal: "g" },
					},
				},
				prim: {
					kind: "primitive",
					primitive: "parallel",
					params: { goals: ["g"] },
				},
			},
		};
		const full = pools({
			strong: ["s:1"],
			mid: ["m:1"],
			cheap: ["c:1"],
			multimodal: ["v:1"],
		});
		const { plan: out, stamped } = stampPass(plan, {
			pools: full,
			familyOf: fam,
		});
		expect(stamped).toEqual({});
		expect(out).toBe(plan);
		expect(out.nodes.hasModel!.model).toBe("x:y");
	});

	it("G-22 链亲和: A→B 单消费者同档 → B 继承 A 的模型", () => {
		const mid = ["mimo:m1", "kimi:k2"];
		const plan: ConductorPlan = {
			name: "p",
			nodes: {
				A: { goal: "a", model: "kimi:k2" },
				B: { goal: "b", depends_on: ["A"] },
			},
		};
		const { plan: out, stamped } = stampPass(plan, {
			pools: pools({ mid }),
			familyOf: fam,
		});
		expect(out.nodes.B!.model).toBe("kimi:k2");
		expect(stamped).toEqual({ B: "kimi:k2" });
		expect(plan.nodes.B!.model).toBeUndefined(); // 输入零变异
	});

	it("G-22 链亲和: 本 pass 先 stamp 的上游同样被继承 (INV-11 链上切换最小化)", () => {
		const mid = ["mimo:m1", "kimi:k2"];
		const plan: ConductorPlan = {
			name: "p",
			nodes: {
				A: { goal: "a" },
				B: { goal: "b", depends_on: ["A"] },
				C: { goal: "c", depends_on: ["B"] },
			},
		};
		const { plan: out } = stampPass(plan, {
			pools: pools({ mid }),
			familyOf: fam,
		});
		// A 轮转得 pools.mid[0]; B 继承 A; C 继承 B → 全链同模型
		expect(out.nodes.A!.model).toBe("mimo:m1");
		expect(out.nodes.B!.model).toBe("mimo:m1");
		expect(out.nodes.C!.model).toBe("mimo:m1");
	});

	it("G-22 链亲和: cluster 不同 → 不继承, 走轮转", () => {
		const mid = ["mimo:m1", "kimi:k2"];
		const plan: ConductorPlan = {
			name: "p",
			nodes: {
				A: { goal: "a", model: "kimi:k2", cluster: "be" },
				B: { goal: "b", depends_on: ["A"], cluster: "fe" },
			},
		};
		const { plan: out } = stampPass(plan, {
			pools: pools({ mid }),
			familyOf: fam,
		});
		expect(out.nodes.B!.model).toBe("mimo:m1"); // 轮转 pools.mid[0], ≠ A 的模型
	});

	it("G-6/INV-7: 3 siblings 共一个消费者, pools.mid 含 2 家族 → 分配跨 ≥2 家族", () => {
		const mid = ["kimi:k2", "mimo:m1", "kimi:k3"];
		const plan: ConductorPlan = {
			name: "p",
			nodes: {
				s1: { goal: "a" },
				s2: { goal: "b" },
				s3: { goal: "c" },
				J: { goal: "judge", depends_on: ["s1", "s2", "s3"] },
			},
		};
		const { plan: out, stamped } = stampPass(plan, {
			pools: pools({ mid }),
			familyOf: fam,
		});
		const assigned = [
			out.nodes.s1!.model!,
			out.nodes.s2!.model!,
			out.nodes.s3!.model!,
		];
		expect(new Set(assigned.map(fam)).size).toBeGreaterThanOrEqual(2);
		// 家族轮转序确定性: kimi → mimo → kimi
		expect(assigned).toEqual(["kimi:k2", "mimo:m1", "kimi:k3"]);
		expect(Object.keys(stamped).sort()).toEqual(["J", "s1", "s2", "s3"]);
		expect(out.nodes.J!.model).toBeDefined(); // 消费者走轮转也 stamp
	});

	it("D-14v2: attach_media:true → multimodal 池; 空则回落 mid", () => {
		const plan: ConductorPlan = {
			name: "p",
			nodes: { v: { goal: "see", attach_media: true } },
		};
		const withMm = stampPass(plan, {
			pools: pools({ mid: ["m:1"], multimodal: ["glm:v1"] }),
			familyOf: fam,
		});
		expect(withMm.plan.nodes.v!.model).toBe("glm:v1");
		const noMm = stampPass(plan, {
			pools: pools({ mid: ["m:1"] }),
			familyOf: fam,
		});
		expect(noMm.plan.nodes.v!.model).toBe("m:1");
	});

	it("D-17: tier:'strong' → strong 池", () => {
		const plan: ConductorPlan = {
			name: "p",
			nodes: { s: { goal: "hard", tier: "strong" }, d: { goal: "normal" } },
		};
		const { plan: out } = stampPass(plan, {
			pools: pools({ strong: ["s:1"], mid: ["m:1"] }),
			familyOf: fam,
		});
		expect(out.nodes.s!.model).toBe("s:1");
		expect(out.nodes.d!.model).toBe("m:1"); // 缺省 mid 地板
	});

	it("确定性: 同输入调用两次结果逐字段相同", () => {
		const plan: ConductorPlan = {
			name: "p",
			nodes: {
				a: { goal: "a", tier: "strong" },
				b: { goal: "b", depends_on: ["a"] },
				s1: { goal: "c" },
				s2: { goal: "d" },
				s3: { goal: "e", attach_media: true },
				J: { goal: "j", depends_on: ["s1", "s2", "s3"] },
				cmd: { executor: "command", command: "echo ok" },
			},
		};
		const full = pools({
			strong: ["kimi:k3"],
			mid: ["kimi:k2", "mimo:m1"],
			cheap: ["c:1"],
			multimodal: ["glm:v1"],
		});
		const r1 = stampPass(plan, { pools: full, familyOf: fam });
		const r2 = stampPass(plan, { pools: full, familyOf: fam });
		expect(r1).toEqual(r2);
	});
});

// 2026-07-26: 卡没钉模型时 tier 曾被静默丢掉 (stamp 对所有 template 节点让路 → 掉静态 leafModel)。
describe('template 节点的 tier 不再是哑弹', () => {
	const p4 = { strong: ['s:a'], mid: ['m:a'], cheap: ['c:a'], multimodal: [] };
	const famOf = (c: string) => c.split(':')[0]!;
	const mk = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 't', nodes }) as ConductorPlan;

	test('卡没钉模型 → 照常按 tier 选池', () => {
		const p = mk({ n: { goal: 'g', template: 'plain-card', tier: 'strong' } });
		const r = stampPass(p, { pools: p4, familyOf: famOf, templateHasModel: () => false });
		expect(r.stamped.n).toBe('s:a');
	});

	test('卡钉了模型 → stamp 让路 (卡级路由仍最高优先于池)', () => {
		const p = mk({ n: { goal: 'g', template: 'pinned-card', tier: 'strong' } });
		const r = stampPass(p, { pools: p4, familyOf: famOf, templateHasModel: () => true });
		expect(r.stamped.n).toBeUndefined();
	});

	test('不注入谓词 → 老行为 (一律让路), 零回归', () => {
		const p = mk({ n: { goal: 'g', template: 'x', tier: 'strong' } });
		expect(stampPass(p, { pools: p4, familyOf: famOf }).stamped.n).toBeUndefined();
	});

	test('node.model 显式仍永远赢 (TPL-3)', () => {
		const p = mk({ n: { goal: 'g', template: 'plain-card', tier: 'strong', model: 'x:y' } });
		expect(stampPass(p, { pools: p4, familyOf: famOf, templateHasModel: () => false }).stamped.n).toBeUndefined();
	});
});

// 2026-07-26 owner: "verifier 需要多模态 SOTA 就该用 gpt sol"。此前 attach_media 一律走 multimodal 池,
// tier 被能力约束整个盖掉 —— 判 UI 的裁判永远只能是中档模型。
describe('强档多模态池 (attach_media + tier:strong)', () => {
	const famOf2 = (c: string) => c.split(':')[0]!;
	const mk2 = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 't', nodes }) as ConductorPlan;
	const P = { strong: ['s:a'], mid: ['m:a'], cheap: ['c:a'], multimodal: ['mm:a'], multimodalStrong: ['sota:mm'] };

	test('tier:strong 的看图节点走强档多模态池', () => {
		const r = stampPass(mk2({ n: { goal: 'g', attach_media: true, tier: 'strong' } }), { pools: P, familyOf: famOf2 });
		expect(r.stamped.n).toBe('sota:mm');
	});

	test('没有 tier 的看图节点仍走普通多模态池 (常规像素检查不烧 SOTA)', () => {
		const r = stampPass(mk2({ n: { goal: 'g', attach_media: true } }), { pools: P, familyOf: famOf2 });
		expect(r.stamped.n).toBe('mm:a');
	});

	test('强档多模态池为空 → 回落普通多模态池 (零回归)', () => {
		const pools = { ...P, multimodalStrong: [] };
		const r = stampPass(mk2({ n: { goal: 'g', attach_media: true, tier: 'strong' } }), { pools, familyOf: famOf2 });
		expect(r.stamped.n).toBe('mm:a');
	});

	test('能力约束仍优先于档位: tier:strong 的非看图节点走普通 strong 池', () => {
		const r = stampPass(mk2({ n: { goal: 'g', tier: 'strong' } }), { pools: P, familyOf: famOf2 });
		expect(r.stamped.n).toBe('s:a');
	});
});

// 2026-07-26 owner: "经过了弱多模态模型之后需要审核的节点换成 kimi k3"。
describe('二次多模态审查自动升档', () => {
	const f3 = (c: string) => c.split(':')[0]!;
	const m3 = (nodes: ConductorPlan['nodes']): ConductorPlan => ({ name: 't', nodes }) as ConductorPlan;
	const P3 = { strong: ['s:a'], mid: ['m:a'], cheap: ['c:a'], multimodal: ['mm:cheap'], multimodalStrong: ['k3:strong'] };

	test('第一层看图走廉价视觉模型, 第二层 (祖先里已有看图节点) 自动升强档', () => {
		const r = stampPass(
			m3({
				shots: { goal: '截图', executor: 'command', command: 'bun run render.ts' },
				look1: { goal: '初判像素', attach_media: true, depends_on: ['shots'] },
				look2: { goal: '再审一次', attach_media: true, depends_on: ['look1'] },
			}),
			{ pools: P3, familyOf: f3 },
		);
		expect(r.stamped.look1).toBe('mm:cheap');
		expect(r.stamped.look2).toBe('k3:strong');
	});

	test('隔了中间节点也算祖先 (链路不必直连)', () => {
		const r = stampPass(
			m3({
				look1: { goal: '初判', attach_media: true },
				mid: { goal: '整理', depends_on: ['look1'] },
				look2: { goal: '再审', attach_media: true, depends_on: ['mid'] },
			}),
			{ pools: P3, familyOf: f3 },
		);
		expect(r.stamped.look2).toBe('k3:strong');
	});

	test('强档池为空 → 不升档, 回落普通多模态池 (零回归)', () => {
		const r = stampPass(
			m3({
				look1: { goal: '初判', attach_media: true },
				look2: { goal: '再审', attach_media: true, depends_on: ['look1'] },
			}),
			{ pools: { ...P3, multimodalStrong: [] }, familyOf: f3 },
		);
		expect(r.stamped.look2).toBe('mm:cheap');
	});
});
