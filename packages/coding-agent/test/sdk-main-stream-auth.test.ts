import { afterEach, describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const RESPONSE_TEXT = "broker response";

type SessionFixture = {
	tempDir: TempDir;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
};

function createFixture(): SessionFixture {
	const tempDir = TempDir.createSync("@omp-sdk-main-stream-auth-");
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const bundledModel = getBundledModel("openai", "gpt-5.5");
	if (!bundledModel) throw new Error("Expected bundled openai/gpt-5.5 model");
	// A private provider name cannot inherit real provider environment credentials.
	const model: Model = { ...bundledModel, provider: "sdk-main-stream-auth-test" };
	return { tempDir, authStorage, modelRegistry, model };
}

function createAssistantResponse(model: Model, text = RESPONSE_TEXT): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function completedStream(model: Model, text = RESPONSE_TEXT): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const response = createAssistantResponse(model, text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: response });
		stream.push({ type: "done", reason: "stop", message: response });
	});
	return stream;
}

function baseOptions(fixture: SessionFixture): CreateAgentSessionOptions {
	return {
		cwd: fixture.tempDir.path(),
		agentDir: fixture.tempDir.path(),
		authStorage: fixture.authStorage,
		modelRegistry: fixture.modelRegistry,
		model: fixture.model,
		sessionManager: SessionManager.inMemory(fixture.tempDir.path()),
		settings: Settings.isolated({
			"advisor.enabled": false,
			"async.enabled": false,
			"compaction.enabled": false,
			"todo.enabled": false,
		}),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: {
			rootPath: fixture.tempDir.path(),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
	};
}

function assertCompletedResponse(session: AgentSession): void {
	const assistantMessage = session.messages.at(-1);
	if (!assistantMessage || assistantMessage.role !== "assistant") {
		throw new Error("Expected the completed prompt to append an assistant message");
	}
	expect(assistantMessage.content).toEqual([{ type: "text", text: RESPONSE_TEXT }]);
}

describe("createAgentSession mainStreamFn authentication ownership", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		fixture?.authStorage.close();
		fixture?.tempDir.removeSync();
		fixture = undefined;
	});

	it("completes a prompt without a native key and does not pass implicit native auth to the external stream", async () => {
		fixture = createFixture();
		const observedApiKeys: Array<SimpleStreamOptions["apiKey"]> = [];
		const mainStreamFn: StreamFn = (model, _context, options) => {
			observedApiKeys.push(options?.apiKey);
			return completedStream(model);
		};
		const result = await createAgentSession({ ...baseOptions(fixture), mainStreamFn });

		try {
			expect(await fixture.authStorage.getApiKey(fixture.model.provider)).toBeUndefined();
			await expect(result.session.prompt("hello")).resolves.toBe(true);
			assertCompletedResponse(result.session);
			expect(observedApiKeys).toEqual([undefined]);
		} finally {
			await result.session.dispose();
		}
	});

	it("authenticates an external stream with an explicitly supplied SDK resolver", async () => {
		fixture = createFixture();
		const mainStreamFn: StreamFn = (model, _context, options) => {
			if (options?.apiKey !== "sdk-owned-key") throw new Error("External provider rejected missing credentials");
			return completedStream(model);
		};
		const result = await createAgentSession({
			...baseOptions(fixture),
			mainStreamFn,
			getApiKey: () => "sdk-owned-key",
		});

		try {
			await expect(result.session.prompt("hello")).resolves.toBe(true);
			assertCompletedResponse(result.session);
		} finally {
			await result.session.dispose();
		}
	});

	it("does not resubmit an externally completed turn and accepts the next explicit prompt", async () => {
		fixture = createFixture();
		let submissions = 0;
		const result = await createAgentSession({
			...baseOptions(fixture),
			mainStreamOwnsTurnLifecycle: true,
			mainStreamFn: model => completedStream(model, ++submissions === 1 ? "" : RESPONSE_TEXT),
		});

		try {
			await result.session.prompt("Complete the engine-owned task");
			expect(submissions).toBe(1);
			expect(result.session.isStreaming).toBe(false);
			await result.session.prompt("Start a different task");
			expect(submissions).toBe(2);
			assertCompletedResponse(result.session);
		} finally {
			await result.session.dispose();
		}
	});

	it("persists an external terminal error without retrying and accepts the next explicit prompt", async () => {
		fixture = createFixture();
		const engineFailure = "503 Service Unavailable from the engine";
		let submissions = 0;
		const result = await createAgentSession({
			...baseOptions(fixture),
			mainStreamOwnsTurnLifecycle: true,
			mainStreamFn: model => {
				if (++submissions > 1) return completedStream(model);
				const response = createAssistantResponse(model, "");
				response.stopReason = "error";
				response.errorMessage = engineFailure;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "error", reason: "error", error: response });
				});
				return stream;
			},
		});
		const observedStops: AssistantMessage["stopReason"][] = [];
		const terminalNotifications: boolean[] = [];
		const unsubscribe = result.session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				observedStops.push(event.message.stopReason);
			}
			if (event.type === "agent_end") terminalNotifications.push(event.isTerminal === true);
		});

		try {
			await result.session.prompt("Run the engine-owned task");
			expect(submissions).toBe(1);
			expect(observedStops).toEqual(["error"]);
			expect(terminalNotifications).toEqual([true]);
			const savedErrors = result.session.sessionManager
				.getBranch()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
						? [entry.message]
						: [],
				);
			expect(savedErrors).toHaveLength(1);
			expect(savedErrors[0]?.errorMessage).toBe(engineFailure);
			await result.session.prompt("Start a different task after the failure");
			expect(submissions).toBe(2);
			assertCompletedResponse(result.session);
		} finally {
			unsubscribe();
			await result.session.dispose();
		}
	});

	it("keeps saved native background work inactive while external prompts complete", async () => {
		fixture = createFixture();
		let memoryRequests = 0;
		const memoryServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				memoryRequests++;
				return new Response("Unexpected native memory request", { status: 503 });
			},
		});
		let session: AgentSession | undefined;
		let submissions = 0;
		try {
			const result = await createAgentSession({
				...baseOptions(fixture),
				model: { ...fixture.model, contextWindow: 128 },
				settings: Settings.isolated({
					"advisor.enabled": true,
					"async.enabled": false,
					"todo.enabled": false,
					"compaction.enabled": true,
					"compaction.reserveTokens": 32,
					"compaction.keepRecentTokens": 16,
					defaultThinkingLevel: "auto",
					"memory.backend": "hindsight",
					"hindsight.apiUrl": memoryServer.url.href,
					"autolearn.enabled": true,
				}),
				mainStreamOwnsTurnLifecycle: true,
				mainStreamFn: model => {
					submissions++;
					return completedStream(model);
				},
			});
			session = result.session;
			expect(session.isAutoThinking).toBe(false);
			expect(session.isAdvisorActive()).toBe(false);
			await session.prompt("External context is engine-owned. ".repeat(100));
			await session.prompt("Continue with a new explicit request.");
			expect(submissions).toBe(2);
			expect(memoryRequests).toBe(0);
			expect(session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toEqual([]);
			assertCompletedResponse(session);
		} finally {
			await session?.dispose();
			memoryServer.stop(true);
		}
	});

	it("rejects native advisor and continuation APIs before admitting another turn", async () => {
		fixture = createFixture();
		let submissions = 0;
		const { session } = await createAgentSession({
			...baseOptions(fixture),
			mainStreamOwnsTurnLifecycle: true,
			mainStreamFn: model => {
				submissions++;
				return completedStream(model);
			},
		});
		try {
			expect(() => session.setAdvisorEnabled(true)).toThrow(/BreadBoard/);
			await expect(session.followUp("Do not enqueue this")).rejects.toThrow(/BreadBoard/);
			await expect(session.prompt("Do not resume this", { synthetic: true })).rejects.toThrow(/BreadBoard/);
			expect(session.isAdvisorEnabled()).toBe(false);
			expect(submissions).toBe(0);
			await session.prompt("A normal explicit request remains supported.");
			expect(submissions).toBe(1);
			assertCompletedResponse(session);
		} finally {
			await session.dispose();
		}
	});

	it("retains the current request model when external model selection fails", async () => {
		fixture = createFixture();
		const observedModels: string[] = [];
		const { session } = await createAgentSession({
			...baseOptions(fixture),
			mainStreamOwnsTurnLifecycle: true,
			mainStreamSelectModel: async () => {
				throw new Error("Engine rejected model selection");
			},
			mainStreamFn: model => {
				observedModels.push(model.id);
				return completedStream(model);
			},
		});
		try {
			const currentModel = session.model;
			if (!currentModel) throw new Error("Expected an active model");
			await expect(session.setModelTemporary({ ...fixture.model, id: "rejected-target" })).rejects.toThrow(
				"Engine rejected model selection",
			);
			expect(session.model?.id).toBe(currentModel.id);
			await session.prompt("Use the unchanged model.");
			expect(observedModels).toEqual([currentModel.id]);
		} finally {
			await session.dispose();
		}
	});

	it("retains empty-response recovery for a transport that does not own the turn lifecycle", async () => {
		fixture = createFixture();
		let requests = 0;
		const result = await createAgentSession({
			...baseOptions(fixture),
			mainStreamFn: model => completedStream(model, ++requests === 1 ? "" : RESPONSE_TEXT),
		});

		try {
			await result.session.prompt("Recover a native provider response");
			expect(requests).toBe(2);
			assertCompletedResponse(result.session);
		} finally {
			await result.session.dispose();
		}
	});

	it("keeps native sessions gated by missing credentials before dispatch", async () => {
		fixture = createFixture();
		let dispatches = 0;
		const result = await createAgentSession({
			...baseOptions(fixture),
			onFirstChatDispatch: () => {
				dispatches++;
			},
		});

		try {
			await expect(result.session.prompt("hello")).rejects.toThrow("No API key found for sdk-main-stream-auth-test");
			expect(dispatches).toBe(0);
		} finally {
			await result.session.dispose();
		}
	});
});
