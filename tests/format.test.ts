/**
 * Unit tests for the display helpers. Pure string formatting: bars, token
 * counts, money, duration countdowns and provider tags.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	formatMoney,
	formatReading,
	formatTokens,
	humanizeDuration,
	renderBar,
	shortProvider,
} from "../src/format.ts";

describe("formatTokens", () => {
	test("scales to k and M", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1_500)).toBe("1.5k");
		expect(formatTokens(470_259)).toBe("470.3k");
		expect(formatTokens(41_914_624)).toBe("41.9M");
	});

	test("survives garbage", () => {
		expect(formatTokens(Number.NaN)).toBe("0");
		expect(formatTokens(-5)).toBe("0");
	});
});

describe("formatMoney", () => {
	test("three decimals for cents, two above", () => {
		expect(formatMoney(0.6709)).toBe("$0.671");
		expect(formatMoney(0.1301)).toBe("$0.130");
		expect(formatMoney(45.94)).toBe("$45.94");
	});
});

describe("renderBar", () => {
	test("fills proportionally to the percentage", () => {
		expect(renderBar(0)).toBe("░░░░░░░░");
		expect(renderBar(50)).toBe("████░░░░");
		expect(renderBar(100)).toBe("████████");
	});

	test("clamps out-of-range values instead of throwing", () => {
		expect(renderBar(-10)).toBe("░░░░░░░░");
		expect(renderBar(500)).toBe("████████");
	});

	test("honors a custom width", () => {
		expect(renderBar(50, 4)).toBe("██░░");
	});
});

describe("humanizeDuration", () => {
	test("picks the right unit", () => {
		expect(humanizeDuration(30_000)).toBe("<1m");
		expect(humanizeDuration(45 * 60_000)).toBe("45m");
		expect(humanizeDuration(72 * 60_000)).toBe("1h12m");
		expect(humanizeDuration(2 * 60 * 60_000)).toBe("2h");
		expect(humanizeDuration(3 * 24 * 60 * 60_000)).toBe("3d");
		expect(humanizeDuration((2 * 24 + 4) * 60 * 60_000)).toBe("2d4h");
	});

	test("past or invalid deadlines read as expired", () => {
		expect(humanizeDuration(0)).toBe("now");
		expect(humanizeDuration(-1000)).toBe("now");
	});

	test("short mode keeps the largest unit only", () => {
		expect(humanizeDuration(72 * 60_000, { short: true })).toBe("1h");
		expect(humanizeDuration((6 * 24 + 17) * 60 * 60_000, { short: true })).toBe("6d");
		expect(humanizeDuration(45 * 60_000, { short: true })).toBe("45m");
		expect(humanizeDuration(30_000, { short: true })).toBe("<1m");
	});
});

describe("formatReading", () => {
	const now = 1_000_000_000_000;

	test("always names the provider, so a bare bar is never ambiguous", () => {
		expect(
			formatReading(
				"zai",
				{ usable: true, windows: [{ label: "5h", percent: 32 }] },
				{ now },
			),
		).toBe("zai 5h █░░░ 32%");
	});

	test("renders every window with its reset countdown", () => {
		const outcome = {
			usable: true,
			windows: [
				{ label: "5h", percent: 32, resetsAt: now + 3 * 3_600_000 },
				{ label: "W", percent: 6, resetsAt: now + (6 * 24 + 17) * 3_600_000 },
			],
		};
		expect(formatReading("zai", outcome, { now })).toBe(
			"zai 5h █░░░ 32% ⟳3h · W ░░░░ 6% ⟳6d",
		);
	});

	test("bar width is configurable, and 0 drops the bar", () => {
		const outcome = { usable: true, windows: [{ label: "5h", percent: 50 }] };
		expect(formatReading("zai", outcome, { now, barWidth: 8 })).toBe("zai 5h ████░░░░ 50%");
		expect(formatReading("zai", outcome, { now, barWidth: 0 })).toBe("zai 5h 50%");
	});

	test("compact mode keeps the tag and drops the bars", () => {
		const outcome = {
			usable: true,
			windows: [
				{ label: "5h", percent: 32 },
				{ label: "W", percent: 6 },
			],
		};
		expect(formatReading("zai", outcome, { compact: true, now })).toBe("zai 32%/6%");
	});

	test("renders a balance with its short provider tag", () => {
		expect(
			formatReading("deepseek", { usable: true, balance: { amount: 45.7, currency: "USD" } }, { now }),
		).toBe("ds $45.70");
	});

	test("falls back to the note when there is no number", () => {
		expect(formatReading("zai", { usable: true, note: "probe failed" }, { now })).toBe(
			"zai probe failed",
		);
	});
});

describe("shortProvider", () => {
	test("uses short tags for long provider ids", () => {
		expect(shortProvider("deepseek")).toBe("ds");
		expect(shortProvider("fireworks")).toBe("fw");
		expect(shortProvider("openai-codex")).toBe("codex");
	});

	test("keeps short ids as they are", () => {
		expect(shortProvider("zai")).toBe("zai");
		expect(shortProvider("anthropic")).toBe("anth");
	});
});
