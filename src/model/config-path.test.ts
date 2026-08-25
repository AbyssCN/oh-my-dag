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
import { configPath, readConfigPath, resetConfigCache } from "./role-models";

const origCwd = process.cwd();
const origEnv = process.env.OMD_CONFIG_PATH;
const origDataHome = process.env.OMD_DATA_HOME;

afterEach(() => {
	process.chdir(origCwd);
	if (origEnv === undefined) delete process.env.OMD_CONFIG_PATH;
	else process.env.OMD_CONFIG_PATH = origEnv;
	if (origDataHome === undefined) delete process.env.OMD_DATA_HOME;
	else process.env.OMD_DATA_HOME = origDataHome;
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

// ── linked worktree (2026-08-05 实测补的那一格) ────────────────────────────────
//
// ⚠ **linked worktree 的 `.git` 是文件不是目录**, 而 `existsSync` 对文件也返 true ——
//   于是发现停在 worktree 根, 而 `.omd/` 是 gitignored, worktree 里按定义没有它。
//   实测 (真 `git worktree add`): configPath() 指向一个不存在的文件 → 座位全部
//   SeatUnresolvedError, **omd 在任何 linked worktree 下开跑即死** (后台 agent /
//   `--worktree` / Claude Code 的 worktree 全中)。下面这组钉的就是那条回主仓的路。

/** 造「主仓 + linked worktree」的形状 (不需要真 git: 判据只看 `.git` 文件的内容)。 */
function worktreeTree(opts: { gitdir?: string; worktreeHasOwnConfig?: boolean } = {}): {
	main: string;
	wt: string;
} {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "omd-wt-")));
	const main = join(base, "main");
	const wt = join(base, "wt");
	mkdirSync(join(main, ".omd"), { recursive: true });
	writeFileSync(join(main, ".omd", "config.json"), '{"version":2,"models":{"leaf":"main:cfg"}}\n');
	mkdirSync(join(main, ".git"), { recursive: true });
	mkdirSync(wt, { recursive: true });
	// worktree 的 `.git` 是**文件**, 内容是指回主仓 gitdir 的一行
	const gitdir = opts.gitdir ?? join(main, ".git", "worktrees", "wt");
	writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
	if (opts.worktreeHasOwnConfig) {
		mkdirSync(join(wt, ".omd"), { recursive: true });
		writeFileSync(join(wt, ".omd", "config.json"), '{"version":2,"models":{"leaf":"wt:own"}}\n');
	}
	return { main, wt };
}

const pathFrom = (dir: string): string => {
	delete process.env.OMD_CONFIG_PATH;
	process.chdir(dir);
	resetConfigCache();
	return configPath();
};

describe("configPath — linked worktree 回主仓", () => {
	test("★ worktree 里没有自己的 .omd → 解析到**主仓**的 config", () => {
		const { main, wt } = worktreeTree();
		expect(pathFrom(wt)).toBe(join(main, ".omd", "config.json"));
	});

	test("★ worktree **有**自己的 .omd → 用自己的 (规则①仍然先赢)", () => {
		// 这一条守的是"worktree 里跑 = 用 worktree 自己的"那条既有语义没被这次修改吃掉。
		const { wt } = worktreeTree({ worktreeHasOwnConfig: true });
		expect(pathFrom(wt)).toBe(join(wt, ".omd", "config.json"));
	});

	test("★ submodule 的 `.git` 也是文件, 但**不许**重定向到宿主仓", () => {
		// submodule 是另一个仓, 它的配置本就不该跟宿主共用。判据只认 `/.git/worktrees/` 那一种。
		const { wt } = worktreeTree({ gitdir: "../.git/modules/foo" });
		expect(pathFrom(wt)).toBe(join(wt, ".omd", "config.json"));
	});

	test("`.git` 文件内容读不懂 → 回落原行为, 不抛 (fail-open)", () => {
		const { wt } = worktreeTree({ gitdir: "" });
		expect(pathFrom(wt)).toBe(join(wt, ".omd", "config.json"));
	});

	test("普通仓 (`.git` 是目录) 行为不变", () => {
		const { main } = worktreeTree();
		expect(pathFrom(main)).toBe(join(main, ".omd", "config.json"));
	});
});

// ── 读路径回落家目录 (2026-08-25 owner 裁: "找不到就回退") ──────────────────────
//
// 病灶: 座位是**逐仓**配的, 而 configPath() 走到 `.git` 就停 (上面那条"不越过 repo 边界"的
// 反向钉)。于是任何还没 `omd models auto` 过的仓, config 指向一个不存在的文件 → 18 个座位
// 全未配 → conductor 解不到模型 → **omd MCP server 在该仓启动即抛 SeatUnresolvedError**。
// 实测 (talous-v2): `claude mcp list` 显示 omd `✘ Failed to connect — Connection closed`。
//
// 修法**只动读, 不动写** —— 这是与那条反向钉共存的关键:
//   · configPath() (写路径) 逐字节不变 → `omd models auto` / init 仍写进本仓, 不会去改家目录那份;
//   · readConfigPath() (读路径) 在本仓那份**不存在**时回落 `~/.omd/config.json`, 并 logger.warn
//     记明回落来源 (INV-7 不静默降级) —— 原注释担心的"配置从哪来的最难查", 由那行 warn 答。
// 所以"劫持"只发生在本来就会崩的场合, 且响一声。

/** 造「家目录 config」+「一个没有自己 config 的仓」。 */
function homeFallbackTree(opts: { repoHasOwnConfig?: boolean; homeHasConfig?: boolean } = {}): {
	home: string;
	repo: string;
} {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "omd-homefb-")));
	const home = join(base, "home", ".omd");
	if (opts.homeHasConfig !== false) {
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "config.json"), '{"version":2,"models":{"conductor":"home:cfg"}}\n');
	}
	const repo = join(base, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	if (opts.repoHasOwnConfig) {
		mkdirSync(join(repo, ".omd"), { recursive: true });
		writeFileSync(join(repo, ".omd", "config.json"), '{"version":2,"models":{"conductor":"repo:own"}}\n');
	}
	return { home, repo };
}

const readFrom = (dir: string, dataHome: string): string => {
	delete process.env.OMD_CONFIG_PATH;
	process.env.OMD_DATA_HOME = dataHome;
	process.chdir(dir);
	resetConfigCache();
	return readConfigPath();
};

describe("readConfigPath — 本仓无 config 时回落家目录", () => {
	test("★ 仓里没有 .omd/config.json + 家目录有 → 读家目录那份", () => {
		const { home, repo } = homeFallbackTree();
		expect(readFrom(repo, home)).toBe(join(home, "config.json"));
	});

	test("★ 写路径**不**跟着回落 (omd models auto 仍写进本仓, 不改家目录那份)", () => {
		const { home, repo } = homeFallbackTree();
		readFrom(repo, home);
		expect(configPath()).toBe(join(repo, ".omd", "config.json"));
	});

	test("★ 仓里**有**自己的 config → 用自己的, 家目录那份不许劫持", () => {
		const { home, repo } = homeFallbackTree({ repoHasOwnConfig: true });
		expect(readFrom(repo, home)).toBe(join(repo, ".omd", "config.json"));
	});

	test("★ 家目录也没有 → 回落原行为 (仍指本仓, 让座位响亮失败)", () => {
		const { home, repo } = homeFallbackTree({ homeHasConfig: false });
		expect(readFrom(repo, home)).toBe(join(repo, ".omd", "config.json"));
	});

	test("★ OMD_CONFIG_PATH 显式即权威 → 不回落 (哪怕它指向不存在的文件)", () => {
		const { home, repo } = homeFallbackTree();
		process.env.OMD_DATA_HOME = home;
		process.chdir(repo);
		process.env.OMD_CONFIG_PATH = join(repo, "nope.json");
		resetConfigCache();
		expect(readConfigPath()).toBe(join(repo, "nope.json"));
	});
});
