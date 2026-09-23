import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import type { PublicResult } from "@breadboard/sdk";
import type { BreadboardClient, SessionSummary } from "@breadboard/sdk/engine";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings, resetSettingsForTest } from "../../src/config/settings";
import { rejectBreadboardSessionTransition } from "../../src/breadboard/runtime";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { SessionManager } from "../../src/session/session-manager";
import type { AgentSession } from "../../src/session/agent-session";
import { executeHarnessSlashCommand } from "../../src/slash-commands/harness";

const result = (data: Readonly<Record<string, unknown>>): PublicResult => ({
	schema_version: "bb.cli.result.v1",
	ok: true,
	status: "ok",
	command: [],
	record_refs: [],
	hashes: {},
	stage_outcomes: [],
	warnings: [],
	next_actions: [],
	error: null,
	exit_code: 0,
	data,
});

const failure = (message: string): PublicResult => ({
	schema_version: "bb.cli.result.v1",
	ok: false,
	status: "error",
	command: [],
	record_refs: [],
	hashes: {},
	stage_outcomes: [],
	warnings: [],
	next_actions: [],
	error: { error_code: "invalid_harness", message },
	exit_code: 2,
	data: {},
});
function clientFor(calls: string[], validation = result({}), lock = result({ graph_hash: "sha256:daily-lock" })) {
	return {
		getHarness: async (id: string) => {
			calls.push(`get:${id}`);
			return result({
				path: "agent_configs/daily_driver.v1.yaml",
				definition: { profile: { name: "daily_driver" } },
			});
		},
		validateHarness: async (id: string) => {
			calls.push(`validate:${id}`);
			return validation;
		},
		lockHarness: async (id: string) => {
			calls.push(`lock:${id}`);
			return lock;
		},
		explainHarness: async (id: string) => {
			calls.push(`explain:${id}`);
			return result({ fields: [] });
		},
		getHarnessLock: async (id: string) => {
			calls.push(`getLock:${id}`);
			return result({ lock: { graph_hash: "sha256:daily-lock", source_layers: [] } });
		},
		getSession: async (id: string) => {
			calls.push(`session:${id}`);
			return {
				session_id: id,
				status: "running",
				generation_id: "generation-1",
				trajectory_segment_id: "segment-1",
				lineage: null,
				effective_lock_hash: "sha256:daily-lock",
				mode: "coding",
			} satisfies SessionSummary;
		},
	} as BreadboardClient;
}

function runtimeFor(startHarnessSession: (harnessId: string) => Promise<boolean>) {
	const showStatus = vi.fn();
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: undefined,
			startHarnessSession,
			showStatus,
		} as unknown as InteractiveModeContext,
	};
	return { runtime, showStatus };
}

async function modeFor(
	client: BreadboardClient,
	newSessionResult = true,
	switchHarnessSession: (
		configPath: string,
		lockId: string,
		transition: () => Promise<boolean>,
	) => Promise<boolean> = (_configPath, _lockId, transition) => transition(),
) {
	const tempDir = TempDir.createSync("@pi-harness-use-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const newSession = vi.fn(async () => newSessionResult);
	const session = {
		sessionManager,
		settings: Settings.isolated(),
		agent: { state: { tools: [] }, metadataForProvider: () => undefined },
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		newSession,
		get isStreaming() {
			return false;
		},
	} as unknown as AgentSession;
	const mode = new InteractiveMode(
		session,
		"test",
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		client,
		"daily_driver",
		undefined,
		switchHarnessSession,
		() => "engine-session-1",
	);
	return { mode, newSession, sessionManager, tempDir };
}

function transcript(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("/harness use", () => {
	test("validates, locks, and starts a new harness-bound OMP session", async () => {
		const calls: string[] = [];
		const switchHarnessSession = vi.fn(
			async (_configPath: string, _lockId: string, transition: () => Promise<boolean>) => transition(),
		);
		const { mode, newSession, tempDir } = await modeFor(clientFor(calls), true, switchHarnessSession);

		try {
			expect(await executeHarnessSlashCommand("/harness use daily_driver", { ctx: mode })).toBe(true);
			expect(calls.slice(0, 3)).toEqual([
				"get:agent_configs/v2/daily_driver.yaml",
				"validate:agent_configs/daily_driver.v1.yaml",
				"lock:agent_configs/daily_driver.v1.yaml",
			]);
			expect(calls).toHaveLength(7);
			expect(calls).toContain("get:agent_configs/daily_driver.v1.yaml");
			expect(calls).toContain("explain:agent_configs/daily_driver.v1.yaml");
			expect(calls).toContain("getLock:agent_configs/daily_driver.v1.lock.json");
			expect(switchHarnessSession).toHaveBeenCalledWith(
				"agent_configs/daily_driver.v1.yaml",
				"agent_configs/daily_driver.v1.lock.json",
				expect.any(Function),
			);
			expect(newSession).toHaveBeenCalledWith({
				parentSession: expect.any(String),
				configPath: "agent_configs/daily_driver.v1.lock.json",
				transition: "harnessSwitch",
			});
			expect(transcript(mode)).toContain("Harness daily_driver is now active with lock hash sha256:daily-lock.");
		} finally {
			mode.stop();
			tempDir.removeSync();
		}
	});

	test("keeps the old OMP binding when the session transition is cancelled", async () => {
		const calls: string[] = [];
		const switchHarnessSession = vi.fn(
			async (_configPath: string, _lockId: string, transition: () => Promise<boolean>) => transition(),
		);
		const { mode, newSession, sessionManager, tempDir } = await modeFor(
			clientFor(calls),
			false,
			switchHarnessSession,
		);
		const oldSessionId = sessionManager.getSessionId();

		try {
			expect(await mode.startHarnessSession("daily_driver")).toBe(false);
			expect(sessionManager.getSessionId()).toBe(oldSessionId);
			expect(newSession).toHaveBeenCalledWith({
				parentSession: expect.any(String),
				configPath: "agent_configs/daily_driver.v1.lock.json",
				transition: "harnessSwitch",
			});
			expect(transcript(mode)).not.toContain("is now active");
		} finally {
			mode.stop();
			tempDir.removeSync();
		}
	});

	test("shows the engine validation error and does not attempt a lock", async () => {
		const calls: string[] = [];
		const { mode, newSession, tempDir } = await modeFor(
			clientFor(calls, failure("Harness definition has no supported modes")),
		);

		try {
			expect(await mode.startHarnessSession("daily_driver")).toBe(false);
			expect(calls).toEqual([
				"get:agent_configs/v2/daily_driver.yaml",
				"validate:agent_configs/daily_driver.v1.yaml",
			]);
			expect(newSession).not.toHaveBeenCalled();
			expect(transcript(mode)).toContain("Harness definition has no supported modes");
		} finally {
			mode.stop();
			tempDir.removeSync();
		}
	});

	test("shows the engine lock error without changing the current session", async () => {
		const calls: string[] = [];
		const { mode, newSession, tempDir } = await modeFor(
			clientFor(calls, result({}), failure("Unable to write harness lock")),
		);

		try {
			expect(await mode.startHarnessSession("daily_driver")).toBe(false);
			expect(calls).toEqual([
				"get:agent_configs/v2/daily_driver.yaml",
				"validate:agent_configs/daily_driver.v1.yaml",
				"lock:agent_configs/daily_driver.v1.yaml",
			]);
			expect(newSession).not.toHaveBeenCalled();
			expect(transcript(mode)).toContain("Unable to write harness lock");
		} finally {
			mode.stop();
			tempDir.removeSync();
		}
	});
});
test("admits only harness switches through the BreadBoard transition guard", () => {
	expect(() => rejectBreadboardSessionTransition({ reason: "harnessSwitch" })).not.toThrow();
	for (const plan of [
		{ reason: "new" },
		{ reason: "fork" },
		{ reason: "resume", targetSessionFile: "resume.jsonl" },
		{ reason: "handoff" },
	] as const) {
		expect(() => rejectBreadboardSessionTransition(plan)).toThrow();
	}
});

test("/harness use --here explains why an in-process switch is rejected", async () => {
	const startHarnessSession = vi.fn(async () => true);
	const harness = runtimeFor(startHarnessSession);

	expect(await executeHarnessSlashCommand("/harness use --here", harness.runtime)).toBe(true);
	expect(startHarnessSession).not.toHaveBeenCalled();
	expect(harness.showStatus).toHaveBeenCalledWith(
		"A BreadBoard session is pinned to its engine session and lock; an in-process harness switch is not possible.",
	);
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
function controlRuntime(
	client: Pick<
		BreadboardClient,
		"getHarness" | "validateHarness" | "explainHarness" | "lockHarness" | "getHarnessLock"
	>,
) {
	const showStatus = vi.fn();
	const snapshot: HarnessSnapshot = {
		harnessId: "daily_driver.yaml",
		name: "Daily Driver",
		lockHash: "sha256:daily-lock",
		verifiedIdentity: { harnessId: "daily_driver.yaml", lockHash: "sha256:daily-lock" },
		generation: "generation-1",
		mode: "build",
		lock: {
			effective_values: [
				{
					path: "multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents",
					value: 2,
					value_kind: "number",
					visibility: "model-visible",
				},
			],
		},
		provenance: {},
		loadedAt: 1,
	};
	return {
		runtime: {
			ctx: {
				settings: Settings.isolated(),
				harnessPort: { current: () => snapshot, controlClient: client },
				showStatus,
			},
		},
		showStatus,
	};
}

describe("/harness control-plane operations", () => {
	test("renders explain provenance for the requested visible leaf", async () => {
		const calls: string[] = [];
		const client = {
			getHarness: async () => result({}),
			validateHarness: async () => result({}),
			explainHarness: async (id: string) => {
				calls.push(`explain:${id}`);
				return result({
					fields: [
						{
							path: "multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents",
							source_layer: "daily_driver.yaml:42",
						},
					],
				});
			},
			lockHarness: async () => result({}),
			getHarnessLock: async () => result({}),
		} satisfies Pick<
			BreadboardClient,
			"getHarness" | "validateHarness" | "explainHarness" | "lockHarness" | "getHarnessLock"
		>;
		const control = controlRuntime(client);

		expect(
			await executeHarnessSlashCommand(
				"/harness explain multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents",
				control.runtime as never,
			),
		).toBe(true);
		expect(calls).toEqual(["explain:daily_driver.yaml"]);
		expect(control.showStatus).toHaveBeenCalledWith(
			expect.stringContaining(
				"multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents: 2 (source layer daily_driver.yaml:42, value kind number, visibility model-visible)",
			),
		);
	});

	test("renders validation problems and successful lock identity", async () => {
		const client = {
			getHarness: async () => result({}),
			validateHarness: async () => result({ problems: ["modes must not be empty"] }),
			explainHarness: async () => result({ fields: [] }),
			lockHarness: async () => result({ graph_hash: "sha256:locked", path: "agent_configs/daily_driver.lock.json" }),
			getHarnessLock: async () => result({}),
		} satisfies Pick<
			BreadboardClient,
			"getHarness" | "validateHarness" | "explainHarness" | "lockHarness" | "getHarnessLock"
		>;
		const control = controlRuntime(client);

		await executeHarnessSlashCommand("/harness validate", control.runtime as never);
		expect(control.showStatus).toHaveBeenLastCalledWith("Harness validation: problems\nmodes must not be empty");
		await executeHarnessSlashCommand("/harness lock", control.runtime as never);
		expect(control.showStatus).toHaveBeenLastCalledWith(
			"Harness lock: sha256:locked\nPath: agent_configs/daily_driver.lock.json",
		);
	});

	test("renders visible added, removed, and changed lock leaves", async () => {
		const locks = {
			left: {
				effective_values: [
					{ path: "same", value: 1, value_kind: "number", visibility: "model-visible" },
					{ path: "removed", value: "old", value_kind: "string", visibility: "model-visible" },
					{ path: "changed", value: "before", value_kind: "string", visibility: "model-visible" },
					{ path: "hidden", value: "secret", value_kind: "secret-ref", visibility: "model-visible" },
				],
			},
			right: {
				effective_values: [
					{ path: "same", value: 1, value_kind: "number", visibility: "model-visible" },
					{ path: "added", value: true, value_kind: "boolean", visibility: "model-visible" },
					{ path: "changed", value: "after", value_kind: "string", visibility: "model-visible" },
					{ path: "hidden", value: "secret", value_kind: "secret-ref", visibility: "model-visible" },
				],
			},
		} as const;
		const client = {
			getHarness: async (id: string) => result({ path: id }),
			validateHarness: async () => result({}),
			explainHarness: async () => result({ fields: [] }),
			lockHarness: async () => result({}),
			getHarnessLock: async (id: string) => result({ lock: id.includes("/left") ? locks.left : locks.right }),
		} satisfies Pick<
			BreadboardClient,
			"getHarness" | "validateHarness" | "explainHarness" | "lockHarness" | "getHarnessLock"
		>;
		const control = controlRuntime(client);

		await executeHarnessSlashCommand("/harness diff left right", control.runtime as never);
		expect(control.showStatus).toHaveBeenCalledWith(
			"Harness diff:\nAdded: added: true\nRemoved: removed: old\nChanged: changed: before -> after",
		);
	});
	test("resolves bare names through engine paths before harness diff locks", async () => {
		const harnessCalls: string[] = [];
		const lockCalls: string[] = [];
		const client = {
			getHarness: async (id: string) => {
				harnessCalls.push(id);
				return result({ path: id });
			},
			validateHarness: async () => result({}),
			explainHarness: async () => result({ fields: [] }),
			lockHarness: async () => result({}),
			getHarnessLock: async (id: string) => {
				lockCalls.push(id);
				return result({ lock: { effective_values: [] } });
			},
		} satisfies Pick<
			BreadboardClient,
			"getHarness" | "validateHarness" | "explainHarness" | "lockHarness" | "getHarnessLock"
		>;
		const control = controlRuntime(client);

		await executeHarnessSlashCommand(
			"/harness diff daily_driver codex_0-107-0_e4_3-6-2026",
			control.runtime as never,
		);

		expect(harnessCalls).toEqual([
			"agent_configs/v2/daily_driver.yaml",
			"agent_configs/v2/codex_0-107-0_e4_3-6-2026.yaml",
		]);
		expect(lockCalls).toEqual([
			"agent_configs/v2/daily_driver.yaml",
			"agent_configs/v2/codex_0-107-0_e4_3-6-2026.yaml",
		]);
		expect(control.showStatus).toHaveBeenCalledWith("Harness diff:\nAdded: none\nRemoved: none\nChanged: none");
	});
});
