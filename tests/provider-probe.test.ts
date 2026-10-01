/**
 * Unit tests for the provider probes.
 *
 * The fixtures reproduce the real response shape of both endpoints (field names,
 * types, envelopes). Values are generic on purpose: no account data belongs in
 * a public repository.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PROBE_OPTIONS,
	deepseekHasCredit,
	describeDeepseek,
	describeZai,
	parseTarget,
	targetKey,
	zaiHasQuota,
} from "../src/provider-probe.ts";

const DEEPSEEK = {
	is_available: true,
	balance_infos: [
		{
			currency: "USD",
			total_balance: "42.00",
			granted_balance: "0.00",
			topped_up_balance: "42.00",
		},
	],
};

const ZAI = {
	code: 200,
	msg: "Operation successful",
	data: {
		level: "pro",
		limits: [
			{
				type: "TIME_LIMIT",
				unit: 5,
				number: 1,
				usage: 1000,
				currentValue: 0,
				remaining: 1000,
				percentage: 0,
			},
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 32 },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 6 },
		],
	},
	success: true,
};

describe("parseTarget", () => {
	test("splits on the first slash only, so ids may contain slashes", () => {
		expect(parseTarget("zai/glm-5.3-flash")).toEqual({
			provider: "zai",
			id: "glm-5.3-flash",
		});
		expect(parseTarget("fireworks/accounts/fireworks/models/glm-5p3")).toEqual({
			provider: "fireworks",
			id: "accounts/fireworks/models/glm-5p3",
		});
	});

	test("rejects malformed references", () => {
		expect(parseTarget("")).toBeUndefined();
		expect(parseTarget("zai")).toBeUndefined();
		expect(parseTarget("/glm")).toBeUndefined();
		expect(parseTarget("zai/")).toBeUndefined();
	});

	test("targetKey round-trips", () => {
		expect(targetKey(parseTarget("deepseek/deepseek-flash")!)).toBe(
			"deepseek/deepseek-flash",
		);
	});
});

describe("deepseekHasCredit", () => {
	test("real shape, funded account -> usable", () => {
		expect(deepseekHasCredit(DEEPSEEK)).toBe(true);
	});

	test("is_available false -> exhausted even with a balance", () => {
		expect(deepseekHasCredit({ ...DEEPSEEK, is_available: false })).toBe(false);
	});

	test("balance below the threshold -> exhausted", () => {
		expect(
			deepseekHasCredit({
				balance_infos: [{ currency: "USD", total_balance: "0.50" }],
			}),
		).toBe(false);
	});

	test("balance exactly at the threshold -> usable", () => {
		expect(
			deepseekHasCredit({
				balance_infos: [{ currency: "USD", total_balance: "1.00" }],
			}),
		).toBe(true);
	});

	test("threshold is configurable", () => {
		const payload = { balance_infos: [{ currency: "USD", total_balance: "5" }] };
		expect(deepseekHasCredit(payload, { ...DEFAULT_PROBE_OPTIONS, minBalanceUsd: 10 })).toBe(false);
		expect(deepseekHasCredit(payload, { ...DEFAULT_PROBE_OPTIONS, minBalanceUsd: 1 })).toBe(true);
	});

	test("balance as a number, not a string", () => {
		expect(
			deepseekHasCredit({ balance_infos: [{ currency: "USD", total_balance: 12 }] }),
		).toBe(true);
	});

	test("multi-currency prefers USD", () => {
		expect(
			deepseekHasCredit({
				balance_infos: [
					{ currency: "CNY", total_balance: "0.10" },
					{ currency: "USD", total_balance: "8.00" },
				],
			}),
		).toBe(true);
	});

	test("missing or empty balance_infos -> fail open", () => {
		expect(deepseekHasCredit({ is_available: true })).toBe(true);
		expect(deepseekHasCredit({ balance_infos: [] })).toBe(true);
	});

	test("unexpected shapes -> fail open", () => {
		expect(deepseekHasCredit(null)).toBe(true);
		expect(deepseekHasCredit("<html>bad gateway</html>")).toBe(true);
		expect(deepseekHasCredit({ balance_infos: [{ currency: "USD" }] })).toBe(true);
	});
});

describe("probe outcomes (structured)", () => {
	test("deepseek reports the balance it read", () => {
		expect(describeDeepseek(DEEPSEEK)).toEqual({
			usable: true,
			balance: { amount: 42, currency: "USD" },
		});
	});

	test("deepseek keeps the number when it is unusable", () => {
		expect(describeDeepseek({ ...DEEPSEEK, is_available: false })).toEqual({
			usable: false,
			balance: { amount: 42, currency: "USD" },
		});
	});

	test("zai reports every token window, soonest resetting first", () => {
		const outcome = describeZai({
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 6, nextResetTime: 2_000 },
					{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 32, nextResetTime: 1_000 },
					{ type: "TIME_LIMIT", percentage: 0, remaining: 1000 },
				],
			},
		});
		expect(outcome.usable).toBe(true);
		expect(outcome.windows).toEqual([
			{ label: "5h", percent: 32, resetsAt: 1_000 },
			{ label: "W", percent: 6, resetsAt: 2_000 },
		]);
	});

	test("zai windows omit the reset when the vendor does not send one", () => {
		const outcome = describeZai({
			data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10 }] },
		});
		expect(outcome.windows).toEqual([{ label: "5h", percent: 10 }]);
	});

	test("a full window makes the provider unusable", () => {
		const outcome = describeZai({
			data: {
				limits: [
					{ type: "TOKENS_LIMIT", percentage: 12, nextResetTime: 1 },
					{ type: "TOKENS_LIMIT", percentage: 99, nextResetTime: 2 },
				],
			},
		});
		expect(outcome.usable).toBe(false);
	});

	test("unreadable payloads explain themselves and stay usable", () => {
		expect(describeDeepseek(null)).toEqual({ usable: true, note: "unreadable" });
		expect(describeZai(null)).toEqual({ usable: true, note: "unreadable" });
	});
});

describe("zaiHasQuota", () => {
	test("real shape, quota left -> usable", () => {
		expect(zaiHasQuota(ZAI)).toBe(true);
	});

	test("a token window at or above the ceiling -> exhausted", () => {
		expect(
			zaiHasQuota({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 96 }] } }),
		).toBe(false);
		expect(
			zaiHasQuota({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 95 }] } }),
		).toBe(false);
		expect(
			zaiHasQuota({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 94 }] } }),
		).toBe(true);
	});

	test("ceiling is configurable", () => {
		const payload = { data: { limits: [{ type: "TOKENS_LIMIT", percentage: 50 }] } };
		expect(zaiHasQuota(payload, { ...DEFAULT_PROBE_OPTIONS, maxQuotaPercent: 40 })).toBe(false);
		expect(zaiHasQuota(payload, { ...DEFAULT_PROBE_OPTIONS, maxQuotaPercent: 95 })).toBe(true);
	});

	test("TIME_LIMIT at 100% is not a token exhaustion", () => {
		expect(
			zaiHasQuota({
				data: { limits: [{ type: "TIME_LIMIT", percentage: 100, remaining: 0 }] },
			}),
		).toBe(true);
	});

	test("missing limits -> fail open", () => {
		expect(zaiHasQuota({ data: {} })).toBe(true);
		expect(zaiHasQuota({})).toBe(true);
	});

	test("unexpected shapes -> fail open", () => {
		expect(zaiHasQuota(null)).toBe(true);
		expect(zaiHasQuota({ data: { limits: "nope" } })).toBe(true);
		expect(
			zaiHasQuota({
				data: { limits: [{ type: "TOKENS_LIMIT", percentage: "abc" }] },
			}),
		).toBe(true);
	});
});
