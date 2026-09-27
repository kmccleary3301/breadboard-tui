import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage, UserMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readBreadboardComposerMetrics } from "../../src/breadboard/composer-metrics";
import type { HarnessSnapshot } from "../../src/breadboard/harness-port";
import { ModelRegistry } from "../../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const pricedModel = buildModel({
	id: "priced-model",
	name: "Priced model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://provider.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
});
const usage = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const user: UserMessage = { role: "user", content: "prompt", timestamp: 1 };
function assistant(responseId: string, model: typeof pricedModel, turnUsage: Usage): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: `breadboard:e4:${responseId}`,
		content: [{ type: "text", text: "Answer" }],
		usage: turnUsage,
		stopReason: "stop",
		timestamp: 1,
	};
}

let directory: TempDir;
let auth: AuthStorage;
const sessions: AgentSession[] = [];
beforeEach(async () => {
	resetSettingsForTest();
	directory = TempDir.createSync("bb-composer-metrics-");
	await Settings.init({ inMemory: true, cwd: directory.path() });
	auth = await AuthStorage.create(join(directory.path(), "auth.db"));
});
afterEach(async () => {
	for (const current of sessions.splice(0)) await current.dispose();
	auth?.close();
	directory.removeSync();
	resetSettingsForTest();
});
function session(messages: AgentMessage[], model = pricedModel): AgentSession {
	const current = new AgentSession({
		agent: new Agent({
			initialState: { model, messages, tools: [], systemPrompt: [], thinkingLevel: ThinkingLevel.High },
		}),
		sessionManager: SessionManager.inMemory(directory.path()),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
		mainStreamOwnsTurnLifecycle: true,
	});
	sessions.push(current);
	return current;
}

describe("BreadBoard composer metrics", () => {
	it("prices API-backed usage and marks it as estimated", () => {
		const metrics = readBreadboardComposerMetrics(
			session([user, assistant("turn-1", pricedModel, usage(1_000, 2_000))]),
			null,
		);
		expect(metrics.spend).toEqual({ sessionUsd: 0.005, turnUsd: 0.005, estimated: true });
	});
	it("does not invent a bill or native effort for Codex subscription usage", () => {
		const codex = { ...pricedModel, provider: "openai-codex" };
		const metrics = readBreadboardComposerMetrics(
			session([user, assistant("turn-1", codex, usage(1_000, 2_000))], codex),
			null,
		);
		expect(metrics.spend).toBeNull();
		expect(metrics.effort).toBeNull();
	});
	it("deduplicates projection receipts without presenting an incomplete session total", () => {
		const unknown = { ...pricedModel, id: "unknown-model" };
		const current = assistant("turn-2", pricedModel, usage(1_000, 2_000));
		const metrics = readBreadboardComposerMetrics(
			session([user, assistant("turn-1", unknown, usage(1_000, 1_000)), user, current, { ...current }]),
			null,
		);
		expect(metrics.spend).toEqual({ sessionUsd: null, turnUsd: 0.005, estimated: true });
	});
	it("requires verified model and harness identity before showing configured effort", () => {
		const harness: HarnessSnapshot = {
			harnessId: "harness",
			name: "Harness",
			lockHash: "hash",
			verifiedIdentity: { harnessId: "harness", lockHash: "hash" },
			generation: "generation",
			mode: "native",
			loadedAt: 1,
			provenance: {},
			lock: {
				effective_values: [
					{
						path: "providers.default_model",
						value_kind: "string",
						value: pricedModel.id,
						visibility: "model-visible",
					},
					{
						path: "providers.models",
						value_kind: "array",
						value: [{ id: pricedModel.id, params: { reasoning_effort: "high" } }],
						visibility: "model-visible",
					},
				],
			},
		};
		const current = session([user]);
		expect(readBreadboardComposerMetrics(current, harness).effort).toBe(ThinkingLevel.High);
		expect(readBreadboardComposerMetrics(current, { ...harness, harnessId: "different" }).effort).toBeNull();
		expect(readBreadboardComposerMetrics(current, { ...harness, verifiedIdentity: null }).effort).toBeNull();
	});
});
