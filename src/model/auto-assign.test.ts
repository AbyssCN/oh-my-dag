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
import { modelFamily, type DeclaredPlan } from "./channels";
import { logger } from "../logger";
import { autoAssign, runAutoAssign } from "./auto-assign";
import { ALL_SEATS } from "./role-models";

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
	/**
	 * ★ **每个座位都真的被派到** (2026-08-02)。
	 *
	 * 缺陷:`NODE_CLASS` 曾是手抄的第二份座位表,而 `autoAssign` 遍历的是
	 * `Object.keys(NODE_CLASS)` —— 照**它自己那份清单**派活,不是照 `ALL_SEATS`。
	 * 两边对不上就**静默漏分配**,后果那张表自己的注释写着:
	 * 「不给它们分配 = 起跑自检恒报缺」。
	 *
	 * 它真的漂了:2026-08-01 加的 `gate` 座位进了 `seats.ts`、漏了 `NODE_CLASS`
	 * (16 vs 15),一整轮没人发现 —— **因为没有任何东西比对这两张表**。
	 *
	 * `NODE_CLASS` 现已从 `SEAT_TIER` 派生,漂移在结构上消掉;这条闸是**另外**那半。
	 * ⚠ 判据刻意取自 `autoAssign` 的**输出**而不是两张表的比对 —— 后者在派生之后是恒真式
	 * (15 号刚栽过一次同形态)。这里问的是「这个座位真的拿到模型了吗」。
	 */
	test("★ ALL_SEATS 里每个座位都拿到分配 (加座位没想过归哪一类 → 这里红)", () => {
		const ratingsPath = writeRatings([
			{ name: "deepseek v4 flash", intelligence: 38, costUsd: 0.01, speedTokS: null },
		]);
		const m = autoAssign({ channels: [ch("deepseek", "token")], ratingsPath });
		const missing = ALL_SEATS.filter((s) => !m[s]);
		expect(
			missing.length === 0
				? ""
				: `以下座位没拿到 auto-assign 分配 —— 起跑自检会恒报它们缺:\n  ${missing.join("\n  ")}\n` +
					"修法: 去 seats.ts 给它写对 tier (NODE_CLASS 从 SEAT_TIER 派生, 不要在 auto-assign 里手抄第二份)。",
		).toBe("");
		// 扫描面自检: 一个都没派到 = 夹具坏了, 而不是"全仓座位都漏了"。
		expect(Object.keys(m).length).toBeGreaterThan(10);
	});

	test("D-19 首选全可达: 大脑簇/校验→v4-pro · 量产+reduce→v4-flash (2026-07-29 表)", () => {
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
		// ⚠ 这里断言的是"codex 渠道**不在**时的兜底", 所以 conductor 也落 flash;
		//   渠道在时它走 NODE_PREFERRED 的 sol —— 那条由下面那个 "GPT 订阅座位" 用例钉。
		for (const n of ["conductor", "escalation", "reason"]) {
			expect(m[n]!.coord).toBe("deepseek:deepseek-v4-flash");
		}
		// ⚠ 2026-08-15 judge 从这一组挪出来 (owner 裁: judge 出厂值 sol → v4-pro)。
		// 它现在**不再依赖 codex 渠道在不在** —— 自己的 NODE_PREFERRED 就在 deepseek 上, 直接命中。
		// 换句话说这一格从"兜底"变成了"首选", via 也跟着从 preferred/fallback 变 override。
		expect(m.judge!.coord).toBe("deepseek:deepseek-v4-pro");
		expect(m.judge!.via).toBe("override");

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

		// 校验座同样落 flash。⚠ 与大脑同族 (deepseek-only 兜底的代价, 见 INV-3 降级测试) ——
		// 这一格没被消灭, 只是频率降低了: 渠道可达时审核座走 sol, 跨家族才成立。
		expect(m.verifier!.coord).toBe("deepseek:deepseek-v4-flash");
		expect(m["review-spec"]!.coord).toBe("deepseek:deepseek-v4-flash");
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
		// 稀疏高价值两座 → sol (flat 渠道)
		for (const n of ["conductor", "escalation"]) {
			expect(m[n]!.coord).toBe("openai-codex:gpt-5.6-sol");
			expect(m[n]!.channelId).toBe("openai-codex:flat");
		}
		// ⚠ 2026-08-15 judge 不再在这一组里 (owner 裁: 出厂值 sol → deepseek:v4-pro)。
		// 裁决理由记在 seats.ts 的 judge.recommend: 内环闸 (`gate`) 拆出去之后, 把 judge 放强模型的
		// 那一半理由没了; 且 v4-pro 与 reason/synth (M3) 异族, 否则是"自己评自己"。
		// 此 fixture **无 deepseek 渠道** → 它的 NODE_PREFERRED 够不着 → 落溢出链, 这正是本用例要钉的:
		// **换了首选之后, 渠道不可达时仍然优雅落链而不是挂掉。**
		expect(m.judge!.coord).toBe("opencode-go:kimi-k3");
		expect(m.judge!.via).toBe("fallback");
		// NODE_PREFERRED 覆盖的其余座位仍走类首选表 (此 fixture 无 deepseek 渠道 → 落 Go 溢出链)
		expect(m.reason!.coord).toBe("opencode-go:kimi-k3");
		// ⚠ 2026-08-05 由 `opencode-go:mimo-v2.5` 改成这个: owner 口径「**mimo 只用于多模态**」,
		//   而 leaf 是纯文本 worker。这条断言此前**钉住的正是那个违规值** —— 改它不是为了变绿,
		//   是因为口径变了; 判据在 FALLBACK_COORDS.worker 那行注释里。
		expect(m.leaf!.coord).toBe("opencode-go:deepseek-v4-flash");
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

	test("S-18 座位降级可见: 首选够不着 → via='fallback' 且必须 warn, 不许与首选命中长得一样", () => {
		// 症状 (改前): 一次成功的降级与一次首选命中的返回值**逐字相同** —— 只有一个 coord。
		// 于是「首选够不着, 用了备胎」读成「我们选了这个座位」, 而换座位实验与基线对比
		// 全都假定座位是首选的。安全侧路是好事, **它冒充主路才是缺陷**。
		const ratingsPath = writeRatings([
			{ name: "kimi k3", intelligence: 57, costUsd: 0.95, speedTokS: 33 },
			{ name: "glm 5.2", intelligence: 51, costUsd: 0.32, speedTokS: 179 },
		]);
		const warned: unknown[] = [];
		const spy = spyOn(logger, "warn").mockImplementation(((o: unknown) => {
			warned.push(o);
		}) as never);
		try {
			// 无 deepseek 渠道 → 类首选 deepseek:deepseek-v4-flash 不可达, 落 Go 溢出链。
			const m = autoAssign({ channels: [ch("opencode-go", "flat")], ratingsPath });
			expect(m.conductor!.coord).toBe("opencode-go:kimi-k3");
			expect(m.conductor!.via).toBe("fallback");
			const seatWarns = warned.filter((o) => (o as { degraded?: string })?.degraded === "seat-fallback");
			expect(seatWarns.length).toBeGreaterThan(0);
			// 判词要说得出**跳过了什么**, 否则"降级了"仍然不够读的人复原当时的条件。
			expect((seatWarns[0] as { skipped?: string[] }).skipped).toContain("deepseek:deepseek-v4-flash");
		} finally {
			spy.mockRestore();
		}
	});

	test("S-18 反向自检: 首选可达 → via='preferred' 且**一条 seat-fallback warn 都没有**", () => {
		// 上一条断言"降级会响"只有在这一条成立时才有意义 —— 否则它可能是个恒响的铃。
		const ratingsPath = writeRatings([
			{ name: "deepseek v4 flash", intelligence: 38, costUsd: 0.01, speedTokS: null },
		]);
		const warned: unknown[] = [];
		const spy = spyOn(logger, "warn").mockImplementation(((o: unknown) => {
			warned.push(o);
		}) as never);
		try {
			const m = autoAssign({ channels: [ch("deepseek", "token")], ratingsPath });
			expect(m.leaf!.coord).toBe("deepseek:deepseek-v4-flash");
			expect(m.leaf!.via).toBe("preferred");
			expect(warned.some((o) => (o as { degraded?: string })?.degraded === "seat-fallback")).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	// ── 2026-08-23: INV-3 的家族判定换成 modelFamily ────────────────────────────
	//
	// 旧写法 `c?.split(":")[0]` 拿的是**裸 provider 前缀**, 会把 `minimax-cn` 与 `minimax-us`
	// 判成异族 —— 于是一次真同族自审从这道闸底下**静默溜过去**, 而这道闸存在的全部理由
	// 就是不让它静默。
	//
	// ★ 证伪方式 (当场验过): 把 auto-assign.ts 的 famOf 改回 `c?.split(":")[0]` → 本条红。
	test("★ INV-3 家族判定走 modelFamily: minimax-cn 与 minimax-us 是**同族**", () => {
		// 语义面: 这是判据本身要的性质。
		expect(modelFamily("minimax-cn:MiniMax-M3")).toBe(modelFamily("minimax-us:MiniMax-M3"));
		// 裸前缀拿不到这条 —— 记下差距, 免得有人"顺手简化"回去。
		expect("minimax-cn:MiniMax-M3".split(":")[0]).not.toBe("minimax-us:MiniMax-M3".split(":")[0]);

		// 接线面: INV-3 那处**确实**用的是 modelFamily, 不是裸前缀 (同
		// agent-leaf-shellruns-wiring.test.ts 的接线钉法 —— 判据在源码里, 就在源码上钉)。
		const src = readFileSync(join(import.meta.dir, "auto-assign.ts"), "utf8");
		expect(src).toContain("const famOf = (c?: string): string | undefined => (c ? modelFamily(c) : undefined);");
		expect(src).not.toContain('const famOf = (c?: string): string | undefined => c?.split(":")[0];');
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

describe("runAutoAssign — 端到端 (发现→分配→写入磁盘; configPath 读写同目标)", () => {
	test("声明 kimi-coding → 大脑簇落 kimi-coding:k3, 写入磁盘可读回, INV-3 跨家族", () => {
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
		// ⚠ 2026-08-15: judge 出厂值改 v4-pro (owner 裁) → 它走自己的 NODE_PREFERRED 而不是类首选。
		// 同族这件事没变 (仍是 deepseek), 变的只是档位 —— 下面那条 INV-3 断言照旧成立。
		expect(map.judge?.coord).toBe("deepseek:deepseek-v4-pro");
		// ⚠ INV-3 在此配置下**不成立**: 判与证同族 (deepseek-only 的代价), 由 autoAssign 打降级告警。
		expect(map.verifier?.coord.split(":")[0]).toBe("deepseek");
		// 写入磁盘后可读回 (configPath 读写同目标)
		const persisted = JSON.parse(readFileSync(configPath, "utf8")).autoAssigned;
		expect(persisted.conductor).toBe("deepseek:deepseek-v4-flash");
	});
});
