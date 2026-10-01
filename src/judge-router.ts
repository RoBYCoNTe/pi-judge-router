/**
 * judge-router — a pi virtual model that routes every request to a model
 * chosen by a calibrated judge, and fails over to an equivalent model on
 * another provider when the primary runs out of credit.
 *
 * Registered as `judge/auto`. The routing rules:
 *
 *   first request of the session -> the judge (TypeSafe Jev by default)
 *       rates the first user message; complex work goes to the strong model,
 *       everything else to the cheap one
 *   after the first successful edit/write -> the implementation model, for the
 *       rest of the session
 *   retry -> the model that answered, so the prompt cache survives
 *   compaction and other out-of-loop requests -> the implementation model
 *
 * Before routing to a probed provider the router asks whether that provider
 * still has credit/quota (cached, fail-open). If it does not, the Fireworks
 * equivalent from `FALLBACKS` is used instead.
 *
 * Why probe instead of react: pi classifies credit errors as terminal, so its
 * automatic retry never fires for them and no error-driven fallback hook can
 * see them. See docs/architecture.md.
 *
 * Configuration is environment variables; every one has a sensible default.
 */

import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	DEFAULT_PROBE_OPTIONS,
	FALLBACKS,
	PROBED_PROVIDERS,
	parseTarget,
	probeProvider,
	probeSignal,
	targetKey,
	type ProbeOptions,
	type ProbeOutcome,
	type Target,
} from "./provider-probe.ts";
import {
	formatUsage,
	loadStore,
	recordUsage,
	saveStore,
	type UsageStore,
} from "./usage-store.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envNumber(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function envString(name: string, fallback: string): string {
	const raw = process.env[name]?.trim();
	return raw ? raw : fallback;
}

/** Model that judges the task. Any classifier model in pi's registry works. */
const JUDGE = envString("JUDGE_ROUTER_JUDGE", "typesafe/jev-latest");

/** The three roles. `provider/id`, ids may contain slashes. */
const CHEAP = parseTarget(envString("JUDGE_ROUTER_CHEAP", "zai/glm-5.3-flash"))!;
const STRONG = parseTarget(envString("JUDGE_ROUTER_STRONG", "zai/glm-5.3"))!;
const IMPLEMENT = parseTarget(
	envString("JUDGE_ROUTER_IMPLEMENT", "deepseek/deepseek-flash"),
)!;

/**
 * Probability of "complex" above which the strong model is used. Deliberately
 * low: under-provisioning a complex task costs more than the pricier tier.
 */
const COMPLEX_THRESHOLD = envNumber("JUDGE_ROUTER_COMPLEX_THRESHOLD", 0.3);

/** Implementation and compaction run at low effort; output is the costly side. */
const IMPLEMENT_THINKING = "low" as const;

const PROBE_OPTIONS: ProbeOptions = {
	minBalanceUsd: envNumber("JUDGE_ROUTER_MIN_BALANCE_USD", DEFAULT_PROBE_OPTIONS.minBalanceUsd),
	maxQuotaPercent: envNumber("JUDGE_ROUTER_MAX_QUOTA_PERCENT", DEFAULT_PROBE_OPTIONS.maxQuotaPercent),
	timeoutMs: envNumber("JUDGE_ROUTER_PROBE_TIMEOUT_MS", DEFAULT_PROBE_OPTIONS.timeoutMs),
};

const PROBE_TTL_MS = envNumber("JUDGE_ROUTER_PROBE_TTL_MS", 60_000);

const EDIT_TOOLS = new Set(["edit", "write"]);

// ---------------------------------------------------------------------------
// Module state: the probe cache lives as long as the pi process.
// ---------------------------------------------------------------------------

const health = new Map<string, { outcome: ProbeOutcome; at: number }>();
const inflight = new Map<string, Promise<ProbeOutcome>>();
const notified = new Map<string, boolean>();

/** Last model the router dispatched, shown in the footer. */
let routed = "";

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function usageFile(): string {
	return envString(
		"JUDGE_ROUTER_USAGE_FILE",
		join(getAgentDir(), "judge-router-usage.json"),
	);
}

let usageStore: UsageStore | undefined;

/**
 * Footer status: what we routed to, plus the cached provider readings. This is
 * the piece a virtual model hides from provider-based indicator extensions,
 * which read the selected model's provider and see only `judge`.
 */
function refreshStatus(ctx: ExtensionContext): void {
	try {
		const parts: string[] = [];
		if (routed) parts.push(routed);
		for (const [provider, entry] of health) {
			if (Date.now() - entry.at < PROBE_TTL_MS) {
				parts.push(`${provider} ${entry.outcome.detail}`);
			}
		}
		ctx.ui.setStatus("judge-router", parts.length > 0 ? parts.join(" · ") : undefined);
	} catch {
		// No UI (headless, RPC): status is cosmetic, never fatal.
	}
}

/**
 * `usable: true` means "the provider has credit/quota", and also "we could not
 * find out". Probe failures fail open so a changed endpoint degrades to
 * no-fallback rather than to a broken agent.
 */
async function providerUsable(
	ctx: ExtensionContext,
	provider: string,
	requestSignal?: AbortSignal,
): Promise<ProbeOutcome> {
	const cached = health.get(provider);
	if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.outcome;

	const running = inflight.get(provider);
	if (running) return running;

	const check = (async (): Promise<ProbeOutcome> => {
		let outcome: ProbeOutcome = { usable: true, detail: "unknown" };
		try {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (apiKey) {
				outcome = await probeProvider(
					provider,
					apiKey,
					probeSignal(PROBE_OPTIONS.timeoutMs, requestSignal),
					PROBE_OPTIONS,
				);
			}
		} catch {
			outcome = { usable: true, detail: "probe failed" };
		}
		health.set(provider, { outcome, at: Date.now() });
		refreshStatus(ctx);
		return outcome;
	})().finally(() => {
		inflight.delete(provider);
	});

	inflight.set(provider, check);
	return check;
}

/** Record one judge call. Accounting must never break routing. */
function recordJudgeUsage(usage: { input?: number; output?: number } | undefined): void {
	if (!usage) return;
	try {
		const day = today();
		if (!usageStore) usageStore = loadStore(usageFile(), day);
		recordUsage(usageStore, { inputTokens: usage.input, outputTokens: usage.output }, day);
		saveStore(usageFile(), usageStore);
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type ThinkingLevel = ModelRouteRequest<RouterState>["thinkingLevel"];

interface RouterState {
	phase: "planning" | "implementation";
	model: Target;
}

type RouterRequest = ModelRouteRequest<RouterState>;

/** Swap in the substitute when the primary provider is exhausted. */
async function withFallback(
	request: RouterRequest,
	ctx: ExtensionContext,
	target: Target,
): Promise<Target> {
	if (!PROBED_PROVIDERS.includes(target.provider)) return target;

	const substitute = FALLBACKS[targetKey(target)];
	if (!substitute) return target;

	if ((await providerUsable(ctx, target.provider, request.signal)).usable) {
		notified.set(target.provider, false);
		return target;
	}

	// A substitute that is not in the catalog is worse than the primary: keep
	// the primary so the real error surfaces instead of a confusing one.
	if (!ctx.modelRegistry.find(substitute.provider, substitute.id)) {
		ctx.ui.notify(
			`judge/auto: ${target.provider} is exhausted but ${targetKey(substitute)} is not in the catalog`,
			"warning",
		);
		return target;
	}

	if (notified.get(target.provider) !== true) {
		notified.set(target.provider, true);
		ctx.ui.notify(
			`judge/auto: ${target.provider} is exhausted -> ${targetKey(substitute)}`,
			"warning",
		);
	}
	return substitute;
}

async function routeTo(
	request: RouterRequest,
	ctx: ExtensionContext,
	target: Target,
	state: RouterState,
	thinkingLevel: ThinkingLevel,
): Promise<ModelRoute<RouterState>> {
	const resolved = await withFallback(request, ctx, target);
	const model = ctx.modelRegistry.find(resolved.provider, resolved.id);
	if (!model) {
		throw new Error(`judge/auto: ${targetKey(resolved)} is not in the model catalog`);
	}
	routed = `→ ${targetKey(resolved)}`;
	refreshStatus(ctx);
	return { model, thinkingLevel, state };
}

function lastUserText(messages: readonly Message[]): string {
	const content =
		messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

/** Whether a successful edit/write happened since the last user message. */
function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages.slice(lastUser + 1).some((message) => {
		if (message.role !== "toolResult") return false;
		return EDIT_TOOLS.has(message.toolName) && !message.isError;
	});
}

/**
 * Ask the judge how demanding the work is. Every failure path (no classifier,
 * transport error, unexpected answer) degrades to the cheap model: routing
 * must never be the reason a request fails.
 */
async function choosePlanningModel(
	request: RouterRequest,
	ctx: ExtensionContext,
): Promise<Target> {
	try {
		const reference = parseTarget(JUDGE);
		const judge = reference
			? ctx.modelRegistry.findOfType("classifier", reference.provider, reference.id)
			: undefined;
		if (!judge) return CHEAP;

		const result = await ctx.modelRegistry.classify(
			judge,
			{
				state: { prompt: lastUserText(request.messages).slice(0, 16_000) },
				questions: {
					complexity: {
						type: "choice",
						instructions:
							"How demanding is the software engineering work requested in `prompt`?",
						criteria: {
							standard: "Ordinary features, fixes, reviews, or questions",
							complex: "Subtle design, cross-cutting changes, or hard debugging",
						},
					},
				},
			},
			{ signal: request.signal },
		);

		recordJudgeUsage(result.usage);

		const answer =
			result.stopReason === "stop" ? result.answers.complexity : undefined;
		if (answer?.type !== "choice") return CHEAP;

		const pComplex = answer.probabilities?.complex ?? 0;
		const pick = pComplex >= COMPLEX_THRESHOLD ? STRONG : CHEAP;
		ctx.ui.notify(
			`judge/auto: planning on ${targetKey(pick)} (p_complex=${pComplex.toFixed(2)})`,
			"info",
		);
		return pick;
	} catch (error) {
		ctx.ui.notify(
			`judge/auto: judge unavailable, using ${targetKey(CHEAP)} (${error instanceof Error ? error.message : String(error)})`,
			"warning",
		);
		return CHEAP;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<RouterState>({
		provider: "judge",
		id: "auto",
		name: "Auto (judge)",
		thinkingLevels: ["low", "high"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		async route(request, ctx) {
			// Out-of-loop requests (compaction summaries, direct calls).
			if (request.reason === "direct") {
				return routeTo(
					request,
					ctx,
					IMPLEMENT,
					{ phase: "implementation", model: IMPLEMENT },
					IMPLEMENT_THINKING,
				);
			}

			// A retry stays on the model that answered: no extra cache miss.
			if (request.reason === "retry" && request.failed) {
				const failed: Target = {
					provider: request.failed.model.provider,
					id: request.failed.model.id,
				};
				return routeTo(
					request,
					ctx,
					failed,
					request.state ?? { phase: "implementation", model: failed },
					request.failed.thinkingLevel ?? request.thinkingLevel,
				);
			}

			const state = request.state;

			// First request of the session: let the judge pick the planner.
			if (!state) {
				const model = await choosePlanningModel(request, ctx);
				return routeTo(
					request,
					ctx,
					model,
					{ phase: "planning", model },
					request.thinkingLevel,
				);
			}

			// The planner made its first edit: hand the rest to the implementer.
			if (state.phase === "planning" && editedThisTurn(request.messages)) {
				ctx.ui.notify(`judge/auto: -> ${targetKey(IMPLEMENT)} (implementation)`, "info");
				return routeTo(
					request,
					ctx,
					IMPLEMENT,
					{ phase: "implementation", model: IMPLEMENT },
					IMPLEMENT_THINKING,
				);
			}

			return routeTo(
				request,
				ctx,
				state.model,
				state,
				state.phase === "implementation"
					? IMPLEMENT_THINKING
					: request.thinkingLevel,
			);
		},
	});

	pi.registerCommand("jev-usage", {
		description: "Show Jev judge usage tracked by judge-router",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const day = today();
			const current = usageStore ?? loadStore(usageFile(), day);
			ctx.ui.notify(
				[
					formatUsage(current, day),
					`file: ${usageFile()}`,
					"counts only judge-router calls; gate and jev_ask calls come from other extensions",
				].join("\n"),
				"info",
			);
		},
	});
}
