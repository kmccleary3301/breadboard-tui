import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import type { PublicResult } from "@breadboard/sdk";
import type { BreadboardClient } from "@breadboard/sdk/engine";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings, resetSettingsForTest } from "../../src/config/settings";
import { initTheme } from "../../src/modes/theme/theme";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import type { InteractiveModeContext } from "../../src/modes/types";
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

async function modeFor(client: BreadboardClient) {
	const tempDir = TempDir.createSync("@pi-harness-use-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const newSession = vi.fn(async () => false);
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
	);
	return { mode, newSession, tempDir };
}

function transcript(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("/harness use", () => {
	test("validates and locks the selected harness without starting a new OMP session", async () => {
		const calls: string[] = [];
		const { mode, newSession, tempDir } = await modeFor(clientFor(calls));

		try {
			expect(await executeHarnessSlashCommand("/harness use daily_driver", { ctx: mode })).toBe(true);
			expect(calls).toEqual([
				"get:daily_driver",
				"validate:agent_configs/daily_driver.v1.yaml",
				"lock:agent_configs/daily_driver.v1.yaml",
			]);
			expect(newSession).not.toHaveBeenCalled();
			expect(transcript(mode)).toContain(
				"Harness daily_driver validated and locked with lock hash sha256:daily-lock",
			);
			expect(transcript(mode)).toContain("Current session stays pinned to its lock");
			expect(transcript(mode)).toContain("bb --harness daily_driver");
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
			expect(calls).toEqual(["get:daily_driver", "validate:agent_configs/daily_driver.v1.yaml"]);
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
				"get:daily_driver",
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

test("/harness use --here explains why an in-process switch is rejected", async () => {
	const startHarnessSession = vi.fn(async () => true);
	const harness = runtimeFor(startHarnessSession);

	expect(await executeHarnessSlashCommand("/harness use --here", harness.runtime)).toBe(true);
	expect(startHarnessSession).not.toHaveBeenCalled();
	expect(harness.showStatus).toHaveBeenCalledWith(
		"A BreadBoard session is pinned to its engine session and lock; an in-process harness switch is not possible.",
	);
});
test("/harness list prints names and paths and marks the active harness", async () => {
	const showStatus = vi.fn();
	const listHarnessChoices = vi.fn(async (directory?: string) => {
		expect(directory).toBe("/project");
		return [
			{ id: "daily_driver.v1.yaml", name: "daily_driver.v1", path: "daily_driver.v1.yaml" },
			{ id: "codex.yaml", name: "codex", path: "codex.yaml" },
		];
	});
	const runtime = {
		ctx: {
			settings: Settings.isolated(),
			harnessPort: {
				current: () =>
					({
						harnessId: "daily_driver.v1.yaml",
						name: "Daily Driver",
						lockHash: null,
						generation: null,
						mode: null,
						lock: null,
						provenance: {},
						loadedAt: 1,
					}) as const,
				listHarnessChoices,
			},
			sessionManager: { getCwd: () => "/project" },
			showStatus,
		},
	};

	expect(await executeHarnessSlashCommand("/harness list", runtime as never)).toBe(true);
	expect(listHarnessChoices).toHaveBeenCalledWith("/project");
	expect(showStatus).toHaveBeenCalledWith(
		"Active harness: daily_driver.v1 (daily_driver.v1.yaml)\n* daily_driver.v1 (daily_driver.v1.yaml)\n  codex (codex.yaml)",
	);
});
