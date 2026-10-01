/**
 * Unit tests for the persistent usage store. Pure module: only node:fs and JSON.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emptyStore,
	formatUsage,
	loadStore,
	recordUsage,
	saveStore,
} from "../src/usage-store.ts";

const DAY = "2026-10-01";

function tempFile(): string {
	return join(mkdtempSync(join(tmpdir(), "jr-usage-")), "usage.json");
}

describe("recordUsage", () => {
	test("accumulates into the day and the total", () => {
		const store = emptyStore(DAY);
		recordUsage(store, { inputTokens: 100, outputTokens: 20 }, DAY);
		recordUsage(store, { inputTokens: 50, outputTokens: 10 }, DAY);

		expect(store.days[DAY]).toEqual({ calls: 2, inputTokens: 150, outputTokens: 30 });
		expect(store.total).toEqual({ calls: 2, inputTokens: 150, outputTokens: 30 });
	});

	test("separates days", () => {
		const store = emptyStore(DAY);
		recordUsage(store, { inputTokens: 10, outputTokens: 1 }, DAY);
		recordUsage(store, { inputTokens: 5, outputTokens: 1 }, "2026-10-02");

		expect(store.days[DAY]!.calls).toBe(1);
		expect(store.days["2026-10-02"]!.calls).toBe(1);
		expect(store.total.calls).toBe(2);
	});

	test("tolerates missing, negative and fractional values", () => {
		const store = emptyStore(DAY);
		recordUsage(store, {}, DAY);
		recordUsage(store, { inputTokens: -10, outputTokens: 1.6 }, DAY);

		expect(store.total.inputTokens).toBe(0);
		expect(store.total.outputTokens).toBe(2);
		expect(store.total.calls).toBe(2);
	});
});

describe("loadStore / saveStore", () => {
	test("round-trips through disk", () => {
		const path = tempFile();
		const store = emptyStore(DAY);
		recordUsage(store, { inputTokens: 300, outputTokens: 40 }, DAY);
		saveStore(path, store);

		const reloaded = loadStore(path, DAY);
		expect(reloaded.total).toEqual({ calls: 1, inputTokens: 300, outputTokens: 40 });
		expect(reloaded.since).toBe(DAY);
	});

	test("missing file starts empty", () => {
		const store = loadStore(join(tmpdir(), "does-not-exist-jr.json"), DAY);
		expect(store.total.calls).toBe(0);
		expect(store.since).toBe(DAY);
	});

	test("corrupt file starts empty instead of throwing", () => {
		const path = tempFile();
		writeFileSync(path, "{ not json at all", "utf8");
		expect(loadStore(path, DAY).total.calls).toBe(0);
	});

	test("garbage fields are normalized to numbers", () => {
		const path = tempFile();
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				since: "2026-09-01",
				total: { calls: "7", inputTokens: "abc", outputTokens: -3 },
				days: { [DAY]: { calls: 7, inputTokens: 10, outputTokens: 2 } },
			}),
			"utf8",
		);
		const store = loadStore(path, DAY);
		expect(store.since).toBe("2026-09-01");
		expect(store.total).toEqual({ calls: 7, inputTokens: 0, outputTokens: 0 });
		expect(store.days[DAY]!.inputTokens).toBe(10);
	});

	test("writes readable JSON", () => {
		const path = tempFile();
		saveStore(path, emptyStore(DAY));
		expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
	});
});

describe("formatUsage", () => {
	test("summarizes total and today", () => {
		const store = emptyStore(DAY);
		recordUsage(store, { inputTokens: 1_500, outputTokens: 250 }, DAY);
		const text = formatUsage(store, DAY);

		expect(text).toContain(`since ${DAY}: 1 calls, in 1.5k, out 250`);
		expect(text).toContain("today: 1 calls");
	});

	test("omits today when there was no activity", () => {
		const store = emptyStore(DAY);
		expect(formatUsage(store, DAY)).not.toContain("today:");
	});
});
