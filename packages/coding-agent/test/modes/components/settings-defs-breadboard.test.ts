import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { getSettingsForTab, SETTING_TABS, TAB_GROUPS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { registerBreadboardUi, unregisterBreadboardUi } from "../../../src/breadboard/ui";
import { registerBreadboardSettings } from "../../../src/breadboard/settings";

const BREADBOARD_PATHS = [
	"breadboard.harness.default",
	"breadboard.harness.paletteHeader",
	"breadboard.harness.unsupportedCommands",
	"breadboard.sessionConfigPath",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
	"task.maxRuntimeMs",
	"breadboard.harness.max_concurrent_agents",
] as const;

let settingsHost = createSettingsHost();
let unregisterSettings: (() => void) | undefined;

beforeAll(() => {
	unregisterSettings = registerBreadboardSettings();
	registerBreadboardUi();
	settingsHost = createSettingsHost();
});

afterAll(() => {
	unregisterBreadboardUi();
	unregisterSettings?.();
});
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

	it("resolves each BreadBoard row to a registered setting", () => {
		const definitions = getSettingsForTab(settingsHost.entries, "breadboard");
		for (const path of BREADBOARD_PATHS) {
			expect(lookup(path), `registered setting ${path}`).toBeDefined();
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

	it("omp (non-BreadBoard) has no breadboard tab or rows and bb does", () => {
		expect(SETTING_TABS).toContain("breadboard");
		expect(Object.hasOwn(TAB_GROUPS, "breadboard")).toBe(true);

		// Unregistered (plain omp state): no tab, and the shared subagent limits return to their stock tab.
		unregisterBreadboardUi();
		unregisterSettings?.();
		try {
			expect(SETTING_TABS).not.toContain("breadboard");
			expect(Object.hasOwn(TAB_GROUPS, "breadboard")).toBe(false);
			const stockHost = createSettingsHost();
			expect(stockHost.entries.some(entry => entry.ui?.tab === "breadboard")).toBe(false);
			expect(stockHost.entries.find(entry => entry.path === "task.maxConcurrency")?.ui?.tab).toBe("tasks");
		} finally {
			unregisterSettings = registerBreadboardSettings();
			registerBreadboardUi();
			settingsHost = createSettingsHost();
		}
	});
});
