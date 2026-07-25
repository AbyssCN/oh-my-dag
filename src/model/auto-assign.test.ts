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
import { mkdirSync, readFileSync } from "node:fs";
import type { DeclaredPlan } from "./channels";
import { autoAssign, runAutoAssign } from "./auto-assign";

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
	test("D-19 首选全可达: 大脑簇→K3(Allegretto) · reduce→MiMo-pro · worker→MiMo-v2.5(Lite) · verifier→GLM(Go)", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "mimo v2.5", intelligence: 42, costUsd: 0.2, speedTokS: null },
			{ name: "mimo v2.5 pro", intelligence: 48, costUsd: 0.25, speedTokS: null },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);

		const m = autoAssign({
			channels: [
				ch("kimi-coding", "token"), // Allegretto plan
				ch("mimo", "token"), // Lite plan
				ch("opencode-go", "flat"), // Go flat-sub (次顶级 + 溢出)
			],
			ratingsPath,
		});

		// 大脑簇 (conductor/escalation/judge/reason) → K3 (Allegretto, 不走 Go 避 288x 烧穿)
		for (const n of ["conductor", "escalation", "judge", "reason"]) {
			expect(m[n]!.coord).toBe("kimi-coding:k3");
		}

		// reduce → MiMo v2.5-pro (D-14 够质量的最廉, 替代 ds-pro 位, 高频留 Lite 桶)
		expect(m.reduce!.coord).toBe("mimo:mimo-v2.5-pro");

		// worker → MiMo v2.5-pro (owner 2026-07-25: Lite 额度大, pro 默认; 多模态池例外留 v2.5)
		for (const n of ["leaf", "agent", "lens", "expand", "distill", "overflow"]) {
			expect(m[n]!.coord).toBe("mimo:mimo-v2.5-pro");
		}

		// verifier/review-spec/dream → GLM via Go flat-sub (次顶级, 跨 Kimi 家族 INV-3)
		expect(m.verifier!.coord).toBe("opencode-go:glm-5.2");
		expect(m["review-spec"]!.coord).toBe("opencode-go:glm-5.2");
		expect(m.dream!.coord).toBe("opencode-go:glm-5.2");
	});

	test("GPT 订阅座位 (owner 2026-07-25): codex 渠道在 → conductor/escalation/judge→sol, reason 留 k3, 量产不动", () => {
		const ratingsPath = writeRatings([
			{ name: "gpt 5.6 sol", intelligence: 62, costUsd: 0, speedTokS: null },
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "mimo v2.5", intelligence: 42, costUsd: 0.2, speedTokS: null },
			{ name: "mimo v2.5 pro", intelligence: 48, costUsd: 0.25, speedTokS: null },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);
		const m = autoAssign({
			channels: [
				ch("openai-codex", "flat", 0), // ChatGPT Plus 订阅 (pi OAuth 通道)
				ch("kimi-coding", "token"),
				ch("mimo", "token"),
				ch("opencode-go", "flat"),
			],
			ratingsPath,
		});
		// 稀疏高价值三座 → sol (flat 渠道)
		for (const n of ["conductor", "escalation", "judge"]) {
			expect(m[n]!.coord).toBe("openai-codex:gpt-5.6-sol");
			expect(m[n]!.channelId).toBe("openai-codex:flat");
		}
		// reason 每图多发 → 留 k3 (Plus 配额保护); reduce/worker 不动
		expect(m.reason!.coord).toBe("kimi-coding:k3");
		expect(m.reduce!.coord).toBe("mimo:mimo-v2.5-pro");
		expect(m.leaf!.coord).toBe("mimo:mimo-v2.5-pro");
		// INV-3: verifier (glm) 跨 gpt 大脑家族
		expect(m.verifier!.coord).toBe("opencode-go:glm-5.2");
	});

	test("溢出链降级: kimi-coding 无渠道 → 大脑簇降级到 Go(opencode-go:kimi-k3)", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);

		const m = autoAssign({
			// 无 kimi-coding → K3 Allegretto 不可达, 落 Go 溢出首位 opencode-go:kimi-k3
			channels: [ch("opencode-go", "flat")],
			ratingsPath,
		});

		expect(m.conductor!.coord).toBe("opencode-go:kimi-k3");
		expect(m.judge!.coord).toBe("opencode-go:kimi-k3");
	});

	test("reduce 特殊: MiMo 不可达 → 降级到判合成溢出链 (Go kimi-k3)", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);

		const m = autoAssign({
			// 无 mimo → reduce 首选 mimo-v2.5-pro 不可达 → 落 judge_synth 溢出链首位
			channels: [ch("opencode-go", "flat")],
			ratingsPath,
		});

		expect(m.reduce!.coord).toBe("opencode-go:kimi-k3");
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

	test("verifier 跨家族 (INV-3): verifier 走 Go-GLM, ≠ 大脑(kimi) 家族", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
			{ name: "mimo v2.5", intelligence: 42, costUsd: 0.2, speedTokS: null },
			{ name: "mimo v2.5 pro", intelligence: 48, costUsd: 0.25, speedTokS: null },
		]);

		const m = autoAssign({
			channels: [
				ch("kimi-coding", "token"),
				ch("mimo", "token"),
				ch("opencode-go", "flat"),
			],
			ratingsPath,
		});

		// conductor/judge = kimi, worker = mimo, reduce = mimo → verifier ≠ kimi 家族 (跨检查者/被检查者)
		const mains = new Set([
			m.conductor!.coord.split(":")[0],
			m.leaf!.coord.split(":")[0],
		]);
		expect(m.verifier!.coord.split(":")[0]).toBe("opencode-go");
		expect(mains.has("opencode-go")).toBe(false);
		expect(m.verifier!.coord.split(":")[0]).not.toBe(m.judge!.coord.split(":")[0]);
	});

	test("node 分类完整覆盖: 所有已知 node 都有分配 (渠道充足时)", () => {
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
			{ name: "mimo v2.5", intelligence: 42, costUsd: 0.2, speedTokS: null },
			{ name: "mimo v2.5 pro", intelligence: 48, costUsd: 0.25, speedTokS: null },
		]);

		const m = autoAssign({
			channels: [
				ch("kimi-coding", "token"),
				ch("mimo", "token"),
				ch("opencode-go", "flat"),
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

describe("runAutoAssign — 端到端 (发现→分配→落盘; configPath 读写同目标)", () => {
	test("声明 kimi-coding → 大脑簇落 kimi-coding:k3, 落盘可读回, INV-3 跨家族", () => {
		const home = mkdtempSync(join(tmpdir(), "omd-run-aa-"));
		mkdirSync(join(home, ".omd"), { recursive: true });
		const configPath = join(home, ".omd", "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				version: 2,
				declaredPlans: [{ provider: "kimi-coding", kind: "token", plan: "allegretto" }],
			}),
		);
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "deepseek v4 pro", intelligence: 44, costUsd: 0.04, speedTokS: null },
			{ name: "mimo v2.5 pro", intelligence: 48, costUsd: 0.25, speedTokS: null },
		]);
		// deepseek/mimo 经 env 自探; PI_AGENT_DIR 指空 temp → auth/models 探不到; kimi 靠声明补上。
		const env = { DEEPSEEK_API_KEY: "sk-x", MIMO_API_KEY: "sk-m", PI_AGENT_DIR: home };
		const map = runAutoAssign(env, { configPath, ratingsPath });

		// 大脑簇 → kimi (声明的 Allegretto, 品牌桥接命中 57)
		expect(map.conductor?.coord).toBe("kimi-coding:k3");
		expect(map.judge?.coord).toBe("kimi-coding:k3");
		expect(map.conductor?.intelligence).toBe(57);
		// INV-3: verifier 家族 ≠ judge(kimi) 家族
		expect(map.verifier?.coord.split(":")[0]).not.toBe("kimi-coding");
		// 落盘可读回 (configPath 读写同目标)
		const persisted = JSON.parse(readFileSync(configPath, "utf8")).autoAssigned;
		expect(persisted.conductor).toBe("kimi-coding:k3");
	});
});
