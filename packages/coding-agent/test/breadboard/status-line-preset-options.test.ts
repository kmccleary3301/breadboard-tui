import { describe, expect, it } from "bun:test";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { getSettingsForTab } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { registerBreadboardSettings } from "../../src/breadboard/settings";

function presetOptionValues(): string[] {
	const row = getSettingsForTab(createSettingsHost().entries, "appearance").find(
		definition => definition.path === "statusLine.preset",
	);
	if (!row || !("options" in row) || !Array.isArray(row.options))
		throw new Error("statusLine.preset row has no options");
	return row.options.map(option => option.value);
}

describe("status line preset choices", () => {
	it("offers BreadBoard presets only while the bb schema is registered", () => {
		// Catches BreadBoard presets leaking into stock omp's settings, or surviving unregister.
		const stock = presetOptionValues();
		expect(stock).not.toContain("bb-balanced");

		const unregister = registerBreadboardSettings();
		try {
			expect(presetOptionValues()).toEqual(["bb-balanced", "bb-quiet", "bb-detailed", ...stock]);
		} finally {
			unregister();
		}

		expect(presetOptionValues()).toEqual(stock);
	});
});
