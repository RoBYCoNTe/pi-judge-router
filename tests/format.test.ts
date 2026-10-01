/**
 * Unit tests for the display helpers. Pure string formatting: bars, token
 * counts, money, duration countdowns and provider tags.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	formatMoney,
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
