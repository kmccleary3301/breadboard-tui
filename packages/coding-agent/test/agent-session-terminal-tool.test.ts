/**
 * A tool marked `terminal` ends the current prompt run once it succeeds, the way a harness's
 * completion tool (`mark_task_complete`) does. A failed call must not end the run, a terminal
 * predicate can keep a successful one from ending it, and the session accepts the next prompt.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const completeSchema = type({ ok: type("boolean") });

const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("mock", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
const active: Array<{ session: AgentSession; tempDir: TempDir }> = [];

afterAll(() => {
	sharedAuthStorage.close();
});

afterEach(async () => {
	for (const harness of active.splice(0)) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
});

const completeTool: AgentTool<typeof completeSchema> = {
	name: "complete",
	label: "Complete",
	description: "Finish the task.",
	parameters: completeSchema,
	terminal: true,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: params.ok ? "done" : "todos still open" }],
			...(params.ok ? {} : { isError: true }),
		};
	},
};

function completeCall(ok: boolean, id: string): MockResponse {
	return { content: [{ type: "toolCall", id, name: "complete", arguments: { ok } }], stopReason: "toolUse" };
}

function textStop(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

/** Succeeds either way; only an `ok` result ends the run. */
const guardedCompleteTool: AgentTool<typeof completeSchema> = {
	...completeTool,
	terminal: result => result.details === "accepted",
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: "done" }], details: params.ok ? "accepted" : "held" };
	},
};

function createSession(
	responses: MockResponse[],
	tool: AgentTool<typeof completeSchema> = completeTool,
): { session: AgentSession; mock: MockModel } {
	const tempDir = TempDir.createSync("@pi-terminal-tool-");
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const tools = [tool] as AgentTool[];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: sharedModelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	active.push({ session, tempDir });
	return { session, mock };
}

function toolResults(messages: AgentMessage[]): Array<{ isError: boolean }> {
	return messages.flatMap(message => (message.role === "toolResult" ? [{ isError: message.isError }] : []));
}

describe("AgentSession terminal tools", () => {
	it("ends the run after a successful terminal call and accepts the next prompt", async () => {
		const { session, mock } = createSession([
			completeCall(true, "call-1"),
			textStop("unreached"),
			textStop("second"),
		]);

		await session.prompt("finish");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(toolResults(session.agent.state.messages)).toEqual([{ isError: false }]);

		await session.prompt("again");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect(last?.role === "assistant" && last.stopReason).toBe("stop");
	});

	it("keeps the run going when the terminal call fails", async () => {
		const { session, mock } = createSession([completeCall(false, "call-1"), completeCall(true, "call-2")]);

		await session.prompt("finish");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		expect(toolResults(session.agent.state.messages)).toEqual([{ isError: true }, { isError: false }]);
	});

	it("lets a terminal predicate keep a successful call from ending the run", async () => {
		const { session, mock } = createSession(
			[completeCall(false, "call-1"), completeCall(true, "call-2"), textStop("unreached")],
			guardedCompleteTool,
		);

		await session.prompt("finish");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		expect(toolResults(session.agent.state.messages)).toEqual([{ isError: false }, { isError: false }]);
	});
});
