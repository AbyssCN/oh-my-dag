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
import { SEAT_PREFERRED_COORD, SEAT_THINKING, SEAT_TIER } from "./seats";
import { logger } from "../logger";
import {
	type Channel,
	type DeclaredPlan,
	discoverChannels,
	modelFamily,
	orderByAmortization,
} from "./channels";
import { type ModelRating, lookupRating } from "./model-ratings";
import { persistAutoAssigned, resolveConfiguredPools, type PoolTier } from "./role-models";
import { POOL_DEFAULTS } from "./pool-defaults";

// ── Types ──────────────────────────────────────────────────────────────

/** Node 分类 (D-5)。 */
export type NodeClass =
	| "decomposer" // conductor + escalation
	| "judge_synth" // judge + reason + reduce
	| "worker" // leaf/agent/lens/expand/distill/overflow
	| "verify"; // verifier + review-spec

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
	/**
	 * **这个座位是候选链上的第几档命中的**(S-18, 2026-08-05)。
	 *
	 * `override` = per-node 覆盖 · `preferred` = 类首选 · `fallback` = **首选够不着, 落到了溢出链**。
	 *
	 * 为什么要单记这一位:溢出链是**安全侧路** —— 它让跑活下去, 那是好事。但一次成功的降级
	 * 与一次首选命中在此前的返回值里**逐字相同** (都只有一个 `coord`), 于是读的人把
	 * 「首选够不着, 我们用了备胎」读成「我们选了这个座位」。
	 *
	 * 这一位对本仓不是锦上添花: G6 换座位、以及「基线不在同一条件上整个对比作废」那条纪律,
	 * 全都建立在**座位是已知的**之上。一次静默溢出会让 A/B 两臂在不知情下跑在同一个座位上。
	 *
	 * 注释里的 INV-7 一直写着「未命中/**降级**必 log」—— 此前只兑现了"未命中"那半句
	 * (全链不可达才 warn), 溢出链降级一个字都没留。INV-3 降级有 warn, 这一格没有, 是不对称。
	 */
	readonly via: "override" | "preferred" | "fallback";
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

/**
 * 按 node 名归类。**从 `seats.ts` 的 `tier` 派生** (2026-08-02),不再手抄第二份。
 *
 * ## 为什么改成派生
 *
 * 此前这里是一张手抄表,而 {@link autoAssign} 遍历的是 `Object.keys(NODE_CLASS)` ——
 * 也就是说引擎派活照的是**它自己那份手抄清单**,不是 `ALL_SEATS`。两边对不上就静默漏分配,
 * 而后果这张表自己的注释写着:「不给它们分配 = 起跑自检恒报缺」。
 *
 * **它已经漂了**:2026-08-01 加的 `gate` 座位(内环收敛闸从 judge 拆出)进了 `seats.ts`、
 * 漏了这里 —— `ALL_SEATS` 16 vs `NODE_CLASS` 15,于是 `gate` 拿不到 auto-assign 分配。
 * 没有任何东西比对这两张表,所以它漂了一整轮没人发现。
 *
 * ⚠ **与 15 号那条教训的关系(容易读反,写清楚)**:那次的结论是
 * 「消除重复之前先问这份重复是不是正在**当交叉验证用**」—— 座位闸从真源派生之后变成恒真式,
 * 是因为那份重复**正在当交叉验证用**。这里相反:**没有任何东西比对这两张表**,
 * 它不是交叉验证,只是漂。所以这里该派生,并**另外**补一条真的交叉验证闸
 * (`NODE_CLASS ⊇ ALL_SEATS`,见 `auto-assign.test.ts`)——
 * 派生消掉漂移,闸守住"新座位有没有被想过归哪一类"。
 *
 * 未列出的 node → worker(保留:`SEAT_TIER` 之外的图内临时 node 名仍走这条兜底)。
 */
const NODE_CLASS: Record<string, NodeClass> = SEAT_TIER as Record<string, NodeClass>;

/**
 * 首选 coord (provider:modelId) 按分类 (D-19 分配表, owner 2026-07-24 定)。
 *
 * **2026-07-31 owner 重派: 落类首选整表压到 `deepseek-v4-flash` 一个坐标。**
 * 起因是 v4-flash **正式版**上线, 推理能力大幅提升 —— 于是 pro 在这张表里失去了位置:
 * 它贵一倍 (0.55/2.19 vs 0.27/1.10) 而这里每一格的活 flash 都接得住。
 * **v4-pro 正式版出来之前一律不用 pro** (今天路上的是预览档)。
 *
 * ⚠ 这张表是**落类首选 = 兜底**, 不是最终座位: 稀疏高价值那几座由下面的 `NODE_PREFERRED`
 * 先派 gpt-5.6-sol, 只有那条渠道够不着时才落到这里。所以"全表 flash"读作
 * **"渠道断了就全用 flash"**, 而不是"引擎只用 flash"。
 *
 * 顺带修回一条 2026-07-29 记下的代价: 那次因渠道大面积失效, verify 与 decomposer 落在同一个
 * DeepSeek 族里, **INV-3 的跨家族对抗失效**(判和证共享盲点)。本轮 conductor/审核座回到 sol,
 * 跨家族在**渠道可达时**成立 —— 但落到兜底表时仍然是同族, 这一格没有被消灭, 只是被降低了频率。
 */
const PREFERRED_COORD: Record<NodeClass, string> = {
	decomposer: "deepseek:deepseek-v4-flash",
	judge_synth: "deepseek:deepseek-v4-flash",
	worker: "deepseek:deepseek-v4-flash",
	verify: "deepseek:deepseek-v4-flash",
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
 *   坐标 → 座位 → 档 的通路连接起来了, 换模型/换池时这里是唯一要改的地方。
 *
 * ⚠ **agent leaf 是 worker 类里的例外, 不吃座位档**: agent-leaf.ts 的 xhigh 默认是 owner 早前锁的
 * (改文件 + 工具循环, 数量远少于 inproc 扇出, 质量优先)。座位档只下发到 inproc leaf 与 conductor。
 */
/**
 * effort 意图 **按座位**取自 `seats.ts` (不再按 class 一刀切) —— 高频闸与低频终审本就该分开配。
 * 未登记的座位落 'high' (保守兜底)。
 *
 * ⚠ 「不同模型收不收得下这个档」不在这里判: transport 层 `reasoningEffortFor` 按 `model-caps`
 * 的实测词表夹 (xhigh 在 mimo/qwen 上自动降 high, 在 deepseek/gpt-5 上发 max)。
 * **加模型改 model-caps, 加角色改 seats, 两件事不互相牵扯。**
 */
const seatThinkingOf = (node: string): SeatThinking => (SEAT_THINKING[node] as SeatThinking) ?? "high";

/**
 * per-node 首选覆盖 (owner 2026-07-25: GPT 订阅进图内当 SOTA 大脑): conductor/escalation/judge 三个
 * **稀疏高价值**座位首选 gpt-5.6-sol via ChatGPT 订阅 (openai-codex, pi 通道 OAuth, flat 计费)。
 * 刻意不含 reason/reduce (每图多发, Plus 配额撑不住) — 量产座位留 k3/mimo 专属桶。
 * 渠道不可达 (未声明持仓/无凭证) → 自然落类首选 k3 链, 老行为不变。
 */
/**
 * per-node 首选坐标覆盖 —— **从 `seats.ts` 的 `preferredCoord` 派生**。
 * 哪些座位值得"稀疏高价值"待遇 (放 flat-sub 订阅、不冲配额) 写在各座位的 `recommend` 里。
 */
const NODE_PREFERRED: Record<string, string> = SEAT_PREFERRED_COORD;

/**
 * reduce 特殊 (D-14 "够质量的最廉"): 高频阶段, 取 MiMo v2.5-pro via Lite plan (替代原 deepseek-pro 位,
 * owner: deepseek 位→mimo)。高频故留专属 Lite 桶不烧 Go 共享桶。
 */
const REDUCE_COORD = "deepseek:deepseek-v4-flash";

/**
 * 按 NodeClass 排列的溢出候选 —— **值与理由都在 `pool-defaults.ts`**(2026-08-05 搬家)。
 * 专属桶烧穿 → 落 Go flat-sub (cost=0, 一价多模型)。
 */
const FALLBACK_COORDS: Record<NodeClass, readonly string[]> = {
	decomposer: POOL_DEFAULTS.fallbackDecomposer ?? [],
	judge_synth: POOL_DEFAULTS.fallbackJudgeSynth ?? [],
	worker: POOL_DEFAULTS.fallbackWorker ?? [],
	verify: POOL_DEFAULTS.fallbackVerify ?? [],
};

/**
 * 溢出候选的解析口 —— **config 可覆盖**(2026-08-05)。
 *
 * 解析序: `.omd/config.json` 的 `pools.fallback<Class>`(或 `OMD_POOL_FALLBACK_<CLASS>`)> 上面的源码默认。
 * 搬这一层的理由与判优池同: 这是**选择**不是事实表,而改一个选择不该要改代码+提交。
 * 源码默认留着是给「还没 init 的仓」用的,不是"真源在代码里"。
 */
const POOL_KEY_BY_CLASS: Record<NodeClass, PoolTier> = {
	decomposer: "fallbackDecomposer",
	judge_synth: "fallbackJudgeSynth",
	worker: "fallbackWorker",
	verify: "fallbackVerify",
};

function fallbackCoords(cls: NodeClass, env: Record<string, string | undefined> = process.env): readonly string[] {
	return resolveConfiguredPools(undefined, env)[POOL_KEY_BY_CLASS[cls]] ?? FALLBACK_COORDS[cls];
}

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
	/** 命中的候选在 `candidates` 里的下标 (0 = 第一档)。见 {@link NodeAssignment.via}。 */
	index: number;
}

function resolveFirstReachable(
	candidates: string[],
	channels: readonly Channel[],
	ratingsPath?: string,
): ResolvedCandidate | null {
	for (const [index, coord] of candidates.entries()) {
		const ch = findChannel(coord, channels);
		if (!ch) continue;
		const rating = lookupRating(coord, ratingsPath);
		if (!rating) continue;
		// index 是**命中位次**, 不是"有没有命中"。调用方靠它把"首选命中"和"降级命中"分开 ——
		// 此前两者返回值逐字相同, 于是一次静默降级长得像一次正常分配 (S-18)。
		return { coord, channel: ch, rating, index };
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
					thinkingLevel: seatThinkingOf(node),
					via: "preferred", // 单元素链, 命中即 D-14 首选
				};
				continue;
			}
			// DS-Pro 不可用 → 降级到 judge_synth 溢出链。
		}

		// per-node 覆盖 → 类首选 → 溢出链。
		const preferred = PREFERRED_COORD[nodeClass];
		const fallbacks = fallbackCoords(nodeClass);
		const nodeOverride = NODE_PREFERRED[node];
		const candidates =
			node === "reduce"
				? [...fallbacks]
				: [...(nodeOverride ? [nodeOverride] : []), preferred, ...fallbacks];

		const resolved = resolveFirstReachable(candidates, channels, ratingsPath);
		if (resolved) {
			// 候选链的构成: [per-node 覆盖?] + 类首选 + 溢出链。命中位次 → via。
			// reduce 走的是纯溢出链 (它的首选在上面那条特殊路径里已经试过并落空了)。
			const overrides = node === "reduce" ? 0 : nodeOverride ? 1 : 0;
			const via: NodeAssignment["via"] =
				node === "reduce" ? "fallback" : resolved.index < overrides ? "override" : resolved.index === overrides ? "preferred" : "fallback";
			result[node] = {
				coord: resolved.coord,
				channelId: resolved.channel.id,
				intelligence: resolved.rating.intelligence,
				thinkingLevel: seatThinkingOf(node),
				via,
			};
			if (via === "fallback") {
				// INV-7 的后半句 (「降级必 log」) 此前没兑现 —— 成功的降级与首选命中长得一模一样。
				// 与 INV-3 那条同款: 不可避免不等于可以静默。
				logger.warn(
					{ node, nodeClass, coord: resolved.coord, skipped: candidates.slice(overrides, resolved.index), degraded: "seat-fallback" },
					`auto-assign: **座位降级** —— ${node} 的首选够不着, 落到溢出链第 ${resolved.index - overrides} 档 (${resolved.coord})。` +
						`换座位实验与基线对比都假定座位是首选, 这一跑不是。`,
				);
			}
		} else {
			// INV-7: 全链不可达 → 不写入, 但 log。
			logger.warn(
				{ node, nodeClass, candidates },
				"auto-assign: 全候选链不可达 (无渠道或无评级), 跳过该 node",
			);
		}
	}

	// INV-3 跨家族校验闸: 校验座位与大脑座位落到同一个 provider 家族 = **判和证共享盲点**,
	// 跨模型对抗名存实亡。可达家族只剩一个时这是不可避免的 (2026-07-29 的 deepseek-only 就是),
	// 但**不可避免不等于可以静默** —— 这里明说一句, 否则一条不变量会在没人注意时死掉。
	// ⚠ **家族判定走 `modelFamily`, 不用 `coord.split(":")[0]`** (2026-08-23 修):
	//   裸前缀会把 `minimax-cn` 与 `minimax-us` 判成**异族** —— 实测 `modelFamily` 两者都是
	//   `minimax`(它剥 `-cn/-us/-go/-coding/-platform` 后缀并做品牌归一)。裸前缀下一次同族
	//   自审会从这道闸底下**静默溜过去**, 而这道闸存在的全部理由就是不让它静默。
	//   同一判据在 `model/seat-conformance.ts` 用的也是 `modelFamily` —— 两处必须同口径。
	const famOf = (c?: string): string | undefined => (c ? modelFamily(c) : undefined);
	const verifyFam = famOf(result.verifier?.coord);
	const brainFams = new Set(
		[result.conductor?.coord, result.judge?.coord, result.leaf?.coord].map(famOf).filter(Boolean) as string[],
	);
	if (verifyFam && brainFams.has(verifyFam)) {
		logger.warn(
			{ verifier: result.verifier?.coord, brains: [...brainFams], degraded: "INV-3" },
			`auto-assign: **INV-3 降级** —— 校验座位 (${result.verifier?.coord}) 与大脑座位同属 '${verifyFam}' 家族, ` +
				`跨模型对抗失效 (判与证共享盲点)。多渠道恢复后应把 verify 挪回异族。`,
		);
	}

	return result;
}

/**
 * 端到端接线 (D-17): 从真实持仓 auto-assign 并**一次性写入磁盘** .omd/config.json 的 autoAssigned 段。
 *   持仓发现 (config-discovery: env/auth.json/models.json/Go) → DeclaredPlan[] → autoAssign → 写入磁盘。
 * 写入磁盘后 resolveRoleModelConfigured 的 auto 层即读到 → 全引擎 node 路由生效 (无需运行时动态)。
 * 由 setup / `omd models auto` 显式触发 (非每 boot), 保"可读可改一次性填"语义。
 *
 * @param env  持仓探测的环境 (默认 process.env)。
 * @param opts.configPath  写入目标 (测试注入; 默认 .omd/config.json)。
 * @param opts.ratingsPath AA 快照路径 (默认 model-ratings.json)。
 * @returns 完整 AssignmentMap (含渠道 + intelligence, 供调用方展示)。
 */
export function runAutoAssign(
	env: Record<string, string | undefined> = process.env,
	opts: { configPath?: string; ratingsPath?: string } = {},
): AssignmentMap {
	// configPath 同时喂发现 (读 declaredPlans) 与写入磁盘 (写 autoAssigned) —— 读写同一目标, 否则声明持仓
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
