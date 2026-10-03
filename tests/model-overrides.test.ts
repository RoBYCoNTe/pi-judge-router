/**
 * Unit tests for the session model overrides and the `/judge-models` command.
 *
 * Run with: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	RoleOverrides,
	ROLES,
	formatRoleSettings,
	isRole,
	modelSearchText,
	runModelsCommand,
	type ModelsCommandDeps,
	type Role,
	type RoleSetting,
} from "../src/model-overrides.ts";

const base: RoleSetting[] = [
	{ role: "judge", value: "typesafe/jev-latest", source: "default" },
	{ role: "cheap", value: "zai/glm-5.3-flash", source: "default" },
	{ role: "strong", value: "zai/glm-5.3", source: "env" },
	{ role: "exec", value: "deepseek/deepseek-flash", source: "default" },
];

const deps = (
	overrides = new RoleOverrides(),
	accepts: ModelsCommandDeps["accepts"] = () => ({ ok: true }),
): ModelsCommandDeps => ({ base, overrides, accepts });

describe("isRole", () => {
	test("accepts the four roles only", () => {
		for (const role of ROLES) expect(isRole(role)).toBe(true);
		expect(isRole("plan")).toBe(false);
		expect(isRole("")).toBe(false);
		expect(isRole(undefined)).toBe(false);
	});
});

describe("RoleOverrides", () => {
	test("an override wins over the base and reports its source", () => {
		const overrides = new RoleOverrides();
		overrides.set("strong", "fireworks/accounts/fireworks/models/glm-5p3");
		const effective = overrides.effective(base);

		expect(effective.find((s) => s.role === "strong")).toEqual({
			role: "strong",
			value: "fireworks/accounts/fireworks/models/glm-5p3",
			source: "override",
		});
		// untouched roles keep their base source, so the status can tell env from default
		expect(effective.find((s) => s.role === "cheap")?.source).toBe("default");
		expect(effective.find((s) => s.role === "judge")?.source).toBe("default");
	});

	test("clear removes one override, clearAll removes everything", () => {
		const overrides = new RoleOverrides();
		overrides.set("cheap", "a/b");
		overrides.set("exec", "c/d");
		expect(overrides.size()).toBe(2);

		expect(overrides.clear("cheap")).toBe(true);
		expect(overrides.clear("cheap")).toBe(false);
		expect(overrides.size()).toBe(1);

		expect(overrides.clearAll()).toBe(1);
		expect(overrides.size()).toBe(0);
		expect(overrides.effective(base)).toEqual(base);
	});
});

describe("formatRoleSettings", () => {
	test("lists every role with its value and source", () => {
		const text = formatRoleSettings(base);
		for (const role of ROLES) expect(text).toContain(role);
		expect(text).toContain("typesafe/jev-latest");
		expect(text).toContain("(env)");
		expect(text.split("\n")).toHaveLength(4);
	});
});

describe("modelSearchText", () => {
	test("matches pi's own /model search text, id first, provider repeated", () => {
		expect(modelSearchText({ id: "glm-5.3-flash", provider: "zai" })).toBe(
			"glm-5.3-flash zai zai/glm-5.3-flash zai glm-5.3-flash",
		);
	});

	test("appends the display name when there is one", () => {
		expect(modelSearchText({ id: "glm-5.3", provider: "zai", name: "GLM 5.3" })).toBe(
			"glm-5.3 zai zai/glm-5.3 zai glm-5.3 GLM 5.3",
		);
	});
});

describe("runModelsCommand", () => {
	test("no arguments prints the status", () => {
		const result = runModelsCommand("", deps());
		expect(result.changed).toBe(false);
		expect(result.lines[0]).toBe("judge/auto models");
		expect(result.lines.join("\n")).toContain("zai/glm-5.3-flash");
	});

	test("setting a role stores a session override", () => {
		const overrides = new RoleOverrides();
		const result = runModelsCommand(
			"strong fireworks/accounts/fireworks/models/glm-5p3",
			deps(overrides),
		);

		expect(result.changed).toBe(true);
		expect(overrides.get("strong")).toBe("fireworks/accounts/fireworks/models/glm-5p3");
		expect(result.lines[0]).toContain("session only");
	});

	test("warns when the chosen provider has no credit probe", () => {
		const result = runModelsCommand("strong fireworks/x/glm-5p3", deps());
		const text = result.lines.join("\n");
		expect(text).toContain("no credit probe");
		expect(text).toContain("no fallback");
	});

	test("does not warn for a probed provider", () => {
		const result = runModelsCommand("strong zai/glm-5.3", deps());
		expect(result.lines.join("\n")).not.toContain("no credit probe");
	});

	test("rejects a model the role cannot use", () => {
		const result = runModelsCommand(
			"judge zai/glm-5.3",
			deps(new RoleOverrides(), () => ({ ok: false, reason: "not a classifier" })),
		);
		expect(result.changed).toBe(false);
		expect(result.lines[0]).toBe("not set: not a classifier");
	});

	test("rejects an unknown role and lists the valid ones", () => {
		const result = runModelsCommand("planner zai/glm-5.3", deps());
		expect(result.changed).toBe(false);
		expect(result.lines[0]).toContain("unknown role");
		expect(result.lines[1]).toContain("judge, cheap, strong, exec");
	});

	test("asks for a reference when only the role is given", () => {
		const result = runModelsCommand("strong", deps());
		expect(result.changed).toBe(false);
		expect(result.lines[0]).toContain("usage: /judge-models strong");
	});

	test("reset drops one override and reports the value it falls back to", () => {
		const overrides = new RoleOverrides();
		overrides.set("strong", "fireworks/x");
		const result = runModelsCommand("reset strong", deps(overrides));

		expect(result.changed).toBe(true);
		expect(overrides.get("strong")).toBeUndefined();
		expect(result.lines[0]).toContain("zai/glm-5.3");
		expect(result.lines[0]).toContain("(env)");
	});

	test("reset on a role without override changes nothing", () => {
		const result = runModelsCommand("reset cheap", deps());
		expect(result.changed).toBe(false);
		expect(result.lines[0]).toContain("no override");
	});

	test("reset all clears every override", () => {
		const overrides = new RoleOverrides();
		overrides.set("cheap", "a/b");
		overrides.set("exec", "c/d");
		const result = runModelsCommand("reset all", deps(overrides));

		expect(result.changed).toBe(true);
		expect(overrides.size()).toBe(0);
		expect(result.lines[0]).toContain("cleared 2");
	});

	test("reset without a target explains the usage", () => {
		expect(runModelsCommand("reset", deps()).lines[0]).toContain("usage: /judge-models reset");
	});

	test("status flags roles whose provider is not probed", () => {
		const overrides = new RoleOverrides();
		overrides.set("exec", "fireworks/x/deepseek");
		const text = runModelsCommand("", deps(overrides)).lines.join("\n");
		expect(text).toContain("no credit probe for: fireworks");
	});

	test("status stays quiet when every chat role is on a probed provider", () => {
		const text = runModelsCommand("", deps()).lines.join("\n");
		expect(text).not.toContain("no credit probe");
	});

	test("the same role can be the target of several set calls", () => {
		const overrides = new RoleOverrides();
		for (const value of ["a/b", "c/d", "e/f"] as const) {
			runModelsCommand(`cheap ${value}`, deps(overrides));
		}
		expect((overrides.get("cheap" as Role))).toBe("e/f");
	});
});
