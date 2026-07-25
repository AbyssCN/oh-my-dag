import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoAssign, type SeatThinking } from "./auto-assign";
import { persistAutoAssigned, resolveSeatThinking } from "./role-models";

// S-T 座位推理档随座位下发 (SDD 2026-07-25 skills-compile-evidence-gate S-T)。
// GWT: ① 落盘分配含座位档 → 按坐标反查得该档 ② 老 config 无该段 → undefined (行为不变)
//      ③ 多座位共用坐标档位不一致 → 取最高档 (不静默降 verify/judge)。

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omd-seat-thinking-"));
	path = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("auto-assign 下发座位档", () => {
	test("每条分配都带 thinkingLevel; 上限是 high 不是 xhigh (mimo 实测 max→400)", () => {
		const map = autoAssign({
			channels: [
				{ provider: "kimi-coding", kind: "prepaid", rate: 1 },
				{ provider: "mimo", kind: "flat-sub", rate: 0 },
				{ provider: "opencode-go", kind: "flat-sub", rate: 0 },
			] as never,
		});
		if (Object.keys(map).length === 0) return; // 无评级快照的环境: 分配为空, 该用例不适用
		for (const a of Object.values(map)) expect(a.thinkingLevel).toBeDefined();
		// 任何座位都不得配 xhigh: 它在 transport 层映 'max', 而 mimo (worker 首选 + 多条溢出链的落点)
		// 实测只接受 low/medium/high, 'max' → HTTP 400 = 整节点白挂。
		for (const a of Object.values(map)) expect(a.thinkingLevel).not.toBe("xhigh");
	});
});

describe("resolveSeatThinking 坐标反查", () => {
	test("GWT①: 落盘分配含座位档 → 按坐标查得该档", () => {
		persistAutoAssigned({ leaf: "mimo:pro", judge: "sol:gpt" }, path, {
			leaf: "low",
			judge: "xhigh",
		});
		expect(resolveSeatThinking("mimo:pro", { configPath: path })).toBe("low");
		expect(resolveSeatThinking("sol:gpt", { configPath: path })).toBe("xhigh");
	});

	test("GWT②: 老 config (只有 autoAssigned 无档段) → undefined, 调用方回落原默认", () => {
		writeFileSync(path, JSON.stringify({ autoAssigned: { leaf: "mimo:pro" } }));
		expect(resolveSeatThinking("mimo:pro", { configPath: path })).toBeUndefined();
	});

	test("没有座位落在该坐标 → undefined", () => {
		persistAutoAssigned({ leaf: "mimo:pro" }, path, { leaf: "low" });
		expect(resolveSeatThinking("other:model", { configPath: path })).toBeUndefined();
	});

	test("GWT③: 多座位共用坐标且档不一致 → 取最高档 (宁可多烧 token 也不静默降 verify 座)", () => {
		persistAutoAssigned({ leaf: "shared:m", verifier: "shared:m" }, path, {
			leaf: "low",
			verifier: "xhigh",
		});
		expect(resolveSeatThinking("shared:m", { configPath: path })).toBe("xhigh");
	});

	test("坏档值被丢弃 (fail-open: 手改 config 打错字不炸引擎)", () => {
		writeFileSync(
			path,
			JSON.stringify({ autoAssigned: { leaf: "m:x" }, autoAssignedThinking: { leaf: "ultra-max" } }),
		);
		expect(resolveSeatThinking("m:x", { configPath: path })).toBeUndefined();
	});

	test("持久化不吞既有段 (models / autoAssigned 都在)", () => {
		writeFileSync(path, JSON.stringify({ models: { judge: "a:b" } }));
		persistAutoAssigned({ leaf: "m:x" }, path, { leaf: "low" });
		const cfg = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
		expect(cfg.models).toEqual({ judge: "a:b" });
		expect(cfg.autoAssigned).toEqual({ leaf: "m:x" });
		expect(cfg.autoAssignedThinking).toEqual({ leaf: "low" });
	});

	test("不传 thinking 时不写档段 (老调用方零影响)", () => {
		persistAutoAssigned({ leaf: "m:x" }, path);
		const cfg = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
		expect(cfg.autoAssignedThinking).toBeUndefined();
	});

	test("注入 map 走纯链 (不读盘, hermetic)", () => {
		const thinkingMap: Record<string, SeatThinking> = { leaf: "medium" };
		expect(
			resolveSeatThinking("m:x", { autoAssignMap: { leaf: "m:x" }, thinkingMap }),
		).toBe("medium");
	});
});
