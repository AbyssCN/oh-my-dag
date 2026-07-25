/**
 * src/harness/render/omd-render —— render CLI 的逻辑件: 把 UI 交付 (本地 HTML / http(s) URL) 渲染成 PNG 像素证据。
 *
 * 产物约定: 每张截图一个绝对路径, 由 CLI 层逐行打印到 stdout; 下游 attach_media 审查 leaf 靠
 * leaf-media 的 extractMediaRefs 正则从输出里拾取这些路径喂给多模态模型, 因此文件名必须满足
 * RND-3 硬约束 (绝对路径、无空格、.png 结尾), 否则像素证据静默丢失。
 *
 * Invariants:
 *  RND-1 解析零 IO: parseRenderArgs 纯函数; resolveChromiumPath 的探测 (env/文件/目录/PATH) 全可注入, 单测不碰真文件系统。
 *  RND-2 惰性依赖: playwright-core 是 devDependency (14MB 驱动不随主包分发, 像素证据是可选能力),
 *        只在 renderTargets 内 dynamic import, 不跑任何 install; 模块缺失 / 浏览器起不来
 *        → 各抛一条可操作指引 (装 playwright-core · 设 OMD_CHROMIUM_PATH 或 npx playwright install chromium)。
 *  RND-3 产物名硬约束: 绝对路径、不含空格、.png 结尾, 必须被 leaf-media 的 MEDIA_REF_RE 原样命中。
 *  RND-4 显式失败: 缺 target / 未知 flag / 非法 WxH / flag 缺值 → 一律抛错, 不猜缺省。
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright-core";

// ---------------------------------------------------------------------------
// RND-1 参数解析 (纯函数, 零 IO)
// ---------------------------------------------------------------------------

export interface Viewport {
	width: number;
	height: number;
}

export interface RenderArgs {
	/** 渲染目标: 本地 HTML 路径或 http(s) URL。 */
	target: string;
	/** 产物目录 (缺省 .omd/render/<slug>-<时间戳>/)。 */
	out?: string;
	/** 视口列表 (--viewport 可重复累积; 缺省单个 1280x800)。 */
	viewports: Viewport[];
	/** 基线截图后施加 hover 的 selector。 */
	hover?: string;
	/** 基线截图后施加 focus 的 selector。 */
	focus?: string;
	/** 定时抽帧数 (--frames 无值取 4, 超过 8 夹到 8); 给了 frames 走抽帧, 不拍基线/hover/focus。 */
	frames?: number;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };
const DEFAULT_FRAMES = 4;
const MAX_FRAMES = 8;

const USAGE =
	"omd-render <file|url> [--out <dir>] [--viewport WxH]... [--hover <sel>] [--focus <sel>] [--frames [n]]";

/**
 * argv (不含 node/脚本名) → RenderArgs。RND-4: 一切非法输入抛错, 行为明确。
 * --frames 的值可选: 仅当下一 token 是纯数字串才吞作帧数, 否则取缺省 4 (target 跟在后面不会被误吞)。
 */
export function parseRenderArgs(argv: string[]): RenderArgs {
	let target: string | undefined;
	let out: string | undefined;
	const viewports: Viewport[] = [];
	let hover: string | undefined;
	let focus: string | undefined;
	let frames: number | undefined;

	const takeValue = (flag: string, i: number): string => {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith("--"))
			throw new Error(`${flag} 缺值 (${USAGE})`);
		return v;
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--out") {
			out = takeValue(a, i);
			i++;
		} else if (a === "--viewport") {
			const v = takeValue(a, i);
			i++;
			const m = /^(\d+)x(\d+)$/i.exec(v);
			if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0)
				throw new Error(`非法 viewport: ${v} (期望 WxH, 如 1280x800)`);
			viewports.push({ width: Number(m[1]), height: Number(m[2]) });
		} else if (a === "--hover") {
			hover = takeValue(a, i);
			i++;
		} else if (a === "--focus") {
			focus = takeValue(a, i);
			i++;
		} else if (a === "--frames") {
			const v = argv[i + 1];
			if (v !== undefined && /^\d+$/.test(v)) {
				i++;
				const n = Number(v);
				if (n < 1) throw new Error(`非法 frames: ${v} (期望 ≥1 的整数)`);
				frames = Math.min(n, MAX_FRAMES);
			} else {
				frames = DEFAULT_FRAMES;
			}
		} else if (a.startsWith("--")) {
			throw new Error(`未知 flag: ${a} (${USAGE})`);
		} else if (target === undefined) {
			target = a;
		} else {
			throw new Error(`多余的位置参数: ${a} (target 已取 ${target})`);
		}
	}
	if (target === undefined) throw new Error(`缺 target (${USAGE})`);

	const args: RenderArgs = {
		target,
		viewports: viewports.length > 0 ? viewports : [DEFAULT_VIEWPORT],
	};
	if (out !== undefined) args.out = out;
	if (hover !== undefined) args.hover = hover;
	if (focus !== undefined) args.focus = focus;
	if (frames !== undefined) args.frames = frames;
	return args;
}

// ---------------------------------------------------------------------------
// RND-1 chromium 可执行文件解析 (探测全注入)
// ---------------------------------------------------------------------------

export interface ChromiumProbes {
	/** 环境变量表 (缺省 process.env)。 */
	env?: Record<string, string | undefined>;
	/** 文件存在性 (缺省 existsSync)。 */
	fileExists?: (p: string) => boolean;
	/** 列子目录名 (缺省 readdirSync 滤目录; 目录不存在 → [])。 */
	listDirs?: (p: string) => string[];
	/** PATH 查可执行文件 (缺省逐 PATH 目录拼名查存在)。 */
	which?: (cmd: string) => string | undefined;
	/** home 目录 (缺省 homedir())。 */
	homeDir?: string;
}

/** 系统 PATH 候选, 按优先序试。 */
const PATH_CANDIDATES = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
];

/**
 * chromium 可执行文件解析。优先序:
 *  ① OMD_CHROMIUM_PATH (设置且文件存在);
 *  ② ${PLAYWRIGHT_BROWSERS_PATH:-~/.cache/ms-playwright}/chromium-* 版本号最大者
 *     (linux 的 chrome-linux64|chrome-linux, 顺手兼容 mac chrome-mac* / win chrome-win);
 *  ③ PATH 里的 google-chrome-stable / google-chrome / chromium / chromium-browser;
 *  ④ 都没有 → undefined (交 playwright 默认解析)。
 */
export function resolveChromiumPath(
	probes: ChromiumProbes = {},
): string | undefined {
	const env = probes.env ?? process.env;
	const fileExists = probes.fileExists ?? ((p: string) => existsSync(p));
	const listDirs = probes.listDirs ?? defaultListDirs;
	const which =
		probes.which ?? ((cmd: string) => defaultWhich(cmd, env, fileExists));
	const home = probes.homeDir ?? homedir();

	// ① 显式环境变量
	const fromEnv = env.OMD_CHROMIUM_PATH;
	if (fromEnv && fileExists(fromEnv)) return fromEnv;

	// ② playwright 受管缓存, 版本号 (chromium-<num>) 最大者
	const browsersRoot =
		env.PLAYWRIGHT_BROWSERS_PATH ?? join(home, ".cache", "ms-playwright");
	const versions = listDirs(browsersRoot)
		.filter((d) => /^chromium-\d+$/.test(d))
		.sort(
			(a, b) =>
				Number(b.slice("chromium-".length)) -
				Number(a.slice("chromium-".length)),
		);
	for (const ver of versions) {
		const dir = join(browsersRoot, ver);
		for (const rel of [
			"chrome-linux64/chrome",
			"chrome-linux/chrome",
			"chrome-win/chrome.exe",
		]) {
			const p = join(dir, rel);
			if (fileExists(p)) return p;
		}
		for (const mac of listDirs(dir).filter((d) => d.startsWith("chrome-mac"))) {
			const p = join(dir, mac, "Chromium.app/Contents/MacOS/Chromium");
			if (fileExists(p)) return p;
		}
	}

	// ③ 系统 PATH
	for (const cmd of PATH_CANDIDATES) {
		const p = which(cmd);
		if (p) return p;
	}
	// ④ 交 playwright 默认解析
	return undefined;
}

function defaultListDirs(p: string): string[] {
	try {
		return readdirSync(p, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
}

function defaultWhich(
	cmd: string,
	env: Record<string, string | undefined>,
	fileExists: (p: string) => boolean,
): string | undefined {
	for (const dir of (env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = join(dir, cmd);
		if (fileExists(p)) return p;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// RND-2 渲染 (playwright-core 惰性 import)
// ---------------------------------------------------------------------------

export interface RenderTargetsOpts {
	/** 渲染目标: 本地 HTML 路径或 http(s) URL。 */
	target: string;
	/** 产物目录 (缺省 .omd/render/<slug>-<时间戳>/, 递归自建)。 */
	out?: string;
	/** 视口列表 (缺省单个 1280x800)。 */
	viewports?: Viewport[];
	hover?: string;
	focus?: string;
	/** 抽帧数 (>0 走抽帧模式, 顶到 8); 与 hover/focus 互斥 — 给了 frames 不拍基线/hover/focus。 */
	frames?: number;
	/** 相对 out / 相对本地文件路径的锚 (缺省 process.cwd())。 */
	cwd?: string;
	/** chromium 解析探测注入 (测试用)。 */
	probes?: ChromiumProbes;
	/** 抽帧间隔 ms (缺省 500; 测试可压小)。 */
	frameIntervalMs?: number;
}

const FRAME_INTERVAL_MS = 500;

/**
 * 渲染目标 → 截图, 返回产物绝对路径数组 (RND-3 硬约束, 保产生序)。
 * 每个视口: 缺省拍基线 <slug>-<W>x<H>.png; 有 hover/focus 再拍 <base>-hover.png / <base>-focus.png;
 * frames>0 改拍 <base>-frame-01.png .. <base>-frame-<n>.png (定时间隔)。
 */
export async function renderTargets(
	opts: RenderTargetsOpts,
): Promise<string[]> {
	const cwd = opts.cwd ?? process.cwd();
	const url = toUrl(opts.target, cwd);
	const slug = slugOf(opts.target);
	const outDir = opts.out
		? isAbsolute(opts.out)
			? opts.out
			: resolve(cwd, opts.out)
		: resolve(cwd, ".omd", "render", `${slug}-${timestamp()}`);
	mkdirSync(outDir, { recursive: true });
	const viewports =
		opts.viewports && opts.viewports.length > 0
			? opts.viewports
			: [DEFAULT_VIEWPORT];
	const frames = Math.min(Math.max(opts.frames ?? 0, 0), MAX_FRAMES);
	const frameInterval = opts.frameIntervalMs ?? FRAME_INTERVAL_MS;

	const executablePath = resolveChromiumPath(opts.probes ?? {});
	let chromium: typeof import("playwright-core").chromium;
	try {
		({ chromium } = await import("playwright-core"));
	} catch {
		throw new Error(
			"playwright-core 未安装 —— 像素证据链是可选能力, 驱动不随主包分发。\n" +
				"装法: bun add -d playwright-core (或 npm i -D playwright-core)。",
		);
	}
	let browser: Browser;
	try {
		browser = await chromium.launch(executablePath ? { executablePath } : {});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`chromium 起不来: ${msg}\n` +
				"排查: ① 设 OMD_CHROMIUM_PATH=<chrome 绝对路径> 指向本机 Chrome/Chromium; " +
				"② 或跑 npx playwright install chromium 装受管浏览器。",
		);
	}

	const produced: string[] = [];
	try {
		for (const vp of viewports) {
			const page = await browser.newPage({
				viewport: { width: vp.width, height: vp.height },
			});
			try {
				await page.goto(url, { waitUntil: "load" });
				const base = join(outDir, `${slug}-${vp.width}x${vp.height}`);
				const shot = async (suffix: string): Promise<void> => {
					const p = `${base}${suffix}.png`;
					await page.screenshot({ path: p });
					produced.push(p);
				};
				if (frames > 0) {
					for (let i = 1; i <= frames; i++) {
						await page.waitForTimeout(frameInterval);
						await shot(`-frame-${String(i).padStart(2, "0")}`);
					}
				} else {
					await shot("");
					if (opts.hover !== undefined) {
						await page.hover(opts.hover);
						await shot("-hover");
					}
					if (opts.focus !== undefined) {
						await page.focus(opts.focus);
						await shot("-focus");
					}
				}
			} finally {
				await page.close();
			}
		}
	} finally {
		await browser.close();
	}
	return produced;
}

/** 本地文件 → file:// URL (先校验存在); http(s) 直通。 */
function toUrl(target: string, cwd: string): string {
	if (/^https?:\/\//i.test(target)) return target;
	const abs = isAbsolute(target) ? target : resolve(cwd, target);
	if (!existsSync(abs)) throw new Error(`本地文件不存在: ${abs}`);
	return pathToFileURL(abs).href;
}

/** 输入 → 文件名片段: URL 取 host+path, 文件取 basename 去扩展; 非法字符全转 '-', 长 40 封顶 (RND-3 无空格)。 */
function slugOf(target: string): string {
	const raw = /^https?:\/\//i.test(target)
		? new URL(target).hostname + new URL(target).pathname
		: basename(target).replace(/\.[^.]*$/, "");
	const slug = raw
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "render";
}

/** 紧凑时间戳 yyyymmdd-hhmmss (本地时区; 无冒号无空格, 守 RND-3)。 */
function timestamp(d = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
