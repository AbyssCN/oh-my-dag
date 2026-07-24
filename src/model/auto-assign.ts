/**
 * src/model/auto-assign.ts — 渠道经济学驱动的 node→模型 auto-assign (D-19 分配表)。
 *
 * 输入(可达渠道矩阵 + AA 快照) → 输出每 node 坐标 + 渠道 + intelligence。
 * 一次性写入 .omd/config.json, 非运行时动态路由。
 *
 * 分类 (D-5): decomposer{conductor,escalation} · judge_synth{judge,reason,reduce} ·
 *   worker{leaf,agent,lens,expand,distill,overflow} · verify{verifier,review-spec} · dream。
 * 摊销序 (D-12): ①预付沉没(plan) ②flat-sub(Go) ③按量(raw API)。
 * 跨家族校验 (INV-3): verifier ≠ judge/conductor/leaf/reduce 家族。
 * 证据分配 (INV-6): 每条 node→模型由 AA 指标/渠道事实推出。
 *
 * Contract: docs/plan/2026-07-24-channel-aware-model-node-routing.md D-19.
 */
import { discoverChannels as discoverHoldings } from "../config/config-discovery";
import { logger } from "../logger";
import {
	type Channel,
	type DeclaredPlan,
	discoverChannels,
	orderByAmortization,
} from "./channels";
import { type ModelRating, lookupRating } from "./model-ratings";
import { persistAutoAssigned } from "./role-models";

// ── Types ──────────────────────────────────────────────────────────────

/** Node 分类 (D-5)。 */
export type NodeClass =
	| "decomposer" // conductor + escalation
	| "judge_synth" // judge + reason + reduce
	| "worker" // leaf/agent/lens/expand/distill/overflow
	| "verify" // verifier + review-spec
	| "dream"; // dream (独立)

/** 单 node 分配结果。 */
export interface NodeAssignment {
	/** 分配到的模型坐标 (provider:modelId)。 */
	readonly coord: string;
	/** 使用的渠道 ID (channel.id, 即 provider:kind)。 */
	readonly channelId: string;
	/** AA intelligence 分数 (快照或启发兜底)。 */
	readonly intelligence: number;
}

/** autoAssign 输出: node 名 → 分配。 */
export type AssignmentMap = Record<string, NodeAssignment>;

/** autoAssign 输入。 */
export interface AutoAssignInput {
	/** 可用渠道声明 (provider + 计费类型 + rate)。 */
	readonly channels: readonly DeclaredPlan[];
	/** AA 快照路径。省略 = 默认 model-ratings.json。 */
	readonly ratingsPath?: string;
}

// ── 配置常量 (D-19 分配表) ────────────────────────────────────────────

/** 按 node 名归类。未列出的 node → worker。 */
const NODE_CLASS: Record<string, NodeClass> = {
	conductor: "decomposer",
	escalation: "decomposer",
	judge: "judge_synth",
	reason: "judge_synth",
	reduce: "judge_synth",
	leaf: "worker",
	agent: "worker",
	lens: "worker",
	expand: "worker",
	distill: "worker",
	overflow: "worker",
	verifier: "verify",
	"review-spec": "verify",
	dream: "dream",
};

/** 首选 coord (provider:modelId) 按分类。⚠ kimi 真坐标 = 'kimi-coding:k3' (modelId 'k3' 非 'kimi-k3')。 */
const PREFERRED_COORD: Record<NodeClass, string> = {
	decomposer: "kimi-coding:k3",
	judge_synth: "kimi-coding:k3",
	worker: "mimo:mimo-v2.5-pro",
	verify: "openrouter:glm-5.2",
	dream: "openrouter:glm-5.2",
};

/**
 * reduce 特殊: "够质量的最廉"而非首选 (D-14)。
 * 取 DS-V4-Pro via Go (智力够, 成本远低于 K3)。
 */
const REDUCE_COORD = "deepseek:deepseek-v4-pro";

/** 按 NodeClass 排列的溢出候选 (D-19 溢出列)。 */
const FALLBACK_COORDS: Record<NodeClass, string[]> = {
	decomposer: ["openrouter:glm-5.2", "deepseek:deepseek-v4-pro"],
	judge_synth: ["openrouter:glm-5.2", "deepseek:deepseek-v4-pro"],
	worker: ["deepseek:deepseek-v4-flash", "openrouter:glm-5.2"],
	verify: ["qwen:qwen3.7-max", "deepseek:deepseek-v4-pro"],
	dream: ["qwen:qwen3.7-max", "deepseek:deepseek-v4-pro"],
};

// ── 内部 helpers ───────────────────────────────────────────────────────

/**
 * coord 的 provider 是否属于给定渠道的 provider。
 * 坐标格式 = 'provider:modelId', 取 ':' 前半。
 */
function coordProvider(coord: string): string {
	const sep = coord.indexOf(":");
	return sep >= 0 ? coord.slice(0, sep) : coord;
}

/**
 * 渠道匹配: 给定 coord 和渠道列表, 找该 provider 可用的最优渠道 (按 amortization 排序)。
 * 无匹配 → undefined。
 */
function findChannel(
	coord: string,
	channels: readonly Channel[],
): Channel | undefined {
	const provider = coordProvider(coord);
	const ordered = orderByAmortization(channels);
	return ordered.find((ch) => ch.provider === provider);
}

/**
 * 候选列表 → 第一个可达 (有渠道 + AA 可查) 的 {coord, channel, rating}。
 * INV-6: 只按渠道事实 + AA 指标, 不凭编造能力断言。
 */
interface ResolvedCandidate {
	coord: string;
	channel: Channel;
	rating: ModelRating;
}

function resolveFirstReachable(
	candidates: string[],
	channels: readonly Channel[],
	ratingsPath?: string,
): ResolvedCandidate | null {
	for (const coord of candidates) {
		const ch = findChannel(coord, channels);
		if (!ch) continue;
		const rating = lookupRating(coord, ratingsPath);
		if (!rating) continue;
		return { coord, channel: ch, rating };
	}
	return null;
}

// ── 主函数 ─────────────────────────────────────────────────────────────

/**
 * 按渠道经济学分配每个 node → 最优模型。
 *
 * D-12 摊销序: 预付沉没 → flat-sub → 按量。
 * D-19 分配表: 逐 node 类的首选 + 溢出链。
 * INV-3: verifier 跨家族 (≠ conductor/judge/leaf/reduce 主力)。
 * INV-6: 每条分配由渠道 + AA 指标推出。
 * INV-7: 未命中/降级必 log。
 *
 * @returns node 名 → NodeAssignment。未被覆盖的 node 不出现在 map 中。
 */
export function autoAssign(input: AutoAssignInput): AssignmentMap {
	const { channels: rawDeclared, ratingsPath } = input;
	const channels = discoverChannels({ declared: rawDeclared });

	if (channels.length === 0) {
		logger.warn("auto-assign: 无可用渠道, 返回空分配");
		return {};
	}

	const result: AssignmentMap = {};

	// 遍历所有已知 node, 逐个分配。
	const allNodes = Object.keys(NODE_CLASS);
	for (const node of allNodes) {
		const nodeClass = NODE_CLASS[node] ?? "worker";

		// reduce 特殊路径 (D-14): "够质量的最廉", 不走首选。
		if (node === "reduce") {
			const r = resolveFirstReachable([REDUCE_COORD], channels, ratingsPath);
			if (r) {
				result[node] = {
					coord: r.coord,
					channelId: r.channel.id,
					intelligence: r.rating.intelligence,
				};
				continue;
			}
			// DS-Pro 不可用 → 降级到 judge_synth 溢出链。
		}

		// 首选 → 溢出链。
		const preferred = PREFERRED_COORD[nodeClass];
		const fallbacks = FALLBACK_COORDS[nodeClass] ?? [];
		const candidates =
			node === "reduce" ? [...fallbacks] : [preferred, ...fallbacks];

		const resolved = resolveFirstReachable(candidates, channels, ratingsPath);
		if (resolved) {
			result[node] = {
				coord: resolved.coord,
				channelId: resolved.channel.id,
				intelligence: resolved.rating.intelligence,
			};
		} else {
			// INV-7: 全链不可达 → 不写入, 但 log。
			logger.warn(
				{ node, nodeClass, candidates },
				"auto-assign: 全候选链不可达 (无渠道或无评级), 跳过该 node",
			);
		}
	}

	return result;
}

/**
 * 端到端接线 (D-17): 从真实持仓 auto-assign 并**一次性落盘** .omd/config.json 的 autoAssigned 段。
 *   持仓发现 (config-discovery: env/auth.json/models.json/Go) → DeclaredPlan[] → autoAssign → 落盘。
 * 落盘后 resolveRoleModelConfigured 的 auto 层即读到 → 全引擎 node 路由生效 (无需运行时动态)。
 * 由 setup / `omd models auto` 显式触发 (非每 boot), 保"可读可改一次性填"语义。
 *
 * @param env  持仓探测的环境 (默认 process.env)。
 * @param opts.configPath  落盘目标 (测试注入; 默认 .omd/config.json)。
 * @param opts.ratingsPath AA 快照路径 (默认 model-ratings.json)。
 * @returns 完整 AssignmentMap (含渠道 + intelligence, 供调用方展示)。
 */
export function runAutoAssign(
	env: Record<string, string | undefined> = process.env,
	opts: { configPath?: string; ratingsPath?: string } = {},
): AssignmentMap {
	const { declarations } = discoverHoldings(env);
	const map = autoAssign({
		channels: declarations,
		...(opts.ratingsPath ? { ratingsPath: opts.ratingsPath } : {}),
	});
	const coords: Record<string, string> = {};
	for (const [node, a] of Object.entries(map)) coords[node] = a.coord;
	persistAutoAssigned(coords, opts.configPath);
	logger.info(
		{ nodes: Object.keys(coords).length, declarations: declarations.length },
		"auto-assign: 已落盘 .omd/config.json autoAssigned 段",
	);
	return map;
}
