import { describe, expect, test } from "bun:test";
import type { AgentTemplate } from "../agent-templates";
import type { ConductorPlan } from "../conductor-plan";
import { evidencePass } from "./evidence-pass";

// S2 证据闸 (SDD 2026-07-25 skills-compile-evidence-gate)。
// 验收三条 (SDD S2 契约段): 缺尾 plan → 含补挂节点 · 完整 plan → 原样通过 · 无 evidence 卡节点不碰。

const templates = new Map<string, AgentTemplate>([
	["frontend-impl", { name: "frontend-impl", description: "UI 实装", evidence: "ui-pixels", body: "…" }],
	["backend-impl", { name: "backend-impl", description: "后端实装", body: "…" }],
]);

const plan = (nodes: ConductorPlan["nodes"], outputs?: string[]): ConductorPlan =>
	({ name: "t", nodes, ...(outputs ? { outputs } : {}) }) as ConductorPlan;

describe("evidence-pass 命中与补挂", () => {
	test("缺尾 plan → 补挂 [command 渲染 → attach_media 审查] 两节点, 链成立", () => {
		const p = plan({
			ui: { goal: "写落地页", template: "frontend-impl", output_path: "dist/index.html", executor: "agent" },
		});
		const r = evidencePass(p, { templates });
		expect(r.patched).toEqual(["ui-pixel-review", "ui-render"]);

		const render = r.plan.nodes["ui-render"]!;
		expect(render.executor).toBe("command");
		expect(render.command).toContain("omd-render");
		expect(render.command).toContain("dist/index.html");
		expect(render.depends_on).toEqual(["ui"]);

		const review = r.plan.nodes["ui-pixel-review"]!;
		expect(review.attach_media).toBe(true);
		expect(review.depends_on).toEqual(["ui-render"]);

		// 原 plan 不被变异 (纯函数)。
		expect(Object.keys(p.nodes)).toEqual(["ui"]);
	});

	test("完整 plan (conductor 自己画了链) → 原样通过, 零补挂", () => {
		const p = plan({
			ui: { goal: "写落地页", template: "frontend-impl", output_path: "dist/index.html", executor: "agent" },
			shots: { goal: "截图", executor: "command", command: "bun run render.ts", depends_on: ["ui"] },
			judge: { goal: "看像素", attach_media: true, depends_on: ["shots"] },
		});
		const r = evidencePass(p, { templates });
		expect(r.patched).toEqual([]);
		expect(r.plan).toBe(p); // EVD-1 恒等: 同一引用
	});

	test("链可跨中间节点成立 (间接后代也算)", () => {
		const p = plan({
			ui: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" },
			build: { goal: "构建", executor: "command", command: "bun run build", depends_on: ["ui"] },
			shots: { goal: "截图", executor: "command", command: "bun run render.ts", depends_on: ["build"] },
			mid: { goal: "整理", depends_on: ["shots"] },
			judge: { goal: "看像素", attach_media: true, depends_on: ["mid"] },
		});
		expect(evidencePass(p, { templates }).patched).toEqual([]);
	});

	test("有 command 后代但没有 attach_media 尾 → 仍判缺链, 补挂", () => {
		const p = plan({
			ui: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" },
			shots: { goal: "截图", executor: "command", command: "bun run render.ts", depends_on: ["ui"] },
			judge: { goal: "看代码", depends_on: ["shots"] }, // 少了 attach_media
		});
		expect(evidencePass(p, { templates }).patched.length).toBe(2);
	});

	test("有 attach_media 审查但没有 command 渲染步 → 仍判缺链 (代码审查冒充像素证据)", () => {
		const p = plan({
			ui: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" },
			judge: { goal: "看像素", attach_media: true, depends_on: ["ui"] },
		});
		expect(evidencePass(p, { templates }).patched.length).toBe(2);
	});

	test("EVD-2 幂等: 补挂后的 plan 再过一遍 = 恒等", () => {
		const p = plan({
			ui: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" },
		});
		const once = evidencePass(p, { templates });
		const twice = evidencePass(once.plan, { templates });
		expect(twice.patched).toEqual([]);
		expect(twice.plan).toBe(once.plan);
	});

	test("id 撞车 → 补挂 id 加后缀, 不覆盖既有节点", () => {
		const p = plan({
			ui: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" },
			"ui-render": { goal: "无关的同名节点", depends_on: [] },
		});
		const r = evidencePass(p, { templates });
		expect(r.plan.nodes["ui-render"]!.goal).toBe("无关的同名节点");
		expect(r.patched).toContain("ui-render-2");
	});

	test("多个命中节点各自补各自的链", () => {
		const p = plan({
			a: { goal: "页面 A", template: "frontend-impl", output_path: "dist/a.html" },
			b: { goal: "页面 B", template: "frontend-impl", output_path: "dist/b.html" },
		});
		const r = evidencePass(p, { templates });
		expect(r.patched.sort()).toEqual(["a-pixel-review", "a-render", "b-pixel-review", "b-render"]);
		expect(r.plan.nodes["b-render"]!.command).toContain("dist/b.html");
	});
});

describe("evidence-pass 补挂节点复用既有 ui-reviewer 卡", () => {
	test("注册表有 ui-reviewer → 补挂的审查 leaf 挂上它 (别让补挂节点裸奔)", () => {
		const tpls = new Map(templates);
		tpls.set("ui-reviewer", { name: "ui-reviewer", description: "多模态 UI 审查", body: "…" });
		const p = plan({ ui: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" } });
		const r = evidencePass(p, { templates: tpls });
		expect(r.plan.nodes["ui-pixel-review"]!.template).toBe("ui-reviewer");
	});

	test("注册表没有 ui-reviewer → 不挂 template (装饰 fail-open, 不召唤未知卡名)", () => {
		const p = plan({ ui: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" } });
		const r = evidencePass(p, { templates }); // 该 map 里没有 ui-reviewer
		expect(r.plan.nodes["ui-pixel-review"]!.template).toBeUndefined();
	});

	test("attach_media 节点自身不算命中 (防审查节点自噬: 它看像素, 不产像素)", () => {
		const tpls = new Map<string, AgentTemplate>([
			["mm", { name: "mm", description: "看图的卡", evidence: "ui-pixels", body: "…" }],
		]);
		const p = plan({ judge: { goal: "看像素", template: "mm", attach_media: true } });
		const r = evidencePass(p, { templates: tpls });
		expect(r.patched).toEqual([]);
		expect(r.plan).toBe(p);
	});
});

describe("evidence-pass 不越界 (EVD-4/EVD-1)", () => {
	test("无 evidence 卡的节点一个字段不碰, plan 恒等", () => {
		const p = plan({
			api: { goal: "写后端", template: "backend-impl", output_path: "src/api.ts" },
			plain: { goal: "写点啥", output_path: "dist/x.html" }, // 无 template
		});
		const r = evidencePass(p, { templates });
		expect(r.patched).toEqual([]);
		expect(r.plan).toBe(p);
	});

	test("引用了不存在的卡名 → 不命中 (未知卡在 parsePlan 已闸, 此处不重复报错)", () => {
		const p = plan({ x: { goal: "写页面", template: "no-such-card", output_path: "dist/a.html" } });
		expect(evidencePass(p, { templates }).plan).toBe(p);
	});

	test("卡的 evidence 不是 ui-pixels → 不命中", () => {
		const tpls = new Map<string, AgentTemplate>([
			["odd", { name: "odd", description: "x", evidence: "some-other-class", body: "…" }],
		]);
		const p = plan({ x: { goal: "写页面", template: "odd", output_path: "dist/a.html" } });
		expect(evidencePass(p, { templates: tpls }).plan).toBe(p);
	});
});

describe("evidence-pass 拒 plan (EVD-3, 地板不可绕)", () => {
	test("命中卡但无 output_path → 抛错, 错误信息给出修法", () => {
		const p = plan({ ui: { goal: "写页面", template: "frontend-impl" } });
		expect(() => evidencePass(p, { templates })).toThrow(/缺可渲染目标/);
		expect(() => evidencePass(p, { templates })).toThrow(/output_path/);
	});

	test("output_path 不是可渲染后缀 (.ts) → 抛错", () => {
		const p = plan({ ui: { goal: "写组件", template: "frontend-impl", output_path: "src/Btn.tsx" } });
		expect(() => evidencePass(p, { templates })).toThrow(/缺可渲染目标/);
	});
});

describe("evidence-pass D-11 挖矿信号 (只进日志, 不改行为)", () => {
	test("noCardHits = 看着是 UI 活却没引卡的节点", () => {
		const p = plan({
			ui: { goal: "实装登录页面的 component" },
			api: { goal: "写数据库迁移" },
			carded: { goal: "写页面", template: "frontend-impl", output_path: "dist/a.html" },
		});
		const r = evidencePass(p, { templates });
		expect(r.noCardHits).toEqual(["ui"]);
	});

	test("shape 指纹确定性: 同图同串, 加边即变", () => {
		const p1 = plan({ a: { goal: "x" }, b: { goal: "y", executor: "command", command: "ls", depends_on: ["a"] } });
		const p2 = plan({ a: { goal: "x" }, b: { goal: "y", executor: "command", command: "ls", depends_on: ["a"] } });
		expect(evidencePass(p1, { templates }).shape).toBe(evidencePass(p2, { templates }).shape);
		expect(evidencePass(p1, { templates }).shape).toBe("n2/e1/command=1,leaf=1");
	});
});
