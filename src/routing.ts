/**
 * Pure routing policy for judge/auto: how a complexity reading becomes a tier,
 * and which role serves a phase. The cadence of the judgement (one per user
 * message, never per tool continuation) lives in the router, keyed off pi's
 * `reason`, and is not a policy decision.
 *
 * No pi imports, so the policy is unit-testable without a running session — the
 * same reason `provider-probe.ts` and `model-overrides.ts` keep themselves
 * dependency-free.
 *
 * The tier **ratchets**: the judge re-reads every new user message, but once a
 * session has been called complex it stays on the strong tier. That is what
 * keeps the policy cache-friendly. A model switch forfeits the warm prompt
 * cache, and on long contexts the re-read dominates the bill, so the router
 * wants few, permanent moves upward rather than a per-turn oscillation. Since
 * real work drifts from simple to complex far more often than the reverse, a
 * ratchet is also the honest shape of the workload; the safe direction is to
 * over-provision, never to under-provision.
 */

import type { Role } from "./model-overrides.ts";
import type { Target } from "./provider-probe.ts";

/** The two spending levels the judge can put a session on. */
export type Tier = "low" | "high";

/** Exploration first, then the mechanical part of the session. */
export type Phase = "planning" | "implementation";

export interface RouterState {
	phase: Phase;
	/** Highest tier reached so far. Only ever moves up within a session. */
	tier?: Tier;
	/** Legacy: the resolved planning role, written before tiers existed. */
	role?: Role;
	/** Legacy: sessions written before roles existed; still honoured on resume. */
	model?: Target;
}

/**
 * The role that serves a phase at a given tier.
 *
 * `strong` is the complex tier in both phases: when the judge says the work is
 * subtle, planning *and* implementation both deserve the better model. `cheap`
 * and `exec` are the cheap planner and the cheap implementer.
 */
export function roleFor(phase: Phase, tier: Tier): Role {
	if (tier === "high") return "strong";
	return phase === "implementation" ? "exec" : "cheap";
}

/**
 * Fold a fresh complexity probability into the session tier.
 *
 * Upward only: a previous `high` is sticky regardless of the new reading, so an
 * escalation is never undone by a calmer turn. Below the threshold the tier is
 * `low`, which is also what an absent reading (judge unavailable) degrades to.
 */
export function ratchetTier(
	previous: Tier | undefined,
	pComplex: number,
	threshold: number,
): Tier {
	if (previous === "high") return "high";
	return pComplex >= threshold ? "high" : "low";
}

/** Recover the tier from a pre-tier session that stored a resolved role. */
export function tierFromRole(role: Role | undefined): Tier | undefined {
	if (role === "strong") return "high";
	if (role === "cheap" || role === "exec") return "low";
	return undefined;
}
