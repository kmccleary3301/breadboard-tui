import { describe, expect, it } from "bun:test";
import {
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_GROUPS,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { getSettingsForTab } from "@oh-my-pi/pi-tui/overlays/settings-defs";

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
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.maxRuntimeMs",
	"breadboard.harness.max_concurrent_agents",
] as const satisfies readonly SettingPath[];

const settingsHost = createSettingsHost();

describe("BreadBoard settings definitions", () => {
	it("exposes the eleventh tab and every declared group has at least one row", () => {
		expect(SETTING_TABS).toHaveLength(11);
		expect(SETTING_TABS.at(-1)).toBe("breadboard");
		const groupsWithRows = new Set(
			getSettingsForTab(settingsHost.entries, "breadboard").map(definition => definition.group),
		);
		for (const group of TAB_GROUPS.breadboard) {
			expect(groupsWithRows.has(group), `empty group ${group}`).toBe(true);
		}
	});

	it("resolves each BreadBoard row to an existing schema path", () => {
		const definitions = getSettingsForTab(settingsHost.entries, "breadboard");
		for (const path of BREADBOARD_PATHS) {
			expect(Object.hasOwn(SETTINGS_SCHEMA, path), `schema path ${path}`).toBe(true);
			expect(
				definitions.some(definition => definition.path === path),
				`settings row ${path}`,
			).toBe(true);
		}
	});

	it("keeps the harness concurrency limit read-only", () => {
		const definitions = getSettingsForTab(settingsHost.entries, "breadboard");
		const path = "breadboard.harness.max_concurrent_agents";
		const definition = definitions.find(item => item.path === path);
		expect(definition, `missing read-only row ${path}`).toBeDefined();
		expect(definition?.readonly, `row ${path} must be read-only`).toBe(true);
	});
});
