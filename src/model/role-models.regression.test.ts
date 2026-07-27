/**
 * role-models regression tests — INV-4 / G-2: per-node snapshot.
 *
 * Verifies that resolveRoleModelConfigured(node) with no env and no auto-assign
 * returns the EXACT same coord as the hardcoded default (NODE_DEFAULT_COORD).
 * Any change here = deliberate (not accidental drift).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NODE_DEFAULT_COORD,
	NODE_TIER,
	persistAutoAssigned,
	resetConfigCache,
	resolveRoleModelConfigured,
} from "./role-models";

/** All 14 D-2 omd nodes. */
const ALL_NODES = [
	"conductor",
	"escalation",
	"judge",
	"reason",
	"reduce",
	"leaf",
	"agent",
	"lens",
	"expand",
	"distill",
	"overflow",
	"verifier",
	"review-spec",
	"dream",
] as const;

describe("resolveRoleModelConfigured — regression snapshots (INV-4, G-2)", () => {
	for (const node of ALL_NODES) {
		test(`${node} → ${NODE_DEFAULT_COORD[node]} (tier: ${NODE_TIER[node]})`, () => {
			const result = resolveRoleModelConfigured(node, {
				env: {}, // empty env → no env hit
				modelsMap: {}, // hermetic: 不读真 .omd/config.json models 段
				autoAssignMap: {}, // explicit empty = no auto-assign (hermetic: 不读真 .omd/config.json)
			});
			expect(result.model).toBe(NODE_DEFAULT_COORD[node]);
			expect(result.source).toBe("default");
		});
	}
});

describe("resolveRoleModelConfigured — priority chain", () => {
	test("explicit overrides everything", () => {
		const result = resolveRoleModelConfigured("conductor", {
			explicit: "custom:my-model",
			env: { OMD_CONDUCTOR_MODEL: "env:model" },
			autoAssignMap: { conductor: "auto:model" },
		});
		expect(result.model).toBe("custom:my-model");
		expect(result.source).toBe("explicit");
	});

	test("env overrides auto-assign and default", () => {
		const result = resolveRoleModelConfigured("leaf", {
			env: { OMD_LEAF_MODEL: "env:leaf-model" },
			modelsMap: {}, // hermetic: 无 models 段 → env 生效
			autoAssignMap: { leaf: "auto:leaf" },
		});
		expect(result.model).toBe("env:leaf-model");
		expect(result.source).toBe("env");
	});

	test("auto-assign overrides default", () => {
		const result = resolveRoleModelConfigured("judge", {
			env: {},
			modelsMap: {},
			autoAssignMap: { judge: "kimi-coding:kimi-k3" },
		});
		expect(result.model).toBe("kimi-coding:kimi-k3");
		expect(result.source).toBe("auto");
	});

	// C1 (单一配置面): models 段压过 env 与 auto-assign — 节点路与角色路同序, 一处设置全解析器同步。
	test("models 段压过 env 与 auto-assign (source:file)", () => {
		const result = resolveRoleModelConfigured("conductor", {
			modelsMap: { conductor: "openai-codex:gpt-5.6-sol" },
			env: { OMD_CONDUCTOR_MODEL: "env:should-lose" },
			autoAssignMap: { conductor: "auto:should-lose" },
		});
		expect(result.model).toBe("openai-codex:gpt-5.6-sol");
		expect(result.source).toBe("file");
	});

	test("review-spec env key = OMD_REVIEW_SPEC_MODEL (hyphen→underscore, 对齐既有约定)", () => {
		const result = resolveRoleModelConfigured("review-spec", {
			env: { OMD_REVIEW_SPEC_MODEL: "qwen:qwen3.7-max" },
		});
		expect(result.model).toBe("qwen:qwen3.7-max");
		expect(result.source).toBe("env");
	});
});

describe("config.json autoAssigned 层 — D-17 端到端接线", () => {
	test("persistAutoAssigned 落盘 → resolveRoleModelConfigured auto 层读到", () => {
		const path = join(mkdtempSync(join(tmpdir(), "omd-aa-")), "config.json");
		persistAutoAssigned(
			{ conductor: "kimi-coding:kimi-k3", leaf: "mimo:mimo-v2.5-pro" },
			path,
		);
		resetConfigCache();
		const c = resolveRoleModelConfigured("conductor", { env: {}, configPath: path });
		expect(c.model).toBe("kimi-coding:kimi-k3");
		expect(c.source).toBe("auto");
	});

	test("env 覆盖 auto 层; 未落盘的 node → default (优先序守 INV-4)", () => {
		const path = join(mkdtempSync(join(tmpdir(), "omd-aa-")), "config.json");
		persistAutoAssigned({ conductor: "kimi-coding:kimi-k3" }, path);
		resetConfigCache();
		// env > auto
		const e = resolveRoleModelConfigured("conductor", {
			env: { OMD_CONDUCTOR_MODEL: "x:y" },
			configPath: path,
		});
		expect(e.model).toBe("x:y");
		expect(e.source).toBe("env");
		// 未落盘的 node → 仍走写死默认 (autoAssigned 只覆盖 conductor)
		const d = resolveRoleModelConfigured("judge", { env: {}, configPath: path });
		expect(d.model).toBe(NODE_DEFAULT_COORD.judge);
		expect(d.source).toBe("default");
	});
});

describe("NODE_TIER — D-5 classification completeness", () => {
	test("all 14 nodes have tier mapping", () => {
		expect(Object.keys(NODE_TIER)).toHaveLength(14);
	});

	test("decomposer = conductor + escalation", () => {
		expect(NODE_TIER.conductor).toBe("decomposer");
		expect(NODE_TIER.escalation).toBe("decomposer");
	});

	test("verify = verifier + review-spec (cross-family, INV-3)", () => {
		expect(NODE_TIER.verifier).toBe("verify");
		expect(NODE_TIER["review-spec"]).toBe("verify");
	});
});
