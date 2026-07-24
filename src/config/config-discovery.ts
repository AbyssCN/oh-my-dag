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
import type { BillingKind, DeclaredPlan } from "../model/channels";

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

/** Read and parse JSON; returns null on any failure (fail-open, D20-3). */
function readJsonSafe(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
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
): DiscoveredProvider[] {
	const path = pathOverride ?? authJsonPath(env);
	const root = readJsonSafe(path);
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
): DiscoveredProvider[] {
	const path = pathOverride ?? modelsJsonPath(env);
	const root = readJsonSafe(path);
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
	opts?: { authPath?: string; modelsPath?: string },
): DiscoveredProvider[] {
	const byId = new Map<string, DiscoveredProvider>();

	// Probe order matters: later overwrites earlier (last-write-wins, D20-2).
	for (const p of probeEnv(env)) byId.set(p.id, p);
	for (const p of probeAuthJson(env, opts?.authPath)) byId.set(p.id, p);
	for (const p of probeModelsJson(env, opts?.modelsPath)) byId.set(p.id, p);
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
		planOverrides?: Record<string, PlanType>;
	},
): { discovered: DiscoveredProvider[]; declarations: DeclaredPlan[] } {
	const discovered = discoverProviders(env, opts);
	const plans = new Map<string, PlanType>();
	for (const p of discovered) {
		const override = opts?.planOverrides?.[p.id];
		plans.set(p.id, override ?? classifyPlan(p));
	}
	const declarations = buildChannelDeclarations(plans, discovered);
	return { discovered, declarations };
}
