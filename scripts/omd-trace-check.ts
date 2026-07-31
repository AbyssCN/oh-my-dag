#!/usr/bin/env bun
/**
 * omd-trace-check —— Langfuse trace 的确定性读数板 (2026-07-31, 契约: docs/plan/2026-07-31-omd-trace-check.md)。
 *
 * ## 它是什么, 更要紧的是它**不是**什么
 *
 * 给定一个 Langfuse `traceId`, 完整抓取该 trace 的全部 observations, 输出四类确定性读数:
 * ① 形状 (根/有父/孤儿/最大深度 + type/name 分布) ② agent 节点 (input/output/model 原样长度)
 * ③ 版本覆盖 (仅 GENERATION) ④ cacheHit 三态 (仅 GENERATION)。
 * 它不是建议器: 零模型调用、零建议、零改动 —— 承 omd-readout 的读数板语言, 不套通用 CLI 模板。
 *
 * ## 分层与注入 (D-7: 真实 I/O 只在编排边界)
 *
 *   parseTraceCheckArgs        纯参数解析 (只认 `--trace-id <value>` 一种形态)
 *   loadTraceCheckConfig       经必传 env + readText 读机器级 secrets (路径只经 omdSecretsPath)
 *   fetchTraceObservations     经必传 fetchImpl 串行分页 (limit=100, meta.totalItems 冻结判停)
 *   summarizeTraceObservations 纯汇总 (四类读数, 与输入顺序无关, 不隐藏读盘或 HTTP)
 *   formatTraceReadout         纯格式化 (逐行冻结)
 *   runOmdTraceCheck           唯一生产依赖默认值边界: process.env/读盘/global fetch/out/err
 *
 * 顶层除 import.meta.main 外零副作用: import 安全 (不读盘/不联网/不执行 CLI)。
 * 错误走 typed error (.code), 编排层翻译成恰一行中文人话 —— 禁堆栈/禁 URL/禁响应体/禁 key。
 *
 * ## 跑法
 *
 *   bun run scripts/omd-trace-check.ts --trace-id <traceId>
 *   bun run scripts/omd-trace-check.ts --help        # 只打印用法, 零配置零网络
 */
import { readFileSync } from "node:fs";
import { omdSecretsPath, type LangfuseConfig } from "../src/model/langfuse";

export type { LangfuseConfig };

// ── 固定导出面 (契约 §1: 统计与格式化均纯函数, 不隐藏 I/O) ────────────────────

export interface LangfuseObservation {
	id: string;
	type: string;
	name?: string | null;
	parentObservationId?: string | null;
	input?: unknown;
	output?: unknown;
	model?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface ObservationsPage {
	data: LangfuseObservation[];
	meta: { totalItems: number };
}

export interface CountEntry {
	value: string;
	count: number;
}

export interface Coverage {
	present: number;
	total: number;
}

export interface AgentObservationReadout {
	observationId: string;
	name: string;
	inputLength: number | null;
	outputLength: number | null;
	model: string | null;
}

export interface CacheHitReadout {
	hit: number;
	zero: number;
	unrecorded: number;
	rate: number | null;
}

export interface TraceReadout {
	total: number;
	roots: number;
	withParent: number;
	orphans: number;
	maxDepth: number | null;
	types: CountEntry[];
	names: CountEntry[];
	agents: AgentObservationReadout[];
	promptVersionCoverage: Coverage;
	engineCommitCoverage: Coverage;
	cacheHit: CacheHitReadout;
}

export interface TraceCheckDeps {
	env?: Record<string, string | undefined>;
	readText?: (path: string) => string;
	fetchImpl?: typeof fetch;
	out?: (line: string) => void;
	err?: (line: string) => void;
}

export const OMD_TRACE_CHECK_USAGE: string =
	"用法: bun run scripts/omd-trace-check.ts --trace-id <traceId>";

// ── typed error: code 携带机器可判错误, 编排层翻译成人话 ───────────────────────
// message 就是 code —— 错误文本绝不含 key/host/URL/响应体/堆栈。
class TraceCheckErrorBase extends Error {
	readonly code: string;
	constructor(code: string, name: string) {
		super(code);
		this.name = name;
		this.code = code;
	}
}
export class TraceCheckArgsError extends TraceCheckErrorBase {
	constructor(code: string) {
		super(code, "TraceCheckArgsError");
	}
}
export class TraceCheckConfigError extends TraceCheckErrorBase {
	constructor(code: string) {
		super(code, "TraceCheckConfigError");
	}
}
export class TraceCheckFetchError extends TraceCheckErrorBase {
	constructor(code: string) {
		super(code, "TraceCheckFetchError");
	}
}
export class TraceCheckDataError extends TraceCheckErrorBase {
	constructor(code: string) {
		super(code, "TraceCheckDataError");
	}
}

// ── 小工具 ───────────────────────────────────────────────────────────────────
/** 非 null、非数组的 object (Record 形状)。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** 码点序比较 —— JS 字符串 `<` 是 UTF-16 码元序, 对非 BMP 字符与码点序不同 (D-10)。 */
function cmpCodePoint(a: string, b: string): number {
	const pa = [...a];
	const pb = [...b];
	const n = Math.min(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
	}
	return pa.length - pb.length;
}
/** 版本覆盖的 present 判定: own property + 非空 string, 不 trim (D-12)。 */
function isRecorded(
	meta: Record<string, unknown> | null | undefined,
	key: string,
): boolean {
	if (!isPlainObject(meta)) return false;
	if (!Object.hasOwn(meta, key)) return false;
	const v = meta[key];
	return typeof v === "string" && v.length > 0;
}

// ── ① 纯参数解析 (D-2) ───────────────────────────────────────────────────────
/**
 * 唯一合法形态: `--trace-id <value>` (两 token, 空格分隔)。不接受 `--trace-id=value`、
 * 短名、别名。`<value>` 原值 verbatim 作 traceId (不 trim、区分大小写; 仅空白值判错)。
 * `-h` / `--help` 单独出现 → help (零副作用路径)。其余一律抛 TraceCheckArgsError。
 */
export function parseTraceCheckArgs(
	argv: string[],
): { help: true } | { help: false; traceId: string } {
	if (argv.length === 0) throw new TraceCheckArgsError("no-args");
	const isHelpToken = (a: string): boolean => a === "-h" || a === "--help";
	if (argv.length === 1 && isHelpToken(argv[0]!)) return { help: true };
	if (argv.some(isHelpToken)) throw new TraceCheckArgsError("help-mixed");
	if (argv[0] !== "--trace-id")
		throw new TraceCheckArgsError("missing-trace-id");
	if (argv.length === 1) throw new TraceCheckArgsError("missing-value");
	if (argv.length !== 2) throw new TraceCheckArgsError("unexpected-args");
	const traceId = argv[1]!;
	if (traceId.trim().length === 0)
		throw new TraceCheckArgsError("blank-trace-id");
	return { help: false, traceId };
}

// ── ② 配置查找与严格校验 (D-3/D-4) ───────────────────────────────────────────
/**
 * 路径只经 `omdSecretsPath(env)` (XDG_CONFIG_HOME 优先, 否则 `${HOME ?? homedir()}/.config`)。
 * 根与 `langfuse` 均须非 null、非数组 object; 三字段 trim 后非空 string;
 * host 须为合法 http(s) URL, 规范化时移除尾部 `/`。任何错误不得打印 key。
 */
export function loadTraceCheckConfig(
	env: Record<string, string | undefined>,
	readText: (path: string) => string,
): LangfuseConfig {
	const path = omdSecretsPath(env);
	let text: string;
	try {
		text = readText(path);
	} catch {
		throw new TraceCheckConfigError("read-failed");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new TraceCheckConfigError("parse-failed");
	}
	if (!isPlainObject(parsed)) throw new TraceCheckConfigError("invalid-root");
	const lf = parsed.langfuse;
	if (!isPlainObject(lf)) throw new TraceCheckConfigError("invalid-langfuse");
	const publicKey = typeof lf.publicKey === "string" ? lf.publicKey.trim() : "";
	const secretKey = typeof lf.secretKey === "string" ? lf.secretKey.trim() : "";
	const hostRaw = typeof lf.host === "string" ? lf.host.trim() : "";
	if (!publicKey || !secretKey || !hostRaw)
		throw new TraceCheckConfigError("missing-field");
	const host = hostRaw.replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(host);
	} catch {
		throw new TraceCheckConfigError("invalid-host");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new TraceCheckConfigError("invalid-host");
	return { host, publicKey, secretKey };
}

// ── ③ observation 校验 (D-8/D-10/D-12) ──────────────────────────────────────
/** 单条观测运行时形状校验: 违例即数据错误, 统计与关联一律保留原值。 */
function validateObservation(raw: unknown): LangfuseObservation {
	if (!isPlainObject(raw)) throw new TraceCheckDataError("invalid-observation");
	const rec = raw;
	const id = rec.id;
	if (typeof id !== "string" || id.trim().length === 0)
		throw new TraceCheckDataError("invalid-observation");
	const type = rec.type;
	if (typeof type !== "string" || type.trim().length === 0)
		throw new TraceCheckDataError("invalid-type");
	if (
		rec.name !== undefined &&
		rec.name !== null &&
		typeof rec.name !== "string"
	)
		throw new TraceCheckDataError("invalid-observation");
	if (
		rec.model !== undefined &&
		rec.model !== null &&
		typeof rec.model !== "string"
	)
		throw new TraceCheckDataError("invalid-observation");
	if (
		rec.metadata !== undefined &&
		rec.metadata !== null &&
		!isPlainObject(rec.metadata)
	)
		throw new TraceCheckDataError("invalid-observation");
	let parentObservationId: string | null = null;
	const p = rec.parentObservationId;
	if (p !== undefined && p !== null) {
		if (typeof p !== "string" || p.trim().length === 0)
			throw new TraceCheckDataError("invalid-parent");
		parentObservationId = p;
	}
	return {
		id,
		type,
		name: rec.name === undefined ? undefined : (rec.name as string | null),
		parentObservationId,
		input: rec.input,
		output: rec.output,
		model: rec.model === undefined ? undefined : (rec.model as string | null),
		metadata:
			rec.metadata === undefined || rec.metadata === null ? null : rec.metadata,
	};
}

// ── ④ 分页抓取与 Basic auth (D-5/D-6) ────────────────────────────────────────
/**
 * 每页串行: `${host}/api/public/observations?traceId=<URL 编码>&limit=100&page=N`, N 从 1 起。
 * 凭证只进 Basic header, 绝进 URL/日志/错误文本。
 * 判停: 第 1 页 totalItems 冻结为 T, 后续页必须相同; 累计 === T 才成功,
 * 累计 > T / 总数跨页变化 / 累计不足却收空页 → 分页错误。不并发、不重试、不截断、
 * 不用 `>=` 吞超发。每页条数不足 100 且累计不足 → 继续请求下一页 (契约字面: 仅空页判错)。
 */
export async function fetchTraceObservations(
	traceId: string,
	config: LangfuseConfig,
	fetchImpl: typeof fetch,
): Promise<LangfuseObservation[]> {
	const authorization =
		"Basic " +
		Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString(
			"base64",
		);
	const observations: LangfuseObservation[] = [];
	const seenIds = new Set<string>();
	let total: number | null = null; // 冻结总数, 第 1 页定
	let cumulative = 0;
	let page = 1;
	for (;;) {
		const url = `${config.host}/api/public/observations?traceId=${encodeURIComponent(traceId)}&limit=100&page=${page}`;
		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: "GET",
				headers: { authorization, accept: "application/json" },
			});
		} catch {
			throw new TraceCheckFetchError("network");
		}
		if (!res.ok) throw new TraceCheckFetchError("http-status");
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			throw new TraceCheckFetchError("page-shape");
		}
		if (!isPlainObject(body)) throw new TraceCheckFetchError("page-shape");
		const data = body.data;
		const meta = body.meta;
		if (!Array.isArray(data)) throw new TraceCheckFetchError("page-shape");
		const totalItems = isPlainObject(meta) ? meta.totalItems : undefined;
		if (
			typeof totalItems !== "number" ||
			!Number.isInteger(totalItems) ||
			totalItems < 0
		)
			throw new TraceCheckFetchError("page-shape");
		if (total === null) total = totalItems;
		else if (totalItems !== total)
			throw new TraceCheckFetchError("total-changed");
		for (const item of data) {
			const o = validateObservation(item);
			if (seenIds.has(o.id)) throw new TraceCheckDataError("duplicate-id"); // 按原值判重
			seenIds.add(o.id);
			observations.push(o);
		}
		cumulative += data.length;
		if (cumulative === total) break; // totalItems=0 且首面为空 → 返回 [] 也走这里
		if (cumulative < total && data.length === 0)
			throw new TraceCheckFetchError("short-fetch");
		if (cumulative > total) throw new TraceCheckFetchError("overflow");
		page++;
	}
	return observations;
}

// ── ⑤ 纯汇总 (D-8..D-13, 与输入顺序无关) ─────────────────────────────────────
/**
 * 单条输入校验 + 原值判重; 任一违例即抛数据错误, 不返回部分统计。
 */
export function summarizeTraceObservations(
	observations: readonly LangfuseObservation[],
): TraceReadout {
	const normalized = observations.map((o) => validateObservation(o));
	const total = normalized.length;
	const ids = new Set<string>();
	for (const o of normalized) {
		if (ids.has(o.id)) throw new TraceCheckDataError("duplicate-id");
		ids.add(o.id);
	}

	// ── type / name 分布 (D-10): 各覆盖全部 observations, 排序 count 降序、同 count 码点升序 ──
	const UNNAMED = "（未命名）";
	const typeCounts = new Map<string, number>();
	const nameCounts = new Map<string, number>();
	for (const o of normalized) {
		typeCounts.set(o.type, (typeCounts.get(o.type) ?? 0) + 1);
		const key =
			o.name === undefined || o.name === null || o.name === ""
				? UNNAMED
				: o.name;
		nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
	}
	const toCountEntries = (m: Map<string, number>): CountEntry[] =>
		[...m.entries()]
			.map(([value, count]) => ({ value, count }))
			.sort((a, b) => b.count - a.count || cmpCodePoint(a.value, b.value));
	const types = toCountEntries(typeCounts);
	const names = toCountEntries(nameCounts);

	// ── 深度 (D-8/D-9): 根与孤儿边界 0; 命中的本地父 +1; memoized, 父可晚于子 ──
	// 任意父环 (含自环) → 数据错误, 不给读数。
	const parentOf = new Map<string, string | null>();
	for (const o of normalized) parentOf.set(o.id, o.parentObservationId ?? null);
	const depth = new Map<string, number>();
	let roots = 0;
	let withParent = 0;
	let orphans = 0;

	/** 沿父链上溯的 memoized 深度; path 内重复出现 → 环。 */
	const depthOf = (id: string): number => {
		const cached = depth.get(id);
		if (cached !== undefined) return cached;
		const path: string[] = [];
		const seen = new Set<string>();
		let cur: string | null = id;
		let endDepth = 0;
		let anchorIsPathNode = false; // 锚点是根/孤儿边界 (在 path 内, 深度 0) 还是缓存节点 (不在 path 内)
		for (;;) {
			if (cur === null) break;
			const c = depth.get(cur);
			if (c !== undefined) {
				endDepth = c;
				break;
			}
			if (seen.has(cur)) throw new TraceCheckDataError("cycle");
			seen.add(cur);
			path.push(cur);
			const p: string | null = parentOf.get(cur) ?? null;
			if (p === null || !ids.has(p)) {
				// 根/孤儿边界: 深度 0, 不得猜孤儿的缺失祖先
				endDepth = 0;
				anchorIsPathNode = true;
				break;
			}
			cur = p;
		}
		let d = endDepth + (anchorIsPathNode ? 0 : 1);
		for (let i = path.length - 1; i >= 0; i--) depth.set(path[i]!, d++);
		return depth.get(id)!;
	};

	for (const o of normalized) {
		const p = o.parentObservationId ?? null;
		if (p === null) {
			roots++;
			depth.set(o.id, 0);
		} else if (ids.has(p)) {
			withParent++;
			depthOf(o.id);
		} else {
			orphans++;
			depth.set(o.id, 0);
		}
	}
	const maxDepth = depth.size === 0 ? null : Math.max(...depth.values());

	// ── agent 读数 (D-11): 仅 name 匹配 /^agent:.+$/ 的 observation, 与 type 无关 ──
	// 排序: 完整 name 码点升序, 同名按原始 observationId 升序。
	// 长度: string → JS .length; 非 null JSON 值 → 紧凑 JSON.stringify 长度;
	// 缺席/null → null; 空串 → 0; 非 JSON/不可序列化值 → 数据错误。
	const jsonLength = (v: unknown): number | null => {
		if (v === undefined || v === null) return null;
		if (typeof v === "string") return v.length;
		if (typeof v === "number" && !Number.isFinite(v))
			throw new TraceCheckDataError("invalid-length"); // NaN/±Infinity 不是 JSON 值
		if (
			typeof v === "function" ||
			typeof v === "symbol" ||
			typeof v === "bigint"
		)
			throw new TraceCheckDataError("invalid-length");
		let s: string | undefined;
		try {
			s = JSON.stringify(v);
		} catch {
			throw new TraceCheckDataError("invalid-length"); // 环引用等
		}
		if (s === undefined) throw new TraceCheckDataError("invalid-length");
		return s.length;
	};
	const agents: AgentObservationReadout[] = [];
	for (const o of normalized) {
		if (o.name === undefined || o.name === null) continue;
		if (!/^agent:.+$/.test(o.name)) continue;
		agents.push({
			observationId: o.id,
			name: o.name,
			inputLength: jsonLength(o.input),
			outputLength: jsonLength(o.output),
			model:
				o.model !== undefined && o.model !== null && o.model.length > 0
					? o.model
					: null,
		});
	}
	agents.sort(
		(a, b) =>
			cmpCodePoint(a.name, b.name) ||
			cmpCodePoint(a.observationId, b.observationId),
	);

	// ── 版本覆盖 + cacheHit 三态 (D-12/D-13): 分母只取 GENERATION, 各自独立记账 ──
	let generations = 0;
	let promptVersionPresent = 0;
	let engineCommitPresent = 0;
	let hit = 0;
	let zero = 0;
	let unrecorded = 0;
	for (const o of normalized) {
		if (o.type !== "GENERATION") continue; // SPAN/EVENT 不进任何分子/分母
		generations++;
		const meta = o.metadata;
		if (isRecorded(meta, "promptVersion")) promptVersionPresent++;
		if (isRecorded(meta, "engineCommit")) engineCommitPresent++; // 'unknown' 是非空 string, 计已记录
		if (isPlainObject(meta) && Object.hasOwn(meta, "cacheHit")) {
			const v = meta.cacheHit;
			if (typeof v === "number" && Number.isFinite(v) && v > 0) hit++;
			else if (v === 0)
				zero++; // 严格 === 0
			else throw new TraceCheckDataError("invalid-cache-hit"); // null/boolean/string/负数/非有限/object
		} else {
			unrecorded++;
		}
	}
	// 命中率唯一分母是 hit + zero; unrecorded 既不进分子也不进分母 (D-13)。
	const rate = hit + zero === 0 ? null : hit / (hit + zero);

	return {
		total,
		roots,
		withParent,
		orphans,
		maxDepth,
		types,
		names,
		agents,
		promptVersionCoverage: {
			present: promptVersionPresent,
			total: generations,
		},
		engineCommitCoverage: { present: engineCommitPresent, total: generations },
		cacheHit: { hit, zero, unrecorded, rate },
	};
}

// ── ⑥ 纯格式化 (D-14/D-15, 逐行冻结) ─────────────────────────────────────────
/** 空数组 → 恰一行; 非空 → 标题 + 四段编号读数。不输出 JSON/建议/URL/host/凭证。 */
export function formatTraceReadout(
	traceId: string,
	readout: TraceReadout,
): string {
	if (readout.total === 0) return `trace ${traceId} 没有 observations。`;
	const renderCounts = (entries: CountEntry[]): string =>
		entries.length === 0
			? "—"
			: entries.map((e) => `${e.value}=${e.count}`).join(" · ");
	const lines: string[] = [
		`═══ omd trace check · ${traceId} · ${readout.total} observations ═══`,
		"",
		"① 形状",
		`   根节点: ${readout.roots} · 有父节点: ${readout.withParent} · 孤儿: ${readout.orphans} · 最大深度: ${readout.maxDepth === null ? "—" : readout.maxDepth}`,
		`   type: ${renderCounts(readout.types)}`,
		`   name: ${renderCounts(readout.names)}`,
		"",
		"② agent 节点",
		...(readout.agents.length === 0
			? ["   —"]
			: readout.agents.map(
					(a) =>
						`   ${a.name} · input ${a.inputLength ?? "—"} · output ${a.outputLength ?? "—"} · model ${a.model ?? "—"}`,
				)),
		"",
		"③ 版本覆盖（仅 GENERATION）",
		`   metadata.promptVersion: ${readout.promptVersionCoverage.present}/${readout.promptVersionCoverage.total}`,
		`   metadata.engineCommit: ${readout.engineCommitCoverage.present}/${readout.engineCommitCoverage.total}`,
		"",
		"④ cacheHit（仅 GENERATION）",
		`   命中: ${readout.cacheHit.hit} · 零命中: ${readout.cacheHit.zero} · 未记录: ${readout.cacheHit.unrecorded} · 命中率: ${readout.cacheHit.rate === null ? "—" : `${(readout.cacheHit.rate * 100).toFixed(1)}%`}`,
	];
	return lines.join("\n");
}

// ── ⑦ 编排层 (D-7/D-16): 默认依赖只在此注入, 错误只在此翻译成人话 ─────────────
const ARG_MESSAGES: Record<string, string> = {
	"no-args": "缺少参数（只接受 --trace-id <traceId>）",
	"help-mixed": "--help 不能与其他参数混用",
	"missing-trace-id": "缺少 --trace-id 参数",
	"missing-value": "--trace-id 后缺少值",
	"blank-trace-id": "--trace-id 的值为空白",
	"unexpected-args": "参数形态不合法（只接受 --trace-id <traceId>）",
};
const CONFIG_MESSAGES: Record<string, string> = {
	"read-failed": "读取配置文件失败",
	"parse-failed": "配置文件不是合法 JSON",
	"invalid-root": "配置文件根节点不是对象",
	"invalid-langfuse": "配置文件缺少 langfuse 配置段",
	"missing-field": "langfuse 缺少 host/publicKey/secretKey 字段",
	"invalid-host": "langfuse.host 不是合法的 http(s) 地址",
};
const FETCH_MESSAGES: Record<string, string> = {
	network: "请求 Langfuse 失败（网络错误或超时）",
	"http-status": "Langfuse 返回了非成功状态码",
	"page-shape": "Langfuse 返回结构不符合预期",
	"total-changed": "分页期间观测总数发生变化，数据不一致",
	"short-fetch": "观测分页不完整（提前结束）",
	overflow: "观测分页超出声明总数",
};
const DATA_MESSAGES: Record<string, string> = {
	"invalid-observation": "观测数据格式不合法",
	"invalid-type": "观测类型不合法",
	"invalid-parent": "parentObservationId 不合法",
	"duplicate-id": "观测 id 重复",
	"invalid-cache-hit": "cacheHit 字段取值不合法",
	"invalid-length": "input/output 不是合法的 JSON 值",
	cycle: "观测祖先链存在环",
};

/**
 * 唯一生产依赖默认值边界: process.env / 读盘 / global fetch / stdout / stderr。
 * 任一失败 → stderr 恰一次、恰一行人话、exit 1; stdout 无部分读数; 无 stack/body/key。
 */
export async function runOmdTraceCheck(
	argv: string[],
	deps?: TraceCheckDeps,
): Promise<number> {
	const env = deps?.env ?? process.env;
	const readText =
		deps?.readText ?? ((path: string) => readFileSync(path, "utf8"));
	const fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
	const out =
		deps?.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const err =
		deps?.err ?? ((line: string) => process.stderr.write(`${line}\n`));
	try {
		const parsed = parseTraceCheckArgs(argv);
		if (parsed.help) {
			out(OMD_TRACE_CHECK_USAGE); // help 路径零副作用: 不读凭证、不发请求
			return 0;
		}
		const config = loadTraceCheckConfig(env, readText);
		const observations = await fetchTraceObservations(
			parsed.traceId,
			config,
			fetchImpl,
		);
		const readout = summarizeTraceObservations(observations);
		out(formatTraceReadout(parsed.traceId, readout));
		return 0;
	} catch (e) {
		let message = "未知错误";
		if (e instanceof TraceCheckArgsError)
			message = ARG_MESSAGES[e.code] ?? "参数不合法";
		else if (e instanceof TraceCheckConfigError)
			message = CONFIG_MESSAGES[e.code] ?? "配置读取失败";
		else if (e instanceof TraceCheckFetchError)
			message = FETCH_MESSAGES[e.code] ?? "数据抓取失败";
		else if (e instanceof TraceCheckDataError)
			message = DATA_MESSAGES[e.code] ?? "数据不合法";
		err(`错误: ${message}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await runOmdTraceCheck(process.argv.slice(2)));
}
