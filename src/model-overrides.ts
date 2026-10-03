/**
 * Session-scoped overrides for the models the router uses.
 *
 * Nothing here touches the disk: the override lives as long as the pi process,
 * which is what "set it before the judge decides" needs without turning into a
 * second configuration file to keep in sync with the environment variables.
 *
 * Pure module, no pi imports, so the command logic and the status rendering are
 * testable without a running session.
 */

import { PROBED_PROVIDERS, parseTarget } from "./provider-probe.ts";

export type Role = "judge" | "cheap" | "strong" | "exec";

export const ROLES: readonly Role[] = ["judge", "cheap", "strong", "exec"];

/** One line per role, for the completion list and the status output. */
export const ROLE_HELP: Record<Role, string> = {
	judge: "classifier that rates task complexity",
	cheap: "planner for ordinary tasks",
	strong: "planner for tasks the judge calls complex",
	exec: "implementation and compaction",
};

export type RoleSource = "override" | "env" | "default";

export interface RoleSetting {
	role: Role;
	value: string;
	source: RoleSource;
}

export function isRole(value: string | undefined): value is Role {
	return value !== undefined && (ROLES as readonly string[]).includes(value);
}

/** Session-only overrides, on top of whatever the environment configured. */
export class RoleOverrides {
	private readonly values = new Map<Role, string>();

	get(role: Role): string | undefined {
		return this.values.get(role);
	}

	set(role: Role, reference: string): void {
		this.values.set(role, reference);
	}

	clear(role: Role): boolean {
		return this.values.delete(role);
	}

	clearAll(): number {
		const count = this.values.size;
		this.values.clear();
		return count;
	}

	size(): number {
		return this.values.size;
	}

	/**
	 * The effective settings: an override wins over the environment, which wins
	 * over the built-in default. The `source` field is what makes the status
	 * output unambiguous, so a surprising model can always be traced back.
	 */
	effective(base: readonly RoleSetting[]): RoleSetting[] {
		return base.map((setting) => {
			const override = this.values.get(setting.role);
			return override === undefined
				? setting
				: { role: setting.role, value: override, source: "override" as const };
		});
	}
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function formatRoleSettings(settings: readonly RoleSetting[]): string {
	const valueWidth = Math.max(...settings.map((s) => s.value.length), 5);
	return settings
		.map(
			(setting) =>
				`  ${pad(setting.role, 6)} ${pad(setting.value, valueWidth)}  (${setting.source})  ${ROLE_HELP[setting.role]}`,
		)
		.join("\n");
}

/**
 * The text a model is matched against. Copied from pi's own `/model` matching
 * so the suggestions here behave the same way: the bare id is deliberately not
 * first, which keeps a query like `openrouter/openai/...` from ranking a proxy
 * provider above the real one.
 */
export function modelSearchText(item: {
	id: string;
	provider: string;
	name?: string;
}): string {
	const name = item.name ? ` ${item.name}` : "";
	return `${item.id} ${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
}

export interface ModelLookupResult {
	ok: boolean;
	reason?: string;
}

export interface ModelsCommandDeps {
	base: readonly RoleSetting[];
	overrides: RoleOverrides;
	/** Whether the reference names a usable model of the right kind for the role. */
	accepts: (role: Role, reference: string) => ModelLookupResult;
}

export interface CommandResult {
	lines: string[];
	changed: boolean;
}

const USAGE = [
	"usage:",
	"  /judge-models                     show the four roles",
	"  /judge-models <role> <provider/id> set a session override",
	"  /judge-models reset <role|all>    drop the override",
];

/** Roles the credit probe and the fallback machinery apply to. The judge is a
 * classifier called explicitly, so it is never probed nor substituted. */
const PROBE_RELEVANT: readonly Role[] = ["cheap", "strong", "exec"];

export function statusLines(deps: ModelsCommandDeps): string[] {
	const settings = deps.overrides.effective(deps.base);
	const lines = ["judge/auto models", formatRoleSettings(settings)];
	const notProbed = settings.filter((setting) => {
		if (!PROBE_RELEVANT.includes(setting.role)) return false;
		const target = parseTarget(setting.value);
		return target !== undefined && !PROBED_PROVIDERS.includes(target.provider);
	});
	if (notProbed.length > 0) {
		lines.push(
			"",
			`no credit probe for: ${[...new Set(notProbed.map((s) => parseTarget(s.value)!.provider))].join(", ")}`,
			"(no quota reading and no fallback on those providers)",
		);
	}
	lines.push("", ...USAGE.slice(1));
	return lines;
}

/**
 * Parses and applies a `/judge-models` invocation. Kept out of the command
 * handler so every branch is unit-testable without a pi session.
 */
export function runModelsCommand(args: string, deps: ModelsCommandDeps): CommandResult {
	const parts = args.trim().split(/\s+/).filter(Boolean);

	if (parts.length === 0) {
		return { lines: statusLines(deps), changed: false };
	}

	if (parts[0] === "reset") {
		const what = parts[1];
		if (what === undefined) {
			return { lines: ["usage: /judge-models reset <role> | reset all"], changed: false };
		}
		if (what === "all") {
			const cleared = deps.overrides.clearAll();
			return {
				lines: [cleared > 0 ? `cleared ${cleared} override(s)` : "no overrides to clear"],
				changed: cleared > 0,
			};
		}
		if (!isRole(what)) {
			return { lines: [`unknown role "${what}"`, `roles: ${ROLES.join(", ")}`], changed: false };
		}
		const had = deps.overrides.clear(what);
		const back = deps.base.find((setting) => setting.role === what);
		return {
			lines: [
				had
					? `${what} -> ${back?.value ?? "?"} (${back?.source ?? "default"})`
					: `${what} has no override`,
			],
			changed: had,
		};
	}

	const role = parts[0]!;
	if (!isRole(role)) {
		return {
			lines: [`unknown role "${role}"`, `roles: ${ROLES.join(", ")}`, "", ...USAGE],
			changed: false,
		};
	}

	const reference = parts.slice(1).join(" ");
	if (reference === "") {
		return { lines: [`usage: /judge-models ${role} <provider/id>`], changed: false };
	}

	const verdict = deps.accepts(role, reference);
	if (!verdict.ok) {
		return { lines: [`not set: ${verdict.reason ?? "invalid model"}`], changed: false };
	}

	deps.overrides.set(role, reference);
	const lines = [`${role} -> ${reference} (session only)`, ROLE_HELP[role]];
	const target = parseTarget(reference);
	if (target !== undefined && !PROBED_PROVIDERS.includes(target.provider)) {
		lines.push(
			`note: ${target.provider} has no credit probe, so no quota reading and no fallback while ${role} points there`,
		);
	}
	return { lines, changed: true };
}
