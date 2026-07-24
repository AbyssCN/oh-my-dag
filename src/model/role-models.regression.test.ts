/**
 * role-models regression tests — INV-4 / G-2: per-node snapshot.
 *
 * Verifies that resolveRoleModelConfigured(node) with no env and no auto-assign
 * returns the EXACT same coord as the hardcoded default (NODE_DEFAULT_COORD).
 * Any change here = deliberate (not accidental drift).
 */
import { describe, expect, test } from "bun:test";
import {
	NODE_DEFAULT_COORD,
	NODE_TIER,
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
				autoAssignMap: undefined, // no auto-assign
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
			autoAssignMap: { leaf: "auto:leaf" },
		});
		expect(result.model).toBe("env:leaf-model");
		expect(result.source).toBe("env");
	});

	test("auto-assign overrides default", () => {
		const result = resolveRoleModelConfigured("judge", {
			env: {},
			autoAssignMap: { judge: "kimi-coding:kimi-k3" },
		});
		expect(result.model).toBe("kimi-coding:kimi-k3");
		expect(result.source).toBe("auto");
	});

	test("review-spec env key = OMD_REVIEW_SPEC_MODEL (hyphen→underscore, 对齐既有约定)", () => {
		const result = resolveRoleModelConfigured("review-spec", {
			env: { OMD_REVIEW_SPEC_MODEL: "qwen:qwen3.7-max" },
		});
		expect(result.model).toBe("qwen:qwen3.7-max");
		expect(result.source).toBe("env");
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
