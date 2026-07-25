/**
 * test/core/omd-render —— render 逻辑件的四层验证:
 *  ① parseRenderArgs 纯函数层 (零 IO, 无条件跑);
 *  ② RND-3 跨切片接缝回归: 产物路径命名规则必须被 leaf-media 的真实 extractMediaRefs 原样命中 (禁复制正则);
 *  ③ resolveChromiumPath 注入探测层 (假 env / 假 fileExists / 假目录列表, 不碰真文件系统);
 *  ④ 集成层: 真 chromium 渲临时 HTML fixture, 断言 PNG 真实落盘 + hover 前后像素不同;
 *     浏览器解析不到时 skipIf 跳过并向 stderr 说明。
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { extractMediaRefs } from "../../src/harness/leaf-media";
import {
	parseRenderArgs,
	renderTargets,
	resolveChromiumPath,
} from "../../src/harness/render/omd-render";

// ---------------------------------------------------------------------------
// ① parseRenderArgs (纯函数)
// ---------------------------------------------------------------------------

describe("parseRenderArgs", () => {
	test("多个 --viewport 累积成数组, 保顺序", () => {
		const args = parseRenderArgs([
			"a.html",
			"--viewport",
			"1280x800",
			"--viewport",
			"375x667",
		]);
		expect(args.target).toBe("a.html");
		expect(args.viewports).toEqual([
			{ width: 1280, height: 800 },
			{ width: 375, height: 667 },
		]);
	});

	test("缺省 viewport = 单个 1280x800", () => {
		expect(parseRenderArgs(["a.html"]).viewports).toEqual([
			{ width: 1280, height: 800 },
		]);
	});

	test("--frames 无值 = 4", () => {
		expect(parseRenderArgs(["a.html", "--frames"]).frames).toBe(4);
	});

	test("--frames 有值取该值", () => {
		expect(parseRenderArgs(["a.html", "--frames", "3"]).frames).toBe(3);
	});

	test("--frames >8 夹到 8", () => {
		expect(parseRenderArgs(["a.html", "--frames", "99"]).frames).toBe(8);
	});

	test("--frames 后面跟 target 不误吞 (target 非纯数字)", () => {
		const args = parseRenderArgs(["--frames", "a.html"]);
		expect(args.frames).toBe(4);
		expect(args.target).toBe("a.html");
	});

	test("缺 target 抛错", () => {
		expect(() => parseRenderArgs(["--viewport", "1280x800"])).toThrow(
			/缺 target/,
		);
	});

	test("未知 flag 抛错", () => {
		expect(() => parseRenderArgs(["a.html", "--nope"])).toThrow(
			/未知 flag: --nope/,
		);
	});
});

// ---------------------------------------------------------------------------
// ② RND-3 接缝回归: 命名规则产物路径 → 真实 extractMediaRefs 必须原样命中
// ---------------------------------------------------------------------------

describe("RND-3 产物路径 × extractMediaRefs 接缝", () => {
	// 按 renderTargets 命名规则 <out>/<slug>-<W>x<H>[-hover|-frame-NN].png 构造 (绝对路径, 无空格)。
	// slug/时间戳函数未导出, 这里按契约规则直构造; 集成层 (④) 再用真产物复验一次。
	test("基线 / -hover / -frame-NN 三种产物名全被原样命中", () => {
		const vp = parseRenderArgs(["index.html"]).viewports[0]!; // 缺省 1280x800
		const outDir = join(tmpdir(), "omd-render-seam");
		const base = join(outDir, `index-${vp.width}x${vp.height}`);
		const produced = [
			`${base}.png`,
			`${base}-hover.png`,
			`${base}-frame-01.png`,
		];
		// 模拟 CLI 逐行打印 stdout, 下游从整段文本拾取
		const stdout = produced.join("\n");
		const refs = extractMediaRefs(stdout);
		expect(refs).toEqual(produced); // 全命中, 不截断, 保序
		for (const p of produced) {
			expect(isAbsolute(p)).toBe(true);
			expect(p).not.toMatch(/\s/);
			expect(p.endsWith(".png")).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// ③ resolveChromiumPath (探测全注入)
// ---------------------------------------------------------------------------

describe("resolveChromiumPath", () => {
	test("env OMD_CHROMIUM_PATH 赢过缓存扫描", () => {
		const p = resolveChromiumPath({
			env: { OMD_CHROMIUM_PATH: "/env/chrome" },
			fileExists: (f) => f === "/env/chrome",
			// 缓存里明明有更新版本, 也必须让位给 env
			listDirs: () => ["chromium-1228"],
			homeDir: "/fakehome",
		});
		expect(p).toBe("/env/chrome");
	});

	test("缓存扫描取版本号最大者 (chromium-1228 > chromium-1220)", () => {
		const root = join("/fakehome", ".cache", "ms-playwright");
		const want = join(root, "chromium-1228", "chrome-linux64", "chrome");
		const p = resolveChromiumPath({
			env: {},
			homeDir: "/fakehome",
			listDirs: (d) => (d === root ? ["chromium-1220", "chromium-1228"] : []),
			fileExists: (f) => f === want,
		});
		expect(p).toBe(want);
	});

	test("env/缓存/PATH 全空 → undefined (交 playwright 默认解析)", () => {
		const p = resolveChromiumPath({
			env: {},
			homeDir: "/fakehome",
			fileExists: () => false,
			listDirs: () => [],
			which: () => undefined,
		});
		expect(p).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// ④ 集成层 (真开浏览器)
// ---------------------------------------------------------------------------

// resolveChromiumPath 已扫 playwright 受管缓存; 它返回 undefined ≈ playwright 默认解析同样失败。
const HAS_CHROMIUM = resolveChromiumPath() !== undefined;
if (!HAS_CHROMIUM) {
	console.error(
		"[omd-render.test] 跳过集成层: 本机解析不到 chromium " +
			"(设 OMD_CHROMIUM_PATH 或 npx playwright install chromium)",
	);
}

describe("renderTargets 集成 (真 chromium)", () => {
	// 临时 fixture: #b:hover 改背景色, 保证 hover 前后像素不同。
	// 基线背景不能写 inline style — inline 特异性高于 #b:hover 规则, 会压掉 hover 态, 全走 stylesheet。
	const fixtureDir = mkdtempSync(join(tmpdir(), "omd-render-it-"));
	const htmlPath = join(fixtureDir, "index.html");
	const outDir = join(fixtureDir, "out");
	writeFileSync(
		htmlPath,
		"<!doctype html><html><head><style>" +
			"body{margin:0} #b{width:200px;height:200px;background:#06c} #b:hover{background:#c00}" +
			'</style></head><body><div id="b"></div></body></html>',
	);

	afterAll(() => {
		rmSync(fixtureDir, { recursive: true, force: true }); // 清理临时文件
	});

	test.skipIf(!HAS_CHROMIUM)(
		"--hover: PNG 真实落盘非空, 路径全绝对且被 extractMediaRefs 命中, 基线与 hover 字节不同",
		async () => {
			const produced = await renderTargets({
				target: htmlPath,
				out: outDir,
				hover: "#b",
			});
			expect(produced).toHaveLength(2); // 基线 + -hover
			for (const p of produced) {
				expect(isAbsolute(p)).toBe(true);
				expect(existsSync(p)).toBe(true);
				expect(statSync(p).size).toBeGreaterThan(0);
			}
			// 接缝复验: 真产物路径全被真实 extractMediaRefs 命中
			expect(extractMediaRefs(produced.join("\n"))).toEqual(produced);
			// hover 生效: 基线图与 hover 图字节内容不同 (#b 背景 #06c → #c00)
			const [baseline, hovered] = produced as [string, string];
			const b1 = readFileSync(baseline);
			const b2 = readFileSync(hovered);
			expect(b1.equals(b2)).toBe(false);
		},
		30_000,
	);
});
