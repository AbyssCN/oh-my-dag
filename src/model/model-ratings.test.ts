/**
 * model-ratings 测试。
 * 覆盖: 快照精确命中 (deepseek:deepseek-v4-pro → 44) · 裸关键词 modelId ('k3') 不升档, 如实落中档兜底 ·
 * 命名启发强档 ('pro') / 廉档 ('flash') · 文件缺 → null 不抛 · 临时快照自定 ratings 精确命中。
 * 临时文件走 mkdtempSync, 零网络零全局态。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupRating } from "./model-ratings";

function writeRatingsJson(content: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "omd-model-ratings-"));
	const path = join(dir, "model-ratings.json");
	writeFileSync(path, JSON.stringify(content));
	return path;
}

describe("lookupRating", () => {
	test("快照精确命中: deepseek:deepseek-v4-pro 归一后命中 → 44", () => {
		const r = lookupRating("deepseek:deepseek-v4-pro");
		expect(r).toEqual({
			name: "deepseek v4 pro",
			intelligence: 44,
			costUsd: 0.04,
			speedTokS: null,
		});
	});

	test("provider 品牌桥接 (D-8): kimi-coding:k3 的裸 modelId 'k3' 快照无 → 试 'kimi k3' 命中 57", () => {
		// 剥 -coding 后缀 → 'kimi' + 'k3' → 'kimi k3' 匹配 AA 名 (修前落中档 42 heuristic)。
		const r = lookupRating("kimi-coding:k3");
		expect(r?.intelligence).toBe(57);
		expect(r?.name).toBe("kimi k3");
	});

	test("品牌桥接不误伤: 含品牌的 modelId 直接命中不走桥接", () => {
		// deepseek-v4-pro 归一即 'deepseek v4 pro' 直接命中, 不因桥接改变。
		expect(lookupRating("deepseek:deepseek-v4-pro")?.intelligence).toBe(44);
	});

	test("未知 coord 含 'pro' → 强档兜底 (45/0.5)", () => {
		const r = lookupRating("somevendor:mystery-pro-1");
		expect(r).toMatchObject({
			intelligence: 45,
			costUsd: 0.5,
			speedTokS: null,
		});
	});

	test("未知 coord 含 'flash' → 廉档兜底 (38/0.15)", () => {
		const r = lookupRating("somevendor:acme-flash-2");
		expect(r).toMatchObject({
			intelligence: 38,
			costUsd: 0.15,
			speedTokS: null,
		});
	});

	test("path 不存在 → null 不抛", () => {
		expect(
			lookupRating(
				"deepseek:deepseek-v4-pro",
				join(tmpdir(), "omd-nope", "model-ratings.json"),
			),
		).toBeNull();
	});

	test("坏 JSON → null 不抛", () => {
		const dir = mkdtempSync(join(tmpdir(), "omd-model-ratings-"));
		const path = join(dir, "model-ratings.json");
		writeFileSync(path, "{ not json");
		expect(lookupRating("deepseek:deepseek-v4-pro", path)).toBeNull();
	});

	test("临时快照: 自定 ratings 归一后精确命中, 未命中走兜底", () => {
		const path = writeRatingsJson({
			source: "artificialanalysis.ai",
			ratings: [
				{ name: "Acme Turbo 9", intelligence: 60, costUsd: 2.5, speedTokS: 88 },
			],
		});
		// 连字符/大小写归一后命中 'acme turbo 9'。
		const hit = lookupRating("acme:ACME-turbo_9", path);
		expect(hit).toEqual({
			name: "Acme Turbo 9",
			intelligence: 60,
			costUsd: 2.5,
			speedTokS: 88,
		});
		// 自定快照无 'kimi k3' → 未命中走启发 ('k3' 出现在更长名字里 → 强档)。
		const fb = lookupRating("kimi:kimi-k3", path);
		expect(fb).toMatchObject({ intelligence: 45, costUsd: 0.5 });
	});
});
