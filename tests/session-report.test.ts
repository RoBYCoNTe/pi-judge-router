/**
 * Unit tests for session usage aggregation and the report table.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	aggregate,
	byModel,
	byProvider,
	formatCostSplit,
	formatTable,
	samplesFromEntries,
	totals,
	type UsageSample,
} from "../src/session-report.ts";

const sample = (over: Partial<UsageSample> = {}): UsageSample => ({
	provider: "deepseek",
	model: "deepseek-flash",
	input: 100,
	output: 10,
	cacheRead: 1_000,
	cacheWrite: 0,
	cost: 0.1,
	...over,
});

describe("aggregate", () => {
	test("sums per key and sorts by cost descending", () => {
		const rows = aggregate(
			[
				sample({ cost: 0.1 }),
				sample({ cost: 0.2 }),
				sample({ provider: "zai", model: "glm-5.3-flash", cost: 0.05 }),
			],
			byModel,
		);

		expect(rows.map((row) => row.label)).toEqual([
			"deepseek/deepseek-flash",
			"zai/glm-5.3-flash",
		]);
		expect(rows[0]).toEqual({
			label: "deepseek/deepseek-flash",
			calls: 2,
			input: 200,
			output: 20,
			cacheRead: 2_000,
			cacheWrite: 0,
			cost: 0.30000000000000004,
		});
	});

	test("groups by provider too", () => {
		const rows = aggregate(
			[
				sample(),
				sample({ model: "deepseek-v4-pro" }),
				sample({ provider: "zai", model: "glm-5.3-flash" }),
			],
			byProvider,
		);

		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.label === "deepseek")?.calls).toBe(2);
	});

	test("empty input is an empty report", () => {
		expect(aggregate([], byModel)).toEqual([]);
	});
});

describe("totals", () => {
	test("adds every column", () => {
		const rows = aggregate([sample(), sample({ provider: "zai", cost: 0.05 })], byProvider);
		const total = totals(rows);
		expect(total.calls).toBe(2);
		expect(total.input).toBe(200);
		expect(total.cost).toBeCloseTo(0.15, 10);
	});

	test("zero rows produce a zero total", () => {
		expect(totals([]).calls).toBe(0);
	});
});

describe("formatTable", () => {
	test("renders header, rows and a TOTAL line", () => {
		const table = formatTable(aggregate([sample()], byModel), { title: "model" });
		const lines = table.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("model");
		expect(lines[0]).toContain("cost");
		expect(lines[1]).toContain("deepseek/deepseek-flash");
		expect(lines[2]).toContain("TOTAL");
		expect(lines[2]).toContain("$0.100");
	});

	test("hides the cache-write column when nothing wrote cache", () => {
		expect(formatTable(aggregate([sample()], byModel))).not.toContain("cache-w");
	});

	test("shows the cache-write column when a row used it", () => {
		const rows = aggregate([sample({ cacheWrite: 500 })], byModel);
		expect(formatTable(rows)).toContain("cache-w");
	});

	test("says so when there is nothing to report", () => {
		expect(formatTable([])).toContain("no usage");
	});
});

describe("samplesFromEntries", () => {
	const assistant = (message: Record<string, unknown> = {}): unknown => ({
		type: "message",
		message: {
			role: "assistant",
			provider: "deepseek",
			model: "deepseek-flash",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 100,
				cacheWrite: 0,
				cost: { total: 0.01 },
			},
			...message,
		},
	});

	test("extracts assistant usage", () => {
		expect(samplesFromEntries([assistant()])).toEqual([
			{
				provider: "deepseek",
				model: "deepseek-flash",
				input: 10,
				output: 2,
				cacheRead: 100,
				cacheWrite: 0,
				cost: 0.01,
			},
		]);
	});

	test("skips other entry types, other roles and messages without usage", () => {
		expect(
			samplesFromEntries([
				{ type: "model_change", provider: "judge", modelId: "auto" },
				{ type: "message", message: { role: "user", content: "hi" } },
				{ type: "message", message: { role: "assistant", provider: "zai", model: "glm" } },
				assistant(),
			]),
		).toHaveLength(1);
	});

	test("tolerates garbage instead of throwing", () => {
		expect(
			samplesFromEntries([
				null,
				42,
				"x",
				{},
				{ type: "message" },
				{ type: "message", message: { role: "assistant", usage: null } },
			]),
		).toEqual([]);
	});

	test("labels missing names and counts missing numbers as zero", () => {
		expect(
			samplesFromEntries([{ type: "message", message: { role: "assistant", usage: {} } }]),
		).toEqual([
			{
				provider: "unknown",
				model: "unknown",
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
			},
		]);
	});
});

describe("formatCostSplit", () => {
	test("one segment per provider with cost", () => {
		const rows = aggregate(
			[
				sample({ cost: 0.6709 }),
				sample({ provider: "zai", cost: 0.1301 }),
				sample({ provider: "fireworks", cost: 0 }),
			],
			byProvider,
		);
		expect(formatCostSplit(rows)).toBe("ds $0.671 · zai $0.130");
	});

	test("empty when nothing was spent", () => {
		expect(formatCostSplit(aggregate([sample({ cost: 0 })], byProvider))).toBe("");
	});
});
