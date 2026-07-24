/**
 * src/model/channels.ts — Channel economics model (V2-ECON channel layer).
 *
 * Discovers provider billing channels from declared plans, deduplicates by
 * provider+kind, and orders by amortization priority. All functions are pure;
 * no side effects, no I/O.
 *
 * Contract: docs/plan/mimo-leaf-execution-contract.md (候选 D65) §channel.
 * Invariants:
 *  - CH-1 · discovery output is deduplicated by (provider, kind) — last-write-wins.
 *  - CH-2 · orderByAmortization is immutable — returns new array, never mutates input.
 *  - CH-3 · BILLING_PRIORITY defines amortization order: lower index = amortize first.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Billing dimension — what the provider actually charges for. */
export type BillingKind = "token" | "request" | "session" | "flat";

/** A discovered billing channel: one (provider, kind) pair with its effective rate. */
export interface Channel {
	readonly id: string;
	readonly provider: string;
	readonly kind: BillingKind;
	/** Cost per unit (USD). Semantic meaning depends on `kind`:
	 *  token   → per-1M-token
	 *  request → per-request
	 *  session → per-session
	 *  flat    → per-month (or fixed period) */
	readonly rateUsd: number;
	/** Quota ceiling for this channel (requests/tokens/sessions, kind-dependent). 0 = unlimited. */
	readonly quota: number;
	/** Provider-declared plan name (e.g. 'free', 'pro', 'enterprise'). */
	readonly plan: string;
}

/** A provider-declared pricing plan, raw from config or discovery. */
export interface DeclaredPlan {
	readonly provider: string;
	readonly kind: BillingKind;
	readonly rateUsd: number;
	readonly quota?: number;
	readonly plan?: string;
}

/** Input to the channel discovery pipeline. */
export interface ChannelDiscoveryInput {
	/** Raw declarations from all providers (may contain duplicates). */
	readonly declared: readonly DeclaredPlan[];
	/** Optional allowlist — if set, only include these providers. */
	readonly providers?: readonly string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Amortization priority: lower index = pay down first.
 * Rationale: sessions burn fastest (per-call), tokens are continuous,
 * requests are bounded, flat is background fixed cost.
 */
export const BILLING_PRIORITY: Readonly<Record<BillingKind, number>> = {
	session: 0,
	token: 1,
	request: 2,
	flat: 3,
} as const;

// ── Functions ──────────────────────────────────────────────────────────────

/** Deterministic channel ID from (provider, kind). */
const channelId = (provider: string, kind: BillingKind): string =>
	`${provider}:${kind}`;

/**
 * Discover billing channels from declared plans.
 *
 * CH-1: deduplicates by (provider, kind) — last declaration wins.
 * Optionally filters to an allowlist of providers.
 */
export function discoverChannels(input: ChannelDiscoveryInput): Channel[] {
	const { declared, providers: allowlist } = input;

	// Dedup by (provider, kind) — last-write-wins via Map insertion order.
	const byKey = new Map<string, Channel>();

	for (const d of declared) {
		// Filter: skip if allowlist set and provider not in it.
		if (allowlist && !allowlist.includes(d.provider)) continue;

		const key = channelId(d.provider, d.kind);
		byKey.set(key, {
			id: key,
			provider: d.provider,
			kind: d.kind,
			rateUsd: d.rateUsd,
			quota: d.quota ?? 0,
			plan: d.plan ?? "default",
		});
	}

	return [...byKey.values()];
}

/**
 * Order channels by amortization priority (BILLING_PRIORITY), then by id
 * for deterministic tie-breaking. Immutable — returns new array.
 *
 * CH-2: never mutates input.
 * CH-3: lower BILLING_PRIORITY index = earlier in output.
 */
export function orderByAmortization(channels: readonly Channel[]): Channel[] {
	return [...channels].sort((a, b) => {
		const pa = BILLING_PRIORITY[a.kind];
		const pb = BILLING_PRIORITY[b.kind];
		if (pa !== pb) return pa - pb;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}
