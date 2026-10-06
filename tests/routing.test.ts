/**
 * Unit tests for the pure routing policy: tier ratchet, role-per-phase, and the
 * judgement key. The router's I/O lives in judge-router.ts; everything that is
 * a policy decision is tested here without a pi session.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	ratchetTier,
	roleFor,
	tierFromRole,
	type RouterState,
} from "../src/routing.ts";

describe("roleFor", () => {
	test("a complex session uses the strong model in both phases", () => {
		expect(roleFor("planning", "high")).toBe("strong");
		expect(roleFor("implementation", "high")).toBe("strong");
	});

	test("a simple session plans cheap and implements on exec", () => {
		expect(roleFor("planning", "low")).toBe("cheap");
		expect(roleFor("implementation", "low")).toBe("exec");
	});
});

describe("ratchetTier", () => {
	const threshold = 0.3;

	test("a first complex reading escalates", () => {
		expect(ratchetTier(undefined, 0.7, threshold)).toBe("high");
	});

	test("a first simple reading stays low", () => {
		expect(ratchetTier(undefined, 0.1, threshold)).toBe("low");
	});

	test("a later complex reading escalates a low session", () => {
		expect(ratchetTier("low", 0.9, threshold)).toBe("high");
	});

	test("a high session is sticky: a simple reading never downgrades it", () => {
		expect(ratchetTier("high", 0.0, threshold)).toBe("high");
	});

	test("the threshold is inclusive on the complex side", () => {
		expect(ratchetTier("low", threshold, threshold)).toBe("high");
	});
});

describe("tierFromRole", () => {
	test("maps the role-era values onto a tier", () => {
		expect(tierFromRole("strong")).toBe("high");
		expect(tierFromRole("cheap")).toBe("low");
		expect(tierFromRole("exec")).toBe("low");
	});

	test("no role and unknown roles read as no tier", () => {
		expect(tierFromRole(undefined)).toBeUndefined();
		expect(tierFromRole("nonsense" as never)).toBeUndefined();
	});
});

describe("RouterState", () => {
	test("a fresh session needs only a phase", () => {
		const state: RouterState = { phase: "planning" };
		expect(state.tier).toBeUndefined();
	});
});
