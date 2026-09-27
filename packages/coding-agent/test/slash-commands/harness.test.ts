import { beforeAll, expect, test, vi } from "bun:test";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import { Settings } from "../../src/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { executeHarnessSlashCommand } from "../../src/slash-commands/harness";

beforeAll(async () => {
	await initTheme(false);
});

test("/harness list prints names and paths and marks the verified active harness", async () => {
	const showStatus = vi.fn();
	const listHarnessChoices = vi.fn(async () => [
		{ id: "daily_driver.v1.yaml", name: "daily_driver.v1", path: "daily_driver.v1.yaml" },
		{ id: "codex.yaml", name: "codex", path: "codex.yaml" },
	]);
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: {
				current: () =>
					({
						harnessId: "daily_driver.v1.yaml",
						name: "Daily Driver",
						lockHash: "sha256:daily-lock",
						verifiedIdentity: { harnessId: "daily_driver.v1.yaml", lockHash: "sha256:daily-lock" },
						generation: null,
						mode: null,
						lock: null,
						provenance: {},
						loadedAt: 1,
					}) as const,
				listHarnessChoices,
			},
			showStatus,
		},
	};

	expect(await executeHarnessSlashCommand("/harness list", runtime as never)).toBe(true);
	expect(listHarnessChoices).toHaveBeenCalledWith();
	expect(showStatus).toHaveBeenCalledWith(
		"* Active harness: daily_driver.v1 (daily_driver.v1.yaml)\n  codex (codex.yaml)",
	);
});

test("/harness list does not fabricate an active harness without verified identity", async () => {
	const showStatus = vi.fn();
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: {
				current: () =>
					({
						harnessId: "daily_driver.v1.yaml",
						name: "Daily Driver",
						lockHash: null,
						verifiedIdentity: null,
						generation: null,
						mode: null,
						lock: null,
						provenance: {},
						loadedAt: 1,
					}) as const,
				listHarnessChoices: async () => [
					{ id: "daily_driver.v1.yaml", name: "daily_driver.v1", path: "daily_driver.v1.yaml" },
				],
			},
			showStatus,
		},
	};

	expect(await executeHarnessSlashCommand("/harness list", runtime as never)).toBe(true);
	expect(showStatus).toHaveBeenCalledWith("  daily_driver.v1 (daily_driver.v1.yaml)");
});

test("opens static harness commands on their named panels without lock gates", async () => {
	const openedPanels: Array<{ section?: string; panel?: string }> = [];
	const showAgentHub = vi.fn((options: { initialSection?: string; initialHarnessPanel?: string }) => {
		openedPanels.push({ section: options.initialSection, panel: options.initialHarnessPanel });
	});
	const showStatus = vi.fn();
	const snapshot: HarnessSnapshot = {
		harnessId: "daily_driver.yaml",
		name: "Daily Driver",
		lockHash: "sha256:daily-lock",
		generation: "generation-1",
		mode: "build",
		lock: { effective_values: [] },
		provenance: {},
		loadedAt: 1,
	};
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: { current: () => snapshot },
			showAgentHub,
			showStatus,
		},
	};

	for (const panel of ["team", "prompts", "evidence"] as const) {
		expect(await executeHarnessSlashCommand(`/${panel}`, runtime as never)).toBe(true);
	}

	expect(openedPanels).toEqual([
		{ section: "harness", panel: "team" },
		{ section: "harness", panel: "prompts" },
		{ section: "harness", panel: "evidence" },
	]);
	expect(showStatus).not.toHaveBeenCalled();
});

test("/harness list forwards an explicit directory", async () => {
	const listHarnessChoices = vi.fn(async (directory?: string) => [
		{ id: `${directory}/daily_driver.yaml`, name: "daily_driver", path: `${directory}/daily_driver.yaml` },
	]);
	const showStatus = vi.fn();
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: {
				current: () => null,
				listHarnessChoices,
			},
			showStatus,
		},
	};

	expect(await executeHarnessSlashCommand("/harness list configs/harnesses", runtime as never)).toBe(true);
	expect(listHarnessChoices).toHaveBeenCalledWith("configs/harnesses");
	expect(showStatus).toHaveBeenCalledWith("  daily_driver (configs/harnesses/daily_driver.yaml)");
});
