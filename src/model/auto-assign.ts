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

/** 推理档 (与 GenerateFn/callModel 的 thinkingLevel 同词表 — 别引入第二套词汇)。 */
export type SeatThinking = "off" | "low" | "medium" | "high" | "xhigh";

/** 单 node 分配结果。 */
export interface NodeAssignment {
	/** 分配到的模型坐标 (provider:modelId)。 */
	readonly coord: string;
	/** 使用的渠道 ID (channel.id, 即 provider:kind)。 */
	readonly channelId: string;
	/** AA intelligence 分数 (快照或启发兜底)。 */
	readonly intelligence: number;
	/** S-T 座位推理档 (随座位下发, 见 NODE_CLASS_THINKING)。 */
	readonly thinkingLevel: SeatThinking;
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

/**
 * 首选 coord (provider:modelId) 按分类 (D-19 分配表, owner 2026-07-24 定):
 *   - 大脑簇 (decomposer/judge/reason) = Kimi K3 via Allegretto 专属桶 (kimi-coding:k3) —— **不走 Go**:
 *     Kimi K3 在 Go 共享美元桶烧穿快 288×, 高频大脑簇会饿死 Go, 故用专属预付桶。
 *   - 干活 (worker) = MiMo v2.5 via Lite plan (替代原 deepseek-flash 位)。
 *   - 校验 (verify) = GLM-5.2 via **Go flat-sub** (opencode-go, 次顶级, 跨 Kimi 家族 INV-3, cost=0)。
 * ⚠ kimi 真坐标 = 'kimi-coding:k3' (modelId 'k3')。
 */
const PREFERRED_COORD: Record<NodeClass, string> = {
	decomposer: "kimi-coding:k3",
	judge_synth: "kimi-coding:k3",
	worker: "mimo:mimo-v2.5-pro", // MiMo Lite 额度大 (owner 2026-07-25: pro 默认替代 v2.5; 多模态池例外留 v2.5)
	verify: "opencode-go:glm-5.2", // 次顶级 via Go flat-sub
	dream: "opencode-go:glm-5.2",
};

/**
 * S-T 座位推理档 (SDD 2026-07-25 skills-compile-evidence-gate S-T; 来源: codex MultiAgent V2 的
 * ROLE_ROUTES 把「模型 + reasoning_effort」**成对**下发)。此前 auto-assign 只派坐标不派档,
 * 执行期全局吃一个硬编码 'high'。
 *
 * 档位选择被 2026-07-25 的实测改写过一轮 (owner 指出 xhigh 不通用 + 要求量证 worker 档):
 *   ① **上限是 high 不是 xhigh** — mimo 实测只接受 'low'|'medium'|'high', 'max' 直接 HTTP 400。
 *      判/证/分解座位随溢出链落到 mimo 是常态, 配 xhigh 等于给自己埋 400。真需要 max 的座位由
 *      transport 层按 provider 能力表决定 (reasoningEffortFor), 分配表不假设。
 *   ② **worker 不降档** — 原设想「量产座降 low 省推理 token」, mimo-v2.5-pro 实测 n=3 打不出差:
 *      不发 effort / low / high 的 completion token 中位 184 / 403 / 316, 区间大幅重叠, 方差远大于
 *      档间差; 且 mimo 没有可用的关思考开关 (enable_thinking:false 等三种写法全被忽略)。
 *      **省不出来的东西就别配** —— 配了只会拿质量换零收益。换到档位真有成本差的模型时再调这张表。
 *
 * 现档表: 全座位 'high'。它当前与硬默认同值 = 行为不变, 但机制在位:
 *   坐标 → 座位 → 档 的通路打通了, 换模型/换池时这里是唯一要改的地方。
 *
 * ⚠ **agent leaf 是 worker 类里的例外, 不吃座位档**: agent-leaf.ts 的 xhigh 默认是 owner 早前锁的
 * (改文件 + 工具循环, 数量远少于 inproc 扇出, 质量优先)。座位档只下发到 inproc leaf 与 conductor。
 */
const NODE_CLASS_THINKING: Record<NodeClass, SeatThinking> = {
	decomposer: "high",
	judge_synth: "high",
	worker: "high",
	verify: "high",
	dream: "high",
};

/**
 * per-node 首选覆盖 (owner 2026-07-25: GPT 订阅进图内当 SOTA 大脑): conductor/escalation/judge 三个
 * **稀疏高价值**座位首选 gpt-5.6-sol via ChatGPT 订阅 (openai-codex, pi 通道 OAuth, flat 计费)。
 * 刻意不含 reason/reduce (每图多发, Plus 配额撑不住) — 量产座位留 k3/mimo 专属桶。
 * 渠道不可达 (未声明持仓/无凭证) → 自然落类首选 k3 链, 老行为不变。
 */
const NODE_PREFERRED: Record<string, string> = {
	conductor: "openai-codex:gpt-5.6-sol",
	escalation: "openai-codex:gpt-5.6-sol",
	judge: "openai-codex:gpt-5.6-sol",
};

/**
 * reduce 特殊 (D-14 "够质量的最廉"): 高频阶段, 取 MiMo v2.5-pro via Lite plan (替代原 deepseek-pro 位,
 * owner: deepseek 位→mimo)。高频故留专属 Lite 桶不烧 Go 共享桶。
 */
const REDUCE_COORD = "mimo:mimo-v2.5-pro";

/**
 * 按 NodeClass 排列的溢出候选 (D-19 溢出列): 专属桶烧穿 → 落 **Go flat-sub** (opencode-go, cost=0,
 * 一价多模型) 作通用溢出目标。Go 里 kimi-k3/glm/qwen/mimo/deepseek 全可达。
 */
const FALLBACK_COORDS: Record<NodeClass, string[]> = {
	decomposer: ["opencode-go:kimi-k3", "opencode-go:glm-5.2"],
	judge_synth: ["opencode-go:kimi-k3", "opencode-go:glm-5.2"],
	worker: ["opencode-go:mimo-v2.5", "opencode-go:deepseek-v4-flash"],
	verify: ["opencode-go:qwen3.7-max", "opencode-go:glm-5.1"],
	dream: ["opencode-go:qwen3.7-max", "opencode-go:deepseek-v4-flash"],
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
					thinkingLevel: NODE_CLASS_THINKING[nodeClass],
				};
				continue;
			}
			// DS-Pro 不可用 → 降级到 judge_synth 溢出链。
		}

		// per-node 覆盖 → 类首选 → 溢出链。
		const preferred = PREFERRED_COORD[nodeClass];
		const fallbacks = FALLBACK_COORDS[nodeClass] ?? [];
		const nodeOverride = NODE_PREFERRED[node];
		const candidates =
			node === "reduce"
				? [...fallbacks]
				: [...(nodeOverride ? [nodeOverride] : []), preferred, ...fallbacks];

		const resolved = resolveFirstReachable(candidates, channels, ratingsPath);
		if (resolved) {
			result[node] = {
				coord: resolved.coord,
				channelId: resolved.channel.id,
				intelligence: resolved.rating.intelligence,
				thinkingLevel: NODE_CLASS_THINKING[nodeClass],
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
	// configPath 同时喂发现 (读 declaredPlans) 与落盘 (写 autoAssigned) —— 读写同一目标, 否则声明持仓
	// 从默认 config 读、结果往 opts.configPath 写 = 错位 (测试/非默认路径会踩)。
	const { declarations } = discoverHoldings(
		env,
		opts.configPath ? { configPath: opts.configPath } : undefined,
	);
	const map = autoAssign({
		channels: declarations,
		...(opts.ratingsPath ? { ratingsPath: opts.ratingsPath } : {}),
	});
	const coords: Record<string, string> = {};
	const thinking: Record<string, SeatThinking> = {};
	for (const [node, a] of Object.entries(map)) {
		coords[node] = a.coord;
		thinking[node] = a.thinkingLevel;
	}
	persistAutoAssigned(coords, opts.configPath, thinking);
	logger.info(
		{ nodes: Object.keys(coords).length, declarations: declarations.length },
		"auto-assign: 已落盘 .omd/config.json autoAssigned 段",
	);
	return map;
}
