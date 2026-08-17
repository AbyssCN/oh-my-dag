/**
 * src/config/config-discovery.ts — provider auto-probe + channel declaration builder (D-20).
 *
 * Probes 4 credential sources, deduplicates, classifies billing plans, and outputs
 * `DeclaredPlan[]` consumable by `discoverChannels` / `autoAssign`.
 *
 * Sources (in probe order; last-write-wins dedup by provider id):
 *   1. env vars (DEEPSEEK_API_KEY, MIMO_API_KEY, ZHIPU_API_KEY, OPENROUTER_API_KEY,
 *      QWEN_API_KEY, MINIMAX_API_KEY, ANYSEARCH_API_KEY, TAVILY_API_KEY,
 *      FIRECRAWL_API_KEY, JINA_API_KEY)
 *   2. auth.json (~/.pi/agent/auth.json) — OAuth tokens (kimi-coding)
 *   3. models.json (~/.pi/agent/models.json) — custom providers with full credentials
 *   4. OPENCODE_API_KEY — Go subscription (opencode-go provider)
 *
 * Invariants:
 *   - D20-1 · pure I/O — no side effects beyond reading files; plan classification is a separate step.
 *   - D20-2 · last-write-wins by provider id (env → auth → models → go; same file later provider overwrites).
 *   - D20-3 · missing files / bad JSON → skip source silently (fail-open, consistent with models-json.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BillingKind, DeclaredPlan } from "../model/channels";
import { zodIssues, type ConfigIssueSink } from "./issues";

// ── Types ──────────────────────────────────────────────────────────────────

/** Plan classification for a discovered provider. */
export type PlanType = "prepaid" | "pay-per-use" | "go" | "unknown";

/** Default plan strings by classification (consumed by auto-assign channel layer). */
export const PLAN_STRINGS: Record<PlanType, string> = {
	prepaid: "prepaid",
	"pay-per-use": "pay-per-use",
	go: "go",
	unknown: "default",
};

/** One discovered provider (pre-dedup). */
export interface DiscoveredProvider {
	id: string;
	/** Where this provider was found. */
	source: "env" | "auth.json" | "models.json" | "go-subscription";
	hasKey: boolean;
	/** Whether the key looks like an OAuth token (from auth.json). */
	isOAuth: boolean;
}

// ── Internal: file readers (fail-open) ─────────────────────────────────────

/**
 * Read and parse JSON; returns null on any failure (fail-open, D20-3).
 * C2: 失败原文进可选 issues sink —— 文件不存在不是错误 (不进 sink), 解析失败/根不是对象才进。
 */
function readJsonSafe(path: string, issues?: ConfigIssueSink): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		issues?.push({ source: path, path: "", message: "根不是 JSON 对象" });
		return null;
	} catch (err) {
		issues?.push({ source: path, path: "", message: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

/** Default auth.json path (~/.pi/agent/auth.json). */
export function authJsonPath(
	env: Record<string, string | undefined> = process.env,
): string {
	const dir = env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(dir, "auth.json");
}

/** Default models.json path (~/.pi/agent/models.json). */
export function modelsJsonPath(
	env: Record<string, string | undefined> = process.env,
): string {
	const dir = env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(dir, "models.json");
}

// ── Internal: source probes ────────────────────────────────────────────────

/** Env var → provider id mapping for known providers. */
const ENV_KEY_MAP: Record<string, string> = {
	DEEPSEEK_API_KEY: "deepseek",
	MIMO_API_KEY: "mimo",
	ZHIPU_API_KEY: "zhipu",
	OPENROUTER_API_KEY: "openrouter",
	QWEN_API_KEY: "qwen",
	MINIMAX_API_KEY: "minimax-cn",
};

/** Probe env vars for API keys. */
function probeEnv(
	env: Record<string, string | undefined>,
): DiscoveredProvider[] {
	const out: DiscoveredProvider[] = [];
	for (const [envKey, providerId] of Object.entries(ENV_KEY_MAP)) {
		const val = env[envKey]?.trim();
		if (val) {
			out.push({ id: providerId, source: "env", hasKey: true, isOAuth: false });
		}
	}
	return out;
}

/** Probe auth.json for OAuth tokens. Scans all provider entries with oauth.access. */
function probeAuthJson(
	env: Record<string, string | undefined>,
	pathOverride?: string,
	issues?: ConfigIssueSink,
): DiscoveredProvider[] {
	const path = pathOverride ?? authJsonPath(env);
	const root = readJsonSafe(path, issues);
	if (!root?.providers || typeof root.providers !== "object") return [];

	const out: DiscoveredProvider[] = [];
	const providers = root.providers as Record<string, unknown>;

	for (const [id, raw] of Object.entries(providers)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		// OAuth token present → provider is reachable via pi OAuth.
		const oauth = entry.oauth as Record<string, unknown> | undefined;
		const hasOAuth =
			!!oauth && typeof oauth.access === "string" && oauth.access.length > 0;
		// API key entry (string) → also reachable.
		const hasApiKey =
			typeof entry.api_key === "string" && entry.api_key.length > 0;

		if (hasOAuth || hasApiKey) {
			out.push({ id, source: "auth.json", hasKey: true, isOAuth: hasOAuth });
		}
	}
	return out;
}

/** Probe models.json for custom providers with full credentials. */
function probeModelsJson(
	env: Record<string, string | undefined>,
	pathOverride?: string,
	issues?: ConfigIssueSink,
): DiscoveredProvider[] {
	const path = pathOverride ?? modelsJsonPath(env);
	const root = readJsonSafe(path, issues);
	if (!root?.providers || typeof root.providers !== "object") return [];

	const out: DiscoveredProvider[] = [];
	const providers = root.providers as Record<string, unknown>;

	for (const [id, raw] of Object.entries(providers)) {
		if (!raw || typeof raw !== "object") continue;
		const p = raw as Record<string, unknown>;
		// Only full custom entries (baseUrl + apiKey + api) — skip builtin-override (INV-5).
		if (
			typeof p.baseUrl !== "string" ||
			typeof p.apiKey !== "string" ||
			typeof p.api !== "string"
		) {
			continue;
		}
		// Resolve $ENV references in apiKey.
		const rawKey = p.apiKey.trim();
		let hasKey = false;
		if (rawKey.startsWith("$")) {
			hasKey = !!env[rawKey.slice(1)]?.trim();
		} else {
			hasKey = rawKey.length > 0;
		}
		if (hasKey) {
			out.push({ id, source: "models.json", hasKey: true, isOAuth: false });
		}
	}
	return out;
}

/** .omd/config.json 路径 (OMD_CONFIG_PATH ?? .omd/config.json, cwd-相对) — 与 role-models 同约定。 */
export function omdConfigPath(env: Record<string, string | undefined> = process.env): string {
	return env.OMD_CONFIG_PATH?.trim() || ".omd/config.json";
}

/**
 * declaredPlans 条目的闸字段 schema (C2: 决定"条目收不收"的字段走 zod; rateUsd/plan 是
 * 有默认值的补充字段, 坏了照旧回落默认 —— 与引入前的接受集逐字相同, 变的只是被拒条目
 * 从静默消失变成 issue 点名字段路径)。looseObject: 多余键照旧忽略。
 */
const declaredPlanEntrySchema = z.looseObject({
	provider: z.string().min(1),
	kind: z.enum(["token", "request", "session", "flat"]),
});

/**
 * 读 .omd/config.json 的 declaredPlans 段 (D-20): 用户**显式声明** auto-probe 探不到的持仓 ——
 * 如 Kimi Allegretto (OAuth, auth.json 里没有)、Go 订阅 (OPENCODE_API_KEY 没配) 等。
 * 形如 [{ provider, kind, rateUsd?, plan? }]。坏条目跳过 (fail-open) + 进 issues sink。
 */
export function readDeclaredPlans(
	env: Record<string, string | undefined> = process.env,
	pathOverride?: string,
	issues?: ConfigIssueSink,
): DeclaredPlan[] {
	const path = pathOverride ?? omdConfigPath(env);
	const root = readJsonSafe(path, issues);
	const raw = root?.declaredPlans;
	if (!Array.isArray(raw)) {
		if (root && raw !== undefined) {
			issues?.push({ source: path, path: "declaredPlans", message: "不是数组" });
		}
		return [];
	}
	const out: DeclaredPlan[] = [];
	for (const [i, d] of raw.entries()) {
		const parsed = declaredPlanEntrySchema.safeParse(d);
		if (!parsed.success) {
			issues?.push(...zodIssues(path, `declaredPlans[${i}]`, parsed.error.issues));
			continue;
		}
		const e = d as Record<string, unknown>;
		out.push({
			provider: parsed.data.provider,
			kind: parsed.data.kind as BillingKind,
			rateUsd: typeof e.rateUsd === "number" ? e.rateUsd : 0,
			plan: typeof e.plan === "string" ? e.plan : "declared",
		});
	}
	return out;
}

/** Probe OPENCODE_API_KEY for Go subscription. */
function probeGoSubscription(
	env: Record<string, string | undefined>,
): DiscoveredProvider | null {
	const key = env.OPENCODE_API_KEY?.trim();
	return key
		? {
				id: "opencode-go",
				source: "go-subscription",
				hasKey: true,
				isOAuth: false,
			}
		: null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover all reachable providers from all credential sources.
 * Deduplicates by provider id — later source wins (env → auth → models → go).
 * Returns sorted by id.
 */
export function discoverProviders(
	env: Record<string, string | undefined> = process.env,
	opts?: { authPath?: string; modelsPath?: string; issues?: ConfigIssueSink },
): DiscoveredProvider[] {
	const byId = new Map<string, DiscoveredProvider>();

	// Probe order matters: later overwrites earlier (last-write-wins, D20-2).
	for (const p of probeEnv(env)) byId.set(p.id, p);
	for (const p of probeAuthJson(env, opts?.authPath, opts?.issues)) byId.set(p.id, p);
	for (const p of probeModelsJson(env, opts?.modelsPath, opts?.issues)) byId.set(p.id, p);
	const go = probeGoSubscription(env);
	if (go) byId.set(go.id, go);

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Classify a provider's billing plan.
 * Priority: explicit prepaid tag > Go subscription > pay-per-use > unknown.
 */
export function classifyPlan(provider: DiscoveredProvider): PlanType {
	if (provider.source === "go-subscription") return "go";
	if (provider.isOAuth) return "pay-per-use";
	return "unknown";
}

/**
 * Build DeclaredPlan[] from plan classifications.
 * Each provider gets one channel with the classified billing kind.
 *
 * @param plans - Map of provider id → PlanType.
 * @param discovered - DiscoveredProvider[] for metadata.
 */
export function buildChannelDeclarations(
	plans: Map<string, PlanType>,
	discovered: readonly DiscoveredProvider[],
): DeclaredPlan[] {
	const decls: DeclaredPlan[] = [];
	const seen = new Set<string>();

	for (const p of discovered) {
		if (seen.has(p.id)) continue;
		seen.add(p.id);

		const planType = plans.get(p.id) ?? classifyPlan(p);
		const kind: BillingKind = planType === "go" ? "flat" : "token";
		const plan = PLAN_STRINGS[planType];
		decls.push({
			provider: p.id,
			kind,
			rateUsd: 0, // rates come from pricing tables, not discovery
			plan,
		});
	}
	return decls;
}

/**
 * Full discovery pipeline: probe → classify → build declarations.
 * Classification uses auto-detected defaults; pass planOverrides to override.
 */
export function discoverChannels(
	env: Record<string, string | undefined> = process.env,
	opts?: {
		authPath?: string;
		modelsPath?: string;
		configPath?: string;
		planOverrides?: Record<string, PlanType>;
		/** C2: 结构化 issue 收集 (省略 = 不收集, 行为不变)。 */
		issues?: ConfigIssueSink;
	},
): { discovered: DiscoveredProvider[]; declarations: DeclaredPlan[] } {
	const discovered = discoverProviders(env, opts);
	const plans = new Map<string, PlanType>();
	for (const p of discovered) {
		const override = opts?.planOverrides?.[p.id];
		plans.set(p.id, override ?? classifyPlan(p));
	}
	const auto = buildChannelDeclarations(plans, discovered);
	// D-20: 合并用户显式声明的持仓 (auto-probe 探不到的 OAuth plan / Go 等)。同 provider 声明胜
	// (用户显式知情 > 自动推断)。
	const declared = readDeclaredPlans(env, opts?.configPath, opts?.issues);
	const byProvider = new Map<string, DeclaredPlan>();
	for (const d of auto) byProvider.set(d.provider, d);
	for (const d of declared) byProvider.set(d.provider, d);
	return { discovered, declarations: [...byProvider.values()] };
}
