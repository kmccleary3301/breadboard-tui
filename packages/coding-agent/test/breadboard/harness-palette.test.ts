import { describe, expect, test } from "bun:test";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import {
	harnessCommandsAsSlashCommands,
	harnessPaletteHeader,
	materializeHarnessCommands,
	type HarnessPaletteSettings,
} from "../../src/slash-commands/harness";
import { registerBuiltinSlashCommands } from "../../src/slash-commands/builtin-registry";
import { HarnessPaletteController } from "../../src/breadboard/harness-palette";
import { Settings } from "../../src/config/settings";
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
	test("registering a command under a taken builtin name or alias throws and registers nothing", () => {
		const spec = (name: string) => ({ name, description: name, handleTui: async () => {} }) as never;
		expect(() => registerBuiltinSlashCommands([spec("bb-test-free"), spec("model")])).toThrow("model");
		const unregister = registerBuiltinSlashCommands([spec("bb-test-free")]);
		unregister();
	});

	test("maps the real lock to the expected enabled command set and reasons", () => {
		const commands = materializeHarnessCommands(snapshot(lockFixture), settings);
		const enabled = new Set(commands.filter(command => command.enabled).map(command => command.name));
		expect([...enabled].sort()).toEqual(["evidence", "harness", "mode", "prompts", "team"].sort());
		expect(commands.find(command => command.name === "checkpoint")).toMatchObject({
			enabled: false,
			source: "long_running.enabled",
			reason: expect.stringContaining("long_running.enabled"),
		});
		expect(commands.find(command => command.name === "team")).toMatchObject({
			enabled: true,
			source: "multi_agent.enabled",
		});
		expect(commands.find(command => command.name === "prompts")).toMatchObject({
			enabled: true,
			source: "prompts.*",
		});
		expect(commands.find(command => command.name === "evidence")).toMatchObject({
			enabled: true,
			source: "evidence",
		});
	});

	test("derives completions only from visible effective lock leaves", () => {
		const commands = harnessCommandsAsSlashCommands(snapshot(lockFixture), settings);
		const mode = commands.find(command => command.name === "mode");
		const role = commands.find(command => command.name === "role");
		expect(mode?.getArgumentCompletions?.("")).toEqual([
			{ value: "plan", label: "plan" },
			{ value: "build", label: "build" },
			{ value: "compact", label: "compact" },
		]);
		expect(role?.getArgumentCompletions?.("")).toEqual([]);
	});

	test("HarnessPaletteController.apply never replaces or modifies upstream builtin commands", () => {
		const fakePort = { current: () => snapshot(lockFixture) };
		const controller = new HarnessPaletteController(Settings.isolated(), fakePort as never);
		const staticCommands = [
			{ name: "skills", description: "Manage skills" },
			{ name: "model", description: "Select model" },
			{ name: "plan", description: "Toggle plan mode" },
			{ name: "todo", description: "Manage todo list" },
			{ name: "harness", description: "Inspect harness" },
			{ name: "mode", description: "Harness execution mode" },
		];
		const result = controller.apply(staticCommands);
		// Upstream commands are preserved verbatim
		expect(result.find(c => c.name === "skills")?.description).toBe("Manage skills");
		expect(result.find(c => c.name === "model")?.description).toBe("Select model");
		expect(result.find(c => c.name === "plan")?.description).toBe("Toggle plan mode");
		expect(result.find(c => c.name === "todo")?.description).toBe("Manage todo list");
		// Harness commands receive lock-derived metadata and completions
		const modeEntry = result.find(c => c.name === "mode");
		expect(modeEntry?.getArgumentCompletions).toBeDefined();
		// Each command name appears only once
		const names = result.map(c => c.name);
		expect(new Set(names).size).toBe(names.length);
	});

	test("dims unsupported commands with a reason and keeps static panels available", () => {
		const lock = {
			effective_values: [{ path: "modes", value: [{ name: "build" }], visibility: "model-visible" }],
		};
		const dimmed = materializeHarnessCommands(snapshot(lock), settings);
		const mode = dimmed.find(command => command.name === "mode");
		expect(mode).toMatchObject({ enabled: true, source: "modes" });
		for (const name of ["team", "prompts", "evidence"]) {
			expect(dimmed.find(command => command.name === name)).toMatchObject({ enabled: true });
		}
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
