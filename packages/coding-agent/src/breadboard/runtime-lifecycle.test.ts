import { describe, expect, test } from "bun:test";
import {
	REPLAY_RETENTION_MAX_AGE_MS,
	REPLAY_RETENTION_MAX_EVENTS,
	type ReplayContractDigest,
	type SessionId,
	type SessionSnapshot,
} from "@breadboard/sdk/internal";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { prepareConnectedBreadboardRuntime } from "../main";
import type { E4AgentStreamBridgeOptions } from "./e4-agent-stream";
import { createLifecycleMonitor } from "./engine-port";
import { lifecycleState } from "./lifecycle/lifecycle-state";
import type { ProviderAuthPort } from "./provider-auth-port";
import type { BreadboardSessionBindingStore } from "./session-binding";
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
	options: { readonly sessionCloseError?: Error; readonly engineCloseError?: Error } = {},
): RuntimeHarness {
	const lifecycle: string[] = [];
	const targets: OpenSession[] = [];
	const monitor = createLifecycleMonitor();
	monitor.activateAuthority({
		mode: "local-owned",
		engineInstanceId: "engine-instance-1",
		engineBootId: "engine-boot-1",
		registrationId: "registration-1",
		registrationGeneration: 1,
		ownerGeneration: 1,
	});
	const session: OpenedSession = {
		sessionId: snapshot.sessionId,
		async snapshot() {
			return snapshot;
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
	const sessionTarget: OpenSession = { kind: "attach", sessionId: snapshot.sessionId };
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
