/**
 * 座位自检 — INV-MODEL-5 (P0 SDD 2026-07-28)。
 *
 * GWT: *Given* config 座位指向无凭证 provider, *When* run 启动, *Then* 起跑自检**响亮失败**并指名该座位。
 * P0 前: 无凭证座位静默顺延兜底 / 静默落硬编码 deepseek → 跑到 leaf 调用才 402, 报错还不说是哪个座。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		expect(out.find((c) => c.seat === "dream")!.status).toBe("unset");
	});

	test("覆盖全部 16 个座位 (加座位不会漏检)", () => {
		const env = envWithConfig({});
		expect(withEnv(env, () => checkSeats(env))).toHaveLength(16);
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
