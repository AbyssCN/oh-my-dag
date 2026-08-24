/**
 * role-models regression tests — P0 模型解析统一 (INV-MODEL-1/2/5, SDD 2026-07-28)。
 *
 * 这批用例钉的是 P0 之后的契约, 不是 P0 之前的快照:
 *   - INV-MODEL-1 单一解析权威: 角色路与节点路同解, env 别名 (OMD_ITER_ / OMD_CG_ 两族) 收进同一条链;
 *   - INV-MODEL-2 零硬编码 deepseek: 没配 = 没有出厂坐标, 只有单一可配 defaultModel;
 *   - INV-MODEL-5 响亮失败: 一层都没命中 → SeatUnresolvedError 指名座位, 不静默落任何模型。
 *
 * (P0 前这里是 NODE_DEFAULT_COORD 的 14 条 deepseek 快照 —— 那张表本身就是被 INV-MODEL-2 判死的东西。)
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ALL_SEATS,
	NODE_TIER,
	type OmdSeat,
	SeatUnresolvedError,
	persistAutoAssigned,
	persistDefaultModel,
	resetConfigCache,
	resolveRoleModel,
	resolveRoleModelConfigured,
	seatEnvKey,
	tryResolveSeatModel,
} from "./role-models";

/** 一次性空 config 路径 (hermetic: 不碰仓内真 .omd/config.json)。 */
function tmpConfig(): string {
	const path = join(mkdtempSync(join(tmpdir(), "omd-seat-")), "config.json");
	resetConfigCache();
	return path;
}

/** 裸链解析 (无 config / 无 env / 无 auto)。 */
function bare(seat: OmdSeat, path: string) {
	return tryResolveSeatModel(seat, {
		env: {},
		modelsMap: {},
		autoAssignMap: {},
		configPath: path,
	});
}

describe("INV-MODEL-2 — 零硬编码兜底 (没配 = 没有坐标)", () => {
	const path = tmpConfig();
	for (const seat of ALL_SEATS) {
		test(`${seat}: 裸链无出厂坐标 (不落 deepseek)`, () => {
			expect(bare(seat, path)).toBeUndefined();
		});
	}

	test("单一可配 defaultModel 兜住全部座位", () => {
		for (const seat of ALL_SEATS) {
			const r = tryResolveSeatModel(seat, {
				env: {},
				modelsMap: {},
				autoAssignMap: {},
				configPath: path,
				defaultModel: "acme:m1",
			});
			expect(r?.model).toBe("acme:m1");
			expect(r?.source).toBe("default");
		}
	});

	test("config.defaultModel 写入磁盘后全座位读到 (跨进程面)", () => {
		const p = tmpConfig();
		persistDefaultModel("acme:from-file", p);
		resetConfigCache();
		const r = tryResolveSeatModel("judge", {
			env: {},
			modelsMap: {},
			autoAssignMap: {},
			configPath: p,
		});
		expect(r?.model).toBe("acme:from-file");
		expect(r?.via).toBe("config.defaultModel");
	});

	test("OMD_RUNTIME_PROVIDER/MODEL 也是 defaultModel 层 (init wizard 写的那对)", () => {
		const r = tryResolveSeatModel("leaf", {
			env: { OMD_RUNTIME_PROVIDER: "acme", OMD_RUNTIME_MODEL: "m9" },
			modelsMap: {},
			autoAssignMap: {},
			configPath: tmpConfig(),
		});
		expect(r?.model).toBe("acme:m9");
		expect(r?.source).toBe("default");
	});
});

describe("INV-MODEL-5 — 响亮失败 (计划期抛, 指名座位)", () => {
	test("resolveRoleModelConfigured 解不到即抛, 错误里有座位名与修法", () => {
		const path = tmpConfig();
		let caught: unknown;
		try {
			resolveRoleModelConfigured("distill", {
				env: {},
				modelsMap: {},
				autoAssignMap: {},
				configPath: path,
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(SeatUnresolvedError);
		expect((caught as Error).message).toContain("distill");
		expect((caught as Error).message).toContain("omd models auto");
	});

	test("tryResolveSeatModel 同场景返 undefined (非致命调用方用它)", () => {
		expect(bare("continuity", tmpConfig())).toBeUndefined();
	});
});

describe("INV-MODEL-1 — 单一解析权威 (一条链)", () => {
	const path = tmpConfig();

	test("优先序: explicit > config.models > env > auto > defaultModel", () => {
		const full = {
			env: { OMD_CONDUCTOR_MODEL: "env:c" },
			modelsMap: { conductor: "file:c" },
			autoAssignMap: { conductor: "auto:c" },
			defaultModel: "def:c",
			configPath: path,
		};
		expect(tryResolveSeatModel("conductor", { ...full, explicit: "x:c" })?.source).toBe("explicit");
		expect(tryResolveSeatModel("conductor", full)?.model).toBe("file:c");
		expect(tryResolveSeatModel("conductor", { ...full, modelsMap: {} })?.model).toBe("env:c");
		expect(
			tryResolveSeatModel("conductor", { ...full, modelsMap: {}, env: {} })?.model,
		).toBe("auto:c");
		expect(
			tryResolveSeatModel("conductor", { ...full, modelsMap: {}, env: {}, autoAssignMap: {} })
				?.model,
		).toBe("def:c");
	});

	// 回归钉: P0 前 resolveEngineModels 把 OMD_ITER_* 排在 config.models **之上**, 于是改了
	// config.json 也不生效 —— 同一个 conductor 座在两条链上解出两个答案。
	test("env 别名 OMD_ITER_*/OMD_CG_* 收进 env 层, 且在 config.models 之下", () => {
		expect(
			tryResolveSeatModel("conductor", {
				env: { OMD_ITER_CONDUCTOR_MODEL: "iter:c" },
				modelsMap: { conductor: "file:c" },
				autoAssignMap: {},
				configPath: path,
			})?.model,
		).toBe("file:c");
		const alias = tryResolveSeatModel("conductor", {
			env: { OMD_ITER_CONDUCTOR_MODEL: "iter:c" },
			modelsMap: {},
			autoAssignMap: {},
			configPath: path,
		});
		expect(alias?.model).toBe("iter:c");
		expect(alias?.via).toBe("OMD_ITER_CONDUCTOR_MODEL");
	});

	test("正名 OMD_<SEAT>_MODEL 压过历史别名", () => {
		const r = tryResolveSeatModel("leaf", {
			env: { OMD_LEAF_MODEL: "proper:l", OMD_ITER_LEAF_MODEL: "iter:l" },
			modelsMap: {},
			autoAssignMap: {},
			configPath: path,
		});
		expect(r?.model).toBe("proper:l");
	});

	test("角色路 resolveRoleModel 与节点路解到同一坐标", () => {
		const p = tmpConfig();
		writeFileSync(p, JSON.stringify({ version: 2, models: { verifier: "acme:v" } }));
		resetConfigCache();
		const viaNode = resolveRoleModelConfigured("verifier", { env: {}, configPath: p });
		// 角色路读默认 configPath(), 故用 OMD_CONFIG_PATH 指到同一份
		const prev = process.env.OMD_CONFIG_PATH;
		process.env.OMD_CONFIG_PATH = p;
		resetConfigCache();
		try {
			expect(resolveRoleModel("verifier", {})).toBe(viaNode.model);
		} finally {
			if (prev === undefined) delete process.env.OMD_CONFIG_PATH;
			else process.env.OMD_CONFIG_PATH = prev;
			resetConfigCache();
		}
	});

	test("review-spec env key = OMD_REVIEW_SPEC_MODEL (连字符→下划线)", () => {
		expect(seatEnvKey("review-spec")).toBe("OMD_REVIEW_SPEC_MODEL");
		expect(
			tryResolveSeatModel("review-spec", {
				env: { OMD_REVIEW_SPEC_MODEL: "qwen:qwen3.7-max" },
				modelsMap: {},
				autoAssignMap: {},
				configPath: path,
			})?.model,
		).toBe("qwen:qwen3.7-max");
	});

	test("座位表 = seats.ts 一处定义 (加座位只改一处)", () => {
		// 2026-08-01 加了 `gate` (内环闸从 judge 拆出) → 17;2026-08-02 摘 `dream` (ADR-0003) → 16;
		// 2026-08-15 加 `fusion` / `graft` (research 终局两发从 judge/reason 拆出, owner 裁) → 18。
		// 数字写死是刻意的: 加座位时这里必须红一次, 逼你去看新座位有没有登记消费点与推荐模型。
		expect(ALL_SEATS).toHaveLength(18);
		expect(Object.keys(NODE_TIER)).toHaveLength(18);
		expect(ALL_SEATS).toContain("continuity");
		expect(ALL_SEATS).toContain("review");
	});
});

describe("config.json autoAssigned 层 — D-17 端到端接线", () => {
	test("persistAutoAssigned 写入磁盘 → auto 层读到", () => {
		const p = tmpConfig();
		persistAutoAssigned({ conductor: "kimi-coding:kimi-k3", leaf: "mimo:mimo-v2.5-pro" }, p);
		resetConfigCache();
		const c = resolveRoleModelConfigured("conductor", { env: {}, modelsMap: {}, configPath: p });
		expect(c.model).toBe("kimi-coding:kimi-k3");
		expect(c.source).toBe("auto");
	});

	test("env 覆盖 auto 层; 未写入磁盘的座位 → 无兜底即抛", () => {
		const p = tmpConfig();
		persistAutoAssigned({ conductor: "kimi-coding:kimi-k3" }, p);
		resetConfigCache();
		const e = resolveRoleModelConfigured("conductor", {
			env: { OMD_CONDUCTOR_MODEL: "x:y" },
			modelsMap: {},
			configPath: p,
		});
		expect(e.model).toBe("x:y");
		expect(e.source).toBe("env");
		expect(() =>
			resolveRoleModelConfigured("judge", { env: {}, modelsMap: {}, configPath: p }),
		).toThrow(SeatUnresolvedError);
	});
});

// INV-MODEL-2 的 GWT 闸: runtime 解析路径不含 deepseek 字面兜底。
// 白名单 = 用户可选的出厂预设 (init/role-presets.ts 是"给用户挑的档", 不是解析兜底) + eval oracle。
describe("INV-MODEL-2 GWT — runtime 解析路径 0 处 deepseek 字面坐标", () => {
	const ALLOW = [
		"src/harness/init/role-presets.ts", // 用户在 init 向导里挑的预设档 (显式选择, 非兜底)
		"src/model/cost-ledger.ts", // 价目表: 坐标是**表的键**, 不是"没配时用谁"
		// 分配策略表 (2026-07-29): 同上一类 —— 坐标是**策略表的值**, 由 `omd models auto` 显式触发,
		// 产出落 config.autoAssigned, 而 autoAssigned 在解析链里**排在 env 之下**。
		// 它不是"解不到就用谁"的兜底, 所以不违反 INV-MODEL-2 (那条禁的是静默兜底)。
		"src/model/auto-assign.ts",
		// 2026-08-15 加: 座位登记表本身。理由与上面 auto-assign.ts **同款** —— `preferredCoord` 就是
		// 那张分配策略表 (`auto-assign.ts:168` 的 NODE_PREFERRED 从 `SEAT_PREFERRED_COORD` 派生),
		// 表搬进了 seats.ts, 白名单也得跟过来。它**不是**"解不到就用谁"的兜底: 解析链是
		// override → config.models → env → autoAssigned → defaultModel, 而 preferredCoord 只喂
		// autoAssign 的产物 autoAssigned, 排在 env 之下。
		// 旁证: 更严的那道闸 `eval/seat-coordinate-gate.test.ts` 也把 seats.ts 列为**声明面**排除。
		"src/model/seats.ts",
	];

	test("src/ 下无 'deepseek:deepseek-' 字面 (白名单外)", () => {
		const out = Bun.spawnSync([
			"ugrep",
			"-rl",
			"-F",
			"deepseek:deepseek-",
			"--include=*.ts",
			"src/",
		]);
		const hits = new TextDecoder()
			.decode(out.stdout)
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.filter((f) => !ALLOW.includes(f))
			.filter((f) => !f.includes(".test.ts") && !f.startsWith("src/eval/"));
		expect(hits).toEqual([]);
	});

	// resolver 自身: 散文注释可以讲这段历史, 但不许再出现**可当坐标用的字面量** (引号里的 deepseek)。
	test("role-models.ts 自身零 deepseek 坐标字面量", () => {
		const src = readFileSync("src/model/role-models.ts", "utf8");
		expect(src).not.toMatch(/['"`]deepseek/);
	});
});
