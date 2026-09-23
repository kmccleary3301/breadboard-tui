import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { COMPACTION_METHOD_CHOICES } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

const [firstChoice, secondChoice] = COMPACTION_METHOD_CHOICES;

function optionRow(component: SettingsSelectorComponent, label: string): number {
	const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
	const row = lines.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`Missing settings option: ${label}`);
	return row + 1;
}

function sendMouse(component: SettingsSelectorComponent, button: number, row: number, suffix: "M" | "m"): void {
	component.handleInput(`\x1b[<${button};3;${row}${suffix}`);
}

function clickOption(component: SettingsSelectorComponent, label: string): void {
	const row = optionRow(component, label);
	sendMouse(component, 0, row, "M");
	sendMouse(component, 0, row, "m");
}

describe("multiselect settings (array-of-enum)", () => {
	it("edits compaction.methodOrder via the ordered toggle list", () => {
		const comp = createSelector();
		settings.set("compaction.methodOrder", []);
		for (const ch of "compaction method order") comp.handleInput(ch);
		const row = comp.render(120).join("\n");
		expect(row).toContain("Compaction Method Order");
		expect(row).toContain(firstChoice!.label);

		comp.handleInput("\n");
		comp.handleInput(" ");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value, secondChoice!.value]);

		comp.handleInput("\x1b[D");
		expect(settings.get("compaction.methodOrder")).toEqual([secondChoice!.value, firstChoice!.value]);

		comp.handleInput(" ");
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value]);

		comp.handleInput("\x1b");
		expect(comp.render(120).join("\n")).toContain(firstChoice!.label);
	});

	it("splices the hovered option into the pressed digit's position", () => {
		const [a, b, c] = COMPACTION_METHOD_CHOICES;
		const comp = createSelector();
		settings.set("compaction.methodOrder", []);
		for (const ch of "compaction method order") comp.handleInput(ch);
		comp.handleInput("\n");

		comp.handleInput(" ");
		comp.handleInput("\x1b[B");
		comp.handleInput("\x1b[B");
		comp.handleInput(" ");
		expect(settings.get("compaction.methodOrder")).toEqual([a!.value, c!.value]);

		comp.handleInput("\x1b[A");
		comp.handleInput("2");
		expect(settings.get("compaction.methodOrder")).toEqual([a!.value, b!.value, c!.value]);

		comp.handleInput("9");
		expect(settings.get("compaction.methodOrder")).toEqual([a!.value, c!.value, b!.value]);

		comp.handleInput("1");
		expect(settings.get("compaction.methodOrder")).toEqual([b!.value, a!.value, c!.value]);
	});

	it("toggles list members on mouse click", () => {
		const comp = createSelector();
		settings.set("compaction.methodOrder", []);
		for (const ch of "compaction method order") comp.handleInput(ch);
		comp.handleInput("\n");

		clickOption(comp, firstChoice!.label);
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value]);

		clickOption(comp, firstChoice!.label);
		expect(settings.get("compaction.methodOrder")).toEqual([]);
	});

	it("reorders selected list members by drag and drop", () => {
		const comp = createSelector();
		settings.set("compaction.methodOrder", []);
		for (const ch of "compaction method order") comp.handleInput(ch);
		comp.handleInput("\n");
		clickOption(comp, firstChoice!.label);
		clickOption(comp, secondChoice!.label);
		expect(settings.get("compaction.methodOrder")).toEqual([firstChoice!.value, secondChoice!.value]);

		const sourceRow = optionRow(comp, secondChoice!.label);
		const targetRow = optionRow(comp, firstChoice!.label);
		sendMouse(comp, 0, sourceRow, "M");
		sendMouse(comp, 32, targetRow, "M");
		sendMouse(comp, 0, targetRow, "m");

		expect(settings.get("compaction.methodOrder")).toEqual([secondChoice!.value, firstChoice!.value]);
	});

});

describe("settings section sidebar", () => {
	it("does not toggle the selected section's first setting", () => {
		const comp = createSelector();
		for (let i = 0; i < 7; i++) comp.handleInput("\x1b[C");
		expect(settings.get("dev.autoqa")).toBe(true);

		clickOption(comp, "Developer");
		expect(settings.get("dev.autoqa")).toBe(true);

		clickOption(comp, "Developer");
		expect(settings.get("dev.autoqa")).toBe(true);
	});
});
