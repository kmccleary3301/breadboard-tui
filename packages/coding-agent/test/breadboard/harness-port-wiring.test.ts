import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { PublicResult } from "@breadboard/sdk";
import { ApiError, type BreadboardClient, type SessionSummary } from "@breadboard/sdk/engine";
import { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { InteractiveMode } from "../../src/modes/interactive-mode";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const HARNESS_ID = "daily_driver.v1.yaml";
const ENGINE_SESSION_ID = "engine-session-1";

const definition = {
	schema_version: "bb.harness_definition.v1",
	profile: { name: "Daily Driver" },
} as const;

const lock = {
	schema_version: "bb.effective_config_graph.v1",
	graph_hash: "sha256:lock",
	source_layers: [],
	effective_values: [],
} as const;

const sessionSummary: SessionSummary = {
	session_id: ENGINE_SESSION_ID,
	status: "running",
	generation_id: "generation-1",
	trajectory_segment_id: "segment-1",
	lineage: null,
	effective_lock_hash: "sha256:lock",
	mode: "coding",
};

function envelope(data: Readonly<Record<string, unknown>>): PublicResult {
	return {
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
	};
}

describe("InteractiveMode BreadBoard harness wiring", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		// Pin the color mode: `fgResolved` throws under NO_COLOR/TERM=dumb (bb-ewnk.18), and init renders the editor.
		await initTheme(false, undefined, undefined, undefined, undefined, "truecolor");
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-harness-wiring-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	test("passes the runtime engine session id to the harness port", async () => {
		const sessionIds: string[] = [];
		const client = {
			getHarness: async () => envelope({ path: HARNESS_ID, definition }),
			explainHarness: async () => envelope({ fields: [] }),
			getHarnessLock: async () => envelope({ path: "daily_driver.v1.lock.json", lock }),
			getSession: async (id: string) => {
				sessionIds.push(id);
				return sessionSummary;
			},
		} as unknown as BreadboardClient;
		const composer = new Composer({ terminal: new VirtualTerminal(120, 32) });
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			composer,
			undefined,
			undefined,
			undefined,
			client,
			HARNESS_ID,
			undefined,
			undefined,
			() => ENGINE_SESSION_ID,
		);

		if (!mode.harnessPort) throw new Error("Expected the harness port to be wired");
		await mode.harnessPort.refresh("session-open");

		expect(sessionIds).toEqual([ENGINE_SESSION_ID]);
		expect(ENGINE_SESSION_ID).not.toBe(session.sessionManager.getSessionId());
	});
	test("shows the selected harness without claiming verification when its source lock is missing", async () => {
		const client = {
			getHarness: async () => envelope({ path: HARNESS_ID, definition }),
			explainHarness: async () => envelope({ fields: [] }),
			getHarnessLock: async () => {
				throw new ApiError("path_unavailable: path is unavailable", 404, {});
			},
			getSession: async () => sessionSummary,
		} as unknown as BreadboardClient;
		const composer = new Composer({ terminal: new VirtualTerminal(120, 32) });
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			composer,
			undefined,
			undefined,
			undefined,
			client,
			HARNESS_ID,
			undefined,
			undefined,
			() => ENGINE_SESSION_ID,
		);

		await mode.init({ suppressWelcomeIntro: true });

		const status = Bun.stripANSI(mode.statusLine.renderBottomBar(120, "full"));
		const welcome = Bun.stripANSI(mode.composer.welcome?.render(120).join("\n") ?? "");
		expect(status).toContain("Daily Driver");
		expect(welcome).toContain("Harness Daily Driver");
		expect(welcome).toContain("details unverified");
	});
});
