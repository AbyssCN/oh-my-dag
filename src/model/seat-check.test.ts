/**
 * 座位自检 — INV-MODEL-5 (P0 SDD 2026-07-28)。
 *
 * GWT: *Given* config 座位指向无凭证 provider, *When* run 启动, *Then* 起跑自检**响亮失败**并指名该座位。
 * P0 前: 无凭证座位静默顺延兜底 / 静默落硬编码 deepseek → 跑到 leaf 调用才 402, 报错还不说是哪个座。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPiTransportDepsForTest } from "./pi-transport";
import { reportProviderFailure, resetProviderCooldowns } from "./provider-health";
import { assertSeatsUsable, checkSeats } from "./role-fallback";
import { resetConfigCache } from "./role-models";

/** 指向一份自造 config 的 env (无任何 provider 凭证 → 全部座位 no-credential)。 */
function envWithConfig(models: Record<string, string>): Record<string, string | undefined> {
	const path = join(mkdtempSync(join(tmpdir(), "omd-seatchk-")), "config.json");
	writeFileSync(path, JSON.stringify({ version: 2, models }));
	resetConfigCache();
	return { OMD_CONFIG_PATH: path };
}

/** checkSeats / assertSeatsUsable 读 process.env 的 OMD_CONFIG_PATH, 故临时接管再还原。 */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
	const prev = process.env.OMD_CONFIG_PATH;
	if (env.OMD_CONFIG_PATH) process.env.OMD_CONFIG_PATH = env.OMD_CONFIG_PATH;
	resetConfigCache();
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.OMD_CONFIG_PATH;
		else process.env.OMD_CONFIG_PATH = prev;
		resetConfigCache();
	}
}

describe("checkSeats — 全座位自检 (纯读, 不抛)", () => {
	test("未配座位 → status 'unset'; 有坐标但无凭证 → 'no-credential'", () => {
		const env = envWithConfig({ conductor: "nosuchvendor:m1" });
		const out = withEnv(env, () => checkSeats(env));
		const conductor = out.find((c) => c.seat === "conductor")!;
		expect(conductor.coord).toBe("nosuchvendor:m1");
		expect(conductor.status).toBe("no-credential");
		// 其余座位这份 config 一个没配, 且无 defaultModel → unset
		expect(out.find((c) => c.seat === "continuity")!.status).toBe("unset");
	});

	test("覆盖全部座位 (加座位不会漏检)", () => {
		const env = envWithConfig({});
		// ⚠ 这个字面量**就是闸**: 改成 `ALL_SEAT_IDS.length` 会变成恒真式 (checkSeats 遍历的正是
		// ALL_SEATS), 绊线就没了。加座位时手动抬这个数 = 被迫确认「新座位真的进自检了」。
		// 16 → 18: 2026-08-15 加 `fusion` / `graft` 两座 (research 终局两发从 judge/reason 拆出)。
		// 18 → 17: 2026-09-04 删 `gate` 座 (消费者全死, 随 v1 退役)。
		expect(withEnv(env, () => checkSeats(env))).toHaveLength(17);
	});
});

describe("assertSeatsUsable — 计划期硬闸 (响亮失败)", () => {
	test("无凭证座位 → 抛, 错误里指名座位 + 坐标 + 修法", () => {
		const env = envWithConfig({ conductor: "nosuchvendor:m1", leaf: "nosuchvendor:m2" });
		let msg = "";
		withEnv(env, () => {
			try {
				assertSeatsUsable(["conductor", "leaf"], env);
			} catch (e) {
				msg = (e as Error).message;
			}
		});
		expect(msg).toContain("conductor=nosuchvendor:m1");
		expect(msg).toContain("无凭证");
		expect(msg).toContain("omd_set_role");
	});

	test("未配座位 → 抛并标 <未配>", () => {
		const env = envWithConfig({});
		let msg = "";
		withEnv(env, () => {
			try {
				assertSeatsUsable(["agent"], env);
			} catch (e) {
				msg = (e as Error).message;
			}
		});
		expect(msg).toContain("agent=<未配>");
	});

	// 只闸「本次 run 真要用的座位」: dream/continuity 是 opt-in 后台角色, 没配不该挡住一次 dag_run。
	test("闸外座位不影响 (opt-in 后台角色没配也放行)", () => {
		const env = envWithConfig({ conductor: "nosuchvendor:m1" });
		withEnv(env, () => {
			// conductor 无凭证 → 闸内会抛
			expect(() => assertSeatsUsable(["conductor"], env)).toThrow();
			// 空闸 = 什么都不检 → 不抛
			expect(() => assertSeatsUsable([], env)).not.toThrow();
		});
	});
});

/**
 * 「无凭证」与「冷却中」是两种态, 不许压成一个 —— 票 t-judge-cred (2026-09-02, 仓规静默坑 1)。
 *
 * 此前 `checkSeats` 把两者都标成 `no-credential`, `[role-seat]` WARN 于是对一个凭证齐全、
 * 只是本机记着一次 402/403 的座位喊「无可用凭证」。owner 照这句话去查 `credentialed()`,
 * 而 `credentialed()` 是对的 —— 一条把人指向错文件的告警比没有告警更贵。
 *
 * 反向自检: 把 `seatStatusOf` 的 cooling 分支删掉 (回到二态) → 第一条当场红;
 *          把凭证那一跳删掉 → 第二条当场红 (真无凭证的座位会被误报成 cooling)。
 */
describe("checkSeats — 冷却中 ≠ 无凭证 (票 t-judge-cred)", () => {
	// auth.json 指向不存在文件 → 凭证只认传入的 env, 不被真机 `~/.pi/agent/auth.json` 干扰
	// (那份里就有 opencode-go, 不隔离的话「真无凭证」那条恒绿 = 假闸)。
	beforeEach(() => {
		setPiTransportDepsForTest({ authPath: "/nonexistent/omd-test-auth.json" });
		resetProviderCooldowns();
	});
	afterAll(() => {
		setPiTransportDepsForTest();
		resetProviderCooldowns();
	});

	test("有凭证但熔断冷却中 → status 'cooling', 且 WARN 文案说的是冷却不是凭证", () => {
		const env = { ...envWithConfig({ judge: "opencode-go:glm-5.2" }), OPENCODE_API_KEY: "sk-x" };
		// 默认 30s 瞬时档 → 只在进程内存, 不写 `.omd/seat-health.json` (周期档才写盘)。
		reportProviderFailure("opencode-go:glm-5.2");
		try {
			const judge = withEnv(env, () => checkSeats(env)).find((c) => c.seat === "judge")!;
			expect(judge.status).toBe("cooling");
			let msg = "";
			withEnv(env, () => {
				try {
					assertSeatsUsable(["judge"], env);
				} catch (e) {
					msg = (e as Error).message;
				}
			});
			expect(msg).toContain("judge=opencode-go:glm-5.2 (熔断冷却中)");
		} finally {
			resetProviderCooldowns();
		}
	});

	test("真无凭证 (没 key 也没冷却) → 仍是 'no-credential' (修的是分辨率, 不是放水)", () => {
		const env = envWithConfig({ judge: "opencode-go:glm-5.2" });
		const judge = withEnv(env, () => checkSeats(env)).find((c) => c.seat === "judge")!;
		expect(judge.status).toBe("no-credential");
	});
});
