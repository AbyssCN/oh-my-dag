/**
 * config 路径发现 — INV-MODEL-4 (P0 SDD 2026-07-28)。
 *
 * GWT: server 与脚本从**不同 cwd** 启动, 各自解析 config → 读同一份文件 (或路径经 OMD_CONFIG_PATH 显式)。
 * P0 前是裸 `.omd/config.json` cwd-相对: 从子目录起的进程读的是一份**不存在**的 config, 于是
 * 全部座位落硬编码默认, 而用户以为自己配好了。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { configPath, resetConfigCache } from "./role-models";

const origCwd = process.cwd();
const origEnv = process.env.OMD_CONFIG_PATH;

afterEach(() => {
	process.chdir(origCwd);
	if (origEnv === undefined) delete process.env.OMD_CONFIG_PATH;
	else process.env.OMD_CONFIG_PATH = origEnv;
	resetConfigCache();
});

/** 造一棵 <root>/.omd/config.json + <root>/a/b 的临时树 (macOS 的 /var→/private/var 用 realpath 归一)。 */
function tree(withConfig = true): { root: string; deep: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "omd-cfgpath-")));
	const deep = join(root, "a", "b");
	mkdirSync(deep, { recursive: true });
	if (withConfig) {
		mkdirSync(join(root, ".omd"), { recursive: true });
		writeFileSync(join(root, ".omd", "config.json"), '{"version":2}\n');
	}
	return { root, deep };
}

describe("configPath — INV-MODEL-4 确定性路径", () => {
	test("深层子目录起 → 向上找到祖先的 .omd/config.json (同一份)", () => {
		const { root, deep } = tree();
		delete process.env.OMD_CONFIG_PATH;
		process.chdir(root);
		resetConfigCache();
		const fromRoot = configPath();
		process.chdir(deep);
		resetConfigCache();
		const fromDeep = configPath();
		expect(fromDeep).toBe(fromRoot);
		expect(fromRoot).toBe(join(root, ".omd", "config.json"));
	});

	test("返回绝对路径 (cwd 之后再变也不会读串)", () => {
		const { deep } = tree();
		delete process.env.OMD_CONFIG_PATH;
		process.chdir(deep);
		resetConfigCache();
		expect(configPath().startsWith("/")).toBe(true);
	});

	test("无现成 config 但有 .git → 落 repo 根 (init/models auto 写到这里)", () => {
		const { root, deep } = tree(false);
		mkdirSync(join(root, ".git"), { recursive: true });
		delete process.env.OMD_CONFIG_PATH;
		process.chdir(deep);
		resetConfigCache();
		expect(configPath()).toBe(join(root, ".omd", "config.json"));
	});

	test("OMD_CONFIG_PATH 显式即权威; 相对路径对 cwd 解析成绝对", () => {
		const { root, deep } = tree();
		process.chdir(deep);
		process.env.OMD_CONFIG_PATH = "custom.json";
		resetConfigCache();
		expect(configPath()).toBe(join(deep, "custom.json"));
		process.env.OMD_CONFIG_PATH = join(root, "abs.json");
		resetConfigCache();
		expect(configPath()).toBe(join(root, "abs.json"));
	});

	// 反向钉: 游离的 ~/.omd/config.json 不许劫持一个还没 init 的仓 (走到 .git 就停)。
	test("仓内不越过 repo 边界去捡祖先的 config", () => {
		const outer = realpathSync(mkdtempSync(join(tmpdir(), "omd-outer-")));
		mkdirSync(join(outer, ".omd"), { recursive: true });
		writeFileSync(join(outer, ".omd", "config.json"), '{"version":2}\n');
		const repo = join(outer, "repo", "pkg");
		mkdirSync(repo, { recursive: true });
		mkdirSync(join(outer, "repo", ".git"), { recursive: true });
		delete process.env.OMD_CONFIG_PATH;
		process.chdir(repo);
		resetConfigCache();
		expect(configPath()).toBe(join(outer, "repo", ".omd", "config.json"));
	});

	test("cwd 变了 → 重新发现 (路径缓存以 cwd+env 为键, 不粘住)", () => {
		const a = tree();
		const b = tree();
		delete process.env.OMD_CONFIG_PATH;
		process.chdir(a.deep);
		resetConfigCache();
		const first = configPath();
		process.chdir(b.deep); // 不调 resetConfigCache: 缓存必须自己认出 cwd 变了
		expect(configPath()).not.toBe(first);
		expect(configPath()).toBe(join(b.root, ".omd", "config.json"));
	});
});
