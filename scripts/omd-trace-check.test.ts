// omd-trace-check 测试 —— 契约: docs/plan/2026-07-31-omd-trace-check.md (2026-07-31 冻结)。
// 零真实 I/O (GWT-14): 所有 observation 都是测试内字面量; 每次 run 调用显式注入隔离的
// env/readText/fake fetch; 未注入的 global fetch 被替换为一调用就抛的间谍且调用数恒 0。
// 分组: T-1 纯统计 (GWT-7..12) / T-2 凭证与 CLI 边界 (GWT-1..4, 13) / T-3 认证与分页 (GWT-5, 6)。
import {
	afterAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	OMD_TRACE_CHECK_USAGE,
	TraceCheckArgsError,
	TraceCheckDataError,
	TraceCheckFetchError,
	fetchTraceObservations,
	formatTraceReadout,
	loadTraceCheckConfig,
	parseTraceCheckArgs,
	runOmdTraceCheck,
	summarizeTraceObservations,
	type LangfuseConfig,
	type LangfuseObservation,
	type TraceCheckDeps,
} from "./omd-trace-check";

type Obs = Partial<LangfuseObservation> &
	Pick<LangfuseObservation, "id" | "type">;

/** 单条假 observation; 默认字段是真实 API 序列化后的最小合法形状。 */
function obs(
	id: string,
	type: string,
	rest: Partial<LangfuseObservation> = {},
): LangfuseObservation {
	const o: Obs = {
		id,
		type,
		name: null,
		model: null,
		metadata: {},
		parentObservationId: null,
	};
	return { ...o, ...rest } as LangfuseObservation;
}

/** 假 GENERATION observation, metadata 可注入。 */
function gen(
	id: string,
	metadata: Record<string, unknown>,
	rest: Partial<LangfuseObservation> = {},
): LangfuseObservation {
	return obs(id, "GENERATION", { metadata, ...rest });
}

const GOOD_SECRETS = JSON.stringify({
	langfuse: { host: "https://lf.example.com", publicKey: "pk-1", secretKey: "sk-2" },
});
const GOOD_CONFIG: LangfuseConfig = {
	host: "https://lf.example.com",
	publicKey: "pk-1",
	secretKey: "sk-2",
};

// ── 假 fetch 面 (T-3): 只走内存 Response, 不碰网络 ────────────────────────────
function page(data: unknown[], totalItems: number): Response {
	return new Response(JSON.stringify({ data, meta: { totalItems } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
function rawPage(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

interface RigOpts {
	env?: Record<string, string | undefined>;
	/** readText 返回值; 缺省返回 "{}" (非合法 langfuse 配置)。 */
	secrets?: string;
	/** readText 一调用就抛。 */
	readThrows?: boolean;
	/** 按序返回的页; 缺省 fetch 一调用就抛。 */
	pages?: Response[];
	fetchImpl?: typeof fetch;
}
interface Rig {
	deps: TraceCheckDeps;
	out: string[];
	err: string[];
	readPaths: string[];
	fetchCalls: { url: string; init?: RequestInit }[];
}
/** 注入隔离 deps 的 rig: 记录 readText 路径 / fetch 调用 / out / err。 */
function makeRig(o: RigOpts = {}): Rig {
	const out: string[] = [];
	const err: string[] = [];
	const readPaths: string[] = [];
	const fetchCalls: { url: string; init?: RequestInit }[] = [];
	const readText = (p: string) => {
		readPaths.push(p);
		if (o.readThrows) throw new Error("read boom");
		return o.secrets ?? "{}";
	};
	const fetchImpl =
		o.fetchImpl ??
		((async (input: string | URL, init?: RequestInit) => {
			fetchCalls.push({ url: String(input), init });
			if (!o.pages) throw new Error("fetch boom");
			return o.pages[Math.min(fetchCalls.length - 1, o.pages.length - 1)]!;
		}) as typeof fetch);
	return {
		deps: {
			env: o.env,
			readText,
			fetchImpl,
			out: (l) => out.push(l),
			err: (l) => err.push(l),
		},
		out,
		err,
		readPaths,
		fetchCalls,
	};
}

// GWT-14 防联网: global fetch 一调用就抛且计数; 任何漏注入都会让 afterAll 红。
const globalFetchCalls: string[] = [];
const guardFetch = async (input: string | URL) => {
	globalFetchCalls.push(String(input));
	throw new Error("GWT-14: 测试不得触碰 global fetch");
};
beforeEach(() => {
	(globalThis as unknown as { fetch: typeof fetch }).fetch =
		guardFetch as unknown as typeof fetch;
});
afterAll(() => {
	expect(globalFetchCalls).toEqual([]);
});

// ── T-1 纯统计 (GWT-7..12) ─────────────────────────────────────────────────────
describe("parseTraceCheckArgs · 参数前置 (GWT-1/GWT-2)", () => {
	test("-h / --help 单独出现 → help", () => {
		expect(parseTraceCheckArgs(["-h"])).toEqual({ help: true });
		expect(parseTraceCheckArgs(["--help"])).toEqual({ help: true });
	});

	test("--trace-id <value> 是唯一合法形态, 原值 verbatim 保留", () => {
		expect(parseTraceCheckArgs(["--trace-id", "abc_123"])).toEqual({
			help: false,
			traceId: "abc_123",
		});
		expect(parseTraceCheckArgs(["--trace-id", "  keep  "])).toEqual({
			help: false,
			traceId: "  keep  ",
		});
	});

	test("缺/空白值/重复 flag/未知 flag/位置参数/help 混用 → TraceCheckArgsError", () => {
		const bads: string[][] = [
			[],
			["pos"],
			["--trace-id"],
			["--trace-id", "   "],
			["--trace-id", "a", "--trace-id", "b"],
			["--trace-id", "a", "pos"],
			["--bogus"],
			["--help", "--trace-id", "a"],
		];
		for (const argv of bads) {
			expect(() => parseTraceCheckArgs(argv)).toThrow(TraceCheckArgsError);
		}
	});
});

describe("loadTraceCheckConfig · 路径与规范化 (GWT-3)", () => {
	test("XDG_CONFIG_HOME 优先; 全空白/缺席回退 HOME", () => {
		const paths: string[] = [];
		const readText = (p: string) => {
			paths.push(p);
			return GOOD_SECRETS;
		};
		loadTraceCheckConfig(
			{ XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/tmp/home" },
			readText,
		);
		loadTraceCheckConfig(
			{ XDG_CONFIG_HOME: "   ", HOME: "/tmp/home" },
			readText,
		);
		loadTraceCheckConfig({ HOME: "/tmp/home" }, readText);
		expect(paths).toEqual([
			"/tmp/xdg/omd/secrets.json",
			"/tmp/home/.config/omd/secrets.json",
			"/tmp/home/.config/omd/secrets.json",
		]);
	});

	test("host 去尾部斜杠; 三字段 trim", () => {
		const cfg = loadTraceCheckConfig({}, () =>
			JSON.stringify({
				langfuse: {
					host: " https://lf.example.com/ ",
					publicKey: " pk ",
					secretKey: " sk ",
				},
			}),
		);
		expect(cfg).toEqual({
			host: "https://lf.example.com",
			publicKey: "pk",
			secretKey: "sk",
		});
	});
});

describe("summarizeTraceObservations · 形状精算与顺序无关 (GWT-7)", () => {
	const g7 = (): LangfuseObservation[] => [
		obs("g", "GENERATION", { parentObservationId: "a" }),
		obs("c", "SPAN", { parentObservationId: "o" }),
		obs("a", "SPAN", { parentObservationId: "r" }),
		obs("o", "SPAN", { parentObservationId: "missing" }),
		obs("r2", "SPAN"),
		obs("r", "SPAN"),
	];

	test("子先父后与逆序 → 同一读数: total=6 roots=2 withParent=3 orphans=1 maxDepth=2", () => {
		const fwd = summarizeTraceObservations(g7());
		const rev = summarizeTraceObservations(g7().reverse());
		for (const s of [fwd, rev]) {
			expect(s.total).toBe(6);
			expect(s.roots).toBe(2);
			expect(s.withParent).toBe(3);
			expect(s.orphans).toBe(1);
			expect(s.maxDepth).toBe(2);
			// 互斥完备分区与分布不变量: 三类之和与 type/name 各自之和都等于 total
			expect(s.roots + s.withParent + s.orphans).toBe(6);
			expect(s.types.reduce((n, t) => n + t.count, 0)).toBe(6);
			expect(s.names.reduce((n, t) => n + t.count, 0)).toBe(6);
		}
	});
});

describe("summarizeTraceObservations · 分布/agent 长度与排序 (GWT-8)", () => {
	const s8 = summarizeTraceObservations([
		obs("x1", "SPAN", { name: "普通", input: "hello" }),
		obs("z", "SPAN", { name: "agent:a", input: "", output: "", model: null }),
		obs("b", "SPAN", { name: "agent:b", input: null, output: null }),
		obs("a", "SPAN", {
			name: "agent:a",
			input: "abc",
			output: { k: "v" },
			model: "gpt-4",
		}),
		obs("n1", "SPAN", { name: null }),
		obs("n2", "SPAN", { name: "agent:" }),
		obs("g1", "GENERATION"),
	]);

	test("type/name 分布: count 降序, 同 count 码点升序", () => {
		expect(s8.types).toEqual([
			{ value: "SPAN", count: 6 },
			{ value: "GENERATION", count: 1 },
		]);
		expect(s8.names).toEqual([
			{ value: "agent:a", count: 2 },
			{ value: "（未命名）", count: 2 },
			{ value: "agent:", count: 1 },
			{ value: "agent:b", count: 1 },
			{ value: "普通", count: 1 },
		]);
	});

	test("agent 行: 同名按 id 码点升序; 长度 string/JSON/缺席/空串 各归其位", () => {
		expect(s8.agents.map((a) => [a.name, a.observationId])).toEqual([
			["agent:a", "a"],
			["agent:a", "z"],
			["agent:b", "b"],
		]);
		const aa = s8.agents[0]!;
		const az = s8.agents[1]!;
		const ab = s8.agents[2]!;
		expect(aa.inputLength).toBe(3); // "abc"
		expect(aa.outputLength).toBe(9); // JSON.stringify({k:"v"}) = {"k":"v"}
		expect(aa.model).toBe("gpt-4");
		expect(az.inputLength).toBe(0); // 空串是 0, 不是 null
		expect(az.outputLength).toBe(0);
		expect(az.model).toBeNull();
		expect(ab.inputLength).toBeNull(); // 缺席 → null → 显示 —
		expect(ab.outputLength).toBeNull();
		expect(ab.model).toBeNull();
		expect(s8.agents.length).toBe(3); // "agent:" 空 id 段不匹配, 不进表
	});

	test("format: 0 与 — 不相同; agent 行逐字", () => {
		const out = formatTraceReadout("t8", s8);
		expect(out).toContain("   agent:a · input 3 · output 9 · model gpt-4\n");
		expect(out).toContain("   agent:a · input 0 · output 0 · model —\n");
		expect(out).toContain("   agent:b · input — · output — · model —\n");
	});
});

describe("summarizeTraceObservations · 版本覆盖 (GWT-9)", () => {
	test("只认 GENERATION; unknown 计已记录; SPAN 不进分子分母", () => {
		const s = summarizeTraceObservations([
			gen("g1", { promptVersion: "v3", engineCommit: "abc123" }),
			gen("g2", { promptVersion: "v3" }),
			gen("g3", { engineCommit: "unknown" }),
			gen("g4", {}),
			obs("s1", "SPAN", {
				metadata: { promptVersion: "v3", engineCommit: "abc123" },
			}),
		]);
		expect(s.promptVersionCoverage).toEqual({ present: 2, total: 4 });
		expect(s.engineCommitCoverage).toEqual({ present: 2, total: 4 });
	});
});

describe("summarizeTraceObservations · cacheHit 三态与零分母 (GWT-10)", () => {
	test("hit/zero/unrecorded 互斥完备; rate = hit/(hit+zero); SPAN 不进", () => {
		const s = summarizeTraceObservations([
			gen("a", { cacheHit: 9 }),
			gen("b", { cacheHit: 0 }),
			gen("c", {}),
			obs("d", "GENERATION", { metadata: null }),
			obs("s1", "SPAN", { metadata: { cacheHit: 99 } }),
		]);
		expect(s.cacheHit).toEqual({ hit: 1, zero: 1, unrecorded: 2, rate: 0.5 });
		expect(s.cacheHit.hit + s.cacheHit.zero + s.cacheHit.unrecorded).toBe(4);
		expect(formatTraceReadout("t10", s)).toContain("命中率: 50.0%");
	});

	test("全未记录 → rate null, 输出 —; 未记录不进分母", () => {
		const s = summarizeTraceObservations([
			gen("e", {}),
			obs("f", "GENERATION", { metadata: null }),
		]);
		expect(s.cacheHit).toEqual({ hit: 0, zero: 0, unrecorded: 2, rate: null });
		expect(formatTraceReadout("t10b", s)).toContain("命中率: —");
	});
});

describe("summarizeTraceObservations · 坏 metadata/cacheHit (GWT-11)", () => {
	test("坏 metadata 形状与坏 cacheHit 值 → TraceCheckDataError", () => {
		const bads: { name: string; o: LangfuseObservation }[] = [
			{
				name: "metadata array",
				o: obs("m1", "SPAN", {
					metadata: [] as unknown as Record<string, unknown>,
				}),
			},
			{
				name: "metadata primitive",
				o: obs("m2", "SPAN", {
					metadata: "x" as unknown as Record<string, unknown>,
				}),
			},
			{ name: "cacheHit null", o: gen("c1", { cacheHit: null }) },
			{ name: "cacheHit boolean", o: gen("c2", { cacheHit: true }) },
			{ name: "cacheHit string", o: gen("c3", { cacheHit: "1" }) },
			{ name: "cacheHit 负数", o: gen("c4", { cacheHit: -1 }) },
			{ name: "cacheHit NaN", o: gen("c5", { cacheHit: Number.NaN }) },
			{ name: "cacheHit Infinity", o: gen("c6", { cacheHit: Infinity }) },
			{ name: "cacheHit object", o: gen("c7", { cacheHit: {} }) },
		];
		for (const { name, o } of bads) {
			expect(() => summarizeTraceObservations([o]), name).toThrow(
				TraceCheckDataError,
			);
		}
	});
});

describe("summarizeTraceObservations · 空数组 (GWT-12)", () => {
	test("零/null 结构", () => {
		const s = summarizeTraceObservations([]);
		expect(s).toEqual({
			total: 0,
			roots: 0,
			withParent: 0,
			orphans: 0,
			maxDepth: null,
			types: [],
			names: [],
			agents: [],
			promptVersionCoverage: { present: 0, total: 0 },
			engineCommitCoverage: { present: 0, total: 0 },
			cacheHit: { hit: 0, zero: 0, unrecorded: 0, rate: null },
		});
	});
});

describe("formatTraceReadout · 冻结输出格式 (D-14/D-15)", () => {
	test("空世界 → 恰一行", () => {
		expect(formatTraceReadout("trace-1", summarizeTraceObservations([]))).toBe(
			"trace trace-1 没有 observations。",
		);
	});

	test("非空输出逐行冻结", () => {
		const readout = summarizeTraceObservations([
			gen("g1", { cacheHit: 2, promptVersion: "v1", engineCommit: "c1" }),
			gen("g2", { cacheHit: 0 }),
		]);
		expect(formatTraceReadout("t1", readout)).toBe(
			"═══ omd trace check · t1 · 2 observations ═══\n" +
				"\n" +
				"① 形状\n" +
				"   根节点: 2 · 有父节点: 0 · 孤儿: 0 · 最大深度: 0\n" +
				"   type: GENERATION=2\n" +
				"   name: （未命名）=2\n" +
				"\n" +
				"② agent 节点\n" +
				"   —\n" +
				"\n" +
				"③ 版本覆盖（仅 GENERATION）\n" +
				"   metadata.promptVersion: 1/2\n" +
				"   metadata.engineCommit: 1/2\n" +
				"\n" +
				"④ cacheHit（仅 GENERATION）\n" +
				"   命中: 1 · 零命中: 1 · 未记录: 0 · 命中率: 50.0%",
		);
	});
});

// ── T-2 凭证与 CLI 边界 (GWT-1..4, 13) ─────────────────────────────────────────
describe("runOmdTraceCheck · CLI 边界", () => {
	test("GWT-1: help 零副作用: 返回 0, 输出 usage, 不读凭证不联网", async () => {
		for (const argv of [["--help"], ["-h"]]) {
			const rig = makeRig({ readThrows: true });
			expect(await runOmdTraceCheck(argv, rig.deps), argv.join(" ")).toBe(0);
			expect(rig.out, argv.join(" ")).toEqual([OMD_TRACE_CHECK_USAGE]);
			expect(rig.err, argv.join(" ")).toEqual([]);
			expect(rig.readPaths, argv.join(" ")).toEqual([]);
			expect(rig.fetchCalls, argv.join(" ")).toEqual([]);
		}
	});

	test("GWT-2: 参数错误 → 恰 1 行 stderr, 返回 1, 未读凭证未联网", async () => {
		const bads: string[][] = [
			[],
			["pos"],
			["--trace-id"],
			["--trace-id", "   "],
			["--trace-id", "a", "--trace-id", "b"],
			["--bogus"],
			["--help", "--trace-id", "a"],
		];
		for (const argv of bads) {
			const rig = makeRig();
			expect(
				await runOmdTraceCheck(argv, rig.deps),
				JSON.stringify(argv),
			).toBe(1);
			expect(rig.err, JSON.stringify(argv)).toHaveLength(1);
			expect(rig.err[0], JSON.stringify(argv)).toMatch(/^错误: /);
			expect(rig.out, JSON.stringify(argv)).toEqual([]);
			expect(rig.readPaths, JSON.stringify(argv)).toEqual([]);
			expect(rig.fetchCalls, JSON.stringify(argv)).toEqual([]);
		}
	});

	test("GWT-4: 凭证严格失败 → 恰 1 行, 返回 1, 无泄漏, 零请求", async () => {
		const cases: { name: string; opts: RigOpts; line: string }[] = [
			{
				name: "文件缺失",
				opts: { readThrows: true },
				line: "错误: 读取配置文件失败",
			},
			{
				name: "坏 JSON",
				opts: { secrets: "not json" },
				line: "错误: 配置文件不是合法 JSON",
			},
			{
				name: "根 null",
				opts: { secrets: "null" },
				line: "错误: 配置文件根节点不是对象",
			},
			{
				name: "根 array",
				opts: { secrets: "[]" },
				line: "错误: 配置文件根节点不是对象",
			},
			{
				name: "根 primitive",
				opts: { secrets: '"str"' },
				line: "错误: 配置文件根节点不是对象",
			},
			{
				name: "langfuse 缺失",
				opts: { secrets: "{}" },
				line: "错误: 配置文件缺少 langfuse 配置段",
			},
			{
				name: "langfuse null",
				opts: { secrets: '{"langfuse":null}' },
				line: "错误: 配置文件缺少 langfuse 配置段",
			},
			{
				name: "langfuse array",
				opts: { secrets: '{"langfuse":[]}' },
				line: "错误: 配置文件缺少 langfuse 配置段",
			},
			{
				name: "publicKey 缺失",
				opts: { secrets: '{"langfuse":{"host":"https://x","secretKey":"sk"}}' },
				line: "错误: langfuse 缺少 host/publicKey/secretKey 字段",
			},
			{
				name: "publicKey 非 string",
				opts: { secrets: '{"langfuse":{"host":"https://x","publicKey":1,"secretKey":"sk"}}' },
				line: "错误: langfuse 缺少 host/publicKey/secretKey 字段",
			},
			{
				name: "publicKey 空白",
				opts: { secrets: '{"langfuse":{"host":"https://x","publicKey":"  ","secretKey":"sk"}}' },
				line: "错误: langfuse 缺少 host/publicKey/secretKey 字段",
			},
			{
				name: "secretKey 缺失",
				opts: { secrets: '{"langfuse":{"host":"https://x","publicKey":"pk"}}' },
				line: "错误: langfuse 缺少 host/publicKey/secretKey 字段",
			},
			{
				name: "host 空白",
				opts: { secrets: '{"langfuse":{"host":"  ","publicKey":"pk","secretKey":"sk"}}' },
				line: "错误: langfuse 缺少 host/publicKey/secretKey 字段",
			},
			{
				name: "host 非 http(s)",
				opts: { secrets: '{"langfuse":{"host":"ftp://x","publicKey":"pk","secretKey":"sk"}}' },
				line: "错误: langfuse.host 不是合法的 http(s) 地址",
			},
			{
				name: "host 不可解析",
				opts: { secrets: '{"langfuse":{"host":"not a url","publicKey":"pk","secretKey":"sk"}}' },
				line: "错误: langfuse.host 不是合法的 http(s) 地址",
			},
		];
		for (const c of cases) {
			const rig = makeRig(c.opts);
			expect(await runOmdTraceCheck(["--trace-id", "t"], rig.deps), c.name).toBe(1);
			expect(rig.err, c.name).toEqual([c.line]);
			expect(rig.out, c.name).toEqual([]);
			expect(rig.fetchCalls, c.name).toEqual([]);
			expect(rig.err[0], c.name).not.toMatch(/Error| at |stack/);
			expect(rig.err[0], c.name).not.toContain("pk");
			expect(rig.err[0], c.name).not.toContain("sk");
		}
	});

	test("GWT-11: 坏 cacheHit → run 只输出单行人话, 返回 1", async () => {
		const rig = makeRig({
			secrets: GOOD_SECRETS,
			pages: [page([gen("g", { cacheHit: "bad" })], 1)],
		});
		expect(await runOmdTraceCheck(["--trace-id", "t"], rig.deps)).toBe(1);
		expect(rig.err).toEqual(["错误: cacheHit 字段取值不合法"]);
		expect(rig.out).toEqual([]);
	});

	test("GWT-12: 空世界 → run 返回 0, 恰一行", async () => {
		const rig = makeRig({ secrets: GOOD_SECRETS, pages: [page([], 0)] });
		expect(await runOmdTraceCheck(["--trace-id", "trace-1"], rig.deps)).toBe(0);
		expect(rig.out).toEqual(["trace trace-1 没有 observations。"]);
		expect(rig.err).toEqual([]);
	});

	test("GWT-13: 抓取/形状/数据错误 → 各恰 1 行, 返回 1, 无泄漏, stdout 无部分读数", async () => {
		const cases: { name: string; opts: RigOpts; line: string }[] = [
			{
				name: "网络错误",
				opts: {
					secrets: GOOD_SECRETS,
					fetchImpl: (async () => {
						throw new Error("net boom");
					}) as unknown as typeof fetch,
				},
				line: "错误: 请求 Langfuse 失败（网络错误或超时）",
			},
			{
				name: "HTTP 401",
				opts: { secrets: GOOD_SECRETS, pages: [new Response("unauthorized", { status: 401 })] },
				line: "错误: Langfuse 返回了非成功状态码",
			},
			{
				name: "HTTP 500",
				opts: { secrets: GOOD_SECRETS, pages: [new Response("boom", { status: 500 })] },
				line: "错误: Langfuse 返回了非成功状态码",
			},
			{
				name: "坏 JSON",
				opts: { secrets: GOOD_SECRETS, pages: [new Response("<html>", { status: 200 })] },
				line: "错误: Langfuse 返回结构不符合预期",
			},
			{
				name: "data 非数组",
				opts: { secrets: GOOD_SECRETS, pages: [rawPage({ data: "x", meta: { totalItems: 1 } })] },
				line: "错误: Langfuse 返回结构不符合预期",
			},
			{
				name: "meta 缺失",
				opts: { secrets: GOOD_SECRETS, pages: [rawPage({ data: [] })] },
				line: "错误: Langfuse 返回结构不符合预期",
			},
			{
				name: "totalItems 负数",
				opts: { secrets: GOOD_SECRETS, pages: [rawPage({ data: [], meta: { totalItems: -1 } })] },
				line: "错误: Langfuse 返回结构不符合预期",
			},
			{
				name: "totalItems 非整数",
				opts: { secrets: GOOD_SECRETS, pages: [rawPage({ data: [], meta: { totalItems: 1.5 } })] },
				line: "错误: Langfuse 返回结构不符合预期",
			},
			{
				name: "缺 id",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ type: "SPAN" }], 1)] },
				line: "错误: 观测数据格式不合法",
			},
			{
				name: "空白 id",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ id: " ", type: "SPAN" }], 1)] },
				line: "错误: 观测数据格式不合法",
			},
			{
				name: "重复 id",
				opts: {
					secrets: GOOD_SECRETS,
					pages: [page([{ id: "x", type: "SPAN" }, { id: "x", type: "SPAN" }], 2)],
				},
				line: "错误: 观测 id 重复",
			},
			{
				name: "缺 type",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ id: "x" }], 1)] },
				line: "错误: 观测类型不合法",
			},
			{
				name: "空白 type",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ id: "x", type: "  " }], 1)] },
				line: "错误: 观测类型不合法",
			},
			{
				name: "name 非 string",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ id: "x", type: "SPAN", name: 1 }], 1)] },
				line: "错误: 观测数据格式不合法",
			},
			{
				name: "model 非 string",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ id: "x", type: "SPAN", model: {} }], 1)] },
				line: "错误: 观测数据格式不合法",
			},
			{
				name: "parent 非 string",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ id: "x", type: "SPAN", parentObservationId: 5 }], 1)] },
				line: "错误: parentObservationId 不合法",
			},
			{
				name: "parent 空白",
				opts: { secrets: GOOD_SECRETS, pages: [page([{ id: "x", type: "SPAN", parentObservationId: " " }], 1)] },
				line: "错误: parentObservationId 不合法",
			},
			{
				name: "父环",
				opts: {
					secrets: GOOD_SECRETS,
					pages: [
						page(
							[
								{ id: "a", type: "SPAN", parentObservationId: "b" },
								{ id: "b", type: "SPAN", parentObservationId: "a" },
							],
							2,
						),
					],
				},
				line: "错误: 观测祖先链存在环",
			},
		];
		for (const c of cases) {
			const rig = makeRig(c.opts);
			expect(
				await runOmdTraceCheck(["--trace-id", "trace-x"], rig.deps),
				c.name,
			).toBe(1);
			expect(rig.err, c.name).toEqual([c.line]);
			expect(rig.out, c.name).toEqual([]);
			expect(rig.err[0], c.name).not.toMatch(/Error| at |stack/);
			expect(rig.err[0], c.name).not.toContain("pk-1");
			expect(rig.err[0], c.name).not.toContain("sk-2");
		}
	});
});

// ── T-3 认证与分页 (GWT-5/6) ───────────────────────────────────────────────────
describe("fetchTraceObservations · Basic + 分页判停 (GWT-5/GWT-6)", () => {
	const auth =
		"Basic " + Buffer.from("pk-1:sk-2", "utf8").toString("base64");

	test("GWT-5: 两页串行, limit=100, URL 编码 traceId, 精确 Basic header, 不请求 page=3", async () => {
		const rig = makeRig({
			secrets: GOOD_SECRETS,
			pages: [
				page(Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, type: "SPAN" })), 101),
				page([{ id: "o100", type: "SPAN" }], 101),
			],
		});
		const obs = await fetchTraceObservations(
			"trace / 1",
			GOOD_CONFIG,
			rig.deps.fetchImpl!,
		);
		expect(obs).toHaveLength(101);
		expect(obs[100]).toMatchObject({ id: "o100" });
		expect(rig.fetchCalls).toHaveLength(2); // 不请求 page=3
		expect(rig.fetchCalls[0]!.url).toBe(
			"https://lf.example.com/api/public/observations?traceId=trace%20%2F%201&limit=100&page=1",
		);
		expect(rig.fetchCalls[1]!.url).toBe(
			"https://lf.example.com/api/public/observations?traceId=trace%20%2F%201&limit=100&page=2",
		);
		for (const call of rig.fetchCalls) {
			expect(call.init?.method).toBe("GET");
			expect(call.init?.headers).toEqual({
				authorization: auth,
				accept: "application/json",
			});
		}
	});

	test("GWT-6: totalItems=0 且空首面 → 返回 []", async () => {
		const rig = makeRig({ secrets: GOOD_SECRETS, pages: [page([], 0)] });
		expect(
			await fetchTraceObservations("t", GOOD_CONFIG, rig.deps.fetchImpl!),
		).toEqual([]);
		expect(rig.fetchCalls).toHaveLength(1);
	});

	test("GWT-6: 累计不足却收空页 → short-fetch, 不循环", async () => {
		const rig = makeRig({
			secrets: GOOD_SECRETS,
			pages: [
				page(Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, type: "SPAN" })), 101),
				page([], 101),
			],
		});
		const err = await fetchTraceObservations(
			"t",
			GOOD_CONFIG,
			rig.deps.fetchImpl!,
		).catch((e) => e);
		expect(err).toBeInstanceOf(TraceCheckFetchError);
		expect((err as TraceCheckFetchError).code).toBe("short-fetch");
		expect(rig.fetchCalls).toHaveLength(2); // 空页即停, 不再翻页
	});

	test("GWT-6: 后页 totalItems 与首页不同 → total-changed", async () => {
		const rig = makeRig({
			secrets: GOOD_SECRETS,
			pages: [
				page([{ id: "a", type: "SPAN" }], 101),
				page([{ id: "b", type: "SPAN" }], 100),
			],
		});
		const err = await fetchTraceObservations(
			"t",
			GOOD_CONFIG,
			rig.deps.fetchImpl!,
		).catch((e) => e);
		expect(err).toBeInstanceOf(TraceCheckFetchError);
		expect((err as TraceCheckFetchError).code).toBe("total-changed");
	});

	test("GWT-6: 累计超过冻结总数 → overflow (不用 >= 吞超发)", async () => {
		const rig = makeRig({
			secrets: GOOD_SECRETS,
			pages: [
				page(Array.from({ length: 102 }, (_, i) => ({ id: `o${i}`, type: "SPAN" })), 101),
			],
		});
		const err = await fetchTraceObservations(
			"t",
			GOOD_CONFIG,
			rig.deps.fetchImpl!,
		).catch((e) => e);
		expect(err).toBeInstanceOf(TraceCheckFetchError);
		expect((err as TraceCheckFetchError).code).toBe("overflow");
	});
});