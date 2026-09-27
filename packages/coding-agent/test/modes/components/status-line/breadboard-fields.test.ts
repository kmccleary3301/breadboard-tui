import { registerBreadboardStatusLine } from "../../../../src/breadboard/ui/status-line";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderComposerShapePreview } from "@oh-my-pi/pi-tui/overlays/composer-shape-preview";
import { BreadboardCustomizeSubmenu } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { DEFAULT_BREADBOARD_FIELD_SETTINGS } from "../../../../src/breadboard/ui/status-line/breadboard-fields";
import { createBreadboardPreviewStatusSource } from "@oh-my-pi/pi-tui/setup/scenes/information-layout";
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
	let fields = config.get("statusLine.breadboard");
	const preview: Component = {
		render: width =>
			renderComposerShapePreview(
				config.get("composer.shape") ?? "box",
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
		value => config.set("statusLine.breadboard", value),
		() => {},
		preview,
	);
	return { menu, preview: () => Bun.stripANSI(preview.render(90).join("\n")) };
}
function down(menu: BreadboardCustomizeSubmenu, count: number) {
	for (let index = 0; index < count; index++) menu.handleInput("\x1b[B");
}

describe("BreadBoard field customization", () => {
	beforeEach(() => {
		registerBreadboardStatusLine();
	});
	it("previews staged choices, discards Cancel, and reopens applied choices", () => {
		const config = Settings.isolated({ "composer.shape": "box" });
		const first = open(config);
		down(first.menu, 6);
		first.menu.handleInput("\x1b[C");
		first.menu.handleInput("\x1b[C");
		expect(first.preview()).toContain("~12K/100K");
		expect(config.get("statusLine.breadboard").context).toBe("preset");
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
		config.set("statusLine.breadboard", {
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
		expect(config.get("composer.shape")).toBe("rail");
		expect(config.get("symbolPreset")).toBe("ascii");
	});
});
