/**
 * Persistent usage accounting for the Jev calls this router makes.
 *
 * Pure module: JSON in, JSON out, `node:fs` for storage. No pi imports, so it
 * is unit-testable and reusable.
 *
 * Scope note (deliberate): this counts ONLY the calls this router makes — one
 * judge request per session, plus retries of it. Calls made by other
 * extensions (a gate judging every tool call, for example) go through their
 * own clients and are invisible here. TypeSafe's API exposes no balance or
 * aggregated usage endpoint, so the authoritative credit number stays in the
 * vendor console; this store answers "how much has pi spent on routing".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface UsageRecord {
	calls: number;
	inputTokens: number;
	outputTokens: number;
}

export interface UsageStore {
	version: 1;
	/** First day ever recorded, for the "since" line. */
	since: string;
	total: UsageRecord;
	/** Keyed by `YYYY-MM-DD`. Days roll off only when pruned. */
	days: Record<string, UsageRecord>;
}

export function emptyStore(today: string): UsageStore {
	return {
		version: 1,
		since: today,
		total: { calls: 0, inputTokens: 0, outputTokens: 0 },
		days: {},
	};
}

function emptyRecord(): UsageRecord {
	return { calls: 0, inputTokens: 0, outputTokens: 0 };
}

function addInto(target: UsageRecord, inputTokens: number, outputTokens: number): void {
	target.calls += 1;
	target.inputTokens += inputTokens;
	target.outputTokens += outputTokens;
}

/** Record one judge call under `day` (`YYYY-MM-DD`). Mutates and returns the store. */
export function recordUsage(
	store: UsageStore,
	usage: { inputTokens?: number; outputTokens?: number },
	day: string,
): UsageStore {
	const inputTokens = Math.max(0, Math.round(usage.inputTokens ?? 0));
	const outputTokens = Math.max(0, Math.round(usage.outputTokens ?? 0));
	if (store.days[day] === undefined) store.days[day] = emptyRecord();
	addInto(store.days[day]!, inputTokens, outputTokens);
	addInto(store.total, inputTokens, outputTokens);
	return store;
}

export function loadStore(path: string, today: string): UsageStore {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const root = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		const store = emptyStore(typeof root.since === "string" ? root.since : today);
		const total = asRecord(root.total);
		if (total) store.total = normalizeRecord(total);
		const days = asRecord(root.days);
		if (days) {
			for (const [day, value] of Object.entries(days)) {
				const record = asRecord(value);
				if (record) store.days[day] = normalizeRecord(record);
			}
		}
		return store;
	} catch {
		// Missing or corrupt file: start over rather than refuse to route.
		return emptyStore(today);
	}
}

export function saveStore(path: string, store: UsageStore): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(store, null, "\t")}\n`, "utf8");
	} catch {
		// A read-only agent directory must not break routing.
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function normalizeRecord(value: Record<string, unknown>): UsageRecord {
	const num = (raw: unknown): number => {
		const parsed = Number(raw);
		return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
	};
	return {
		calls: num(value.calls),
		inputTokens: num(value.inputTokens),
		outputTokens: num(value.outputTokens),
	};
}

function compact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/** One-line human summary, for the footer and for `/jev-usage`. */
export function formatUsage(store: UsageStore, today: string): string {
	const total = store.total;
	const todayRecord = store.days[today] ?? emptyRecord();
	const parts = [
		`since ${store.since}: ${total.calls} calls, in ${compact(total.inputTokens)}, out ${compact(total.outputTokens)}`,
	];
	if (todayRecord.calls > 0) {
		parts.push(
			`today: ${todayRecord.calls} calls, in ${compact(todayRecord.inputTokens)}, out ${compact(todayRecord.outputTokens)}`,
		);
	}
	return parts.join(" · ");
}
