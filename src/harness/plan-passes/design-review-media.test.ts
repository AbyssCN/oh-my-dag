/**
 * src/harness/plan-passes/design-review-media.test.ts —— D4 (2026-08-25) design-review
 * 补挂带 attach_media 的契约钉死 (D2 视觉通道 SDD, slice 3)。
 *
 * 承接 D3 的 agent 注入实装 (片 2): 补挂的 design-review 节点今天 executor 是 agent, 卡 body
 * 明写「输入 = 截图 + diff」, 没有 attach_media 就是「看不到图的 UI 裁判」 —— 此前盲判绿
 * 是假绿 (engine 静默扔图 → agent leaf 假装跑过)。本文件钉死 attach_media:true 真在补挂节点
 * 上, 让 D3 的注入能落地, 看不见图时 engine.ts:3641 fail-closed 判 failed。
 *
 * **反向自检 / 证伪方式** (各一条, 实跑过):
 *  - GWT-7: 把 `trigger-pass.ts` 里的 `MEDIA_REVIEW_CARDS.has(card.name) ? { attach_media: true as const } : {}`
 *    改成无条件 `attach_media: true` → 补挂了无 trigger 的卡也会带 attach_media (假阴性放大, 见 TRG-5);
 *    改成 `MEDIA_REVIEW_CARDS = new Set()` → GWT-7 直接红 (attach_media 字段缺席)。
 *  - 命中白名单但未命中 writeSetGlob: `fe` 节点 output_path 改 `src/api.ts` → GWT-7 红 (补挂节点不出现)。
 *  - 二次补挂 (TRG-2 幂等): alreadyPresent 路径走时不会重新出现带 attach_media 的节点。
 *
 * 与 `trigger-pass.test.ts` 的分工: 那文件专测 C-5/C-6 主路径 (glob 命中 / 幂等 / 顺序);
 * 本文件只钉 D-4 这一项: 像素依赖卡补挂节点带 attach_media=true, 与白名单外的卡零回归。
 */
import { describe, expect, test } from "bun:test";
import type { AgentTemplate } from "../agent-templates";
import type { ConductorPlan } from "../conductor-plan";
import { triggerPass } from "./trigger-pass";

const FE_GLOB = "**/*.{tsx,jsx,css,html,vue,svelte}";
const BE_GLOB = "**/*.{ts,js,py,go,rs}";

const templates = new Map<string, AgentTemplate>([
	// design-review: 像素依赖卡 (D-4 白名单唯一项, body 写「输入 = 截图 + diff」)。
	["design-review", { name: "design-review", description: "前端设计审核", trigger: { writeSetGlob: FE_GLOB }, body: "…" }],
	// 假想非像素依赖卡 (今日注册表里没有; 用它证伪「无差别 attach_media」= 假阴性放大)。
	["backend-review", { name: "backend-review", description: "后端代码审查", trigger: { writeSetGlob: BE_GLOB }, body: "…" }],
	["code-reviewer", { name: "code-reviewer", description: "通用代码审查", body: "…" }], // 无 trigger: 永不参与
]);

const plan = (nodes: ConductorPlan["nodes"]): ConductorPlan => ({ name: "t", nodes }) as ConductorPlan;

// ── GWT-7: design-review 触发补挂节点带 attach_media === true (INV-5) ───────────
describe("D-4 design-review 补挂带 attach_media (GWT-7, INV-5)", () => {
	test("★ FE 写集命中 design-review → 补挂节点 attach_media === true", () => {
		const r = triggerPass(
			plan({ fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" } }),
			{ templates },
		);
		expect(r.attached).toEqual(["design-review-triggered"]);
		const node = r.plan.nodes["design-review-triggered"]!;
		// 钉死: attach_media 字段存在且 === true (经 D-3 注入落地, 真拿到像素)。
		expect(node.attach_media).toBe(true);
	});

	test("★ 节点其余字段与原 D-12 一卡一档形态保持一致 (profile/template/depends_on/advisory)", () => {
		const r = triggerPass(
			plan({ fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" } }),
			{ templates },
		);
		const node = r.plan.nodes["design-review-triggered"]!;
		expect(node.executor).toBe("agent");
		expect(node.template).toBe("design-review");
		expect(node.profile).toBe("design-review");
		expect(node.depends_on).toEqual(["fe"]);
		expect(node.requires).toBe("all");
		// SEAT-1: 不写 tier (写就让 stamp 盖座位, 静默覆盖)。
		expect(node.tier).toBeUndefined();
		// advisory (O-2): 没有任何既有节点依赖补挂节点 → 它红了也没有下游可级联。
		expect(r.plan.nodes["fe"]!.depends_on ?? []).not.toContain("design-review-triggered");
	});

	test("★ 无图时引擎 fail-closed (GWT-7 旁证): 这里只验证节点字段, 注入行为由 agent-media-injection.test.ts 钉", () => {
		// 注: engine 端 fail-closed 在 engine.ts:3641, 属 engine 护栏 (不在本写集), 此处只验
		// 补挂节点确实把 attach_media 设为 true, 让引擎那条 fail-closed 走得通 (否则 0/0 假阴性)。
		const r = triggerPass(plan({ fe: { goal: "写设置页", executor: "agent", output_path: "web/src/pages/Settings.tsx" } }), { templates });
		expect(r.plan.nodes["design-review-triggered"]!.attach_media).toBe(true);
	});
});

// ── TRG-5 白名单收紧: 非像素依赖卡不放大 attach_media ────────────────────────
describe("TRG-5 白名单 (非像素依赖卡不放大 attach_media)", () => {
	test("后端写集命中 backend-review → 补挂节点 attach_media 缺省 (走 fail-closed 是假阴性)", () => {
		// backend-review 不在 MEDIA_REVIEW_CARDS 白名单 → 不带 attach_media。
		// 设计意图: 后端 review 卡根本不该被前端 diff 触发, 触发是写集口径的活, 不是 attach_media 的活;
		// 若给它加 attach_media, 它在前端 diff 上命中时会因无图走 fail-closed = 假阴性。
		const r = triggerPass(
			plan({ be: { goal: "写接口", executor: "agent", output_path: "src/api.ts" } }),
			{ templates },
		);
		expect(r.attached).toEqual(["backend-review-triggered"]);
		const node = r.plan.nodes["backend-review-triggered"]!;
		expect(node.attach_media).toBeUndefined();
	});

	test("★ 同一 plan 同时触发 design-review + backend-review → 仅 design-review 节点带 attach_media", () => {
		// 极端场景: 一个 plan 既有前端 diff 又有后端 diff, 两个 trigger 卡都被命中。
		// attach_media 必须只在 design-review 节点上, 否则后端 review 卡在同一图里假阴性。
		const r = triggerPass(
			plan({
				fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" },
				be: { goal: "写接口", executor: "agent", output_path: "src/api.ts" },
			}),
			{ templates },
		);
		expect(r.attached.sort()).toEqual(["backend-review-triggered", "design-review-triggered"]);
		expect(r.plan.nodes["design-review-triggered"]!.attach_media).toBe(true);
		expect(r.plan.nodes["backend-review-triggered"]!.attach_media).toBeUndefined();
	});
});

// ── 零回归护栏: TRG-1/TRG-2/TRG-3 与本切片交互的形态 ──────────────────────────
describe("D-4 与既有不变量交互 (TRG-1/TRG-2/TRG-3)", () => {
	test("写集不相交 → 恒等 (TRG-1): 写一个既不命中 FE_GLOB 也不命中 BE_GLOB 的 plan, 无任何补挂", () => {
		// 用一个完全不合任何 glob 的产物 (e.g. .md 文档) → TRG-1 路径。
		const p = plan({ doc: { goal: "写文档", executor: "agent", output_path: "docs/notes.md" } });
		const r = triggerPass(p, { templates });
		expect(r.attached).toEqual([]);
		expect(r.plan).toBe(p); // 引用恒等
		// 既然没补挂, 自然也不可能在某处出现 attach_media: design-review 节点。
		expect(r.plan.nodes["design-review-triggered"]).toBeUndefined();
	});

	test("图上已有该卡节点 (TRG-2 幂等) → 不重复补, alreadyPresent 记录, attach_media 不双写", () => {
		const p = plan({
			fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" },
		});
		const once = triggerPass(p, { templates });
		expect(once.attached).toEqual(["design-review-triggered"]);
		expect(once.plan.nodes["design-review-triggered"]!.attach_media).toBe(true);

		// 第二次跑 = 恒等: 已有的那个节点 attach_media 不变 (不会被抹掉或重写)。
		const twice = triggerPass(once.plan, { templates });
		expect(twice.attached).toEqual([]);
		expect(twice.alreadyPresent).toEqual(["design-review"]);
		expect(twice.plan.nodes["design-review-triggered"]!.attach_media).toBe(true);
	});

	test("纯函数: 原 plan 不被变异 (TRG-3) — 既有节点一个字段都不碰", () => {
		const p = plan({ fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" } });
		const feBefore = p.nodes["fe"];
		triggerPass(p, { templates });
		expect(p.nodes["fe"]).toBe(feBefore); // 同一引用
		expect(p.nodes["fe"]).toEqual({ goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" });
	});

	test("无 trigger 卡 → 恒等 (TRG-1): 只挂 code-reviewer 的 plan 不补挂任何节点, attach_media 不泄露", () => {
		const noTriggerTemplates = new Map<string, AgentTemplate>([
			["code-reviewer", { name: "code-reviewer", description: "通用代码审查", body: "…" }],
		]);
		const p = plan({ fe: { goal: "写页面", executor: "agent", output_path: "web/src/a.tsx" } });
		const r = triggerPass(p, { templates: noTriggerTemplates });
		expect(r.attached).toEqual([]);
		expect(r.plan).toBe(p);
	});
});