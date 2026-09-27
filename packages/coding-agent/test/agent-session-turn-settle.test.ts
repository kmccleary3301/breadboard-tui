/**
 * `turn_settle` is awaited at the turn boundary: messages it returns reach the very next model call,
 * and they continue a run that would otherwise stop.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
}

async function createSession(factory: ExtensionFactory, responses: MockResponse[]) {
	const tempDir = TempDir.createSync("@pi-turn-settle-");
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false });
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, tempDir.path(), new EventBus(), runtime, "turn-settle");
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const extensionRunner = new ExtensionRunner(
		[extension],
		runtime,
		tempDir.path(),
		sessionManager,
		sharedModelRegistry,
	);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: sharedModelRegistry,
		extensionRunner,
	});
	active.push({ session, tempDir });
	return { session, mock };
}

describe("AgentSession turn_settle", () => {
	it("continues a stopping run with the handler's message before the next model call", async () => {
		const seen: boolean[] = [];
		const { session, mock } = await createSession(
			api => {
				api.on("turn_settle", event => {
					seen.push(event.willContinue);
					const text = assistantText(event.message);
					return text === "call pending"
						? { messages: [{ customType: "settle", content: "result: 42" }] }
						: undefined;
				});
			},
			[
				{ content: [{ type: "text", text: "call pending" }], stopReason: "stop" },
				{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
			],
		);

		await session.prompt("go");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const secondRequest = JSON.stringify(mock.calls[1]?.context.messages);
		expect(secondRequest).toContain("result: 42");
		expect(seen).toEqual([false, false]);
		const settled = session.agent.state.messages.filter(message => message.role === "custom");
		expect(settled.map(message => (message.role === "custom" ? message.customType : ""))).toEqual(["settle"]);
	});

	it("leaves a stopping run alone when handlers return nothing", async () => {
		const { session, mock } = await createSession(
			api => {
				api.on("turn_settle", () => undefined);
			},
			[
				{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
				{ content: [{ type: "text", text: "extra" }] },
			],
		);

		await session.prompt("go");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
	});
});
