/**
 * Display helpers for the footer and the report command.
 *
 * Pure and dependency-free: numbers in, strings out. Kept separate from the
 * parsers so the formatting choices (bar width, when to say `1h12m` instead of
 * `72m`) can be tested without any network or pi runtime.
 */

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

/** Compact countdown: `<1m`, `45m`, `1h12m`, `3d`, `2d4h`. */
export function humanizeDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "now";
	if (ms < 60_000) return "<1m";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
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
