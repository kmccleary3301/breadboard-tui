import { describe, expect, test } from "bun:test";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import {
	harnessCommandsAsSlashCommands,
	harnessPaletteHeader,
	materializeHarnessCommands,
	type HarnessPaletteSettings,
} from "../../src/slash-commands/harness";

const settings: HarnessPaletteSettings = {
	defaultHarness: "daily_driver",
	paletteHeader: true,
	unsupportedCommands: "dim",
};

function snapshot(lock: Readonly<Record<string, unknown>>): HarnessSnapshot {
	return {
		harnessId: "daily_driver.yaml",
		name: "Daily Driver",
		lockHash: "sha256:lock",
		generation: "g1",
		mode: "build",
		lock,
		provenance: {},
		loadedAt: 1,
	};
}

describe("lock-derived harness palette", () => {
	test("dims unsupported commands with a reason and hides them when configured", () => {
		const lock = { modes: [{ name: "build" }] };
		const dimmed = materializeHarnessCommands(snapshot(lock), settings);
		const mode = dimmed.find(command => command.name === "mode");
		expect(mode).toMatchObject({ enabled: true, source: "modes" });
		expect(dimmed.find(command => command.name === "longrun")).toMatchObject({
			enabled: false,
			reason: expect.stringContaining("long_running"),
		});

		const hidden = materializeHarnessCommands(snapshot(lock), { ...settings, unsupportedCommands: "hide" });
		expect(hidden.some(command => command.name === "longrun")).toBe(false);
	});

	test("honors the optional header and re-derives entries for a changed snapshot", () => {
		const first = harnessCommandsAsSlashCommands(snapshot({ modes: [{ name: "build" }] }), settings);
		const second = materializeHarnessCommands(
			snapshot({ long_running: { enabled: true }, host_commands: ["ps"] }),
			settings,
		);
		expect(first.map(command => command.name)).toContain("mode");
		expect(second.find(command => command.name === "mode")).toMatchObject({ enabled: false });
		expect(second.find(command => command.name === "longrun")).toMatchObject({ enabled: true });
		expect(second.map(command => command.name)).toContain("ps");
		expect(harnessPaletteHeader(snapshot({}), settings)).toContain("Harness: Daily Driver");
		expect(harnessPaletteHeader(snapshot({}), { ...settings, paletteHeader: false })).toBeUndefined();
	});
});
