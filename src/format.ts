/**
 * Display helpers for the footer and the report command.
 *
 * Pure and dependency-free: numbers in, strings out. Kept separate from the
 * parsers so the formatting choices (bar width, when to say `1h12m` instead of
 * `72m`) can be tested without any network or pi runtime.
 */

import type { ProbeOutcome } from "./provider-probe.ts";

/** `1234567` -> `1.2M`, `1500` -> `1.5k`. */
export function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(Math.round(value));
}

/** Three decimals for cents, two for larger amounts: `$0.671`, `$45.94`. */
export function formatMoney(value: number): string {
	if (!Number.isFinite(value)) return "$?";
	return `$${value.toFixed(value >= 10 ? 2 : 3)}`;
}

/** `32` -> `██░░░░░░` with `width` cells. */
export function renderBar(percent: number, width = 8): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Compact countdown: `<1m`, `45m`, `1h12m`, `3d`, `2d4h`.
 *
 * With `{ short: true }` it keeps the largest unit only — `3h`, `6d` — which is
 * what the footer uses: the exact minutes are noise in a one-line status.
 */
export function humanizeDuration(ms: number, options: { short?: boolean } = {}): string {
	if (!Number.isFinite(ms) || ms <= 0) return "now";
	if (ms < 60_000) return "<1m";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (options.short) return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
	const restMinutes = minutes % 60;
	if (hours < 24) {
		return restMinutes === 0
			? `${hours}h`
			: `${hours}h${String(restMinutes).padStart(2, "0")}m`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0 ? `${days}d` : `${days}d${restHours}h`;
}

/** Short provider tag for the footer: `deepseek` -> `ds`. */
export function shortProvider(provider: string): string {
	switch (provider) {
		case "deepseek":
			return "ds";
		case "fireworks":
			return "fw";
		case "openai-codex":
			return "codex";
		case "openrouter":
			return "or";
		default:
			return provider.length <= 4 ? provider : provider.slice(0, 4);
	}
}

export interface ReadingOptions {
	/** Numbers only: no bars, no countdowns. */
	compact?: boolean;
	/** Bar width in cells. `0` drops the bar and keeps the number. Default 4. */
	barWidth?: number;
	/** Injectable clock, so countdowns are testable. */
	now?: number;
}

/**
 * One provider's reading as footer text.
 *
 * Always starts with the provider tag. A bare `5h ███░░ 32% ⟳3h46m` does not
 * say whose window it is, and the footer concatenates several extensions'
 * statuses with nothing between them, so context has to be in the text.
 */
export function formatReading(
	provider: string,
	outcome: ProbeOutcome,
	options: ReadingOptions = {},
): string {
	const tag = shortProvider(provider);
	const now = options.now ?? Date.now();
	const barWidth = options.barWidth ?? 4;

	if (outcome.windows !== undefined && outcome.windows.length > 0) {
		if (options.compact) {
			const percents = outcome.windows
				.map((window) => `${Math.round(window.percent)}%`)
				.join("/");
			return `${tag} ${percents}`;
		}
		const windows = outcome.windows
			.map((window) => {
				const reset =
					window.resetsAt === undefined
						? ""
						: ` ⟳${humanizeDuration(window.resetsAt - now, { short: true })}`;
				const bar = barWidth > 0 ? `${renderBar(window.percent, barWidth)} ` : "";
				return `${window.label} ${bar}${Math.round(window.percent)}%${reset}`;
			})
			.join(" · ");
		return `${tag} ${windows}`;
	}

	if (outcome.balance !== undefined) {
		return `${tag} ${formatMoney(outcome.balance.amount)}`;
	}
	return `${tag} ${outcome.note ?? "?"}`;
}
