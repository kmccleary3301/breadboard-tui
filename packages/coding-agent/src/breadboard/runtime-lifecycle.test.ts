import { describe, expect, test } from "bun:test";
import {
	type EventId,
	type InputId,
	REPLAY_RETENTION_MAX_AGE_MS,
	REPLAY_RETENTION_MAX_EVENTS,
	type ReplayContractDigest,
	type SessionId,
	type SessionSnapshot,
	type TurnId,
} from "@breadboard/sdk/session";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	createRecoverableBreadboardRuntime,
	type PreparedBreadboardRuntime,
	prepareConnectedBreadboardRuntime,
	resolveBreadboardCatalogModels,
} from "./runtime";
import type { E4AgentStreamBridgeOptions } from "./e4-agent-stream";
import { createLifecycleMonitor } from "./engine-port";
import { lifecycleState } from "./lifecycle/lifecycle-state";
import type { ProviderAuthPort } from "./provider-auth-port";
import {
	BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
	type BreadboardSessionBindingData,
	type BreadboardSessionBindingStore,
} from "./session-binding";
import type { OpenedSession, OpenSession } from "./session-port";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("bundled test model missing");

const replayDigest = "sha256:runtime-lifecycle-test" as ReplayContractDigest;
const snapshot: SessionSnapshot = {
	sessionId: "session-1" as SessionId,
	status: "running",
	createdAt: "2026-08-28T00:00:00.000Z",
	lastActivityAt: "2026-08-28T00:00:01.000Z",
	model: `${model.provider}/${model.id}`,
	mode: null,
	turnAdmission: "idle",
	activeTurnId: null,
	queuedTurnCount: 0,
	terminalTurns: [],
	replayRetention: {
		maxEvents: REPLAY_RETENTION_MAX_EVENTS,
		maxAgeMs: REPLAY_RETENTION_MAX_AGE_MS,
		configurationDigest: replayDigest,
	},
	earliestRetainedSequence: null,
	earliestRetainedEventId: null,
	headSequence: 0,
	headEventId: null,
	retainedHistory: "complete",
	sessionReplayContractDigest: replayDigest,
};

const providerAuth: ProviderAuthPort = {
	async listProviders() {
		return [];
	},
	async listCredentials() {
		return [];
	},
	async beginLogin() {
		throw new Error("provider auth not used");
	},
	async getLogin() {
		throw new Error("provider auth not used");
	},
	async completeLogin() {
		throw new Error("provider auth not used");
	},
	async cancelLogin() {
		throw new Error("provider auth not used");
	},
	async putApiKey() {
		throw new Error("provider auth not used");
	},
	async logout() {
		throw new Error("provider auth not used");
	},
	async revoke() {
		throw new Error("provider auth not used");
	},
};

const inertStream: StreamFn = () => new AssistantMessageEventStream();

interface RuntimeHarness {
	readonly lifecycle: string[];
	readonly monitor: ReturnType<typeof createLifecycleMonitor>;
	readonly sessionTarget: OpenSession;
	readonly bridgeOptions: () => E4AgentStreamBridgeOptions;
	prepare(): ReturnType<typeof prepareConnectedBreadboardRuntime>;
}

function runtimeHarness(
	options: {
		readonly sessionCloseError?: Error;
		readonly engineCloseError?: Error;
		readonly snapshot?: SessionSnapshot;
		readonly sessionBinding?: BreadboardSessionBindingData;
		readonly allowTerminalSnapshotRecovery?: boolean;
	} = {},
): RuntimeHarness {
	const lifecycle: string[] = [];
	const targets: OpenSession[] = [];
	const monitor = createLifecycleMonitor();
	const activeSnapshot = options.snapshot ?? snapshot;
	monitor.activateAuthority({
		mode: "local-owned",
		engineInstanceId: "engine-instance-1",
		engineBootId: "engine-boot-1",
		registrationId: "registration-1",
		registrationGeneration: 1,
		ownerGeneration: 1,
	});
	const session: OpenedSession = {
		sessionId: activeSnapshot.sessionId,
		async snapshot() {
			return activeSnapshot;
		},
		async submit() {
			throw new Error("submit not used");
		},
		async cancel() {
			throw new Error("cancel not used");
		},
		async respondPermission() {
			throw new Error("permission not used");
		},
		async *events() {},
		async close() {
			lifecycle.push("session");
			if (options.sessionCloseError) throw options.sessionCloseError;
		},
	};
	let capturedBridgeOptions: E4AgentStreamBridgeOptions | undefined;
	const sessionTarget: OpenSession = { kind: "attach", sessionId: activeSnapshot.sessionId };
	return {
		lifecycle,
		monitor,
		sessionTarget,
		bridgeOptions: () => {
			if (!capturedBridgeOptions) throw new Error("bridge options not captured");
			return capturedBridgeOptions;
		},
		prepare: () =>
			prepareConnectedBreadboardRuntime({
				engine: {
					lifecycleFailure: monitor.signal,
					async getModelCatalog(configPath) {
						return {
							models: [
								{
									id: `${model.provider}/${model.id}`,
									provider: model.provider,
									canonical_provider: model.provider,
									support_tier: "core" as const,
									available: true,
									availability_reason: null,
									discovery: "configured_only" as const,
									source: "configured" as const,
								},
							],
							default_model: `${model.provider}/${model.id}`,
							config_path: configPath,
							discovery_policy: "configured_only" as const,
							issues: [],
						};
					},
					async setSessionModel() {
						throw new Error("model selection not used");
					},
					providerAuth,
					async openSession(target) {
						targets.push(target);
						return session;
					},
					async close() {
						lifecycle.push("engine");
						if (options.engineCloseError) throw options.engineCloseError;
					},
				},
				sessionTarget,
				sessionBinding: options.sessionBinding,
				allowTerminalSnapshotRecovery: options.allowTerminalSnapshotRecovery,
				modelRegistry: { getAll: () => [model] },
				async requestPermission() {
					return "deny";
				},
				async emitAgentEvent() {},
				releaseAgentEvent() {},
				registerCleanup: () => () => {},
				createBridge(bridgeOptions) {
					capturedBridgeOptions = bridgeOptions;
					return {
						stream: inertStream,
						start() {},
						async close() {
							lifecycle.push("bridge");
							await session.close();
						},
					};
				},
			}).then(runtime => {
				expect(targets).toEqual([sessionTarget]);
				return runtime;
			}),
	};
}

test("projects configured evidence routes into the public session model scope", () => {
	const models = resolveBreadboardCatalogModels(
		{
			models: ["mock/reference", "cli_mock/reference"].map(id => {
				const provider = id.split("/", 1)[0];
				return {
					id,
					provider,
					canonical_provider: provider,
					support_tier: "evidence" as const,
					available: true,
					availability_reason: null,
					discovery: "configured_only" as const,
					source: "configured" as const,
				};
			}),
			default_model: "mock/reference",
			config_path: "agent_configs/templates/daily_driver.v1.yaml",
			discovery_policy: "configured_only",
			issues: [],
		},
		{ getAll: () => [] },
	);

	expect(models.map(candidate => `${candidate.provider}/${candidate.id}`)).toEqual([
		"mock/reference",
		"cli_mock/reference",
	]);
	expect(models.every(candidate => candidate.baseUrl === "http://127.0.0.1:9/v1")).toBeTrue();
});
describe("connected BreadBoard runtime lifecycle", () => {
	test("invalidates one old runtime on authority replacement and requires an explicit fresh attach", async () => {
		const oldHarness = runtimeHarness();
		const oldRuntime = await oldHarness.prepare();
		oldHarness.monitor.stateChanged(lifecycleState("local-owned", "reconnecting", 1));
		expect(oldHarness.lifecycle).toEqual([]);
		oldHarness.monitor.stateChanged(lifecycleState("local-owned", "backing-off", 1));
		await oldRuntime.close();
		oldHarness.monitor.stateChanged(lifecycleState("local-owned", "ready", 1));
		await oldRuntime.close();
		expect(oldHarness.lifecycle).toEqual(["bridge", "session", "engine"]);

		const freshHarness = runtimeHarness();
		const freshRuntime = await freshHarness.prepare();
		expect(freshRuntime.sessionId).toBe(oldRuntime.sessionId);
		expect(freshHarness.lifecycle).toEqual([]);
		await freshRuntime.close();
		expect(freshHarness.lifecycle).toEqual(["bridge", "session", "engine"]);
	});

	test("advances a fully terminal retained snapshot before opening the fresh SDK stream", async () => {
		const inputId = "input-1" as InputId;
		const turnId = "turn-1" as TurnId;
		const interruptedSubmission: BreadboardSessionBindingData["ownedSubmissions"][number] = {
			clientMessageId: "client-1",
			inputId,
			turnId,
		};
		const interruptedBinding: BreadboardSessionBindingData = {
			schemaVersion: "breadboard.session-binding.v3",
			sessionId: snapshot.sessionId,
			replayConfigurationDigest: replayDigest,
			cursor: { eventId: "event-4" as EventId, sequence: 4 },
			ownedSubmissions: [interruptedSubmission],
		};
		const harness = runtimeHarness({
			snapshot: {
				...snapshot,
				headSequence: 5,
				headEventId: "event-5" as EventId,
				earliestRetainedSequence: 1,
				earliestRetainedEventId: "event-1" as EventId,
				retainedHistory: "partial",
				terminalTurns: [
					{
						inputId,
						turnId,
						outcome: "failed",
						originalDisposition: "started",
					},
				],
			},
			sessionBinding: interruptedBinding,
			allowTerminalSnapshotRecovery: true,
		});
		const runtime = await harness.prepare();
		expect(harness.bridgeOptions().durableCursor).toEqual({
			eventId: "event-5",
			sequence: 5,
		});
		const branch: Array<{ type: string; customType?: string; data?: unknown }> = [
			{
				type: "custom",
				customType: BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
				data: interruptedBinding,
			},
		];
		const store: BreadboardSessionBindingStore = {
			getBranch: () => branch,
			appendCustomEntry(customType, data) {
				branch.push({ type: "custom", customType, data });
			},
			async flush() {},
		};
		await runtime.activate(store);
		expect(branch.at(-1)?.data).toMatchObject({
			cursor: { eventId: "event-5", sequence: 5 },
		});
		await runtime.close();
	});

	test("reattaches one unchanged turn through a fresh runtime generation", async () => {
		const oldMonitor = createLifecycleMonitor();
		oldMonitor.activateAuthority({
			mode: "local-owned",
			engineInstanceId: "engine-instance-old",
			engineBootId: "engine-boot-old",
			registrationId: "registration-old",
			registrationGeneration: 1,
			ownerGeneration: 1,
		});
		const freshMonitor = createLifecycleMonitor();
		freshMonitor.activateAuthority({
			mode: "local-owned",
			engineInstanceId: "engine-instance-fresh",
			engineBootId: "engine-boot-fresh",
			registrationId: "registration-fresh",
			registrationGeneration: 1,
			ownerGeneration: 1,
		});
		const oldStream = new AssistantMessageEventStream();
		const freshStream = new AssistantMessageEventStream();
		const calls: string[] = [];
		let registeredCleanup: (() => Promise<void>) | undefined;
		const prepared = (label: string, stream: StreamFn): PreparedBreadboardRuntime => ({
			providerAuth,
			stream,
			sessionId: snapshot.sessionId,
			model,
			models: [model],
			async activate() {
				calls.push(`${label}:activate`);
			},
			start() {
				calls.push(`${label}:start`);
			},
			async close() {
				calls.push(`${label}:close`);
			},
		});
		const oldRuntime = prepared("old", () => oldStream);
		const freshRuntime = prepared("fresh", () => freshStream);
		const branch: Array<{ type: string; customType?: string; data?: unknown }> = [
			{
				type: "custom",
				customType: BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
				data: {
					schemaVersion: "breadboard.session-binding.v3",
					sessionId: snapshot.sessionId,
					replayConfigurationDigest: replayDigest,
					cursor: { eventId: null, sequence: 0 },
					ownedSubmissions: [],
				},
			},
		];
		const store: BreadboardSessionBindingStore = {
			getBranch: () => branch,
			appendCustomEntry(customType, data) {
				branch.push({ type: "custom", customType, data });
			},
			async flush() {},
		};
		const runtime = createRecoverableBreadboardRuntime(
			{ runtime: oldRuntime, lifecycleFailure: oldMonitor.signal },
			async (sessionId, binding) => {
				expect(sessionId).toBe(snapshot.sessionId);
				expect(binding.sessionId).toBe(snapshot.sessionId);
				calls.push("reconnect");
				return { runtime: freshRuntime, lifecycleFailure: freshMonitor.signal };
			},
			cleanup => {
				calls.push("register");
				registeredCleanup = cleanup;
				return () => calls.push("unregister");
			},
		);
		await runtime.activate(store);
		runtime.start();
		const output = await runtime.stream(model, { messages: [] });
		oldMonitor.stateChanged(lifecycleState("local-owned", "backing-off", 1));
		oldStream.push({
			type: "error",
			reason: "aborted",
			error: {
				role: "assistant",
				content: [],
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
				stopReason: "aborted",
				errorMessage: "BreadBoard session closed",
				timestamp: 1,
			},
		});
		expect((await output.result()).errorMessage).toBe("BreadBoard session closed");
		expect(calls).toEqual([
			"register",
			"old:activate",
			"old:start",
			"old:close",
			"reconnect",
			"fresh:activate",
			"fresh:start",
		]);
		const nextOutput = await runtime.stream(model, { messages: [] });
		freshStream.fail(new Error("fresh generation failed"));
		await expect(nextOutput.result()).rejects.toThrow("fresh generation failed");
		if (!registeredCleanup) throw new Error("recoverable cleanup was not registered");
		await registeredCleanup();
		expect(calls.slice(-2)).toEqual(["unregister", "fresh:close"]);
	});

	test("keeps a binding flush failure primary while cleanup reports late close failures", async () => {
		const flushFailure = new Error("binding flush failed");
		const harness = runtimeHarness({
			sessionCloseError: new Error("late session close failed"),
			engineCloseError: new Error("engine close failed"),
		});
		const runtime = await harness.prepare();
		const store: BreadboardSessionBindingStore = {
			getBranch: () => [],
			appendCustomEntry() {
				harness.lifecycle.push("append");
			},
			async flush() {
				harness.lifecycle.push("flush");
				throw flushFailure;
			},
		};
		await expect(runtime.activate(store)).rejects.toBe(flushFailure);
		expect(harness.lifecycle).toEqual(["append", "flush", "bridge", "session", "engine"]);
	});

	test("serializes binding updates and continues after a failed durable flush", async () => {
		const harness = runtimeHarness();
		const runtime = await harness.prepare();
		const flushFailure = new Error("ownership flush failed");
		let flushCount = 0;
		const entries: unknown[] = [];
		const store: BreadboardSessionBindingStore = {
			getBranch: () => [],
			appendCustomEntry(_customType, data) {
				entries.push(data);
			},
			async flush() {
				flushCount++;
				if (flushCount === 2) throw flushFailure;
			},
		};
		await runtime.activate(store);
		const bridge = harness.bridgeOptions();
		await expect(
			bridge.submissionOwned({ clientMessageId: "client-1", inputId: "input-1", turnId: "turn-1" }),
		).rejects.toBe(flushFailure);
		await bridge.projectionCommitted({ eventId: "event-1", sequence: 1 }, []);
		expect(flushCount).toBe(3);
		expect(entries).toHaveLength(3);
		await runtime.close();
	});
});
