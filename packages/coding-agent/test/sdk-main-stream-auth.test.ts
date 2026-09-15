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

function createAssistantResponse(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: RESPONSE_TEXT }],
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

function completedStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const response = createAssistantResponse(model);
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
