import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { BreadboardSessionTransitionError } from "@oh-my-pi/pi-coding-agent/breadboard/session-binding";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

describe("CommandController new-session transition rejection", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-command-controller-new-session-");
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

	it("visibly retains prior durable local identity, path, and history with an in-TUI warning on typed transition rejection while keeping the UI usable", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		const priorMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "durable user question from prior session" }],
			timestamp: Date.now(),
		};
		session.sessionManager.appendMessage(priorMessage);
		await session.sessionManager.ensureOnDisk();
		mode.addMessageToChat(priorMessage);
		await term.waitForRender(() =>
			plainRows(term.getViewport()).some(row => row.includes("durable user question from prior session")),
		);

		const priorSessionId = session.sessionManager.getSessionId();
		const priorSessionFile = session.sessionManager.getSessionFile();
		if (!priorSessionFile) throw new Error("Expected a durable session file");
		const priorEntries = structuredClone(session.sessionManager.getEntries());
		const guardReason = "The active E4 session prevents this transition.";
		session.setSessionTransitionGuard(() => {
			throw new BreadboardSessionTransitionError(guardReason);
		});

		await mode.handleClearCommand();

		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes(guardReason)));
		const viewport = plainRows(term.getViewport());
		expect(viewport.some(row => row.includes(guardReason))).toBe(true);

		expect(session.sessionManager.getSessionId()).toBe(priorSessionId);
		expect(session.sessionManager.getSessionFile()).toBe(priorSessionFile);
		expect(await Bun.file(priorSessionFile).exists()).toBe(true);

		expect(session.sessionManager.getEntries()).toEqual(priorEntries);
		const fullBuffer = plainRows(term.getScrollBuffer());
		expect(fullBuffer.some(row => row.includes("durable user question from prior session"))).toBe(true);

		term.sendInput("user prompt after rejection");
		await term.waitForRender(() =>
			plainRows(term.getViewport()).some(row => row.includes("user prompt after rejection")),
		);
		expect(plainRows(term.getViewport()).some(row => row.includes("user prompt after rejection"))).toBe(true);
	});

	it("propagates unexpected non-transition errors without swallowing them", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		session.setSessionTransitionGuard(() => {
			throw new Error("unexpected error during transition");
		});

		await expect(mode.handleClearCommand()).rejects.toThrow("unexpected error during transition");
	});

	it("preserves successful /new behavior when no transition guard rejects", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		mode.addMessageToChat({
			role: "user",
			content: [{ type: "text", text: "temporary message before reset" }],
			timestamp: Date.now(),
		});
		await term.waitForRender(() =>
			plainRows(term.getViewport()).some(row => row.includes("temporary message before reset")),
		);

		const priorSessionId = session.sessionManager.getSessionId();
		const priorSessionFile = session.sessionManager.getSessionFile();

		await mode.handleClearCommand();

		expect(session.sessionManager.getSessionId()).not.toBe(priorSessionId);
		expect(session.sessionManager.getSessionFile()).not.toBe(priorSessionFile);

		await term.waitForRender(() =>
			!plainRows(term.getViewport()).some(row => row.includes("temporary message before reset")),
		);
		expect(plainRows(term.getViewport()).some(row => row.includes("temporary message before reset"))).toBe(false);
	});
});
