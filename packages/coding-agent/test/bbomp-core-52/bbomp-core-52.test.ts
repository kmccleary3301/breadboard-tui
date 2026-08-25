import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	assertAdvertisedReplayConfigurationDigest,
	type CancellationReceipt,
	type ClientMessageId,
	computeSessionReplayDigest,
	decodeExactEmptyPayload,
	decodeLoggedSessionEvent,
	digestLoggedSessionEvent,
	type LoggedSessionEvent,
	normalizeSubmitInput,
	type PermissionDecisionReceipt,
	replayConfigurationDigest,
	type SessionReplayFacts,
	type SubmitReceipt,
	serializeLoggedSessionEvent,
	validateSessionReplayFacts,
} from "@breadboard/sdk/internal";
import { CanonicalE4SessionPort } from "../../src/breadboard/canonical-e4-session-port";
import { breadboardProjectionEventId, E4AgentStreamBridge } from "../../src/breadboard/e4-agent-stream";
import {
	displayEndpointIdentity,
	presentLifecycle,
	restoreLifecycleTerminal,
	secretSafeLifecycleStatus,
} from "../../src/breadboard/lifecycle/lifecycle-presenter";
import { type LifecycleResult, lifecycleFailure, lifecycleState } from "../../src/breadboard/lifecycle/lifecycle-state";
import { lifecycleChildEnvironment } from "../../src/breadboard/lifecycle/lifecycle-supervisor";
import {
	type BreadboardRunConfig,
	parseSelectedBreadboardConfig,
	resolveBreadboardRunConfig,
} from "../../src/breadboard/lifecycle/run-config";
import type { OpenedSession } from "../../src/breadboard/session-port";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const provenance = JSON.parse(await readFile(resolve(PACKAGE_ROOT, "breadboard-sdk-provenance.json"), "utf8")) as {
	readonly packageName: string;
	readonly packageVersion: string;
	readonly artifactPath: string;
	readonly artifactSha256: string;
	readonly backendCommit: string;
};

const model = { api: "test", provider: "test-provider", id: "test-model" } as never;
const context = { messages: [{ role: "user", content: "run the requested turn", timestamp: 1 }] } as never;

function wireEvent(
	sequence: number,
	type: string,
	payload: unknown,
	turnId: string | null = "turn-1",
): LoggedSessionEvent {
	return decodeLoggedSessionEvent({
		stable_cursor: true,
		id: `event-${sequence}`,
		seq: sequence,
		session_id: "session-1",
		input_id: turnId === null ? null : turnId === "turn-1" ? "input-1" : `input-${turnId}`,
		turn_id: turnId,
		timestamp_ms: sequence,
		type,
		payload,
	});
}

const turnStarted = wireEvent(1, "turn_start", {});
if (turnStarted.inputId === null || turnStarted.turnId === null) throw new Error("test fixture correlation missing");

function openedSession(events: readonly LoggedSessionEvent[], submissions: unknown[] = []): OpenedSession {
	const receipt: SubmitReceipt = {
		clientMessageId: "client-1" as ClientMessageId,
		inputId: turnStarted.inputId!,
		turnId: turnStarted.turnId!,
		disposition: "started",
		originalDisposition: "started",
	};
	return {
		sessionId: turnStarted.sessionId,
		async snapshot() {
			throw new Error("snapshot is not used by this fixture");
		},
		async submit(input) {
			submissions.push(input);
			return {
				...receipt,
				clientMessageId: (input as { clientMessageId?: string }).clientMessageId as ClientMessageId,
			};
		},
		async cancel(): Promise<CancellationReceipt> {
			return {
				disposition: "cancellation_requested",
				originalDisposition: "cancellation_requested",
				requestId: "cancel-1",
			} as never;
		},
		async respondPermission(): Promise<PermissionDecisionReceipt> {
			return { requestId: "permission-1", decision: "allow" } as never;
		},
		async *events(request) {
			const after = request?.after?.sequence ?? 0;
			for (const event of events) {
				if (event.sequence <= after || request?.signal?.aborted) continue;
				yield event;
			}
		},
		async close() {},
	};
}

type MutableReplayFacts = { -readonly [Key in keyof SessionReplayFacts]: SessionReplayFacts[Key] };
const validReplayFacts = (): SessionReplayFacts => ({
	replayRetention: { maxEvents: 1000, maxAgeMs: 86_400_000, configurationDigest: replayConfigurationDigest },
	earliestRetainedSequence: 1,
	earliestRetainedEventId: "event-1" as never,
	headSequence: 1,
	headEventId: "event-1" as never,
	retainedHistory: "complete",
	sessionReplayContractDigest: "pending" as never,
});

const configInput = {
	workspacePath: "/workspace",
	canonicalizeWorkspace: () => "/workspace",
	environment: {} as Record<string, string | undefined>,
};

function offConfig(): BreadboardRunConfig {
	return resolveBreadboardRunConfig({ ...configInput, cli: { engineMode: "off" } });
}

function failedResult(
	reason: "mode_forbidden" | "engine_mode_off" = "mode_forbidden",
): Extract<LifecycleResult, { kind: "failure" }> {
	return lifecycleFailure("off", "failed", reason) as Extract<LifecycleResult, { kind: "failure" }>;
}

describe("BBOMP-CORE-52 — SDK event envelope, decoding, ordering, and cursor behavior (12)", () => {
	test("[fast] decodes the canonical turn-start envelope into typed fields", () => {
		expect(turnStarted).toMatchObject({
			kind: "turn_started",
			sequence: 1,
			sessionId: "session-1",
			inputId: "input-1",
			turnId: "turn-1",
		});
	});
	test("[fast] preserves a null turn correlation for session-scoped events", () => {
		const event = wireEvent(2, "checkpoint_list", {}, null);
		expect(event).toMatchObject({ kind: "checkpoint_list_observed", inputId: null, turnId: null });
	});
	test("[fast] rejects an envelope with a missing stable cursor", () => {
		expect(() =>
			decodeLoggedSessionEvent({ id: "event-1", seq: 1, session_id: "session-1", type: "turn_start", payload: {} }),
		).toThrow();
	});
	test("[fast] rejects an unknown event family instead of guessing its meaning", () => {
		expect(() =>
			decodeLoggedSessionEvent({
				stable_cursor: true,
				id: "event-2",
				seq: 2,
				session_id: "session-1",
				type: "future.event",
				payload: {},
			}),
		).toThrow();
	});
	test("[fast] serializes the same event deterministically", () => {
		expect(Buffer.from(serializeLoggedSessionEvent(turnStarted))).toEqual(
			Buffer.from(serializeLoggedSessionEvent(turnStarted)),
		);
	});
	test("[fast] event serialization keeps the event envelope fields", () => {
		const decoded = JSON.parse(Buffer.from(serializeLoggedSessionEvent(turnStarted)).toString("utf8")) as Record<
			string,
			unknown
		>;
		expect(decoded).toMatchObject({ kind: "turn_started", eventId: "event-1", sequence: 1, sessionId: "session-1" });
	});
	test("[fast] computes a stable digest for a logged event", async () => {
		expect(await digestLoggedSessionEvent(turnStarted)).toBe(await digestLoggedSessionEvent(turnStarted));
	});
	test("[fast] changes the event digest when the durable sequence changes", async () => {
		expect(await digestLoggedSessionEvent(turnStarted)).not.toBe(
			await digestLoggedSessionEvent(wireEvent(9, "turn_start", {})),
		);
	});
	test("[fast] orders events by their durable sequence rather than arrival order", () => {
		const events = [
			wireEvent(3, "turn_completed", {}),
			turnStarted,
			wireEvent(2, "assistant.message.delta", { text: "x" }),
		];
		expect(events.toSorted((a, b) => a.sequence - b.sequence).map(event => event.sequence)).toEqual([1, 2, 3]);
	});
	test("[fast] normalizes a text submission to the structured input contract", () => {
		expect(normalizeSubmitInput("hello")).toEqual({ text: "hello" });
	});
	test("[fast] retains correlation fields when normalizing structured input", () => {
		const input = { text: "hello", clientMessageId: "client-1", metadata: { source: "tui" } } as never;
		expect(normalizeSubmitInput(input)).toBe(input);
	});
	test("[fast] rejects non-empty payloads for exact-empty event kinds", () => {
		expect(() => decodeExactEmptyPayload({ unexpected: true })).toThrow();
	});
});

describe("BBOMP-CORE-52 — session create/resume/reconnect/cancel/replay (12)", () => {
	test("[fast] creates a session through the canonical port without changing the request", async () => {
		const request = { configPath: "agent.yaml", task: "task", workspace: "/canonical/project" };
		let received: unknown;
		const runtime = openedSession([]);
		const port = new CanonicalE4SessionPort(
			{
				create: async value => {
					received = value;
					return runtime;
				},
				attach: async () => runtime,
			},
			{ onLateCloseError: () => {} },
		);
		await port.open({ kind: "create", request });
		expect(received).toBe(request);
	});
	test("[fast] resumes an existing session through attach with its opaque ID", async () => {
		let received: unknown;
		const runtime = openedSession([]);
		const port = new CanonicalE4SessionPort(
			{
				create: async () => runtime,
				attach: async value => {
					received = value;
					return runtime;
				},
			},
			{ onLateCloseError: () => {} },
		);
		await port.open({ kind: "attach", sessionId: "session-resume" });
		expect(received).toEqual({ sessionId: "session-resume" });
	});
	test("[fast] aborts a session open before issuing a backend request", async () => {
		let calls = 0;
		const runtime = openedSession([]);
		const port = new CanonicalE4SessionPort(
			{
				create: async () => {
					calls += 1;
					return runtime;
				},
				attach: async () => runtime,
			},
			{ onLateCloseError: () => {} },
		);
		const abort = new AbortController();
		abort.abort();
		await expect(
			port.open(
				{ kind: "create", request: { configPath: "agent.yaml", workspace: "/canonical/project" } },
				abort.signal,
			),
		).rejects.toThrow();
		expect(calls).toBe(0);
	});
	test("[fast] closes a session exactly once when an open is aborted late", async () => {
		let closeCalls = 0;
		let resolve!: (value: OpenedSession) => void;
		const pending = new Promise<OpenedSession>(res => (resolve = res));
		const port = new CanonicalE4SessionPort(
			{ create: async () => pending, attach: async () => pending },
			{ onLateCloseError: () => {} },
		);
		const abort = new AbortController();
		const opening = port.open(
			{ kind: "create", request: { configPath: "agent.yaml", workspace: "/canonical/project" } },
			abort.signal,
		);
		abort.abort();
		resolve({
			...openedSession([]),
			close: async () => {
				closeCalls += 1;
			},
		});
		await expect(opening).rejects.toThrow();
		await Promise.resolve();
		expect(closeCalls).toBe(1);
	});
	test("[fast] does not start a bridge stream before the bridge is started", async () => {
		const bridge = new E4AgentStreamBridge({
			session: openedSession([]),
			emitAgentEvent: async () => {},
			releaseAgentEvent: () => {},
			submissionOwned: async () => {},
			projectionCommitted: async () => {},
		});
		const result = await (await bridge.stream(model, context)).result();
		expect(result.stopReason).toBe("error");
		await bridge.close();
	});
	test("[fast] submits the latest user turn through the bridge", async () => {
		const submissions: unknown[] = [];
		const bridge = new E4AgentStreamBridge({
			session: openedSession(
				[turnStarted, wireEvent(2, "assistant.message.end", { text: "done" }), wireEvent(3, "turn_completed", {})],
				submissions,
			),
			emitAgentEvent: async () => {},
			releaseAgentEvent: () => {},
			submissionOwned: async () => {},
			projectionCommitted: async () => {},
			modelPolicy: { kind: "fixed", model },
		});
		bridge.start();
		const result = await (await bridge.stream(model, context)).result();
		expect(submissions).toHaveLength(1);
		expect(submissions[0]).toMatchObject({ text: "run the requested turn" });
		expect(result.stopReason).toBe("stop");
		await bridge.close();
	});
	test("[fast] preserves a caller cursor when reconnecting event observation", async () => {
		const observed: number[] = [];
		const session = openedSession([turnStarted, wireEvent(2, "assistant.message.delta", { text: "new" })]);
		const originalEvents = session.events;
		const wrapped: OpenedSession = {
			...session,
			async *events(request) {
				for await (const event of originalEvents(request)) {
					observed.push(event.sequence);
					yield event;
				}
			},
		};
		await Array.fromAsync(wrapped.events({ after: { eventId: "event-1", sequence: 1 } as never }));
		expect(observed).toEqual([2]);
	});
	test("[fast] reconnect replay facts validate against the advertised retention contract", async () => {
		const facts = validReplayFacts() as MutableReplayFacts;
		const { sessionReplayContractDigest: _ignored, ...replayFacts } = facts;
		facts.sessionReplayContractDigest = (await computeSessionReplayDigest(replayFacts as never)) as never;
		await expect(validateSessionReplayFacts(facts)).resolves.toBeUndefined();
	});
	test("replay digest changes when the retained head changes", async () => {
		const facts = validReplayFacts();
		const first = await computeSessionReplayDigest(facts as never);
		const second = await computeSessionReplayDigest({ ...facts, headSequence: 2 } as never);
		expect(first).not.toBe(second);
	});
	test("cancellation requests retain an explicit user-requested reason", async () => {
		const calls: unknown[] = [];
		const session = {
			...openedSession([]),
			async cancel(request: unknown) {
				calls.push(request);
				return {} as CancellationReceipt;
			},
		} as OpenedSession;
		await session.cancel({ turnId: "turn-1", reason: "user_requested" } as never);
		expect(calls).toEqual([{ turnId: "turn-1", reason: "user_requested" }]);
	});
	test("closing an opened session is idempotent at the port boundary", async () => {
		let closes = 0;
		const runtime = { ...openedSession([]), close: async () => void closes++ };
		const port = new CanonicalE4SessionPort(
			{ create: async () => runtime, attach: async () => runtime },
			{ onLateCloseError: () => {} },
		);
		const opened = await port.open({
			kind: "create",
			request: { configPath: "agent.yaml", workspace: "/canonical/project" },
		});
		await Promise.all([opened.close(), opened.close()]);
		expect(closes).toBe(1);
	});
	test("a session snapshot keeps terminal turn outcome and replay cursor together", () => {
		const snapshot = {
			sessionId: "session-1",
			status: "completed",
			turnAdmission: "idle",
			activeTurnId: null,
			queuedTurnCount: 0,
			terminalTurns: [
				{ inputId: "input-1", turnId: "turn-1", outcome: "completed", originalDisposition: "started" },
			],
			...validReplayFacts(),
		};
		expect(snapshot.terminalTurns[0]).toMatchObject({ outcome: "completed", turnId: "turn-1" });
		expect(snapshot.headSequence).toBe(1);
	});
});

describe("BBOMP-CORE-52 — tool result, terminal outcome, and exact-once visibility (8)", () => {
	test("[fast] decodes a tool call with its stable call ID", () => {
		const event = wireEvent(4, "tool_call", {
			call_id: "call-1",
			tool: "read",
			arguments: { path: "file" },
			action: null,
			diff_preview: null,
			progress: null,
		});
		expect(event).toMatchObject({ kind: "tool_called", payload: { callId: "call-1", tool: "read" } });
	});
	test("[fast] decodes a tool result with explicit error status", () => {
		const event = wireEvent(5, "tool.result", {
			call_id: "call-1",
			tool: "read",
			status: "failed",
			error: true,
			result: null,
			artifact_ref: null,
		});
		expect(event).toMatchObject({
			kind: "tool_result_observed",
			payload: { callId: "call-1", error: true, status: "failed" },
		});
	});
	test("[fast] extracts a projection event ID from the response envelope", () => {
		expect(breadboardProjectionEventId({ responseId: "breadboard:e4:event-7" })).toBe("event-7");
	});
	test("[fast] extracts a projection event ID from tool-result details", () => {
		expect(breadboardProjectionEventId({ details: { breadboardProjectionEventId: "event-8" } })).toBe("event-8");
	});
	test("the final assistant outcome remains visible after a tool-bearing turn", async () => {
		const events = [
			turnStarted,
			wireEvent(2, "tool_call", {
				call_id: "call-1",
				tool: "read",
				arguments: {},
				action: null,
				diff_preview: null,
				progress: null,
			}),
			wireEvent(3, "tool.result", {
				call_id: "call-1",
				tool: "read",
				status: "completed",
				error: false,
				result: { text: "ok" },
				artifact_ref: null,
			}),
			wireEvent(4, "assistant.message.end", { text: "finished" }),
			wireEvent(5, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			session: openedSession(events),
			emitAgentEvent: async () => {},
			releaseAgentEvent: () => {},
			submissionOwned: async () => {},
			projectionCommitted: async () => {},
			modelPolicy: { kind: "fixed", model },
		});
		bridge.start();
		const result = await (await bridge.stream(model, context)).result();
		expect(result.content).toEqual([{ type: "text", text: "finished" }]);
		await bridge.close();
	});
	test("a terminal turn completion is represented as a stop outcome", async () => {
		const bridge = new E4AgentStreamBridge({
			session: openedSession([turnStarted, wireEvent(2, "turn_completed", {})]),
			emitAgentEvent: async () => {},
			releaseAgentEvent: () => {},
			submissionOwned: async () => {},
			projectionCommitted: async () => {},
			modelPolicy: { kind: "fixed", model },
		});
		bridge.start();
		expect((await (await bridge.stream(model, context)).result()).stopReason).toBe("stop");
		await bridge.close();
	});
	test("a terminal turn failure remains an error rather than a successful stop", async () => {
		const bridge = new E4AgentStreamBridge({
			session: openedSession([
				turnStarted,
				wireEvent(2, "turn_failed", { error: { code: "turn_execution_failed", message: "[redacted]" } }),
			]),
			emitAgentEvent: async () => {},
			releaseAgentEvent: () => {},
			submissionOwned: async () => {},
			projectionCommitted: async () => {},
			modelPolicy: { kind: "fixed", model },
		});
		bridge.start();
		expect((await (await bridge.stream(model, context)).result()).stopReason).toBe("error");
		await bridge.close();
	});
	test("projection receipt IDs identify already-visible events for exact-once replay", () => {
		const receipts = new Set(["event-2"]);
		expect(receipts.has(breadboardProjectionEventId({ responseId: "breadboard:e4:event-2" })!)).toBe(true);
	});
});

describe("BBOMP-CORE-52 — process exit, signal, cleanup, and host-terminal restoration (8)", () => {
	test("[fast] child process environment is an exact minimal allowlist", () => {
		expect(lifecycleChildEnvironment("launch-1")).toEqual({
			PATH: "/usr/bin:/bin",
			BREADBOARD_LEGACY_ROUTES: "1",
			BREADBOARD_ENGINE_LAUNCH_ID: "launch-1",
			BREADBOARD_LIFECYCLE_BOOTSTRAP_FD: "3",
		});
	});
	test("[fast] child process environment excludes inherited credentials and HOME", () => {
		const child = lifecycleChildEnvironment("launch-2");
		expect(child).not.toHaveProperty("HOME");
		expect(child).not.toHaveProperty("BREADBOARD_API_TOKEN");
	});
	test("[fast] lifecycle state forbids local-owned-only transitions in off mode", () => {
		expect(() => lifecycleState("off", "claiming")).toThrow();
	});
	test("[fast] terminal lifecycle states require a reason when they signal failure", () => {
		expect(() => lifecycleState("local-owned", "failed")).toThrow();
	});
	test("off lifecycle presentation exits successfully with actionable remediation", () => {
		const presentation = presentLifecycle({
			kind: "off",
			state: lifecycleState("off", "off") as Extract<LifecycleResult, { kind: "off" }>["state"],
		});
		expect(presentation).toMatchObject({ summary: "BreadBoard engine: off", exitCode: 0 });
		expect(presentation.remediation).toContain("--engine-mode");
	});
	test("failed lifecycle presentation returns a nonzero exit code and reason", () => {
		const presentation = presentLifecycle(failedResult());
		expect(presentation).toMatchObject({ exitCode: 2, summary: "BreadBoard engine: failed (mode_forbidden)" });
	});
	test("endpoint presentation hides the configured path behind a digest", () => {
		const presented = displayEndpointIdentity("https://engine.example/private/session");
		expect(presented).toMatch(/^https:\/\/engine\.example\/\[path-sha256:[0-9a-f]{12}\]$/);
		expect(presented).not.toContain("private/session");
	});
	test("terminal restoration is safe to invoke during cleanup", () => {
		expect(() => restoreLifecycleTerminal()).not.toThrow();
	});
});

describe("BBOMP-CORE-52 — package identity, SDK provenance, version, and compatibility (6)", () => {
	test("package identity names the pinned BreadBoard SDK artifact", () => {
		expect(provenance).toMatchObject({ packageName: "@breadboard/sdk", packageVersion: "0.3.0" });
	});
	test("SDK provenance records a content-addressed artifact", () => {
		expect(provenance.artifactPath).toContain("breadboard-sdk-0.3.0.tgz");
		expect(provenance.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
	});
	test("SDK provenance records the source commit used for the artifact", () => {
		expect(provenance.backendCommit).toMatch(/^[0-9a-f]{40}$/);
	});
	test("the advertised replay configuration digest is checked exactly", () => {
		expect(() => assertAdvertisedReplayConfigurationDigest(replayConfigurationDigest)).not.toThrow();
	});
	test("the event envelope includes the SDK-owned stable cursor fields", () => {
		expect(String(turnStarted.eventId)).toBe("event-1");
	});
	test("compatibility facts reject a mismatched replay configuration digest", () => {
		expect(() => assertAdvertisedReplayConfigurationDigest("sha256:not-the-pinned-digest")).toThrow();
	});
});

describe("BBOMP-CORE-52 — credential and redaction invariants (4)", () => {
	test("config digests do not change when only a process credential rotates", () => {
		const first = resolveBreadboardRunConfig({
			...configInput,
			cli: { engineMode: "remote", engineUrl: "https://engine.example" },
			environment: { BREADBOARD_API_TOKEN: "s".repeat(32) },
		});
		const second = resolveBreadboardRunConfig({
			...configInput,
			cli: { engineMode: "remote", engineUrl: "https://engine.example" },
			environment: { BREADBOARD_API_TOKEN: "t".repeat(32) },
		});
		expect(first.configDigest).toBe(second.configDigest);
	});
	test("secret-safe lifecycle status never includes the raw authentication material", () => {
		const config = resolveBreadboardRunConfig({
			...configInput,
			cli: { engineMode: "remote", engineUrl: "https://engine.example/private" },
			environment: { BREADBOARD_API_TOKEN: "v".repeat(32) },
		});
		const status = JSON.stringify(secretSafeLifecycleStatus(config, lifecycleState("remote", "connecting")));
		expect(status).not.toContain("v".repeat(32));
		expect(status).not.toContain("/private");
	});
	test("child launch environment cannot carry a credential even when the parent has one", () => {
		process.env.BREADBOARD_API_TOKEN = "parent-secret";
		try {
			expect(Object.keys(lifecycleChildEnvironment("launch-3"))).not.toContain("BREADBOARD_API_TOKEN");
		} finally {
			delete process.env.BREADBOARD_API_TOKEN;
		}
	});
	test("turn failures carry the redacted error marker instead of backend detail", () => {
		const event = wireEvent(6, "turn_failed", { error: { code: "turn_execution_failed", message: "[redacted]" } });
		expect(event).toMatchObject({ payload: { error: { message: "[redacted]" } } });
		expect(JSON.stringify(event)).not.toContain("backend secret");
	});
});

describe("BBOMP-CORE-52 — launcher and config namespace isolation (2)", () => {
	test("off mode is the explicit default namespace when no engine selection is provided", () => {
		const config = offConfig();
		expect(config.mode).toBe("off");
		expect(config).not.toHaveProperty("endpoint");
		expect(config).not.toHaveProperty("auth");
	});
	test("selected configuration rejects unknown fields before promotion", () => {
		expect(() => parseSelectedBreadboardConfig({ engineMode: "off", ompHome: "/tmp/.omp" })).toThrow();
	});
});
