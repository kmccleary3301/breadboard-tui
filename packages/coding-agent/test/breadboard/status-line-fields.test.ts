import {
	cfgBreadboardFields,
	cfgStatusLineBreadboard,
	registerBreadboardSettings,
} from "../../src/breadboard/settings";
import { registerBreadboardStatusLine } from "../../src/breadboard/ui/status-line";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgComposerShape, cfgSymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { renderComposerShapePreview } from "@oh-my-pi/pi-tui/overlays/composer-shape-preview";
import { BreadboardCustomizeSubmenu } from "../../src/breadboard/ui/customize-submenu";
import { DEFAULT_BREADBOARD_FIELD_SETTINGS } from "../../src/breadboard/ui/status-line/breadboard-fields";
import { createBreadboardPreviewStatusSource } from "../../src/breadboard/ui/information-layout";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});
const snapshot = {
	modelName: "Luna",
	workspace: "project",
	workspacePath: "/Users/developer/project",
	context: { tokens: 12_000, capacity: 100_000 },
};
function open(config: Settings) {
	let fields = cfgBreadboardFields.get(config);
	const preview: Component = {
		render: width =>
			renderComposerShapePreview(
				cfgComposerShape.get(config) ?? "box",
				width,
				createBreadboardPreviewStatusSource(snapshot, "bb-balanced", fields),
			),
		invalidate: () => {},
	};
	const menu = new BreadboardCustomizeSubmenu(
		fields,
		"bb-balanced",
		value => {
			fields = value;
		},
		value => cfgStatusLineBreadboard.set(config, { ...value }),
		() => {},
		preview,
	);
	return { menu, preview: () => Bun.stripANSI(preview.render(90).join("\n")) };
}
function down(menu: BreadboardCustomizeSubmenu, count: number) {
	for (let index = 0; index < count; index++) menu.handleInput("\x1b[B");
}

describe("BreadBoard field customization", () => {
	let unregisterStatusLine: () => void;
	let unregisterSettings: () => void;
	beforeEach(() => {
		unregisterSettings = registerBreadboardSettings();
		unregisterStatusLine = registerBreadboardStatusLine();
	});
	afterEach(() => {
		unregisterStatusLine();
		unregisterSettings();
	});
	it("previews staged choices, discards Cancel, and reopens applied choices", () => {
		const config = Settings.isolated({ "composer.shape": "box" });
		const first = open(config);
		down(first.menu, 6);
		first.menu.handleInput("\x1b[C");
		first.menu.handleInput("\x1b[C");
		expect(first.preview()).toContain("~12K/100K");
		expect(cfgBreadboardFields.get(config).context).toBe("preset");
		first.menu.handleInput("\x1b");
		expect(first.preview()).toContain("~12%");
		const second = open(config);
		down(second.menu, 6);
		second.menu.handleInput("\x1b[C");
		second.menu.handleInput("\x1b[C");
		down(second.menu, 5);
		second.menu.handleInput("\r");
		expect(open(config).preview()).toContain("~12K/100K");
	});

	it("cancels an individual field preview without losing other staged choices", () => {
		const config = Settings.isolated({ "composer.shape": "box" });
		const editor = open(config);
		editor.menu.handleInput("\x1b[C");
		editor.menu.handleInput("\x1b[C");
		down(editor.menu, 6);
		editor.menu.handleInput("\r");
		editor.menu.handleInput("\x1b[B");
		editor.menu.handleInput("\x1b[B");
		expect(editor.preview()).toContain("~12K/100K");
		editor.menu.handleInput("\x1b");
		expect(editor.preview()).toContain("~12%");
		expect(editor.preview()).toContain(snapshot.workspacePath);
	});

	it("resets layout overrides only after Apply and leaves shape and glyph preferences intact", () => {
		const config = Settings.isolated({ "composer.shape": "rail", symbolPreset: "ascii" });
		cfgStatusLineBreadboard.set(config, {
			...DEFAULT_BREADBOARD_FIELD_SETTINGS,
			folder: "full",
			context: "tokens",
		});
		const editor = open(config);
		down(editor.menu, 10);
		editor.menu.handleInput("\r");
		expect(editor.preview()).toContain("~12%");
		expect(editor.preview()).not.toContain("/Users/");
		expect(open(config).preview()).toContain("~12K/100K");
		editor.menu.handleInput("\x1b[B");
		editor.menu.handleInput("\r");
		expect(open(config).preview()).toContain("~12%");
		expect(cfgComposerShape.get(config)).toBe("rail");
		expect(cfgSymbolPreset.get(config)).toBe("ascii");
	});

	it("loads settings that leave the field choices unset and rejects malformed ones", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-fields-"));
		try {
			const loaded = await Settings.loadReadOnly({ cwd: root, agentDir: path.join(root, "agent") });
			expect(cfgBreadboardFields.get(loaded)).toEqual(DEFAULT_BREADBOARD_FIELD_SETTINGS);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
		expect(() => Settings.isolated({ "statusLine.breadboard": "full" })).toThrow(
			"statusLine.breadboard must be an object of field choices.",
		);
	});
});
