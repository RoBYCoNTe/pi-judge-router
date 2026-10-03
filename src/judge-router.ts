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
import { fuzzyFilter, truncateToWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
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
import { formatReading } from "./format.ts";
import {
	aggregate,
	byModel,
	byProvider,
	formatCostSplit,
	formatTable,
	samplesFromEntries,
	type UsageSample,
} from "./session-report.ts";
import {
	RoleOverrides,
	ROLES,
	ROLE_HELP,
	isRole,
	modelSearchText,
	runModelsCommand,
	type ModelLookupResult,
	type Role,
	type RoleSetting,
} from "./model-overrides.ts";
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

function envSetting(role: Role, name: string, fallback: string): RoleSetting {
	const raw = process.env[name]?.trim();
	return raw ? { role, value: raw, source: "env" } : { role, value: fallback, source: "default" };
}

/**
 * The four roles, from the environment or the built-in default. Session
 * overrides sit on top of these; see `overrides` below.
 */
const BASE_ROLES: readonly RoleSetting[] = [
	envSetting("judge", "JUDGE_ROUTER_JUDGE", "typesafe/jev-latest"),
	envSetting("cheap", "JUDGE_ROUTER_CHEAP", "zai/glm-5.3-flash"),
	envSetting("strong", "JUDGE_ROUTER_STRONG", "zai/glm-5.3"),
	envSetting("exec", "JUDGE_ROUTER_IMPLEMENT", "deepseek/deepseek-flash"),
];

/** Session-only overrides, set with `/judge-models`. */
const overrides = new RoleOverrides();

/** Resolve a role to a `provider/id` pair, honouring the session override. */
function roleTarget(role: Role): Target {
	const setting = overrides.effective(BASE_ROLES).find((entry) => entry.role === role);
	const parsed = setting === undefined ? undefined : parseTarget(setting.value);
	if (parsed === undefined) {
		throw new Error(
			`judge/auto: ${role} is set to "${setting?.value ?? ""}", which is not a provider/id reference`,
		);
	}
	return parsed;
}

/**
 * Whether a reference names something the role can actually use. The judge role
 * needs a classifier; the other three need a chat model with working
 * credentials, otherwise the override would only fail later at dispatch time.
 */
function acceptsModel(
	ctx: ExtensionContext,
	role: Role,
	reference: string,
): ModelLookupResult {
	const target = parseTarget(reference);
	if (target === undefined) {
		return { ok: false, reason: `"${reference}" is not a provider/id reference` };
	}

	if (role === "judge") {
		const classifier = ctx.modelRegistry.findOfType(
			"classifier",
			target.provider,
			target.id,
		);
		return classifier === undefined
			? { ok: false, reason: `${reference} is not a classifier model in the catalog` }
			: { ok: true };
	}

	if (ctx.modelRegistry.find(target.provider, target.id) === undefined) {
		return { ok: false, reason: `${reference} is not in the model catalog` };
	}
	const usable = ctx.modelRegistry
		.getAvailable()
		.some(
			(candidate) =>
				candidate.provider === target.provider && candidate.id === target.id,
		);
	return usable
		? { ok: true }
		: { ok: false, reason: `${reference} has no working credentials` };
}

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

/** Footer verbosity: `full` (bars, reset times, session split), `compact`, `off`. */
const STATUS_MODE = (() => {
	const raw = envString("JUDGE_ROUTER_STATUS", "full");
	return raw === "compact" || raw === "off" ? raw : "full";
})();

/** Bar width in the footer, in cells. `0` keeps the numbers and drops the bars. */
const BAR_WIDTH = envNumber("JUDGE_ROUTER_BAR_WIDTH", 4);

const EDIT_TOOLS = new Set(["edit", "write"]);

// ---------------------------------------------------------------------------
// Module state: the probe cache lives as long as the pi process.
// ---------------------------------------------------------------------------

const health = new Map<string, { outcome: ProbeOutcome; at: number }>();
const inflight = new Map<string, Promise<ProbeOutcome>>();
const notified = new Map<string, boolean>();

/** Last model the router dispatched, shown in the footer. */
let routed = "";

/**
 * Latest context seen by any handler. `getArgumentCompletions` receives only
 * the typed prefix, so the model list for the completion has to come from
 * somewhere: this is that somewhere.
 */
let latestCtx: ExtensionContext | undefined;

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
 * Where the line lives.
 *
 * The status line is shared with every other extension and pi joins all of
 * them into one row with `join(" ")`, then truncates to the terminal width —
 * so a long line silently eats the others. `sanitizeStatusText` also rewrites
 * every `\n` to a space, so the row cannot be split from the inside. The way
 * to stop competing is a widget: its own row above or below the editor.
 *
 * `below` (default) | `above` | `status` (back to the shared line).
 */
const PLACEMENT = (() => {
	const raw = envString("JUDGE_ROUTER_PLACEMENT", "below");
	return raw === "above" || raw === "status" ? raw : "below";
})();

const STATUS_KEY = "judge-router";
const WIDGET_KEY = "judge-router";

/** Assemble the line's text; `undefined` when there is nothing to show. */
function renderStatusText(ctx: ExtensionContext): string | undefined {
	const parts: string[] = [];
	if (routed) parts.push(routed);

	const readings: string[] = [];
	for (const provider of [...health.keys()].sort()) {
		const entry = health.get(provider)!;
		readings.push(
			formatReading(provider, entry.outcome, {
				compact: STATUS_MODE === "compact",
				barWidth: BAR_WIDTH,
			}),
		);
	}
	if (readings.length > 0) parts.push(readings.join(" · "));

	if (STATUS_MODE === "full") {
		const split = formatCostSplit(aggregate(sessionSamples(ctx), byProvider));
		if (split) parts.push(`sess ${split}`);
	}

	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Publish the line: what we routed to, the provider readings, and the session
 * cost split. This is the piece a virtual model hides from provider-based
 * indicator extensions, which read the selected model's provider and see only
 * `judge`. The session split matters because the providers do not bill the same
 * way: one is a prepaid dollar balance, the other a plan in quota percentages.
 */
function refreshStatus(ctx: ExtensionContext): void {
	latestCtx = ctx;
	try {
		const text = STATUS_MODE === "off" ? undefined : renderStatusText(ctx);
		dumpStatus(text);
		if (ctx.hasUI === false) return;

		if (PLACEMENT === "status") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, text);
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(
			WIDGET_KEY,
			text === undefined
				? undefined
				: (_tui, theme) => ({
						// A component factory, not `string[]`: pi wraps string arrays in
						// `new Text(line, 1, 0)`, and that hardcoded paddingX is the leading
						// space. Rendering ourselves keeps the line flush with pi's own rows.
						invalidate() {},
						render: (width: number): string[] => [
							truncateToWidth(theme.fg("dim", text), width, theme.fg("dim", "…")),
						],
					}),
			{ placement: PLACEMENT === "above" ? "aboveEditor" : "belowEditor" },
		);
	} catch {
		// No UI (headless, RPC): status is cosmetic, never fatal.
	}
}

/**
 * Debug escape hatch: `JUDGE_ROUTER_STATUS_FILE` appends every rendered status
 * line to a file. The status is invisible in headless runs and easy to
 * misinterpret in a terminal, so being able to read what was actually computed
 * is worth five lines.
 */
function dumpStatus(text: string | undefined): void {
	const path = process.env["JUDGE_ROUTER_STATUS_FILE"];
	if (!path) return;
	try {
		appendFileSync(path, `${new Date().toISOString()} ${text ?? "(empty)"}\n`);
	} catch {
		// Best effort: a debug file never breaks a session.
	}
}

/**
 * Refresh the readings for display, not for routing.
 *
 * Routing probes on demand, which means the footer would only ever show the
 * provider the router just used — and it would go blank as soon as the cache
 * entry aged out. Monitoring has to be independent of routing: probe every
 * known provider whose reading is stale, in the background, so a turn never
 * waits on it.
 */
function refreshReadings(ctx: ExtensionContext): void {
	refreshStatus(ctx);
	for (const provider of PROBED_PROVIDERS) {
		const entry = health.get(provider);
		if (entry !== undefined && Date.now() - entry.at < PROBE_TTL_MS) continue;
		void providerUsable(ctx, provider);
	}
}


/** Every assistant message on the current branch, as a usage sample. */
function sessionSamples(ctx: ExtensionContext): UsageSample[] {
	return samplesFromEntries(ctx.sessionManager.getBranch());
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
		let outcome: ProbeOutcome = { usable: true, note: "unknown" };
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
			outcome = { usable: true, note: "probe failed" };
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

/**
 * Which role serves a phase. The role is what gets stored in the session state,
 * not the resolved model, so a `/judge-models` override applies from the next
 * request instead of waiting for a new session.
 */
interface RouterState {
	phase: "planning" | "implementation";
	role?: Role;
	/** Written by versions before roles existed; still honoured on resume. */
	model?: Target;
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
 * Ask the judge how demanding the work is, and return the role to plan with.
 * Every failure path (no classifier, transport error, unexpected answer)
 * degrades to the cheap role: routing must never fail a request.
 */
async function choosePlanningRole(
	request: RouterRequest,
	ctx: ExtensionContext,
): Promise<Role> {
	try {
		const reference = roleTarget("judge");
		const judge = ctx.modelRegistry.findOfType(
			"classifier",
			reference.provider,
			reference.id,
		);
		if (!judge) return "cheap";

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
		if (answer?.type !== "choice") return "cheap";

		const pComplex = answer.probabilities?.complex ?? 0;
		const role: Role = pComplex >= COMPLEX_THRESHOLD ? "strong" : "cheap";
		ctx.ui.notify(
			`judge/auto: planning with ${role}, ${targetKey(roleTarget(role))} (p_complex=${pComplex.toFixed(2)})`,
			"info",
		);
		return role;
	} catch (error) {
		ctx.ui.notify(
			`judge/auto: judge unavailable, planning with cheap (${error instanceof Error ? error.message : String(error)})`,
			"warning",
		);
		return "cheap";
	}
}

export default function (pi: ExtensionAPI) {
	// Show something from the first second. The line is otherwise empty until the
	// first dispatch, which reads like a broken plugin.
	pi.on("session_start", async (_event, ctx) => {
		const model = ctx.model;
		if (model) {
			// Plain `provider/id` while it is only the selection; the router switches
			// to `→ provider/id` once a request has actually been dispatched.
			routed =
				model.provider === "judge"
					? `${model.provider}/${model.id}`
					: `→ ${model.provider}/${model.id}`;
		}
		refreshReadings(ctx);
	});

	// Keep the footer truthful while the router is idle. Selecting a physical
	// model means route() stops running, so without these two hooks the line
	// would freeze on the last dispatched model and on a stale cost split.
	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider !== "judge") {
			routed = `→ ${event.model.provider}/${event.model.id}`;
		}
		refreshStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshReadings(ctx);
	});

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
					roleTarget("exec"),
					{ phase: "implementation", role: "exec" },
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
					request.state ?? { phase: "implementation", role: "exec" },
					request.failed.thinkingLevel ?? request.thinkingLevel,
				);
			}

			const state = request.state;
			const role = state?.role !== undefined && isRole(state.role) ? state.role : undefined;

			// A session written before roles existed: honour its model in the planning
			// phase, and repair it to the exec role once implementation has started.
			if (state !== undefined && role === undefined && state.model !== undefined) {
				if (state.phase === "implementation") {
					return routeTo(
						request,
						ctx,
						roleTarget("exec"),
						{ phase: "implementation", role: "exec" },
						IMPLEMENT_THINKING,
					);
				}
				return routeTo(request, ctx, state.model, state, request.thinkingLevel);
			}

			// First request of the session: let the judge pick the planning role.
			if (state === undefined || role === undefined) {
				const picked = await choosePlanningRole(request, ctx);
				return routeTo(
					request,
					ctx,
					roleTarget(picked),
					{ phase: "planning", role: picked },
					request.thinkingLevel,
				);
			}

			// The planner made its first edit: hand the rest to the implementer.
			if (state.phase === "planning" && editedThisTurn(request.messages)) {
				ctx.ui.notify(
					`judge/auto: -> ${targetKey(roleTarget("exec"))} (implementation)`,
					"info",
				);
				return routeTo(
					request,
					ctx,
					roleTarget("exec"),
					{ phase: "implementation", role: "exec" },
					IMPLEMENT_THINKING,
				);
			}

			return routeTo(
				request,
				ctx,
				roleTarget(role),
				state,
				state.phase === "implementation"
					? IMPLEMENT_THINKING
					: request.thinkingLevel,
			);
		},
	});

	pi.registerCommand("judge-models", {
		description: "Show or override the models judge/auto uses (session only)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const parts = prefix.trimStart().split(/\s+/);
			const completingRole = parts.length <= 1 && !/\s$/.test(prefix);

			if (completingRole) {
				const typed = parts[0] ?? "";
				const roles = ROLES.filter((role) => role.startsWith(typed));
				return roles.length > 0
					? roles.map((role) => ({
							value: role,
							label: role,
							description: ROLE_HELP[role],
						}))
					: null;
			}

			const first = parts[0]!;
			if (first === "reset") {
				const typed = parts[1] ?? "";
				const targets = [...ROLES, "all"].filter((entry) => entry.startsWith(typed));
				return targets.length > 0
					? targets.map((entry) => ({ value: entry, label: entry }))
					: null;
			}
			if (!isRole(first)) return null;

			// Same list, same fuzzy matching and same search text as pi's /model, so
			// the suggestions behave the way they do there.
			const models = latestCtx?.modelRegistry.getAvailable() ?? [];
			if (models.length === 0) return null;
			const filtered = fuzzyFilter(
				models.map((model) => ({
					id: model.id,
					provider: model.provider,
					name: model.name,
				})),
				parts.slice(1).join(" "),
				modelSearchText,
			);
			return filtered.length > 0
				? filtered.map((model) => ({
						value: `${model.provider}/${model.id}`,
						label: model.id,
						description: model.provider,
					}))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			latestCtx = ctx;
			const result = runModelsCommand(args, {
				base: BASE_ROLES,
				overrides,
				accepts: (role, reference) => acceptsModel(ctx, role, reference),
			});
			ctx.ui.notify(result.lines.join("\n"), "info");
			refreshStatus(ctx);
		},
	});

	pi.registerCommand("usage-breakdown", {
		description: "Per-model and per-provider usage for the current session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const samples = sessionSamples(ctx);
			ctx.ui.notify(
				[
					formatTable(aggregate(samples, byModel), { title: "model" }),
					"",
					formatTable(aggregate(samples, byProvider), { title: "provider" }),
				].join("\n"),
				"info",
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
