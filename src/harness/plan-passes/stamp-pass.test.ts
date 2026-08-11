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
				// SEAT-1 后 tier 必须显式写 —— 没写就不 stamp, 链亲和无从谈起 (见本文件末 SEAT-1 段)。
				B: { goal: "b", depends_on: ["A"], tier: "mid" },
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
				A: { goal: "a", tier: "mid" },
				B: { goal: "b", depends_on: ["A"], tier: "mid" },
				C: { goal: "c", depends_on: ["B"], tier: "mid" },
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
				B: { goal: "b", depends_on: ["A"], cluster: "fe", tier: "mid" },
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
				s1: { goal: "a", tier: "mid" },
				s2: { goal: "b", tier: "mid" },
				s3: { goal: "c", tier: "mid" },
				J: { goal: "judge", depends_on: ["s1", "s2", "s3"], tier: "mid" },
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
		// SEAT-1: 没标 tier 的 d **不再被 stamp** (原先有个"缺省 mid 地板"会盖它) ——
		// 它回落自己 executor 的座位, 由 mcp/assemble:resolveEngineModels 决定。
		expect(out.nodes.d!.model).toBeUndefined();
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

// SEAT-1 (owner 裁 2026-08-11): 座位是唯一真源, stamp 不得覆盖它。
// 病根实测 (run 71356c1c): agent 座位配的是 sonnet-5, 而三个真改文件的 agent 节点全跑成
// mid 池里的 deepseek-v4-flash —— 因为老实现有一句 `n.tier ?? "mid"` 缺省地板, 把**每一个**
// 没标 tier 的节点都从 mid 池盖了模型, 不问 executor。
describe('SEAT-1: 没标 tier 的节点不被 stamp (回落 executor 的座位)', () => {
	const P: StampPools = { strong: ['s:1'], mid: ['m:1'], cheap: ['c:1'], multimodal: [] };
	const f = (c: string): string => c.split(':')[0]!;

	test('agent 节点没标 tier → model 保持 undefined, 不进 stamped', () => {
		// 怎么让它红:把 stamp-pass 的 `if (!n.tier) return null` 换回 `n.tier ?? "mid"` →
		// a 会被盖成 'm:1', 两条断言当场红。(改回来实测过一次)
		const r = stampPass(
			{ name: 'p', nodes: { a: { goal: '改文件', executor: 'agent' } } },
			{ pools: P, familyOf: f },
		);
		expect(r.plan.nodes.a!.model).toBeUndefined();
		expect(r.stamped).toEqual({});
	});

	test('inproc leaf 没标 tier → 同样不被 stamp', () => {
		// 怎么让它红:同上。leaf 与 agent 走的是**两个不同座位**(leaf=量产档 / agent=改文件档),
		// 地板一盖两者就都变成池里那一个坐标 —— 座位表上的区分整个失效。
		const r = stampPass(
			{ name: 'p', nodes: { l: { goal: '生成', executor: 'leaf' } } },
			{ pools: P, familyOf: f },
		);
		expect(r.plan.nodes.l!.model).toBeUndefined();
	});

	test('显式 tier 仍然管用 —— 它表达"有意越档", 不是静默地板', () => {
		// 怎么让它红:把 `if (!n.tier) return null` 写成无条件 `return null` → strong 那条不再被 stamp。
		const r = stampPass(
			{ name: 'p', nodes: { hard: { goal: '难', executor: 'leaf', tier: 'strong' } } },
			{ pools: P, familyOf: f },
		);
		expect(r.plan.nodes.hard!.model).toBe('s:1');
	});

	test('能力约束不受影响:看图节点没标 tier 照样进多模态池', () => {
		// 怎么让它红:把 `if (!n.tier) return null` 提到 attach_media 分支**之前** → 看图节点
		// 拿不到多模态坐标, 会被送进文本模型必然失败 (文件头那条"宁可失败得响亮"的注)。
		const r = stampPass(
			{ name: 'p', nodes: { pic: { goal: '看图', attach_media: true } } },
			{ pools: { ...P, multimodal: ['mm:1'] }, familyOf: f },
		);
		expect(r.plan.nodes.pic!.model).toBe('mm:1');
	});
});
