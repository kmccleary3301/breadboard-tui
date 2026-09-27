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
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: {
				current: () =>
					({
						harnessId: "bb-omp.native",
						name: "BB OMP",
						lockHash: "sha256:bb-lock",
						verifiedIdentity: { harnessId: "bb-omp.native", lockHash: "sha256:bb-lock" },
						generation: null,
						mode: null,
						lock: null,
						provenance: {},
						loadedAt: 1,
					}) as const,
			},
			showStatus,
		},
	};

	expect(await executeHarnessSlashCommand("/harness list", runtime as never)).toBe(true);
	expect(showStatus).toHaveBeenCalledWith(
		[
			"* Active harness: bb-omp.native (bb-omp.native/bb-omp.harness.yaml)",
			"  claude_code (claude_code/research.harness.yaml)",
			"  codex (codex/research.harness.yaml)",
			"  opencode (opencode/research.harness.yaml)",
			"  oh_my_opencode (oh_my_opencode/research.harness.yaml)",
			"  pi (pi/research.harness.yaml)",
			"  oh_my_pi (oh_my_pi/research.harness.yaml)",
		].join("\n"),
	);
});

const BUILTIN_ROWS = [
	"  bb-omp.native (bb-omp.native/bb-omp.harness.yaml)",
	"  claude_code (claude_code/research.harness.yaml)",
	"  codex (codex/research.harness.yaml)",
	"  opencode (opencode/research.harness.yaml)",
	"  oh_my_opencode (oh_my_opencode/research.harness.yaml)",
	"  pi (pi/research.harness.yaml)",
	"  oh_my_pi (oh_my_pi/research.harness.yaml)",
];

function listRuntime(snapshot: HarnessSnapshot | null) {
	const showStatus = vi.fn();
	return {
		showStatus,
		runtime: { ctx: { settings: Settings.isolated(), harnessPort: { current: () => snapshot }, showStatus } },
	};
}

test("/harness list lists a spec-path harness first as the active harness", async () => {
	const { showStatus, runtime } = listRuntime({
		harnessId: "/work/harnesses/team.yaml",
		name: "Team",
		lockHash: "sha256:team",
		verifiedIdentity: { harnessId: "/work/harnesses/team.yaml", lockHash: "sha256:team" },
		generation: "1",
		mode: null,
		lock: null,
		provenance: {},
		loadedAt: 1,
	});
	expect(await executeHarnessSlashCommand("/harness list", runtime as never)).toBe(true);
	expect(showStatus).toHaveBeenCalledWith(
		["* Active harness: Team (/work/harnesses/team.yaml)", ...BUILTIN_ROWS].join("\n"),
	);
});

test("/harness list does not mark an unverified harness active", async () => {
	const { showStatus, runtime } = listRuntime({
		harnessId: "bb-omp.native",
		name: "BB OMP",
		lockHash: null,
		verifiedIdentity: null,
		generation: null,
		mode: null,
		lock: null,
		provenance: {},
		loadedAt: 1,
	});

	expect(await executeHarnessSlashCommand("/harness list", runtime as never)).toBe(true);
	expect(showStatus).toHaveBeenCalledWith(BUILTIN_ROWS.join("\n"));
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

test("/mode does not reach the model and reports unavailable", async () => {
	const showStatus = vi.fn();
	const snapshot: HarnessSnapshot = {
		harnessId: "bb-omp.native",
		name: "BB OMP",
		lockHash: "sha256:bb-omp",
		verifiedIdentity: { harnessId: "bb-omp.native", lockHash: "sha256:bb-omp" },
		generation: null,
		mode: null,
		lock: {
			effective_values: [{ path: "modes", value: ["code"], visibility: "model-visible", value_kind: "array" }],
		},
		provenance: {},
		loadedAt: 1,
	};
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: { current: () => snapshot },
			showStatus,
		},
	};

	const result = await executeHarnessSlashCommand("/mode plan", runtime as never);
	expect(result).toBe(true);
	expect(showStatus).toHaveBeenCalledWith("/mode unavailable: no host implementation");
});
