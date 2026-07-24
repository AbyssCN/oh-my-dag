/**
 * model-ratings —— artificialanalysis.ai 模型评级快照 (intelligence/cost/speed) 的坐标查询。
 *
 * 快照是同目录 `model-ratings.json` (name 已归一化)。`lookupRating` 把 `provider:model` 坐标归一化后
 * 先按快照 name 精确匹配; 未命中走命名启发兜底 (pro/max/k3/... → 强档, flash/air/... → 廉档,
 * 否则中档)。兜底是**降级路径**, 必 logger.warn 记录未命中坐标 (INV-7 不静默降级)。
 * 文件缺/坏 → null (静默, 永不抛, 同 readCustomProviders 容错约定)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger";

/** 一条模型评级。speedTokS 缺测 → null。 */
export interface ModelRating {
	name: string;
	intelligence: number;
	costUsd: number;
	speedTokS: number | null;
}

/** 归一化: 小写 + 连字符/下划线转空格 + 去多余标点 (保版本号小数点) + 折叠空白。 */
function normalizeName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[-_]+/g, " ")
		.replace(/[^a-z0-9.\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 默认快照路径: 同目录 model-ratings.json (import.meta.dir = 本文件所在目录, 编译后亦成立)。 */
function defaultRatingsPath(): string {
	return join(import.meta.dir, "model-ratings.json");
}

/** 读快照 (已归一 name 索引)。文件缺/坏/结构不符 → null (静默不抛)。 */
function readRatings(path: string): Map<string, ModelRating> | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			ratings?: unknown;
		};
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ratings))
			return null;
		const out = new Map<string, ModelRating>();
		for (const r of parsed.ratings) {
			if (!r || typeof r !== "object") continue;
			const { name, intelligence, costUsd, speedTokS } = r as Record<
				string,
				unknown
			>;
			if (
				typeof name !== "string" ||
				typeof intelligence !== "number" ||
				typeof costUsd !== "number"
			) {
				continue;
			}
			out.set(normalizeName(name), {
				name,
				intelligence,
				costUsd,
				speedTokS: typeof speedTokS === "number" ? speedTokS : null,
			});
		}
		return out;
	} catch {
		return null;
	}
}

// 命名启发兜底档 (快照未命中时)。speedTokS 无从猜 → null。
const TIER_STRONG: Omit<ModelRating, "name"> = {
	intelligence: 45,
	costUsd: 0.5,
	speedTokS: null,
};
const TIER_CHEAP: Omit<ModelRating, "name"> = {
	intelligence: 38,
	costUsd: 0.15,
	speedTokS: null,
};
const TIER_MID: Omit<ModelRating, "name"> = {
	intelligence: 42,
	costUsd: 0.3,
	speedTokS: null,
};

const STRONG_KEYWORDS = ["pro", "max", "k3", "ultra", "opus", "plus"];
const CHEAP_KEYWORDS = ["flash", "air", "mini", "lite", "fast"];

/**
 * 命名启发: 关键词须出现在**更长**的名字里 (norm !== kw) —— modelId 光秃就是关键词本身
 * (如 'k3') 时信息量不足定档, 不落强档, 如实落中档。
 */
function heuristicRating(norm: string): Omit<ModelRating, "name"> {
	if (STRONG_KEYWORDS.some((kw) => norm.includes(kw) && norm !== kw))
		return TIER_STRONG;
	if (CHEAP_KEYWORDS.some((kw) => norm.includes(kw) && norm !== kw))
		return TIER_CHEAP;
	return TIER_MID;
}

/**
 * 查坐标 (`provider:model`, 无 ':' 用整串) 的评级。
 * 快照精确命中 → 快照值; 未命中 → 命名启发兜底 + logger.warn (INV-7); 文件缺/坏 → null。
 */
export function lookupRating(
	coord: string,
	path = defaultRatingsPath(),
): ModelRating | null {
	const ratings = readRatings(path);
	if (!ratings) return null;
	const sep = coord.indexOf(":");
	const modelId = sep >= 0 ? coord.slice(sep + 1) : coord;
	const norm = normalizeName(modelId);
	if (!norm) return null;
	const hit = ratings.get(norm);
	if (hit) return hit;
	const tier = heuristicRating(norm);
	logger.warn(
		{ coord, tier: tier.intelligence },
		"model-ratings: 快照未命中, 命名启发兜底 (INV-7)",
	);
	return { name: norm, ...tier };
}
