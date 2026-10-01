/**
 * Provider credit/quota probing.
 *
 * Pure, dependency-free and testable: this module knows nothing about pi. It
 * answers one question — "can this provider still serve a request, or is its
 * credit/quota exhausted?" — by reading the provider's own billing endpoint.
 *
 * Design contract, and the reason this is safe to run on every request:
 *
 *   `true`  -> use the primary provider (also the answer whenever anything is
 *              unexpected: changed payload shape, unknown field, HTTP error,
 *              timeout, missing key). We fail OPEN. A broken probe must never
 *              break the agent; the worst case is losing the fallback.
 *   `false` -> the provider explicitly reports exhaustion (`is_available:
 *              false`, a balance below the threshold, a token quota at or
 *              above the ceiling).
 *
 * Endpoints here are not part of any formal contract with us. They can change
 * shape without notice, which is why parsing lives in two small exported
 * functions with tests, rather than being inlined in the router.
 */

/** A `provider/id` pair. Model ids may themselves contain `/`. */
export interface Target {
	provider: string;
	id: string;
}

export interface ProbeOptions {
	/** DeepSeek: below this balance (USD) the provider is considered exhausted. */
	minBalanceUsd: number;
	/** z.ai: at or above this token-quota percentage the provider is exhausted. */
	maxQuotaPercent: number;
	/** HTTP timeout for a probe. Short on purpose: this runs before a request. */
	timeoutMs: number;
}

export const DEFAULT_PROBE_OPTIONS: ProbeOptions = {
	minBalanceUsd: 1,
	maxQuotaPercent: 95,
	timeoutMs: 3_000,
};

/** Result of a probe: the verdict plus a short string for the footer. */
export interface ProbeOutcome {
	/** `true` = use the primary provider. Unknown states also answer `true`. */
	usable: boolean;
	/** Compact human detail, e.g. `USD 42.00` or `tokens 32%/6%`. */
	detail: string;
}

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/**
 * Provider we know how to probe.
 *
 * Anything not listed here is passed through unprobed, so adding a provider is
 * a matter of adding an entry and a parser.
 */
export const PROBED_PROVIDERS: readonly string[] = ["zai", "deepseek"];

/**
 * Substitutable model per primary, used when the primary is exhausted.
 *
 * This is DATA, not logic: it goes stale as vendors release models, so it is
 * deliberately a single readable constant. Prices here match the primaries
 * (Fireworks serves the same weights and bills essentially the same rate), so
 * a failover is a cache miss, not a bill shock.
 */
export const FALLBACKS: Record<string, Target> = {
	"zai/glm-5.3-flash": {
		provider: "fireworks",
		id: "accounts/fireworks/models/glm-5p3-flash",
	},
	"zai/glm-5.3": {
		provider: "fireworks",
		id: "accounts/fireworks/models/glm-5p3",
	},
	"deepseek/deepseek-flash": {
		provider: "fireworks",
		id: "accounts/fireworks/models/deepseek-v4p1-flash",
	},
};

/** Key used by {@link FALLBACKS}. */
export function targetKey(target: Target): string {
	return `${target.provider}/${target.id}`;
}

/**
 * Parse a `provider/id` reference. Split on the FIRST slash only, so ids that
 * contain slashes (e.g. `accounts/fireworks/models/...`) survive intact.
 */
export function parseTarget(reference: string): Target | undefined {
	const trimmed = reference.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return {
		provider: trimmed.slice(0, slash),
		id: trimmed.slice(slash + 1),
	};
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

/** Numbers arrive as strings from these APIs; accept both, reject garbage. */
function readNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * DeepSeek `GET /user/balance`:
 *
 * ```json
 * { "is_available": true,
 *   "balance_infos": [{ "currency": "USD", "total_balance": "12.34" }] }
 * ```
 *
 * `total_balance` is a string, and `balance_infos` may hold several currencies.
 */
export function describeDeepseek(
	payload: unknown,
	options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): ProbeOutcome {
	const root = asRecord(payload);
	if (!root) return { usable: true, detail: "unreadable" };

	const infos = (Array.isArray(root.balance_infos) ? root.balance_infos : [])
		.map(asRecord)
		.filter((entry): entry is Record<string, unknown> => entry !== null);
	if (infos.length === 0) {
		return root.is_available === false
			? { usable: false, detail: "unavailable" }
			: { usable: true, detail: "no balance" };
	}

	const usd = infos.find(
		(entry) =>
			typeof entry.currency === "string" &&
			entry.currency.toUpperCase() === "USD",
	);
	const chosen = usd ?? infos[0]!;
	const balance = readNumber(chosen.total_balance ?? chosen.totalBalance);
	const currency = typeof chosen.currency === "string"
		? chosen.currency.toUpperCase()
		: "USD";

	if (balance === null) return { usable: true, detail: `${currency} ?` };
	const usable =
		root.is_available !== false && balance >= options.minBalanceUsd;
	return { usable, detail: `${currency} ${balance.toFixed(2)}` };
}

/** Boolean view of {@link describeDeepseek}. */
export function deepseekHasCredit(
	payload: unknown,
	options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): boolean {
	return describeDeepseek(payload, options).usable;
}

/**
 * z.ai `GET /monitor/usage/quota/limit`:
 *
 * ```json
 * { "code": 200, "success": true,
 *   "data": { "limits": [
 *     { "type": "TIME_LIMIT",   "remaining": 1000, "percentage": 0 },
 *     { "type": "TOKENS_LIMIT", "percentage": 32 },
 *     { "type": "TOKENS_LIMIT", "percentage": 6 } ] } }
 * ```
 *
 * Two window kinds are reported. `TIME_LIMIT` counts requests and carries
 * `remaining`; `TOKENS_LIMIT` is the real budget. Only token windows decide.
 */
export function describeZai(
	payload: unknown,
	options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): ProbeOutcome {
	const root = asRecord(payload);
	if (!root) return { usable: true, detail: "unreadable" };
	const data = asRecord(root.data) ?? root;

	const limits = (Array.isArray(data.limits) ? data.limits : [])
		.map(asRecord)
		.filter((entry): entry is Record<string, unknown> => entry !== null);
	if (limits.length === 0) return { usable: true, detail: "no limits" };

	const tokenLimits = limits.filter((entry) => entry.type === "TOKENS_LIMIT");
	if (tokenLimits.length === 0) return { usable: true, detail: "no token windows" };

	const percentages = tokenLimits
		.map((entry) => readNumber(entry.percentage))
		.filter((value): value is number => value !== null);
	if (percentages.length === 0) return { usable: true, detail: "tokens ?" };

	const usable = percentages.every((value) => value < options.maxQuotaPercent);
	const detail = `tokens ${percentages.map((value) => `${Math.round(value)}%`).join("/")}`;
	return { usable, detail };
}

/** Boolean view of {@link describeZai}. */
export function zaiHasQuota(
	payload: unknown,
	options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): boolean {
	return describeZai(payload, options).usable;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

async function fetchJson(
	url: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<unknown> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return await response.json();
}

/**
 * Ask one provider whether it can still serve. Throws only on transport
 * problems; the caller decides that an error means "keep the primary".
 */
export async function probeProvider(
	provider: string,
	apiKey: string,
	signal: AbortSignal,
	options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): Promise<ProbeOutcome> {
	if (provider === "deepseek") {
		return describeDeepseek(await fetchJson(DEEPSEEK_BALANCE_URL, apiKey, signal), options);
	}
	if (provider === "zai") {
		return describeZai(await fetchJson(ZAI_QUOTA_URL, apiKey, signal), options);
	}
	return { usable: true, detail: "not probed" };
}

/** AbortSignal that fires on timeout, or on the caller's abort, whichever is first. */
export function probeSignal(
	timeoutMs: number,
	requestSignal?: AbortSignal,
): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!requestSignal) return timeout;
	return AbortSignal.any([requestSignal, timeout]);
}
