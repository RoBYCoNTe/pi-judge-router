/**
 * Session usage aggregation for `/usage-breakdown`.
 *
 * Pure: it takes already-extracted `UsageSample`s, so it knows nothing about pi
 * session entries, the network, or the footer. The extension maps its own
 * entries into these samples; everything below is testable in isolation.
 *
 * Why this exists: the built-in footer shows one cumulative cost for the whole
 * session, which mixes providers that do not bill the same way — a prepaid
 * balance in dollars and a plan measured in quota percentages. Splitting the
 * same numbers per provider and per model is what makes the consumption
 * readable.
 */

import { formatMoney, formatTokens, shortProvider } from "./format.ts";

export interface UsageSample {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ReportRow {
	label: string;
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const UNKNOWN = "unknown";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : UNKNOWN;
}

/**
 * Map pi session entries to usage samples.
 *
 * Takes `unknown` on purpose: the caller passes `ctx.sessionManager.getBranch()`
 * and every shape is narrowed defensively, so a future entry type or a partial
 * message is skipped instead of throwing inside a render path. Extracted from
 * the extension for exactly that reason — here it can be tested with fixtures.
 */
export function samplesFromEntries(entries: readonly unknown[]): UsageSample[] {
	const samples: UsageSample[] = [];
	for (const raw of entries) {
		const entry = asRecord(raw);
		if (!entry || entry.type !== "message") continue;
		const message = asRecord(entry.message);
		if (!message || message.role !== "assistant") continue;
		const usage = asRecord(message.usage);
		if (!usage) continue;
		const cost = asRecord(usage.cost);
		samples.push({
			provider: str(message.provider),
			model: str(message.model),
			input: num(usage.input),
			output: num(usage.output),
			cacheRead: num(usage.cacheRead),
			cacheWrite: num(usage.cacheWrite),
			cost: num(cost?.total),
		});
	}
	return samples;
}

export const byProvider = (sample: UsageSample): string =>
	sample.provider || UNKNOWN;

export const byModel = (sample: UsageSample): string =>
	`${sample.provider || UNKNOWN}/${sample.model || UNKNOWN}`;

/** Group samples by `keyOf`, sorted by cost (descending) then input. */
export function aggregate(
	samples: readonly UsageSample[],
	keyOf: (sample: UsageSample) => string,
): ReportRow[] {
	const rows = new Map<string, ReportRow>();
	for (const sample of samples) {
		const label = keyOf(sample);
		let row = rows.get(label);
		if (row === undefined) {
			row = {
				label,
				calls: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
			};
			rows.set(label, row);
		}
		row.calls += 1;
		row.input += sample.input;
		row.output += sample.output;
		row.cacheRead += sample.cacheRead;
		row.cacheWrite += sample.cacheWrite;
		row.cost += sample.cost;
	}
	return [...rows.values()].sort(
		(a, b) => b.cost - a.cost || b.input - a.input || a.label.localeCompare(b.label),
	);
}

export function totals(rows: readonly ReportRow[]): ReportRow {
	return rows.reduce<ReportRow>(
		(acc, row) => ({
			label: "TOTAL",
			calls: acc.calls + row.calls,
			input: acc.input + row.input,
			output: acc.output + row.output,
			cacheRead: acc.cacheRead + row.cacheRead,
			cacheWrite: acc.cacheWrite + row.cacheWrite,
			cost: acc.cost + row.cost,
		}),
		{ label: "TOTAL", calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
}

export interface TableOptions {
	/** Column header for the grouping key. */
	title?: string;
	/** Show the cache-write column (hidden when every row is zero). */
	showCacheWrite?: boolean;
}

/** Fixed-width table for a monospace terminal. */
export function formatTable(
	rows: readonly ReportRow[],
	options: TableOptions = {},
): string {
	if (rows.length === 0) return "no usage in this session yet";
	const showCacheWrite =
		options.showCacheWrite ?? rows.some((row) => row.cacheWrite > 0);
	const labelWidth = Math.max(
		"TOTAL".length,
		options.title?.length ?? 0,
		...rows.map((row) => row.label.length),
	);

	const header = [
		(options.title ?? "model").padEnd(labelWidth),
		"calls".padStart(6),
		"in".padStart(9),
		"out".padStart(9),
		"cache-r".padStart(9),
		...(showCacheWrite ? ["cache-w".padStart(9)] : []),
		"cost".padStart(9),
	].join("  ");

	const line = (row: ReportRow): string =>
		[
			row.label.padEnd(labelWidth),
			String(row.calls).padStart(6),
			formatTokens(row.input).padStart(9),
			formatTokens(row.output).padStart(9),
			formatTokens(row.cacheRead).padStart(9),
			...(showCacheWrite ? [formatTokens(row.cacheWrite).padStart(9)] : []),
			formatMoney(row.cost).padStart(9),
		].join("  ");

	return [header, ...rows.map(line), line(totals(rows))].join("\n");
}

/** One-line per-provider cost split for the footer: `ds $0.671 · zai $0.130`. */
export function formatCostSplit(rows: readonly ReportRow[]): string {
	return rows
		.filter((row) => row.cost > 0)
		.map((row) => `${shortProvider(row.label)} ${formatMoney(row.cost)}`)
		.join(" · ");
}
