/**
 * auto-assign 测试。
 * 覆盖: D-19 分配表全链 (首选可达) · 溢出链降级 · reduce 特殊路径 (DS-Pro) ·
 * 跨家族校验 verifier ≠ 主力族 · 空渠道 → 空分配 · 全链不可达 → 跳过 + log ·
 * 临时快照 + 临时渠道, 零网络零全局态。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeclaredPlan } from "./channels";
import { autoAssign } from "./auto-assign";

/** 造 DeclaredPlan 的 shorthand。 */
const ch = (
	provider: string,
	kind: "token" | "request" | "session" | "flat" = "token",
	rateUsd = 1,
): DeclaredPlan => ({
	provider,
	kind,
	rateUsd,
});

/**
 * 造临时 model-ratings.json, 返回路径。
 * 归一化匹配: name 字段会被 lookupRating normalizeName 处理。
 */
function writeRatings(ratings: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "omd-auto-assign-"));
	const path = join(dir, "model-ratings.json");
	writeFileSync(path, JSON.stringify({ source: "test", ratings }));
	return path;
}

describe("autoAssign", () => {
	test("D-19 首选全可达: conductor/judge/escalation→K3(Allegretto) · leaf→MiMo-pro(Lite) · verifier→GLM(Go) · reduce→DS-Pro(Go)", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{
				name: "mimo v2.5 pro",
				intelligence: 48,
				costUsd: 0.25,
				speedTokS: null,
			},
			{
				name: "deepseek v4 pro",
				intelligence: 44,
				costUsd: 0.04,
				speedTokS: null,
			},
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);

		const m = autoAssign({
			channels: [
				ch("kimi-coding", "token"), // Allegretto plan
				ch("mimo", "token"), // Lite plan
				ch("deepseek", "token"), // Go / 按量
				ch("openrouter", "token"), // Go (GLM via openrouter)
			],
			ratingsPath,
		});

		// conductor + escalation → K3
		expect(m.conductor!.coord).toBe("kimi-coding:k3");
		expect(m.escalation!.coord).toBe("kimi-coding:k3");

		// judge + reason → K3
		expect(m.judge!.coord).toBe("kimi-coding:k3");
		expect(m.reason!.coord).toBe("kimi-coding:k3");

		// reduce → DS-Pro (D-14 特殊: 不走 K3)
		expect(m.reduce!.coord).toBe("deepseek:deepseek-v4-pro");

		// worker (leaf/agent/lens/expand/distill/overflow) → MiMo v2.5-pro
		for (const n of [
			"leaf",
			"agent",
			"lens",
			"expand",
			"distill",
			"overflow",
		]) {
			expect(m[n]!.coord).toBe("mimo:mimo-v2.5-pro");
		}

		// verifier → GLM (跨家族, INV-3)
		expect(m.verifier!.coord).toBe("openrouter:glm-5.2");
		expect(m["review-spec"]!.coord).toBe("openrouter:glm-5.2");

		// dream → GLM
		expect(m.dream!.coord).toBe("openrouter:glm-5.2");
	});

	test("溢出链降级: K3 无渠道 → conductor 降级到 GLM-5.2", () => {
		const ratingsPath = writeRatings([
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
			{
				name: "deepseek v4 pro",
				intelligence: 44,
				costUsd: 0.04,
				speedTokS: null,
			},
			{
				name: "mimo v2.5 pro",
				intelligence: 48,
				costUsd: 0.25,
				speedTokS: null,
			},
		]);

		const m = autoAssign({
			channels: [
				// 无 kimi-coding 渠道 → K3 不可达
				ch("openrouter", "token"), // GLM
				ch("mimo", "token"),
				ch("deepseek", "token"),
			],
			ratingsPath,
		});

		// conductor 降级到第一溢出候选 GLM
		expect(m.conductor!.coord).toBe("openrouter:glm-5.2");
		expect(m.judge!.coord).toBe("openrouter:glm-5.2");
	});

	test("reduce 特殊: DS-Pro 不可达 → 降级到溢出链 (GLM)", () => {
		const ratingsPath = writeRatings([
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
			{
				name: "mimo v2.5 pro",
				intelligence: 48,
				costUsd: 0.25,
				speedTokS: null,
			},
		]);

		const m = autoAssign({
			channels: [
				ch("mimo", "token"),
				ch("openrouter", "token"), // GLM
				// 无 deepseek 渠道 → DS-Pro 不可达
			],
			ratingsPath,
		});

		// reduce: DS-Pro 不可达 → 跳到溢出链首位 GLM
		expect(m.reduce!.coord).toBe("openrouter:glm-5.2");
	});

	test("空渠道 → 空分配", () => {
		const m = autoAssign({ channels: [] });
		expect(Object.keys(m)).toHaveLength(0);
	});

	test("全链不可达 → node 不出现在 map 中", () => {
		// 只给一个无关 provider, 什么都不覆盖
		const m = autoAssign({
			channels: [ch("irrelevant-provider", "token")],
		});
		expect(Object.keys(m)).toHaveLength(0);
	});

	test("verifier 跨家族 (INV-3): GLM 可达时 verifier 走 GLM, 不走同族 kimi/mimo/deepseek", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
			{
				name: "mimo v2.5 pro",
				intelligence: 48,
				costUsd: 0.25,
				speedTokS: null,
			},
			{
				name: "deepseek v4 pro",
				intelligence: 44,
				costUsd: 0.04,
				speedTokS: null,
			},
		]);

		const m = autoAssign({
			channels: [
				ch("kimi-coding", "token"),
				ch("mimo", "token"),
				ch("deepseek", "token"),
				ch("openrouter", "token"),
			],
			ratingsPath,
		});

		// conductor/judge = kimi, leaf = mimo, reduce = deepseek
		// verifier 必须 ≠ 上述三家 → GLM
		const families = new Set([
			m.conductor!.coord.split(":")[0],
			m.leaf!.coord.split(":")[0],
			m.reduce!.coord.split(":")[0],
		]);
		expect(m.verifier!.coord.split(":")[0]).toBe("openrouter");
		expect(families.has("openrouter")).toBe(false);
	});

	test("node 分类完整覆盖: 所有已知 node 都有分配 (渠道充足时)", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
			{
				name: "mimo v2.5 pro",
				intelligence: 48,
				costUsd: 0.25,
				speedTokS: null,
			},
			{
				name: "deepseek v4 pro",
				intelligence: 44,
				costUsd: 0.04,
				speedTokS: null,
			},
		]);

		const m = autoAssign({
			channels: [
				ch("kimi-coding", "token"),
				ch("mimo", "token"),
				ch("deepseek", "token"),
				ch("openrouter", "token"),
			],
			ratingsPath,
		});

		const expected = [
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
		];
		for (const node of expected) {
			expect(m[node]).toBeDefined();
			expect(m[node]!.coord).toBeTruthy();
			expect(m[node]!.channelId).toBeTruthy();
			expect(typeof m[node]!.intelligence).toBe("number");
		}
	});

	test("AA 快照未命中 → 命名启发兜底 (INV-7), 不崩", () => {
		// 只给 GLM 快照 (无 kimi): kimi-coding:k3 → modelId 'k3' 快照无 → 品牌桥接试 'kimi k3' 亦无
		// → 命名启发 norm='k3' (裸关键词, norm===kw 守卫挡升档) → 中档 42。验证 miss 不崩、返非空。
		const ratingsPath = writeRatings([
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);

		const m = autoAssign({
			channels: [ch("kimi-coding", "token"), ch("openrouter", "token")],
			ratingsPath,
		});

		expect(m.conductor!.coord).toBe("kimi-coding:k3");
		expect(m.conductor!.intelligence).toBe(42);
	});
});
