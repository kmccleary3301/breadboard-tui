import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registerBreadboardUi, unregisterBreadboardUi } from "../src/breadboard/ui";
import {
	getAvailableSymbolPresets,
	getAvailableThemes,
	isValidSymbolPreset,
	loadThemeJson,
	setSymbolPreset,
	theme,
} from "@oh-my-pi/pi-tui/theme";

describe("BreadBoard UI registration slice", () => {
	beforeEach(async () => {
		unregisterBreadboardUi();
		await setSymbolPreset("unicode");
	});

	afterEach(async () => {
		unregisterBreadboardUi();
		await setSymbolPreset("unicode");
	});

	it("renders stock unicode symbols matching upstream before any registration", async () => {
		// Stock omp: nothing registered
		expect(isValidSymbolPreset("emoji")).toBe(false);
		expect(getAvailableSymbolPresets()).toEqual(["unicode", "nerd", "ascii"]);

		await setSymbolPreset("unicode");

		// Representative values from git show 62bc57be1b:packages/tui/src/theme/symbols.ts
		expect(theme.symbol("status.pending")).toBe("⏳");
		expect(theme.symbol("icon.plan")).toBe("🗺");
		expect(theme.symbol("lang.rust")).toBe("🦀");
		expect(theme.symbol("icon.tokens")).toBe("🪙");
		expect(theme.symbol("tab.appearance")).toBe("🎨");
		expect(theme.symbol("tab.breadboard")).toBe("");
	});

	it("activates monochrome unicode values and emoji preset after registerBreadboardUi", async () => {
		registerBreadboardUi();

		expect(isValidSymbolPreset("emoji")).toBe(true);
		expect(getAvailableSymbolPresets()).toContain("emoji");

		// In BreadBoard, unicode is configured with monochrome overrides
		await setSymbolPreset("unicode");
		expect(theme.symbol("status.pending")).toBe("…");
		expect(theme.symbol("icon.plan")).toBe("☷");
		expect(theme.symbol("lang.rust")).toBe("Rs");
		expect(theme.symbol("icon.tokens")).toBe("◈");
		expect(theme.symbol("tab.appearance")).toBe("✦");
		expect(theme.symbol("tab.breadboard")).toBe("⌘");

		// The emoji preset retains expressive glyphs and adds tab.breadboard
		await setSymbolPreset("emoji");
		expect(theme.symbol("status.pending")).toBe("⏳");
		expect(theme.symbol("icon.plan")).toBe("🗺");
		expect(theme.symbol("lang.rust")).toBe("🦀");
		expect(theme.symbol("icon.tokens")).toBe("🪙");
		expect(theme.symbol("tab.breadboard")).toBe("🍞");
	});

	it("includes breadboard themes in theme list only after registration", async () => {
		// Before registration: breadboard themes do not exist
		const stockThemes = await getAvailableThemes();
		expect(stockThemes).not.toContain("breadboard");
		expect(stockThemes).not.toContain("breadboard-light");
		expect(loadThemeJson("breadboard")).rejects.toThrow();

		registerBreadboardUi();

		// After registration: both themes appear in available list and can be loaded
		const registeredThemes = await getAvailableThemes();
		expect(registeredThemes).toContain("breadboard");
		expect(registeredThemes).toContain("breadboard-light");

		const darkTheme = await loadThemeJson("breadboard");
		expect(darkTheme.name).toBe("breadboard");

		const lightTheme = await loadThemeJson("breadboard-light");
		expect(lightTheme.name).toBe("breadboard-light");

		// After unregistering: clean slate
		unregisterBreadboardUi();
		const restoredThemes = await getAvailableThemes();
		expect(restoredThemes).not.toContain("breadboard");
		expect(restoredThemes).not.toContain("breadboard-light");
	});
});
