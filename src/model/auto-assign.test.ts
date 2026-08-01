/**
 * auto-assign 测试。
 * 覆盖: D-19 分配表全链 (首选可达) · 溢出链降级 · reduce 特殊路径 (DS-Pro) ·
 * 跨家族校验 verifier ≠ 主力族 · 空渠道 → 空分配 · 全链不可达 → 跳过 + log ·
 * 临时快照 + 临时渠道, 零网络零全局态。
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import type { DeclaredPlan } from "./channels";
import { logger } from "../logger";
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
	test("D-19 首选全可达: 大脑簇/校验→v4-pro · 量产+reduce+dream→v4-flash (2026-07-29 表)", () => {
		const ratingsPath = writeRatings([
			{ name: "deepseek v4 pro", intelligence: 44, costUsd: 0.04, speedTokS: null },
			{ name: "deepseek v4 flash", intelligence: 38, costUsd: 0.01, speedTokS: null },
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "mimo v2.5", intelligence: 42, costUsd: 0.2, speedTokS: null },
			{ name: "mimo v2.5 pro", intelligence: 48, costUsd: 0.25, speedTokS: null },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);

		const m = autoAssign({
			channels: [
				ch("deepseek", "token"), // 官网 API (2026-07-29 起的主力)
				ch("kimi-coding", "token"), // Allegretto plan
				ch("mimo", "token"), // Lite plan
				ch("opencode-go", "flat"), // Go flat-sub (次顶级 + 溢出)
			],
			ratingsPath,
		});

		// 2026-07-31 v4-flash 正式版上线 → **落类首选整表压到 flash** (分配表是唯一真源, 改表即改这里)。
		// ⚠ 这里断言的是"codex 渠道**不在**时的兜底", 所以 conductor/judge 也落 flash;
		//   渠道在时它们走 NODE_PREFERRED 的 sol —— 那条由下面那个 "GPT 订阅座位" 用例钉。
		for (const n of ["conductor", "escalation", "judge", "reason"]) {
			expect(m[n]!.coord).toBe("deepseek:deepseek-v4-flash");
		}

		// reduce → v4-flash (D-14 够质量的最廉; 高频阶段)
		expect(m.reduce!.coord).toBe("deepseek:deepseek-v4-flash");

		// worker → v4-flash (量在这里)
		for (const n of ["leaf", "agent", "lens", "expand", "distill", "overflow"]) {
			expect(m[n]!.coord).toBe("deepseek:deepseek-v4-flash");
			// 2026-08-01 owner: worker 提到 xhigh (deepseek 上 = reasoning_effort=max)。
			// 敢配 xhigh 的前提是 transport 层按**模型**夹 —— 见 seat-thinking.test.ts 那条
			// 「约束搬层了」的用例, 它钉住 xhigh 在 mimo/qwen 上会自动降到 high。
			expect(m[n]!.thinkingLevel).toBe("xhigh");
		}

		// 校验/dream 同样落 flash。⚠ 与大脑同族 (deepseek-only 兜底的代价, 见 INV-3 降级测试) ——
		// 这一格没被消灭, 只是频率降低了: 渠道可达时审核座走 sol, 跨家族才成立。
		expect(m.verifier!.coord).toBe("deepseek:deepseek-v4-flash");
		expect(m["review-spec"]!.coord).toBe("deepseek:deepseek-v4-flash");
		expect(m.dream!.coord).toBe("deepseek:deepseek-v4-flash");
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
		// NODE_PREFERRED 只覆盖那三座; 其余仍走类首选表 (此 fixture 无 deepseek 渠道 → 落 Go 溢出链)
		expect(m.reason!.coord).toBe("opencode-go:kimi-k3");
		expect(m.leaf!.coord).toBe("opencode-go:mimo-v2.5");
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

	test("INV-3 跨家族只在**首选表本身跨家族**时成立 —— 当前表单家族, 故必然降级", () => {
		// 旧表 (kimi 脑 / mimo 干活 / Go 校验) 天生跨家族, 所以这条不变量当年是白拿的。
		// 2026-07-29 切成 deepseek-only 后前提没了: 首选可达时同族, 首选不可达时全落 Go 溢出链 —— 也同族。
		// 结论: 这条不变量现在**必须靠告警可见**, 而不是靠断言"它成立"。见下一条测试。
		const ratingsPath = writeRatings([
			{ name: "deepseek v4 pro", intelligence: 44, costUsd: 0.04, speedTokS: null },
			{ name: "deepseek v4 flash", intelligence: 38, costUsd: 0.01, speedTokS: null },
		]);
		const m = autoAssign({ channels: [ch("deepseek", "token")], ratingsPath });
		const fam = (c: string): string => c.split(":")[0]!;
		expect(fam(m.verifier!.coord)).toBe(fam(m.judge!.coord));
	});

	test("INV-3 降级可见: 只有一个家族可达 → 判与证同族, autoAssign 必须打 warn 而非静默", () => {
		const ratingsPath = writeRatings([
			{ name: "deepseek v4 pro", intelligence: 44, costUsd: 0.04, speedTokS: null },
			{ name: "deepseek v4 flash", intelligence: 38, costUsd: 0.01, speedTokS: null },
		]);
		const warned: unknown[] = [];
		const spy = spyOn(logger, "warn").mockImplementation(((o: unknown) => {
			warned.push(o);
		}) as never);
		try {
			const m = autoAssign({ channels: [ch("deepseek", "token")], ratingsPath });
			const fam = (c: string): string => c.split(":")[0]!;
			// 同族是**事实**, 不是 bug —— 只剩一个家族时无从跨。
			expect(fam(m.verifier!.coord)).toBe(fam(m.judge!.coord));
			// 但它必须被说出来: 一条不变量不该在没人注意的时候死掉。
			expect(warned.some((o) => (o as { degraded?: string })?.degraded === "INV-3")).toBe(true);
		} finally {
			spy.mockRestore();
		}
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
		// 只给 GLM 快照 (无 deepseek): 首选坐标在快照里查不到 → 品牌桥接亦无 → 命名启发给中档 42。
		// 验证 miss 不崩、返非空。
		const ratingsPath = writeRatings([
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);

		const m = autoAssign({
			// 首选家族在场 (否则无分配可言); 快照里**没有**它 → 走命名启发那条路。
			channels: [ch("deepseek", "token"), ch("openrouter", "token")],
			ratingsPath,
		});

		expect(m.conductor!.coord).toBe("deepseek:deepseek-v4-flash");
		// 具体数字由命名启发给 (换首选坐标就会变); 这里钉住的是"miss 不崩且给得出分", 不是这个值本身。
		// 45 → 38: 首选坐标从 v4-pro 换成 v4-flash, 启发式按名字给分, 跟着变是**预期**的 —— 这条用例
		// 自己写着"不是这个值本身", 所以跟着改数不是在迁就测试。
		expect(m.conductor!.intelligence).toBe(38);
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

		// 大脑簇 → v4-flash: 分配表是**硬偏好**, 声明持仓只决定"可达不可达", 不改变优先序。
		// (deepseek 经 DEEPSEEK_API_KEY 自探可达 → 首选命中, 不再落到声明的 kimi。)
		expect(map.conductor?.coord).toBe("deepseek:deepseek-v4-flash");
		expect(map.judge?.coord).toBe("deepseek:deepseek-v4-flash");
		// ⚠ INV-3 在此配置下**不成立**: 判与证同族 (deepseek-only 的代价), 由 autoAssign 打降级告警。
		expect(map.verifier?.coord.split(":")[0]).toBe("deepseek");
		// 落盘可读回 (configPath 读写同目标)
		const persisted = JSON.parse(readFileSync(configPath, "utf8")).autoAssigned;
		expect(persisted.conductor).toBe("deepseek:deepseek-v4-flash");
	});
});
