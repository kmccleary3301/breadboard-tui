import { describe, expect, test } from "bun:test";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import {
	harnessCommandsAsSlashCommands,
	harnessPaletteHeader,
	materializeHarnessCommands,
	type HarnessPaletteSettings,
} from "../../src/slash-commands/harness";

const lockFixture = JSON.parse(
	await Bun.file(new URL("./fixtures/codex_e4.lock.json", import.meta.url)).text(),
) as Readonly<Record<string, unknown>>;

const settings: HarnessPaletteSettings = {
	defaultHarness: "daily_driver",
	paletteHeader: true,
	unsupportedCommands: "dim",
};

function snapshot(lock: Readonly<Record<string, unknown>>): HarnessSnapshot {
	return {
		harnessId: "codex_e4.yaml",
		name: "Codex E4",
		lockHash: "sha256:lock",
		generation: "g1",
		mode: "build",
		lock,
		provenance: {},
		loadedAt: 1,
	};
}

describe("lock-derived harness palette", () => {
	test("maps the real lock to the expected enabled command set and reasons", () => {
		const commands = materializeHarnessCommands(snapshot(lockFixture), settings);
		const enabled = new Set(commands.filter(command => command.enabled).map(command => command.name));
		expect([...enabled].sort()).toEqual(["harness", "mode", "model"].sort());
		expect(commands.find(command => command.name === "checkpoint")).toMatchObject({
			enabled: false,
			source: "long_running.enabled",
			reason: expect.stringContaining("long_running.enabled"),
		});
		expect(commands.find(command => command.name === "plan")).toMatchObject({
			enabled: false,
			source: "features.plan",
			reason: expect.stringContaining("features.plan"),
		});
		expect(commands.find(command => command.name === "todo")).toMatchObject({
			enabled: false,
			source: "features.todos.enabled",
			reason: expect.stringContaining("features.todos.enabled"),
		});
		expect(commands.find(command => command.name === "prompts")).toMatchObject({
			enabled: false,
			source: "prompts.*",
			reason: "no host implementation",
		});
	});

	test("derives completions only from visible effective lock leaves", () => {
		const commands = harnessCommandsAsSlashCommands(snapshot(lockFixture), settings);
		const mode = commands.find(command => command.name === "mode");
		const model = commands.find(command => command.name === "model");
		const skills = commands.find(command => command.name === "skills");
		expect(mode?.getArgumentCompletions?.("")).toEqual([
			{ value: "plan", label: "plan" },
			{ value: "build", label: "build" },
			{ value: "compact", label: "compact" },
		]);
		expect(model?.getArgumentCompletions?.("")).toEqual([
			{ value: "openai/gpt-5.1-codex-mini", label: "openai/gpt-5.1-codex-mini" },
		]);
		expect(skills?.getArgumentCompletions?.("")).toEqual([]);
		expect(skills?.getAutocompleteDescription?.()).toContain("no skills leaf");
	});

	test("dims unsupported commands with a reason and hides them when configured", () => {
		const lock = {
			effective_values: [{ path: "modes", value: [{ name: "build" }], visibility: "model-visible" }],
		};
		const dimmed = materializeHarnessCommands(snapshot(lock), settings);
		const mode = dimmed.find(command => command.name === "mode");
		expect(mode).toMatchObject({ enabled: true, source: "modes" });
		expect(dimmed.find(command => command.name === "longrun")).toMatchObject({
			enabled: false,
			reason: expect.stringContaining("long_running.enabled"),
		});

		const hidden = materializeHarnessCommands(snapshot(lock), { ...settings, unsupportedCommands: "hide" });
		expect(hidden.some(command => command.name === "longrun")).toBe(false);
	});

	test("honors the optional header and re-derives entries for a changed snapshot", () => {
		const first = harnessCommandsAsSlashCommands(
			snapshot({ effective_values: [{ path: "modes", value: [{ name: "build" }], visibility: "model-visible" }] }),
			settings,
		);
		const second = materializeHarnessCommands(
			snapshot({
				effective_values: [{ path: "long_running.enabled", value: true, visibility: "model-visible" }],
			}),
			settings,
		);
		expect(first.map(command => command.name)).toContain("mode");
		expect(second.find(command => command.name === "mode")).toMatchObject({ enabled: false });
		expect(second.find(command => command.name === "longrun")).toMatchObject({
			enabled: false,
			reason: "no host implementation",
		});
		expect(harnessPaletteHeader(snapshot({}), settings)).toContain("Harness: Codex E4");
		expect(harnessPaletteHeader(snapshot({}), { ...settings, paletteHeader: false })).toBeUndefined();
	});
});
