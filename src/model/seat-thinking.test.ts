import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reasoningEffortFor } from "./index";
import { autoAssign, type SeatThinking } from "./auto-assign";
import { persistAutoAssigned, resolveSeatThinking } from "./role-models";

// S-T 座位推理档随座位下发 (SDD 2026-07-25 skills-compile-evidence-gate S-T)。
// GWT: ① 写入磁盘分配含座位档 → 按坐标反查得该档 ② 老 config 无该段 → undefined (行为不变)
//      ③ 多座位共用坐标档位不一致 → 取最高档 (不静默降 verify/judge)。

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omd-seat-thinking-"));
	path = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("auto-assign 下发座位档", () => {
	test("每条分配都带 thinkingLevel", () => {
		const map = autoAssign({
			channels: [
				{ provider: "kimi-coding", kind: "prepaid", rate: 1 },
				{ provider: "mimo", kind: "flat-sub", rate: 0 },
				{ provider: "opencode-go", kind: "flat-sub", rate: 0 },
			] as never,
		});
		if (Object.keys(map).length === 0) return; // 无评级快照的环境: 分配为空, 该用例不适用
		for (const a of Object.values(map)) expect(a.thinkingLevel).toBeDefined();
	});

	/**
	 * ★ **约束搬层了, 断言跟着搬** (2026-08-01)。
	 *
	 * 这里原来钉的是「任何座位都不得配 xhigh」, 理由是 xhigh 在 transport 层映 'max',
	 * 而 mimo (多条溢出链的落点) 实测拒 'max' → HTTP 400 整节点白挂。那条断言是**在分配表上
	 * 防传输层的坑** —— 当时只能这么防, 因为 pi 那条通道根本不查 `model-caps`。
	 *
	 * 两条传输并成一条之后 (2026-08-01), 每一发都过 `reasoningEffortFor` 按**模型**查实测词表。
	 * 于是防线挪到了它该在的地方: **分配表表达意图 (尽力想), transport 表达能力 (发得出什么)**。
	 * 删掉旧断言而不补这一条, 就是把一道真闸换成了没有闸。
	 */
	test("★ xhigh 的安全性现在由 transport 保证: mimo/qwen 自动降 high, 只有真收 max 的才发 max", () => {
		// 拒 'max' 的两家 —— 分配表配 xhigh 也发不出 max。
		expect(reasoningEffortFor("mimo", "xhigh", "mimo-v2.5-pro")).toBe("high");
		expect(reasoningEffortFor("opencode-go", "xhigh", "qwen3.7-plus")).toBe("high");
		// 收 'max' 的 —— 意图原样出门。
		expect(reasoningEffortFor("deepseek", "xhigh", "deepseek-v4-flash")).toBe("max");
	});
});

describe("resolveSeatThinking 坐标反查", () => {
	test("GWT①: 存盘的分配含座位档 → 按坐标查得该档", () => {
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

describe("resolveSeatThinking · 生效坐标 + 座位提示 (P3 S7 跟进, 2026-09-02)", () => {
	test("GWT④: models 手配压过 autoAssigned —— 手配把 agent 钉到别的模型后, 按新坐标仍查得该座位的档", () => {
		persistAutoAssigned({ agent: "auto:flash" }, path, { agent: "medium" });
		const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...raw, models: { agent: "hand:m3" } }));
		// 证伪: resolveSeatThinking 只看 autoAssigned → 这里 undefined, 红。
		expect(resolveSeatThinking("hand:m3", { configPath: path })).toBe("medium");
	});

	test("GWT⑤: 座位提示绕过「共坐标取最高档」—— worker 与 lens 共用模型, agent 座拿 medium 不是 xhigh", () => {
		persistAutoAssigned({ agent: "shared:m", lens: "shared:m" }, path, { agent: "medium", lens: "xhigh" });
		expect(resolveSeatThinking("shared:m", { configPath: path })).toBe("xhigh"); // 无提示 = 老规则
		expect(resolveSeatThinking("shared:m", { configPath: path, seat: "agent" })).toBe("medium");
		expect(resolveSeatThinking("shared:m", { configPath: path, seat: "lens" })).toBe("xhigh");
		// 提示的座位不在此坐标 → 退回坐标反查 (老行为), 不编一个档。
		expect(resolveSeatThinking("shared:m", { configPath: path, seat: "verifier" })).toBe("xhigh");
	});
});
