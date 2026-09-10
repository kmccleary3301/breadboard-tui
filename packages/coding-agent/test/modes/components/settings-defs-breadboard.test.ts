import { describe, expect, it } from "bun:test";
import {
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_GROUPS,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";

const BREADBOARD_PATHS = [
	"breadboard.harness.default",
	"breadboard.harness.paletteHeader",
	"breadboard.harness.unsupportedCommands",
	"breadboard.engineMode",
	"breadboard.baseUrl",
	"breadboard.startupTimeoutMs",
	"breadboard.requestTimeoutMs",
	"breadboard.ownerExitPolicy",
	"breadboard.sessionConfigPath",
	"auth.broker.url",
	"auth.broker.token",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.maxRuntimeMs",
	"breadboard.harness.max_concurrent_agents",
] as const satisfies readonly SettingPath[];

describe("BreadBoard settings definitions", () => {
	it("exposes the eleventh tab with all declared groups", () => {
		expect(SETTING_TABS).toHaveLength(11);
		expect(SETTING_TABS.at(-1)).toBe("breadboard");
		expect(TAB_GROUPS.breadboard).toEqual(["Harness", "Engine", "Providers", "Subagents", "Long-run"]);
	});

	it("resolves each BreadBoard row to an existing schema path", () => {
		const definitions = getSettingsForTab("breadboard");
		for (const path of BREADBOARD_PATHS) {
			expect(Object.hasOwn(SETTINGS_SCHEMA, path), `schema path ${path}`).toBe(true);
			expect(definitions.some(definition => definition.path === path), `settings row ${path}`).toBe(true);
		}
	});

	it("keeps provider metadata and the harness concurrency limit read-only", () => {
		const definitions = getSettingsForTab("breadboard");
		for (const path of ["auth.broker.url", "auth.broker.token", "breadboard.harness.max_concurrent_agents"] as const) {
			const definition = definitions.find(item => item.path === path);
			expect(definition, `missing read-only row ${path}`).toBeDefined();
			expect(definition?.readonly, `row ${path} must be read-only`).toBe(true);
		}
	});
});
