import { describe, expect, it } from "bun:test";
import { getAllStatusLinePresets, registerStatusLinePreset, resetStatusLinePresets } from "../src/status-line/presets";
import { STATUS_LINE_PRESET_VALUES } from "../src/status-line/schema";

describe("status line preset registry", () => {
	it("names exactly upstream presets when nothing is registered", () => {
		const existing = [...getAllStatusLinePresets()];
		resetStatusLinePresets();
		try {
			const presetNames = getAllStatusLinePresets()
				.map(p => p.name)
				.sort();
			const expected = [...STATUS_LINE_PRESET_VALUES].sort();
			expect(presetNames).toEqual(expected);
			expect(expected).toEqual(["ascii", "compact", "custom", "default", "full", "minimal", "nerd"]);
		} finally {
			for (const p of existing) {
				if (!STATUS_LINE_PRESET_VALUES.includes(p.name as any)) {
					registerStatusLinePreset(p);
				}
			}
		}
	});
});
