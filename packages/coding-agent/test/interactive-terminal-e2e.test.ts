import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createBreadboardClient, type SessionSummary } from "@breadboard/sdk/engine";
import {
	BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
	type BreadboardSessionBindingData,
} from "@oh-my-pi/pi-coding-agent/breadboard/session-binding";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, setSymbolPreset, theme } from "@oh-my-pi/pi-tui/theme";
import { getSlashCommandTypeIcon } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { EFFECTIVE_HARNESS_SNAPSHOT } from "./modes/components/effective-lock-fixture";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function dump(label: string, rows: readonly string[]): void {
	console.log(`==== ${label} ====`);
	for (const [i, row] of rows.entries()) console.log(String(i).padStart(3), JSON.stringify(row));
}

describe("libkitty end-to-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-libkitty-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("updates visible slash icons when the symbol preset changes in either direction", async () => {
		const originalPreset = theme.getSymbolPreset();
		const modelRow = () => plainRows(term.getViewport()).find(row => /^[^A-Za-z0-9/]*model\s/.test(row));
		try {
			await mode.init({ suppressWelcomeIntro: true });
			void mode.getUserInput();
			await setSymbolPreset("nerd");
			const icon = getSlashCommandTypeIcon("model");
			if (!icon) throw new Error("Nerd Font model icon is missing");
			term.sendInput("/model");
			await term.waitForRender(() => modelRow()?.includes(icon) === true);
			expect(modelRow()).toContain(icon);

			mode.editor.setText("");
			await setSymbolPreset("ascii");
			term.sendInput("/model");
			await term.waitForRender(() => {
				const row = modelRow();
				return row !== undefined && !row.includes(icon);
			});
			expect(modelRow()).not.toContain(icon);
		} finally {
			await setSymbolPreset(originalPreset);
		}
	});

	it("keeps unrelated custom commands visible with an active harness", async () => {
		const model = session.model;
		if (!model) throw new Error("Expected fixture model");
		mode.stop();
		await session.dispose();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			customCommands: ["ps", "clean"].map(name => ({
				path: path.join(tempDir.path(), `${name}.ts`),
				resolvedPath: path.join(tempDir.path(), `${name}.ts`),
				source: "project",
				command: {
					name,
					description: `Custom ${name} command`,
					execute() {
						throw new Error("Autocomplete must not execute commands");
					},
				},
			})),
		});
		term = new VirtualTerminal(120, 32);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		mode.harnessPort = {
			current: () => EFFECTIVE_HARNESS_SNAPSHOT,
			refresh: async () => EFFECTIVE_HARNESS_SNAPSHOT,
			subscribe: () => () => {},
		};
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		for (const name of ["ps", "clean"]) {
			mode.editor.setText("");
			term.sendInput(`/${name}`);
			await term.waitForRender(() =>
				plainRows(term.getViewport()).some(row => row.includes(`Custom ${name} command`)),
			);
			expect(plainRows(term.getViewport()).join("\n")).toContain(`Custom ${name} command`);
		}
	});

	it("paints the submitted user message before any model reply", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const pending = mode.getUserInput();
		await term.waitForRender();

		term.sendInput("hi there omp");
		await term.waitForRender();
		term.sendInput("\r");
		const input = await pending;
		expect(input.text).toBe("hi there omp");

		// The optimistic user-message block must be on the physical screen now,
		// before any assistant output exists.
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("hi there omp")));
		const viewport = plainRows(term.getViewport());
		const hits = viewport.filter(row => row.includes("hi there omp"));
		if (hits.length !== 1) dump("viewport after submit", viewport);
		expect(hits.length).toBe(1);
	});

	it("keeps the whole buffer clean across non-overflowing width resizes", async () => {
		term.resize(140, 40);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		term.resize(120, 40);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(110, 40);
		await Bun.sleep(300);
		await term.waitForRender();

		// Content always fit the screen, so the terminal never pushed live rows
		// into scrollback: the entire buffer must hold exactly one copy.
		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after resizes", buffer);
		expect(drafts.length).toBe(1);
		expect(buffer).toEqual(plainRows(term.getViewport()));
	});

	it("keeps the screen exact through an overflowing shrink", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Width+height shrink: the live viewport rewraps taller than the new
		// screen, so the terminal itself pushes stale top rows into scrollback.
		// Those pushed rows are unreachable to an inline app; the contract is an
		// exact screen and no duplicate of the bottom-anchored rows anywhere.
		term.resize(88, 26);
		await Bun.sleep(300);
		await term.waitForRender();

		const viewport = plainRows(term.getViewport());
		const editors = viewport.filter(row => row.includes("MARKER_DRAFT"));
		if (editors.length !== 1) dump("viewport after overflowing shrink", viewport);
		expect(editors.length).toBe(1);
		const buffer = plainRows(term.getScrollBuffer());
		expect(buffer.filter(row => row.includes("MARKER_DRAFT")).length).toBe(1);
	});

	it("keeps one editor through a drag storm, shrink, and grow", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Drag storm: several unsettled steps inside one settle window.
		term.resize(112, 30);
		await Bun.sleep(30);
		term.resize(104, 28);
		await Bun.sleep(30);
		term.resize(96, 24);
		await Bun.sleep(300);
		await term.waitForRender();
		// Height-only shrink, then a combined grow back out.
		term.resize(96, 18);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(120, 32);
		await Bun.sleep(300);
		await term.waitForRender();

		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after drag storm", buffer);
		expect(drafts.length).toBe(1);

		// The editor is still live: typing paints into the one surviving editor.
		term.sendInput("X");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFTX")));
		expect(plainRows(term.getViewport()).filter(row => row.includes("MARKER_DRAFTX")).length).toBe(1);
	});

	it("hides thinking already retired to native scrollback when Ctrl+T toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		const THINK = "RETIRED_REASONING_MARKER";
		const thinkingMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: THINK },
				{ type: "text", text: "First visible answer." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};

		// A short viewport forces the oldest finalized blocks into immutable
		// terminal history, which is where the regression hid (a plain viewport
		// repaint leaves retired rows untouched).
		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Observed reasoning content unlocks Ctrl+T and renders the block visible.
		mode.noteDisplayableThinkingContent(thinkingMessage);
		mode.addMessageToChat(thinkingMessage);
		for (let i = 0; i < 12; i++) {
			mode.addMessageToChat(assistantText(`Filler answer number ${i} occupying a transcript row.`));
		}

		// Retirement offers one finalized batch per frame under capacity pressure;
		// drive frames until the thinking turn commits to native scrollback.
		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(THINK)); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(THINK))).toBe(true);

		// A live editor draft must survive the toggle's history rebuild.
		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Ctrl+T (0x14): the real keybinding path toggles thinking hidden.
		term.sendInput("\x14");
		await term.waitForRender(() => !plainRows(term.getScrollBuffer()).some(row => row.includes(THINK)));

		// The retired history was cleared and replayed hidden — the marker is gone
		// from scrollback and viewport alike — while the live editor stays mounted.
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(THINK))).toBe(false);
		expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
	});

	it("retains parent session file, header ID, and binding content on harness switch", async () => {
		const sessionSummary: SessionSummary = {
			session_id: "engine-session-1",
			status: "running",
			generation_id: "generation-1",
			trajectory_segment_id: "segment-1",
			lineage: null,
			effective_lock_hash: "sha256:lock-hash",
			mode: "coding",
		};

		const makeEnvelope = <T>(data: T) =>
			Response.json({
				schema_version: "bb.cli.result.v1",
				ok: true,
				status: "ok",
				command: [],
				record_refs: [],
				hashes: {
					graph: "sha256:lock-hash",
				},
				stage_outcomes: [],
				warnings: [],
				next_actions: [],
				error: null,
				exit_code: 0,
				data,
			});

		const client = createBreadboardClient({
			baseUrl: "http://127.0.0.1:9099",
			fetch: asGlobalFetch(async input => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const pathname = new URL(url).pathname;
				if (pathname.endsWith("/validate")) {
					return makeEnvelope({ valid: true });
				}
				if (pathname.endsWith("/lock")) {
					return makeEnvelope({
						path: "daily_driver.v1.lock.json",
						graph_hash: "sha256:lock-hash",
						lock: {
							schema_version: "bb.effective_config_graph.v1",
							graph_hash: "sha256:lock-hash",
							source_layers: [],
							effective_values: [],
						},
					});
				}
				if (pathname.endsWith("/explain")) {
					return makeEnvelope({ fields: [] });
				}
				if (pathname.startsWith("/v1/harness-locks/")) {
					return makeEnvelope({
						path: "daily_driver.v1.lock.json",
						lock: {
							schema_version: "bb.effective_config_graph.v1",
							graph_hash: "sha256:lock-hash",
							source_layers: [],
							effective_values: [],
						},
					});
				}
				if (pathname.startsWith("/v1/sessions/")) {
					return makeEnvelope({ session: sessionSummary });
				}
				if (pathname.startsWith("/v1/harnesses/")) {
					return makeEnvelope({
						path: "daily_driver.v1.yaml",
						definition: {
							schema_version: "bb.harness_definition.v1",
							profile: { name: "Daily Driver" },
						},
					});
				}
				throw new Error(`Unexpected harness fixture request: ${pathname}`);
			}),
		});

		term = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			composer,
			undefined,
			undefined,
			undefined,
			client,
			"daily_driver.v1.yaml",
			undefined,
			async (_configPath, _lockId, transition) => transition(),
			() => "engine-session-1",
		);

		await mode.init({ suppressWelcomeIntro: true });

		const expectedParentId = session.sessionManager.getSessionId();
		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Expected a persistent parent session path");

		const expectedBinding: BreadboardSessionBindingData = {
			schemaVersion: "breadboard.session-binding.v4",
			sessionId: "engine-parent-session-1",
			previousSessionId: null,
			replayConfigurationDigest: "sha256:parent-replay",
			cursor: {
				eventId: null,
				sequence: 0,
			},
			ownedSubmissions: [],
		};
		session.sessionManager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, expectedBinding);

		// Assert parent is initially unpersisted and has no assistant messages
		expect(session.sessionManager.isSessionOnDisk()).toBe(false);
		expect(session.sessionManager.getEntries().some(e => e.type === "message")).toBe(false);

		const switched = await mode.startHarnessSession("daily_driver.v1.yaml");
		expect(switched).toBe(true);

		// Parent session must now exist on disk and be openable through SessionManager
		const openedParent = await SessionManager.open(parentSessionFile);
		try {
			expect(openedParent.getSessionId()).toBe(expectedParentId);

			const bindingEntry = openedParent
				.getEntries()
				.find(entry => entry.type === "custom" && entry.customType === BREADBOARD_SESSION_BINDING_CUSTOM_TYPE);
			if (bindingEntry?.type !== "custom") throw new Error("Retained parent binding is missing");
			expect(bindingEntry.data).toEqual(expectedBinding);
		} finally {
			await openedParent.close();
		}

		// Child local ID is distinct from parent
		const childSessionId = session.sessionManager.getSessionId();
		expect(childSessionId).not.toBe(expectedParentId);
		const childHeader = session.sessionManager.getHeader();

		// Child parent path points to actual parent file
		expect(childHeader?.parentSession).toBe(parentSessionFile);
		expect(await Bun.file(parentSessionFile).exists()).toBe(true);
	});

	it("hides tool activity already retired to native scrollback when the real shortcut toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const TOOL_MARKER = "RETIRED_TOOL_ACTIVITY_MARKER";
		const callId = "retired-tool-call";
		const toolCall: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `printf ${TOOL_MARKER}` } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: TOOL_MARKER }],
			isError: false,
			timestamp: 2,
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 3,
		});

		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Tool visibility is a global input-controller action; it reads the live keybindings.
		mode.keybindings.setUserBindings({ "app.tools.toggleVisibility": "alt+o" });
		mode.renderSessionContext({
			messages: [
				toolCall,
				toolResult,
				...Array.from({ length: 12 }, (_, i) =>
					assistantText(`Filler answer number ${i} occupying a transcript row.`),
				),
			],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});

		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(TOOL_MARKER)); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(TOOL_MARKER))).toBe(true);

		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Alt+O is the configured app.tools.toggleVisibility binding from this test's keybinding manager.
		term.sendInput("\x1bo");
		await term.waitForRender(() => !plainRows(term.getScrollBuffer()).some(row => row.includes(TOOL_MARKER)));
		expect(mode.hideToolActivity).toBe(true);
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(TOOL_MARKER))).toBe(false);
		expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
	});
});
