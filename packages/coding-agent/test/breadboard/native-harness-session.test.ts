/**
 * An OMP session configured by a compiled R39 harness runs Python's tool contract on OMP's loop:
 * harness function tools only, `run_shell` through OMP bash with Python's result text, text-dialect
 * TodoWrite through `turn_settle`, the strict-todo completion guard, per-turn framing, and a
 * `mark_task_complete` that ends the run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LoadedNativeHarness, loadNativeHarness } from "@breadboard/harness";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { applyNativeHarnessSessionOptions } from "@oh-my-pi/pi-coding-agent/breadboard/native-harness-session";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const R39_FIXTURE = path.resolve(import.meta.dir, "../../../breadboard-harness/test/native/fixtures/r39-workspace");
const R39_SPEC = ".breadboard/bb-omp/r39/bb-omp.harness.yaml";
const GUARD_ONE_OPEN = "Outstanding todos must be completed or canceled before finishing. Pending items: write the test";

let modelRegistry: ModelRegistry;
const tempDirs: string[] = [];
const sessions: AgentSession[] = [];

beforeAll(async () => {
	const authDir = fs.mkdtempSync(path.join(os.tmpdir(), `bb-native-session-auth-${Snowflake.next()}-`));
	tempDirs.push(authDir);
	modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
	modelRegistry.authStorage.setRuntimeApiKey("openai", "test-key");
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

afterAll(() => {
	for (const dir of tempDirs) removeSyncWithRetries(dir);
});

async function nativeSession(
	responses: MockResponse[],
	options: { autoApprove?: boolean } = {},
): Promise<{ session: AgentSession; harness: LoadedNativeHarness; calls: ReturnType<typeof createMockModel>["calls"] }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bb-native-session-${Snowflake.next()}-`));
	tempDirs.push(root);
	const cwd = fs.realpathSync(root);
	fs.cpSync(R39_FIXTURE, cwd, { recursive: true });
	const harness = await loadNativeHarness({ specPath: R39_SPEC, workspaceRoot: cwd });
	const settings = Settings.isolated({
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
	});
	const sessionOptions: CreateAgentSessionOptions = {
		cwd,
		agentDir: cwd,
		modelRegistry,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		autoApprove: options.autoApprove ?? false,
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
	};
	applyNativeHarnessSessionOptions(sessionOptions, harness, settings, { approvalSelected: false });
	const { session } = await createAgentSession(sessionOptions);
	sessions.push(session);
	const mock = createMockModel({ responses });
	vi.spyOn(session.agent, "streamFn").mockImplementation(mock.stream);
	return { session, harness, calls: mock.calls };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

const todoWrite: MockResponse = {
	content: [
		{
			type: "text",
			text: '<TOOL_CALL> TodoWrite(todos=[{"content": "write the test", "status": "pending", "activeForm": "Writing the test"}]) </TOOL_CALL>',
		},
	],
	stopReason: "stop",
};

function toolResult(session: AgentSession, id: string): ToolResultMessage | undefined {
	return session.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
	);
}

function textOf(message: { content: ReadonlyArray<{ type: string; text?: string }> } | undefined): string {
	return (message?.content ?? []).flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("");
}

function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		const content = message.content;
		return [typeof content === "string" ? content : textOf({ content })];
	});
}

describe("native harness session", () => {
	it("exposes exactly the harness function tools under the compiled system prompt", async () => {
		const { session, harness } = await nativeSession([]);
		expect(session.getActiveToolNames().toSorted()).toEqual(
			["create_file_from_block", "eval", "list_dir", "mark_task_complete", "read_file", "run_shell"].toSorted(),
		);
		expect(session.agent.state.systemPrompt.join("\n\n")).toBe(harness.systemPrompt);
	});

	it("runs run_shell on OMP bash, returns Python's result text, and ends the run on mark_task_complete", async () => {
		const { session, harness, calls } = await nativeSession(
			[
				toolCall("shell-1", "run_shell", { command: "printf native-ok" }),
				toolCall("done-1", "mark_task_complete", {}),
				{ content: [{ type: "text", text: "never requested" }] },
			],
			{ autoApprove: true },
		);

		await session.prompt("hello");
		await session.waitForIdle();

		expect(textOf(toolResult(session, "shell-1"))).toBe(
			'{"stdout": "native-ok", "exit": 0, "__mvi_text_output": "native-ok"}',
		);
		expect(toolResult(session, "done-1")?.isError).toBe(false);
		expect(calls).toHaveLength(2);
		// The model sees Python's framing; the transcript keeps what the user typed.
		expect(userTexts(calls[0]?.context.messages ?? [])).toEqual([
			`hello\n\n<BREADBOARD_INTERNAL>\n${harness.perTurnPrompt}\n</BREADBOARD_INTERNAL>`,
		]);
		expect(userTexts(session.messages)).toEqual(["hello"]);
	});

	it("runs text TodoWrite at the turn boundary and holds completion while a todo is open", async () => {
		const { session, calls } = await nativeSession([
			todoWrite,
			toolCall("done-early", "mark_task_complete", {}),
			{ content: [{ type: "text", text: "still working" }], stopReason: "stop" },
		]);

		await session.prompt("plan it");
		await session.waitForIdle();

		expect(calls).toHaveLength(3);
		// Python's TodoWrite success text (`todo/manager.py`), sent back as a user message.
		expect(userTexts(calls[1]?.context.messages ?? []).at(-1)).toBe(
			'[TodoWrite] "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable"',
		);
		// The held completion keeps its normal result; Python's advisory follows it as a user message.
		expect(toolResult(session, "done-early")?.isError).toBe(false);
		expect(userTexts(calls[2]?.context.messages ?? []).at(-1)).toBe(
			`<VALIDATION_ERROR>\n${GUARD_ONE_OPEN}\nCompletion guard engaged. Provide concrete file edits and successful tests. Warnings remaining before abort: 1.\n</VALIDATION_ERROR>`,
		);
	});

	it("ends the run on the second held completion, as Python's guard threshold does", async () => {
		const { session, calls } = await nativeSession([
			todoWrite,
			toolCall("done-1", "mark_task_complete", {}),
			toolCall("done-2", "mark_task_complete", {}),
			{ content: [{ type: "text", text: "never requested" }] },
		]);

		await session.prompt("plan it");
		await session.waitForIdle();

		expect(calls).toHaveLength(3);
		expect(toolResult(session, "done-2")?.isError).toBe(false);
	});

	it("asks before run_shell under the harness's prompt permissions", async () => {
		const { session, calls } = await nativeSession([
			toolCall("shell-denied", "run_shell", { command: "printf should-not-run > ran.txt" }),
			{ content: [{ type: "text", text: "ok" }], stopReason: "stop" },
		]);

		await session.prompt("hello");
		await session.waitForIdle();

		expect(calls).toHaveLength(2);
		expect(toolResult(session, "shell-denied")?.isError).toBe(true);
		expect(fs.existsSync(path.join(session.sessionManager.getCwd(), "ran.txt"))).toBe(false);
	});
});
