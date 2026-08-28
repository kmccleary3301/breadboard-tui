import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	CancellationReceipt,
	ClientMessageId,
	LoggedSessionEvent,
	PermissionDecisionReceipt,
	StructuredSubmit,
	SubmitInput,
	SubmitReceipt,
} from "@breadboard/sdk/internal";
import { CanonicalE4ClientError, decodeLoggedSessionEvent, LifecycleE4ClientError } from "@breadboard/sdk/internal";
import { Agent, type AgentEvent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { collectPendingToolCalls } from "../session/exit-diagnostics";
import { convertToLlm } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { E4AgentStreamBridge, type E4BackendModelAttribution } from "./e4-agent-stream";
import type { OpenedSession } from "./session-port";

const normalizePersistedMessage = <T>(message: T): T =>
	JSON.parse(JSON.stringify(message, (key, value) => (key === "errorId" && value === 0 ? undefined : value))) as T;

const ZERO_COMPLETION_PAYLOAD = {
	finish_reason: "stop",
	raw_provider_finish: null,
	output_emitted: true,
	usage: {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
	},
};

const wireEvent = (
	sequence: number,
	type: string,
	payload: unknown,
	turnId: string | null = "turn-1",
): LoggedSessionEvent => {
	const normalizedPayload =
		type === "turn_completed" &&
		payload !== null &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		Object.keys(payload).length === 0
			? ZERO_COMPLETION_PAYLOAD
			: payload;
	return decodeLoggedSessionEvent({
		stable_cursor: true,
		id: `event-${sequence}`,
		seq: sequence,
		session_id: "session-1",
		input_id: turnId === null ? null : turnId === "turn-1" ? "input-1" : `input-${turnId.replace(/^turn-/, "")}`,
		turn_id: turnId,
		timestamp_ms: sequence,
		type,
		payload: normalizedPayload,
	});
};

const started = wireEvent(2, "turn_start", {});
if (started.inputId === null || started.turnId === null) throw new Error("fixture correlation missing");

const receipt: SubmitReceipt = {
	clientMessageId: String(started.eventId) as ClientMessageId,
	inputId: started.inputId,
	turnId: started.turnId,
	disposition: "started",
	originalDisposition: "started",
};
const ownedReceipt = {
	clientMessageId: String(receipt.clientMessageId),
	inputId: String(receipt.inputId),
	turnId: String(receipt.turnId),
};

function openedSession(events: readonly LoggedSessionEvent[], submitted: SubmitInput[]): OpenedSession {
	return {
		sessionId: started.sessionId,
		async snapshot() {
			throw new Error("snapshot not used by stream bridge");
		},
		async submit(input) {
			submitted.push(input);
			return receipt;
		},
		async cancel(): Promise<CancellationReceipt> {
			throw new Error("cancel not expected");
		},
		async respondPermission(): Promise<PermissionDecisionReceipt> {
			throw new Error("permission response not expected");
		},
		async *events(request) {
			let highestSequence = request?.after?.sequence ?? 0;
			for (const event of events) {
				if (event.sequence <= highestSequence) continue;
				await Bun.sleep(0);
				if (request?.signal?.aborted) return;
				yield event;
				highestSequence = event.sequence;
			}
		},
		async close() {},
	};
}

function startBridgeStream(bridge: E4AgentStreamBridge, ...args: Parameters<StreamFn>) {
	bridge.start();
	return bridge.stream(...args);
}

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("bundled test model missing");

const context: Context = {
	messages: [
		{ role: "user", content: "older", timestamp: 1 },
		{
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
			stopReason: "stop",
			timestamp: 2,
		},
		{ role: "user", content: "new prompt", timestamp: 3 },
	],
};

function permissionSession(
	responded: Array<Parameters<OpenedSession["respondPermission"]>[0]>,
	cancelled: Array<Parameters<OpenedSession["cancel"]>[0]>,
	respondError?: Error,
): {
	readonly session: OpenedSession;
	readonly permissionObserved: Promise<void>;
	readonly actionObserved: Promise<void>;
} {
	const resumeEvents = Promise.withResolvers<void>();
	const permissionObserved = Promise.withResolvers<void>();
	const actionObserved = Promise.withResolvers<void>();
	return {
		permissionObserved: permissionObserved.promise,
		actionObserved: actionObserved.promise,
		session: {
			...openedSession([], []),
			async cancel(request) {
				cancelled.push(request);
				actionObserved.resolve();
				await resumeEvents.promise;
				return {} as CancellationReceipt;
			},
			async respondPermission(request) {
				responded.push(request);
				actionObserved.resolve();
				if (respondError) throw respondError;
				resumeEvents.resolve();
				return {
					requestId: request.requestId as PermissionDecisionReceipt["requestId"],
					decision: request.decision,
				};
			},
			async *events(request) {
				yield started;
				yield wireEvent(3, "assistant.message.delta", { text: "partial output" });
				yield wireEvent(4, "permission_request", {
					request_id: "permission-1",
					tool: "edit",
					kind: "write",
					summary: "Update the requested file",
					default_scope: null,
					rewindable: true,
				});
				permissionObserved.resolve();
				await Promise.race([
					resumeEvents.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield wireEvent(5, "assistant.message.delta", { text: "permission handled" });
				yield wireEvent(6, "turn_completed", {});
			},
		},
	};
}

describe("E4AgentStreamBridge", () => {
	test("submits the latest user turn and projects canonical text into the native stream", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const events = [
			started,
			wireEvent(3, "assistant.message.delta", { text: "hello " }),
			wireEvent(4, "assistant.message.delta", { text: "world" }),
			wireEvent(5, "assistant.message.end", { text: "hello world" }),
			wireEvent(6, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, submitted),
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			emitAgentEvent: async event => {
				agentEvents.push(event);
			},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toMatchObject({ text: "new prompt" });
		expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
		expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(result.provider).toBe(model.provider);
		expect(agentEvents).toEqual([]);
		await bridge.close();
	});

	test("projects the canonical provider finish reason and exact usage", async () => {
		const submitted: SubmitInput[] = [];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(
				[
					started,
					wireEvent(3, "assistant.message.end", { text: "bounded" }),
					wireEvent(4, "turn_completed", {
						finish_reason: "length",
						raw_provider_finish: "max_tokens",
						output_emitted: true,
						usage: {
							inputTokens: 11,
							outputTokens: 7,
							cacheReadTokens: 3,
							cacheWriteTokens: 2,
							totalTokens: 23,
							reasoningTokens: 4,
						},
					}),
				],
				submitted,
			),
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});

		const result = await (await startBridgeStream(bridge, model, context)).result();

		expect(result.stopReason).toBe("length");
		expect(result.responseId).toBe("breadboard:e4:event-4");
		expect(result.usage).toEqual({
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 23,
			reasoningTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		await bridge.close();
	});

	test("fails closed when canonical completion usage is unknown", async () => {
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(
				[started, wireEvent(3, "turn_completed", { finish_reason: "stop", output_emitted: false })],
				[],
			),
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});

		const result = await (await startBridgeStream(bridge, model, context)).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("BreadBoard turn completion omitted exact provider usage");
		await bridge.close();
	});

	test("projects reasoning and tool-call deltas without delegating backend tools to OMP", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const events = [
			started,
			wireEvent(3, "assistant.message.start", { message_id: "message-1" }),
			wireEvent(4, "assistant.reasoning.delta", { text: "Inspecting." }),
			wireEvent(5, "assistant.message.delta", { text: "Calling read." }),
			wireEvent(6, "assistant.message.end", { text: "Calling read." }),
			wireEvent(7, "assistant.tool_call.start", { index: 0, call_id: "call-1", tool: "read" }),
			wireEvent(8, "assistant.tool_call.delta", {
				index: 0,
				call_id: "call-1",
				tool: "read",
				arguments_delta: '{"path":',
			}),
			wireEvent(9, "assistant.tool_call.delta", {
				index: 0,
				call_id: "call-1",
				tool: "read",
				arguments_delta: '"README.md"}',
			}),
			wireEvent(10, "assistant.tool_call.end", {
				index: 0,
				call_id: "call-1",
				tool: "read",
				arguments: '{"path":"README.md"}',
			}),
			wireEvent(11, "tool_call", {
				call_id: "call-1",
				tool: "read",
				arguments: { path: "README.md" },
				action: null,
				diff_preview: null,
				progress: null,
			}),
			wireEvent(12, "tool.result", {
				call_id: "call-1",
				tool: "read",
				status: "completed",
				error: false,
				result: { text: "contents" },
				artifact_ref: null,
			}),
			wireEvent(13, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, submitted),
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			emitAgentEvent: async event => {
				agentEvents.push(event);
			},
			modelPolicy: { kind: "fixed", model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(result.content).toEqual([]);
		const updates = agentEvents.filter(
			(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
		);
		expect(updates.map(event => event.assistantMessageEvent.type)).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
		]);
		const toolCallMessages = agentEvents.filter(
			event =>
				event.type === "message_start" &&
				event.message.role === "assistant" &&
				event.message.content.some(block => block.type === "toolCall"),
		);
		expect(toolCallMessages).toHaveLength(1);
		expect(agentEvents.filter(event => event.type === "tool_execution_start")).toHaveLength(1);
		expect(agentEvents.filter(event => event.type === "tool_execution_end")).toHaveLength(1);
		await bridge.close();
	});

	test("uses repeated backend turn starts as completed assistant message boundaries", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(
				[
					started,
					wireEvent(3, "assistant.message.delta", { text: "first" }),
					wireEvent(4, "assistant.message.end", { text: "first" }),
					wireEvent(5, "turn_start", {}),
					wireEvent(6, "assistant.message.delta", { text: "second" }),
					wireEvent(7, "assistant.message.end", { text: "second" }),
					wireEvent(8, "turn_completed", {}),
				],
				submitted,
			),
			releaseAgentEvent() {},
			async projectionCommitted() {},
			emitAgentEvent: async event => {
				agentEvents.push(event);
			},
			modelPolicy: { kind: "fixed", model },
		});

		const result = await (await startBridgeStream(bridge, model, context)).result();
		const firstCompletion = agentEvents.find(event => event.type === "message_end");

		expect(
			firstCompletion?.type === "message_end" && firstCompletion.message.role === "assistant"
				? firstCompletion.message.content
				: null,
		).toEqual([{ type: "text", text: "first" }]);
		expect(result.content).toEqual([{ type: "text", text: "second" }]);
		await bridge.close();
	});

	test("commits session observations regardless of optional turn correlation", async () => {
		const submitted: SubmitInput[] = [];
		const committed: number[] = [];
		const events = [
			wireEvent(1, "ctree_node", { node: { id: "bootstrap" } }, null),
			started,
			wireEvent(3, "stream.gap", { source: "worker" }),
			wireEvent(4, "session_control", { action: "observed" }),
			wireEvent(5, "assistant.message.delta", { text: "ready" }),
			wireEvent(6, "assistant.message.end", { text: "ready" }),
			wireEvent(7, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, submitted),
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				committed.push(cursor.sequence);
			},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "ready" }]);
		expect(committed).toEqual(expect.arrayContaining([1, 3, 4]));
		await bridge.close();
	});

	test("reuses the exact structured submission after an ambiguous failure without retrying automatically", async () => {
		const submitted: SubmitInput[] = [];
		const retryStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) throw new LifecycleE4ClientError({ kind: "timeout" });
				retryStarted.resolve();
				const structured = input as StructuredSubmit;
				return {
					...receipt,
					clientMessageId: structured.clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await Promise.race([
					retryStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_completed", {});
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const firstStream = await startBridgeStream(bridge, model, context);
			const firstResult = await firstStream.result();
			expect(firstResult.stopReason).toBe("error");
			expect(submitted).toHaveLength(1);

			const retryStream = await startBridgeStream(bridge, model, context);
			const retryResult = await retryStream.result();
			expect(retryResult.stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
			expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
		} finally {
			await bridge.close();
		}
	});

	test("surfaces an ordinary admission rejection with a caller signal and admits the next turn", async () => {
		const submitted: SubmitInput[] = [];
		const retryStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) throw new Error("admission rejected");
				retryStarted.resolve();
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await Promise.race([
					retryStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_completed", {});
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});
		const controller = new AbortController();

		try {
			const firstStream = await startBridgeStream(bridge, model, context, { signal: controller.signal });
			const firstResult = await Promise.race([
				firstStream.result(),
				Bun.sleep(100).then(() => "timed-out" as const),
			]);
			if (firstResult === "timed-out") throw new Error("ordinary admission rejection did not settle");
			expect(firstResult.stopReason).toBe("error");
			expect(firstResult.errorMessage).toContain("admission rejected");

			const retryResult = await (await startBridgeStream(bridge, model, context)).result();
			expect(retryResult.stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect((submitted[1] as StructuredSubmit).clientMessageId).not.toBe(
				(submitted[0] as StructuredSubmit).clientMessageId,
			);
		} finally {
			await bridge.close();
		}
	});

	test("fails closed rather than claiming a foreign turn when receipt correlation is unusable", async () => {
		const submitted: SubmitInput[] = [];
		const submitStarted = Promise.withResolvers<void>();
		const foreignEventYielded = Promise.withResolvers<void>();
		const ownership: Array<{ clientMessageId: string; inputId: string; turnId: string }> = [];
		const projected: AgentEvent[] = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				submitStarted.resolve();
				await foreignEventYielded.promise;
				throw new CanonicalE4ClientError({
					kind: "protocol",
					code: "invalid_client_message_id",
				});
			},
			async *events() {
				await submitStarted.promise;
				foreignEventYielded.resolve();
				yield wireEvent(2, "turn_start", {}, "turn-2");
				yield wireEvent(3, "assistant.message.delta", { text: "foreign" }, "turn-2");
				yield wireEvent(4, "turn_completed", {}, "turn-2");
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned(value) {
				ownership.push(value);
			},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent(event) {
				projected.push(event);
			},
			modelPolicy: { kind: "fixed", model },
		});

		try {
			const result = await (await startBridgeStream(bridge, model, context)).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("BreadBoard submission response lost canonical ownership correlation");
			expect(submitted).toHaveLength(1);
			expect(ownership).toEqual([]);
			expect(projected).toEqual([]);
		} finally {
			await bridge.close();
		}
	});

	test("clears a cancelled admission after its late definitive rejection", async () => {
		const submitted: SubmitInput[] = [];
		const firstSubmission = Promise.withResolvers<SubmitReceipt>();
		const firstSubmitStarted = Promise.withResolvers<void>();
		const retryStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) {
					firstSubmitStarted.resolve();
					return firstSubmission.promise;
				}
				retryStarted.resolve();
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await Promise.race([
					retryStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_completed", {});
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});
		const controller = new AbortController();
		const differentContext: Context = {
			messages: [{ role: "user", content: "different prompt", timestamp: 4 }],
		};

		try {
			const firstStream = await startBridgeStream(bridge, model, context, { signal: controller.signal });
			await firstSubmitStarted.promise;
			controller.abort();
			expect((await firstStream.result()).stopReason).toBe("aborted");
			firstSubmission.reject(new Error("admission rejected"));
			await drainMicrotasks();

			const retryResult = await (await startBridgeStream(bridge, model, differentContext)).result();
			expect(retryResult.stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect((submitted[1] as StructuredSubmit).clientMessageId).not.toBe(
				(submitted[0] as StructuredSubmit).clientMessageId,
			);
		} finally {
			firstSubmission.reject(new Error("test cleanup"));
			await bridge.close();
		}
	});

	test("attaches an unchanged retry after ambiguous admission before replaying its completed turn", async () => {
		const submitted: SubmitInput[] = [];
		const firstFailed = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) {
					firstFailed.resolve();
					throw new LifecycleE4ClientError({ kind: "timeout" });
				}
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await firstFailed.promise;
				yield started;
				yield wireEvent(3, "turn_completed", {});
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const firstResult = await (await startBridgeStream(bridge, model, context)).result();
			expect(firstResult.stopReason).toBe("error");

			const retryResult = await (await startBridgeStream(bridge, model, context)).result();
			expect(retryResult.stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
		} finally {
			await bridge.close();
		}
	});

	test("attaches an unchanged retry while its ambiguously admitted turn is being observed", async () => {
		const submitted: SubmitInput[] = [];
		const firstFailed = Promise.withResolvers<void>();
		const startedProjected = Promise.withResolvers<void>();
		const finishObservedTurn = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) {
					firstFailed.resolve();
					throw new LifecycleE4ClientError({ kind: "timeout" });
				}
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await firstFailed.promise;
				yield started;
				await finishObservedTurn.promise;
				yield wireEvent(3, "turn_completed", {});
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				if (cursor.sequence === started.sequence) startedProjected.resolve();
			},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const firstResult = await (await startBridgeStream(bridge, model, context)).result();
			expect(firstResult.stopReason).toBe("error");

			const retryStream = await startBridgeStream(bridge, model, context);
			await startedProjected.promise;
			finishObservedTurn.resolve();
			const retryResult = await retryStream.result();
			expect(retryResult.stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
		} finally {
			await bridge.close();
		}
	});

	test("does not claim a foreign turn while resolving an ambiguous local submission", async () => {
		const submitted: SubmitInput[] = [];
		const firstFailed = Promise.withResolvers<void>();
		const commits: number[] = [];
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) {
					firstFailed.resolve();
					throw new LifecycleE4ClientError({ kind: "timeout" });
				}
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events() {
				await firstFailed.promise;
				yield wireEvent(2, "turn_start", {}, "turn-2");
				yield wireEvent(3, "turn_completed", {}, "turn-2");
				yield wireEvent(4, "turn_start", {});
				yield wireEvent(5, "turn_completed", {});
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				commits.push(cursor.sequence);
			},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});

		try {
			expect((await (await startBridgeStream(bridge, model, context)).result()).stopReason).toBe("error");
			const retryResult = await (await startBridgeStream(bridge, model, context)).result();
			expect(retryResult.stopReason).toBe("stop");
			expect(commits).toEqual([2, 3, 4]);
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
		} finally {
			await bridge.close();
		}
	});

	test("does not restore ownership when a retry receipt names an already adopted terminal turn", async () => {
		const submission = Promise.withResolvers<SubmitReceipt>();
		const lateRetry = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const terminalCommitted = Promise.withResolvers<void>();
		const lateRetryStarted = Promise.withResolvers<void>();
		const ownershipStarted = Promise.withResolvers<void>();
		const persistOwnership = Promise.withResolvers<void>();
		const ownershipCalls: string[] = [];
		const ownershipSnapshots: string[][] = [];
		let attempts = 0;
		let firstInput: StructuredSubmit | undefined;
		let lateRetryInput: StructuredSubmit | undefined;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				firstInput ??= input as StructuredSubmit;
				attempts += 1;
				if (attempts === 1) {
					submitStarted.resolve();
					return submission.promise;
				}
				if (attempts === 3) {
					lateRetryInput = input as StructuredSubmit;
					lateRetryStarted.resolve();
					return lateRetry.promise;
				}
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async cancel(): Promise<CancellationReceipt> {
				return {} as CancellationReceipt;
			},
			async *events(request) {
				await submitStarted.promise;
				yield started;
				yield wireEvent(3, "turn_completed", {});
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned(owned) {
				ownershipCalls.push(owned.turnId);
				ownershipStarted.resolve();
				await persistOwnership.promise;
			},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted(cursor, owned) {
				ownershipSnapshots.push(owned.map(item => item.turnId));
				if (cursor.sequence === 3) terminalCommitted.resolve();
			},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});
		const controller = new AbortController();

		try {
			const firstStream = await startBridgeStream(bridge, model, context, { signal: controller.signal });
			await submitStarted.promise;
			controller.abort();
			expect((await firstStream.result()).stopReason).toBe("aborted");
			if (!firstInput) throw new Error("first submission missing");
			submission.resolve({
				...receipt,
				clientMessageId: firstInput.clientMessageId as ClientMessageId,
			});
			await ownershipStarted.promise;
			const prematureCommit = await Promise.race([
				terminalCommitted.promise.then(() => true),
				Bun.sleep(10).then(() => false),
			]);
			expect(prematureCommit).toBeFalse();
			persistOwnership.resolve();
			await terminalCommitted.promise;

			const retryResult = await (await startBridgeStream(bridge, model, context)).result();
			expect(retryResult.stopReason).toBe("error");
			expect(retryResult.errorMessage).toContain("already in the transcript");
			expect(ownershipCalls).toEqual([String(receipt.turnId)]);
			expect(ownershipSnapshots.at(-1)).toEqual([String(receipt.turnId)]);

			const lateAbort = new AbortController();
			const lateStream = await startBridgeStream(bridge, model, context, { signal: lateAbort.signal });
			await lateRetryStarted.promise;
			lateAbort.abort();
			expect((await lateStream.result()).stopReason).toBe("aborted");
			if (!lateRetryInput) throw new Error("late retry submission missing");
			lateRetry.resolve({
				...receipt,
				clientMessageId: lateRetryInput.clientMessageId as ClientMessageId,
			});
			await Bun.sleep(0);
			expect(ownershipCalls).toEqual([String(receipt.turnId)]);
		} finally {
			persistOwnership.resolve();
			await bridge.close();
		}
	});

	test("aborts a pending admission without holding session close until the submit request times out", async () => {
		const submission = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const cancellationObserved = Promise.withResolvers<void>();
		const cancellationTurnIds: string[] = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				submitStarted.resolve();
				return submission.promise;
			},
			async cancel(request) {
				cancellationTurnIds.push(String(request.turnId));
				cancellationObserved.resolve();
				return {} as CancellationReceipt;
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const abort = new AbortController();

		const stream = await startBridgeStream(bridge, model, context, { signal: abort.signal });
		await submitStarted.promise;
		abort.abort();
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain("cancelled while admission was in progress");

		const closeOutcome = await Promise.race([
			bridge.close().then(() => "closed" as const),
			Bun.sleep(100).then(() => "blocked" as const),
		]);
		expect(closeOutcome).toBe("closed");

		submission.resolve(receipt);
		await cancellationObserved.promise;
		expect(cancellationTurnIds).toEqual([String(receipt.turnId)]);
	});

	test("closes while a signal-less submission remains pending and cancels a late receipt", async () => {
		const submission = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const cancellationObserved = Promise.withResolvers<void>();
		const cancellationTurnIds: string[] = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				submitStarted.resolve();
				return submission.promise;
			},
			async cancel(request) {
				cancellationTurnIds.push(String(request.turnId));
				cancellationObserved.resolve();
				return {} as CancellationReceipt;
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		await submitStarted.promise;
		const closeOutcome = await Promise.race([
			bridge.close().then(() => "closed" as const),
			Bun.sleep(500).then(() => "blocked" as const),
		]);
		expect(closeOutcome).toBe("closed");
		expect((await stream.result()).stopReason).toBe("aborted");

		submission.resolve(receipt);
		await cancellationObserved.promise;
		expect(cancellationTurnIds).toEqual([String(receipt.turnId)]);
	});

	test("waits for started late ownership persistence before closing", async () => {
		const submission = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const ownershipStarted = Promise.withResolvers<void>();
		const persistOwnership = Promise.withResolvers<void>();
		let submitted: StructuredSubmit | undefined;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted = input as StructuredSubmit;
				submitStarted.resolve();
				return submission.promise;
			},
			async cancel(): Promise<CancellationReceipt> {
				return {} as CancellationReceipt;
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {
				ownershipStarted.resolve();
				await persistOwnership.promise;
			},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});
		const controller = new AbortController();

		const stream = await startBridgeStream(bridge, model, context, { signal: controller.signal });
		await submitStarted.promise;
		controller.abort();
		expect((await stream.result()).stopReason).toBe("aborted");
		if (!submitted) throw new Error("submission missing");
		submission.resolve({
			...receipt,
			clientMessageId: submitted.clientMessageId as ClientMessageId,
		});
		await ownershipStarted.promise;

		const close = bridge.close();
		expect(
			await Promise.race([close.then(() => "closed" as const), Bun.sleep(10).then(() => "blocked" as const)]),
		).toBe("blocked");
		persistOwnership.resolve();
		await close;
	});

	test("does not advance the cursor when ownership persistence fails during admission", async () => {
		const ownershipStarted = Promise.withResolvers<void>();
		const persistOwnership = Promise.withResolvers<void>();
		const commits: number[] = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async cancel(): Promise<CancellationReceipt> {
				return {} as CancellationReceipt;
			},
			async *events() {
				await ownershipStarted.promise;
				yield started;
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {
				ownershipStarted.resolve();
				await persistOwnership.promise;
			},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				commits.push(cursor.sequence);
			},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});

		try {
			const stream = await startBridgeStream(bridge, model, context);
			await ownershipStarted.promise;
			persistOwnership.reject(new Error("binding flush failed"));
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("binding flush failed");
			await Bun.sleep(0);
			expect(commits).toEqual([]);
		} finally {
			persistOwnership.resolve();
			await bridge.close();
		}
	});

	test("retains ambiguous ownership after an aborted submit later rejects", async () => {
		const firstSubmission = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const submitted: SubmitInput[] = [];
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) {
					submitStarted.resolve();
					return firstSubmission.promise;
				}
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await submitStarted.promise;
				yield started;
				yield wireEvent(3, "turn_completed", {});
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});
		const controller = new AbortController();

		try {
			const firstStream = await startBridgeStream(bridge, model, context, { signal: controller.signal });
			await submitStarted.promise;
			controller.abort();
			expect((await firstStream.result()).stopReason).toBe("aborted");
			firstSubmission.reject(new LifecycleE4ClientError({ kind: "timeout" }));
			await Bun.sleep(0);

			const retryResult = await (await startBridgeStream(bridge, model, context)).result();
			expect(retryResult.stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
		} finally {
			await bridge.close();
		}
	});

	test("fails closed on a different prompt while an ambiguous submission is unresolved", async () => {
		const submitted: SubmitInput[] = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				throw new LifecycleE4ClientError({ kind: "caller-abort" });
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const differentContext: Context = {
			messages: [{ role: "user", content: "different prompt", timestamp: 4 }],
		};

		try {
			expect((await (await startBridgeStream(bridge, model, context)).result()).stopReason).toBe("error");
			const differentResult = await (await startBridgeStream(bridge, model, differentContext)).result();

			expect(differentResult.stopReason).toBe("error");
			expect(differentResult.errorMessage).toContain("previous submission is unresolved");
			expect(submitted).toHaveLength(1);
		} finally {
			await bridge.close();
		}
	});

	test("compares attachment uploads by content digest before reusing an ambiguous submission", async () => {
		const submitted: SubmitInput[] = [];
		const retryStarted = Promise.withResolvers<void>();
		let attempts = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submitted.push(input);
				attempts += 1;
				if (attempts === 1) {
					throw new LifecycleE4ClientError({
						kind: "http",
						status: 0,
						code: null,
						correlation: {},
						body: "[redacted]",
					});
				}
				retryStarted.resolve();
				return {
					...receipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await Promise.race([
					retryStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_completed", {});
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const withImage = (data: string): Context => ({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "inspect image" },
						{ type: "image", mimeType: "image/png", data },
					],
					timestamp: 4,
				},
			],
		});
		const original = withImage(Buffer.from([0, 1, 2]).toString("base64"));
		const differentBytes = withImage(Buffer.from([0, 1, 3]).toString("base64"));
		const equivalent = withImage(Buffer.from([0, 1, 2]).toString("base64"));

		try {
			expect((await (await startBridgeStream(bridge, model, original)).result()).stopReason).toBe("error");
			const differentResult = await (await startBridgeStream(bridge, model, differentBytes)).result();
			expect(differentResult.errorMessage).toContain("previous submission is unresolved");
			expect(submitted).toHaveLength(1);

			expect((await (await startBridgeStream(bridge, model, equivalent)).result()).stopReason).toBe("stop");
			expect(submitted).toHaveLength(2);
			expect(submitted[1]).toBe(submitted[0]);
		} finally {
			await bridge.close();
		}
	});

	test("fails and cancels only the sink correlated to a turn-owned runtime error", async () => {
		const submissionsReady = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const ownershipSnapshots: string[][] = [];
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: "client-message-2" as ClientMessageId,
			inputId: "input-2" as SubmitReceipt["inputId"],
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		let submissionCount = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submissionCount += 1;
				if (submissionCount === 2) submissionsReady.resolve();
				const selected = submissionCount === 1 ? receipt : secondReceipt;
				return {
					...selected,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async cancel(request) {
				cancelled.push(request);
				return {} as CancellationReceipt;
			},
			async *events(request) {
				await Promise.race([
					submissionsReady.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "turn_start", {}, "turn-2");
				yield wireEvent(4, "assistant.message.delta", { text: "partial" });
				yield wireEvent(5, "error", { code: "worker_crash", message: "sensitive backend detail" });
				yield wireEvent(6, "turn_completed", {});
				yield wireEvent(7, "assistant.message.delta", { text: "healthy" }, "turn-2");
				yield wireEvent(8, "turn_completed", {}, "turn-2");
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted(_cursor, owned) {
				ownershipSnapshots.push(owned.map(item => item.turnId));
			},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const secondContext: Context = {
			messages: [{ role: "user", content: "second prompt", timestamp: 4 }],
		};

		try {
			const firstStream = await startBridgeStream(bridge, model, context);
			const secondStream = await startBridgeStream(bridge, model, secondContext);
			const [firstResult, secondResult] = await Promise.all([firstStream.result(), secondStream.result()]);

			expect(firstResult.stopReason).toBe("error");
			expect(firstResult.content).toEqual([{ type: "text", text: "partial" }]);
			expect(firstResult.errorMessage).toBe("BreadBoard runtime error [worker_crash]: [redacted]");
			expect(firstResult.responseId).toBe("breadboard:e4:event-5");
			expect(firstResult.errorMessage).not.toContain("sensitive backend detail");
			expect(secondResult.stopReason).toBe("stop");
			expect(secondResult.content).toEqual([{ type: "text", text: "healthy" }]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
			await bridge.close();
			expect(ownershipSnapshots.at(-1)).toEqual([String(secondReceipt.turnId)]);
		} finally {
			await bridge.close();
		}
	});

	test("waits for every in-flight submission before adopting an observed turn", async () => {
		const submissionsReady = Promise.withResolvers<void>();
		const eventYielded = Promise.withResolvers<void>();
		const firstReturned = Promise.withResolvers<void>();
		const pending = [Promise.withResolvers<SubmitReceipt>(), Promise.withResolvers<SubmitReceipt>()];
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: "client-message-2" as ClientMessageId,
			inputId: "input-2" as SubmitReceipt["inputId"],
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		let submissionCount = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				const index = submissionCount;
				submissionCount += 1;
				if (submissionCount === pending.length) submissionsReady.resolve();
				const selected = await pending[index]!.promise;
				if (index === 0) firstReturned.resolve();
				return {
					...selected,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async *events(request) {
				await submissionsReady.promise;
				if (request?.signal?.aborted) return;
				eventYielded.resolve();
				yield wireEvent(2, "turn_start", {}, "turn-2");
				yield wireEvent(3, "assistant.message.delta", { text: "second" }, "turn-2");
				yield wireEvent(4, "assistant.message.end", { text: "second" }, "turn-2");
				yield wireEvent(5, "turn_completed", {}, "turn-2");
				yield wireEvent(6, "turn_start", {});
				yield wireEvent(7, "assistant.message.delta", { text: "first" });
				yield wireEvent(8, "assistant.message.end", { text: "first" });
				yield wireEvent(9, "turn_completed", {});
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const secondContext: Context = {
			messages: [{ role: "user", content: "second prompt", timestamp: 4 }],
		};

		try {
			const firstStream = await startBridgeStream(bridge, model, context);
			const secondStream = await startBridgeStream(bridge, model, secondContext);
			await eventYielded.promise;
			pending[0]!.resolve(receipt);
			await firstReturned.promise;
			await Bun.sleep(0);
			pending[1]!.resolve(secondReceipt);

			const [firstResult, secondResult] = await Promise.all([firstStream.result(), secondStream.result()]);
			expect(firstResult.stopReason).toBe("stop");
			expect(firstResult.content).toEqual([{ type: "text", text: "first" }]);
			expect(secondResult.stopReason).toBe("stop");
			expect(secondResult.content).toEqual([{ type: "text", text: "second" }]);
		} finally {
			await bridge.close();
		}
	});

	test("invalidates the bridge on a session-scoped runtime error", async () => {
		const secondSubmitStarted = Promise.withResolvers<void>();
		const releaseSecondSubmit = Promise.withResolvers<void>();
		const runtimeErrorObserved = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const commits: Array<{ readonly eventId: string; readonly sequence: number; readonly owned: string[] }> = [];
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: "client-message-2" as ClientMessageId,
			inputId: "input-2" as SubmitReceipt["inputId"],
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		let submissionCount = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit(input) {
				submissionCount += 1;
				if (submissionCount === 1) {
					return {
						...receipt,
						clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
					};
				}
				secondSubmitStarted.resolve();
				await releaseSecondSubmit.promise;
				return {
					...secondReceipt,
					clientMessageId: (input as StructuredSubmit).clientMessageId as ClientMessageId,
				};
			},
			async cancel(request) {
				cancelled.push(request);
				return {} as CancellationReceipt;
			},
			async *events(request) {
				await Promise.race([
					secondSubmitStarted.promise,
					new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					),
				]);
				if (request?.signal?.aborted) return;
				yield started;
				yield wireEvent(3, "assistant.message.delta", { text: "partial" });
				runtimeErrorObserved.resolve();
				yield wireEvent(4, "error", { code: "runtime_failure", message: "sensitive backend detail" }, null);
				await releaseSecondSubmit.promise;
				if (request?.signal?.aborted) return;
				yield wireEvent(5, "turn_completed", {});
				yield wireEvent(6, "turn_start", {}, "turn-2");
				yield wireEvent(7, "assistant.message.delta", { text: "should not run" }, "turn-2");
				yield wireEvent(8, "turn_completed", {}, "turn-2");
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted(cursor, owned) {
				commits.push({
					eventId: cursor.eventId,
					sequence: cursor.sequence,
					owned: owned.map(submission => submission.turnId),
				});
			},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		const secondContext: Context = {
			messages: [{ role: "user", content: "second prompt", timestamp: 4 }],
		};
		const laterContext: Context = {
			messages: [{ role: "user", content: "later prompt", timestamp: 5 }],
		};

		try {
			const activeStream = await startBridgeStream(bridge, model, context);
			const submittingStream = await startBridgeStream(bridge, model, secondContext);
			await runtimeErrorObserved.promise;
			releaseSecondSubmit.resolve();
			const [activeResult, submittingResult] = await Promise.all([activeStream.result(), submittingStream.result()]);

			expect(activeResult.stopReason).toBe("error");
			expect(activeResult.content).toEqual([{ type: "text", text: "partial" }]);
			expect(activeResult.errorMessage).toBe("BreadBoard runtime error [runtime_failure]: [redacted]");
			expect(activeResult.responseId).toBe("breadboard:e4:event-4");
			expect(activeResult.errorMessage).not.toContain("sensitive backend detail");
			expect(submittingResult.stopReason).toBe("error");
			expect(submittingResult.errorMessage).toBe("BreadBoard runtime error [runtime_failure]: [redacted]");
			expect(submittingResult.responseId).toBe("breadboard:e4:event-4");

			const laterResult = await (await startBridgeStream(bridge, model, laterContext)).result();
			expect(laterResult.stopReason).toBe("error");
			expect(laterResult.errorMessage).toBe("BreadBoard runtime error [runtime_failure]: [redacted]");
			expect(laterResult.responseId).toBe("breadboard:e4:event-4");
			expect(submissionCount).toBe(2);
			expect(cancelled).toEqual([
				{ turnId: receipt.turnId, reason: "timeout" },
				{ turnId: secondReceipt.turnId, reason: "timeout" },
			]);
			await bridge.close();
			expect(commits.at(-1)).toEqual({ eventId: "event-4", sequence: 4, owned: [] });
		} finally {
			releaseSecondSubmit.resolve();
			await bridge.close();
		}
	});

	test("commits one session-failure cursor after every adopted turn projection", async () => {
		const projected = Promise.withResolvers<void>();
		const commits: Array<{ readonly sequence: number; readonly owned: string[] }> = [];
		const emittedKeys: string[] = [];
		const session = openedSession(
			[
				wireEvent(1, "turn_start", {}, "turn-1"),
				wireEvent(2, "turn_start", {}, "turn-2"),
				wireEvent(3, "error", { code: "runtime_failure", message: "sensitive backend detail" }, null),
			],
			[],
		);
		const bridge = new E4AgentStreamBridge({
			session,
			durableCursor: undefined,
			ownedSubmissions: [
				{ clientMessageId: "client-1", inputId: "input-1", turnId: "turn-1" },
				{ clientMessageId: "client-2", inputId: "input-2", turnId: "turn-2" },
			],
			async submissionOwned() {},
			async emitAgentEvent(_event, key) {
				emittedKeys.push(key);
				if (emittedKeys.length === 4) projected.resolve();
			},
			releaseAgentEvent() {},
			async projectionCommitted(cursor, owned) {
				commits.push({ sequence: cursor.sequence, owned: owned.map(submission => submission.turnId) });
			},
			modelPolicy: { kind: "fixed", model },
		});

		bridge.start();
		await projected.promise;
		await bridge.close();
		expect(emittedKeys).toEqual([
			"event-3:message_start:turn-1",
			"event-3:message_end:turn-1",
			"event-3:message_start:turn-2",
			"event-3:message_end:turn-2",
		]);
		expect(commits).toEqual([
			{ sequence: 1, owned: ["turn-1", "turn-2"] },
			{ sequence: 2, owned: ["turn-1", "turn-2"] },
			{ sequence: 3, owned: [] },
		]);
	});

	test("interrupts an unbounded admission with the authoritative session failure", async () => {
		const submitStarted = Promise.withResolvers<void>();
		const unresolvedSubmission = Promise.withResolvers<SubmitReceipt>();
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				submitStarted.resolve();
				return await unresolvedSubmission.promise;
			},
			async *events() {
				await submitStarted.promise;
				yield wireEvent(1, "error", { code: "runtime_failure", message: "sensitive backend detail" }, null);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
		});

		try {
			const result = await (await startBridgeStream(bridge, model, context)).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("BreadBoard runtime error [runtime_failure]: [redacted]");
			expect(result.responseId).toBe("breadboard:e4:event-1");
		} finally {
			await bridge.close();
		}
	});

	for (const runtimeFamily of [
		{
			label: "a session-scoped runtime protocol error",
			event: wireEvent(4, "error", { code: "runtime_protocol_error" }),
			expectedMessage: "BreadBoard runtime error [runtime_protocol_error]: [redacted]",
		},
		{
			label: "an unknown canonical runtime family",
			event: {
				...wireEvent(4, "warning", {}),
				kind: "future_runtime_observed",
			} as unknown as LoggedSessionEvent,
			expectedMessage: "BreadBoard unsupported canonical runtime event family",
		},
	] as const) {
		test(`does not silently drop ${runtimeFamily.label}`, async () => {
			const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
			const session: OpenedSession = {
				...openedSession(
					[
						started,
						wireEvent(3, "assistant.message.delta", { text: "partial" }),
						runtimeFamily.event,
						wireEvent(5, "turn_completed", {}),
					],
					[],
				),
				async cancel(request) {
					cancelled.push(request);
					return {} as CancellationReceipt;
				},
			};
			const bridge = new E4AgentStreamBridge({
				async submissionOwned() {},
				session,
				durableCursor: undefined,
				releaseAgentEvent() {},
				async projectionCommitted() {},
				async emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
			});

			try {
				const result = await (await startBridgeStream(bridge, model, context)).result();
				expect(result.stopReason).toBe("error");
				expect(result.content).toEqual([{ type: "text", text: "partial" }]);
				expect(result.errorMessage).toBe(runtimeFamily.expectedMessage);
				expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
			} finally {
				await bridge.close();
			}
		});
	}

	test("parses canonical JSON-string tool arguments before native projection", async () => {
		const agentEvents: AgentEvent[] = [];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(
				[
					started,
					wireEvent(3, "tool_call", {
						call_id: "call-string-arguments",
						tool: "todo.write_board",
						arguments: '{"todos":[{"content":"Plan work","status":"completed"}]}',
						action: "update",
						diff_preview: null,
						progress: null,
					}),
					wireEvent(4, "turn_failed", {
						error: { code: "turn_execution_failed", message: "[redacted]" },
					}),
				],
				[],
			),
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent(event) {
				agentEvents.push(event);
			},
			modelPolicy: { kind: "fixed", model },
		});

		try {
			const result = await (await startBridgeStream(bridge, model, context)).result();
			expect(result.stopReason).toBe("error");
			const messageStart = agentEvents.find(event => event.type === "message_start");
			expect(messageStart).toMatchObject({
				type: "message_start",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-string-arguments",
							name: "todo.write_board",
							arguments: { todos: [{ content: "Plan work", status: "completed" }] },
						},
					],
				},
			});
		} finally {
			await bridge.close();
		}
	});

	test("drops replayed history and projects durable native tool result events in agent-loop order", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const normalizedResult = {
			content: [{ type: "text" as const, text: '{"output":"contents"}\nArtifact: artifact-1' }],
			details: {
				result: { output: "contents" },
				artifactRef: "artifact-1",
				breadboardProjectionEventId: "event-4",
			},
		};
		const events = [
			wireEvent(1, "tool.result", {
				call_id: "call-1",
				tool: "read",
				status: "completed",
				error: false,
				result: { output: "stale" },
				artifact_ref: null,
			}),
			started,
			wireEvent(3, "tool_call", {
				call_id: "call-1",
				tool: "write",
				arguments: { filePath: "README.md", content: "contents" },
				action: "create",
				diff_preview: null,
				progress: null,
			}),
			wireEvent(4, "tool.result", {
				call_id: "call-1",
				tool: "create_file_from_block",
				status: "completed",
				error: false,
				result: { output: "contents" },
				artifact_ref: "artifact-1",
			}),
			wireEvent(5, "assistant.message.delta", { text: "fresh" }),
			wireEvent(6, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, submitted),
			durableCursor: { eventId: "event-1", sequence: 1 },
			releaseAgentEvent() {},
			async projectionCommitted() {},
			emitAgentEvent: async event => {
				agentEvents.push(event);
			},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "fresh" }]);
		expect(agentEvents.map(event => event.type)).toEqual([
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		const toolCallMessageStart = agentEvents[0];
		const toolCallMessageEnd = agentEvents[1];
		if (toolCallMessageStart?.type !== "message_start" || toolCallMessageEnd?.type !== "message_end") {
			throw new Error("Expected native assistant tool-call message lifecycle");
		}
		expect(toolCallMessageStart.message).toEqual({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "write",
					arguments: { filePath: "README.md", content: "contents" },
				},
			],
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
			responseId: "breadboard:e4:event-3",
			stopReason: "toolUse",
			timestamp: 3,
		});
		expect(toolCallMessageEnd.message).toEqual(toolCallMessageStart.message);
		expect(agentEvents[2]).toEqual({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "write",
			args: { filePath: "README.md", content: "contents" },
			intent: "create",
		});
		expect(agentEvents[3]).toEqual({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "write",
			result: normalizedResult,
			isError: false,
		});
		const messageStart = agentEvents[4];
		const messageEnd = agentEvents[5];
		if (messageStart?.type !== "message_start" || messageEnd?.type !== "message_end") {
			throw new Error("Expected native tool result message lifecycle");
		}
		expect(messageStart.message).toEqual({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "write",
			content: normalizedResult.content,
			details: normalizedResult.details,
			isError: false,
			timestamp: expect.any(Number),
		});
		expect(messageEnd.message).toEqual(messageStart.message);
		await bridge.close();
	});
	test("projects multiple assistant messages around tools exactly once and correlates nullable tool names by call ID", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const firstCall = wireEvent(6, "tool_call", {
			call_id: "call-1",
			tool: "read",
			arguments: { path: "README.md" },
			action: null,
			diff_preview: null,
			progress: null,
		});
		const firstResult = wireEvent(8, "tool.result", {
			call_id: "call-2",
			tool: null,
			status: "completed",
			error: false,
			result: "edit result",
			artifact_ref: null,
		});
		const secondCompletion = wireEvent(12, "assistant.message.end", { text: "After." });
		const events = [
			started,
			wireEvent(3, "assistant.message.start", { message_id: "message-1" }),
			wireEvent(4, "assistant.message.delta", { text: "Before." }),
			wireEvent(5, "assistant.message.end", { text: "Before." }),
			firstCall,
			firstCall,
			wireEvent(7, "tool_call", {
				call_id: "call-2",
				tool: "edit",
				arguments: { path: "README.md" },
				action: null,
				diff_preview: null,
				progress: null,
			}),
			firstResult,
			firstResult,
			wireEvent(9, "tool.result", {
				call_id: "call-1",
				tool: null,
				status: "completed",
				error: false,
				result: "read result",
				artifact_ref: null,
			}),
			wireEvent(10, "assistant.message.start", { message_id: "message-2" }),
			wireEvent(11, "assistant.message.delta", { text: "After." }),
			secondCompletion,
			secondCompletion,
			wireEvent(13, "tool_call", {
				call_id: "call-1",
				tool: "read",
				arguments: { path: "README.md" },
				action: null,
				diff_preview: null,
				progress: null,
			}),
			wireEvent(14, "tool.result", {
				call_id: "call-1",
				tool: null,
				status: "completed",
				error: false,
				result: "duplicate read result",
				artifact_ref: null,
			}),
			wireEvent(15, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, submitted),
			durableCursor: { eventId: "event-1", sequence: 1 },
			releaseAgentEvent() {},
			async projectionCommitted() {},
			emitAgentEvent: async event => {
				agentEvents.push(event);
			},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "After." }]);
		expect(agentEvents.filter(event => event.type === "tool_execution_start")).toHaveLength(2);
		const ends = agentEvents.filter(event => event.type === "tool_execution_end");
		expect(ends).toHaveLength(2);
		expect(ends.map(event => event.toolName)).toEqual(["edit", "read"]);
		const projectedMessages = agentEvents.filter(event => event.type === "message_end").map(event => event.message);
		expect(projectedMessages.map(message => message.role)).toEqual([
			"assistant",
			"assistant",
			"assistant",
			"toolResult",
			"toolResult",
		]);
		expect(projectedMessages[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Before." }],
		});
		await bridge.close();
	});
	test("ignores duplicate and out-of-order event sequences for exact-once SSE projection", async () => {
		const submitted: SubmitInput[] = [];
		const agentEvents: AgentEvent[] = [];
		const toolCall = wireEvent(3, "tool_call", {
			call_id: "call-1",
			tool: "read",
			arguments: null,
			action: "inspect",
			diff_preview: null,
			progress: null,
		});
		const toolResultEvent = wireEvent(4, "tool.result", {
			call_id: "call-1",
			tool: "read",
			status: "completed",
			error: false,
			result: { output: "contents" },
			artifact_ref: null,
		});
		const textDelta = wireEvent(5, "assistant.message.delta", { text: "fresh" });
		const textCompleted = wireEvent(6, "assistant.message.end", { text: "fresh" });
		const events = [
			started,
			toolCall,
			toolCall,
			toolResultEvent,
			toolResultEvent,
			textDelta,
			textDelta,
			textCompleted,
			textCompleted,
			wireEvent(7, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, submitted),
			durableCursor: { eventId: "event-1", sequence: 1 },
			releaseAgentEvent() {},
			async projectionCommitted() {},
			emitAgentEvent: async event => {
				agentEvents.push(event);
			},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "fresh" }]);
		expect(agentEvents.map(event => event.type)).toEqual([
			"message_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		expect(agentEvents.filter(event => event.type === "message_end")).toHaveLength(2);
		const toolCallMessage = agentEvents[1];
		if (toolCallMessage?.type !== "message_end" || toolCallMessage.message.role !== "assistant") {
			throw new Error("Expected exact native assistant tool-call message");
		}
		expect(toolCallMessage.message.content as unknown).toEqual([
			{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		]);
		expect(agentEvents[2]).toMatchObject({ type: "tool_execution_start", args: null });
		await bridge.close();
	});

	test("persists backend tool calls before results in AgentSession JSONL and native context", async () => {
		using tempDir = TempDir.createSync("@breadboard-e4-agent-session-order-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent AgentSession JSONL");

		const submitted: SubmitInput[] = [];
		const admitted = Promise.withResolvers<void>();
		const events = [
			started,
			wireEvent(3, "assistant.message.start", { message_id: "message-before-tool" }),
			wireEvent(4, "assistant.message.delta", { text: "Before." }),
			wireEvent(5, "assistant.message.end", { text: "Before." }),
			wireEvent(6, "tool_call", {
				call_id: "call-native-order",
				tool: "read",
				arguments: { path: "README.md", selectors: [1, 3] },
				action: "inspect",
				diff_preview: null,
				progress: null,
			}),
			wireEvent(7, "tool.result", {
				call_id: "call-native-order",
				tool: null,
				status: "completed",
				error: false,
				result: { output: "contents" },
				artifact_ref: null,
			}),
			wireEvent(8, "assistant.message.start", { message_id: "message-after-tool" }),
			wireEvent(9, "assistant.message.delta", { text: "Finished." }),
			wireEvent(10, "assistant.message.end", { text: "Finished." }),
			wireEvent(11, "turn_completed", {}),
		];
		const runtime: OpenedSession = {
			...openedSession([], submitted),
			async submit(input) {
				submitted.push(input);
				admitted.resolve();
				return receipt;
			},
			async *events(request) {
				await admitted.promise;
				for (const event of events) {
					if (request?.signal?.aborted) return;
					yield event;
				}
			},
		};
		const persistenceAtCommit: Array<{ sequence: number; roles: string[] }> = [];
		const releasedProjectionKeys: string[] = [];
		let agent!: Agent;
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: runtime,
			durableCursor: { eventId: "event-1", sequence: 1 },
			releaseAgentEvent(key) {
				agent.releaseExternalEvent(key);
				releasedProjectionKeys.push(key);
			},
			async projectionCommitted(cursor) {
				await sessionManager.flush();
				persistenceAtCommit.push({
					sequence: cursor.sequence,
					roles: sessionManager
						.getBranch()
						.filter(entry => entry.type === "message")
						.map(entry => (entry.type === "message" ? entry.message.role : "unreachable")),
				});
			},
			emitAgentEvent: async (event, key) => {
				await agent.emitExternalEventAndWait(event, key);
			},
			modelPolicy: { kind: "fixed", model },
		});
		bridge.start();
		agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: bridge.stream,
			convertToLlm,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		try {
			await agentSession.sendUserMessage("Inspect the README");
			await agentSession.waitForIdle();
			for (let pass = 0; pass < 20; pass += 1) {
				const persistedMessageCount = sessionManager.getBranch().filter(entry => entry.type === "message").length;
				if (persistedMessageCount === 5) break;
				await Promise.resolve();
			}
			await sessionManager.flush();

			expect(submitted).toHaveLength(1);
			expect(submitted[0]).toMatchObject({ text: "Inspect the README" });
			expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
			expect(persistenceAtCommit).toContainEqual({ sequence: 5, roles: ["user", "assistant"] });
			expect(persistenceAtCommit).toContainEqual({
				sequence: 7,
				roles: ["user", "assistant", "assistant", "toolResult"],
			});
			expect(releasedProjectionKeys).toEqual([
				"event-5:message_start",
				"event-5:message_end",
				"event-6:message_start",
				"event-6:message_end",
				"event-6:tool_execution_start",
				"event-7:tool_execution_end",
				"event-7:message_start",
				"event-7:message_end",
			]);
			expect(agent.state.messages.map(message => message.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(convertToLlm(agent.state.messages).map(message => message.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(agent.state.messages[1]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Before." }],
			});
			expect(agent.state.messages[2]).toMatchObject({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-native-order",
						name: "read",
						arguments: { path: "README.md", selectors: [1, 3] },
					},
				],
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
				stopReason: "toolUse",
				timestamp: 6,
			});
			expect(agent.state.messages[3]).toMatchObject({
				role: "toolResult",
				toolCallId: "call-native-order",
				toolName: "read",
				isError: false,
			});
			expect(agent.state.messages[4]).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Finished." }],
			});
			expect(agent.state.pendingToolCalls.size).toBe(0);
			expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);

			const jsonlEntries = fs
				.readFileSync(sessionFile, "utf8")
				.trimEnd()
				.split("\n")
				.map(
					line =>
						JSON.parse(line) as {
							type?: string;
							message?: { role?: string; content?: unknown };
						},
				);
			const persistedMessages = jsonlEntries.filter(entry => entry.type === "message").map(entry => entry.message);
			expect(persistedMessages.map(message => message?.role)).toEqual([
				"user",
				"assistant",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(persistedMessages[1]?.content).toEqual([{ type: "text", text: "Before." }]);
			expect(persistedMessages[4]?.content).toEqual([{ type: "text", text: "Finished." }]);

			const reloaded = await SessionManager.open(sessionFile, tempDir.path());
			try {
				const reloadedMessages = reloaded
					.getBranch()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message);
				expect(reloadedMessages.map(message => message.role)).toEqual([
					"user",
					"assistant",
					"assistant",
					"toolResult",
					"assistant",
				]);
				expect(reloadedMessages[1]).toEqual(normalizePersistedMessage(agent.state.messages[1]));
				expect(reloadedMessages[2]).toEqual(normalizePersistedMessage(agent.state.messages[2]));
				expect(reloadedMessages[3]).toEqual(normalizePersistedMessage(agent.state.messages[3]));
				expect(reloadedMessages[4]).toEqual(normalizePersistedMessage(agent.state.messages[4]));
				expect(collectPendingToolCalls(reloaded.getBranch())).toEqual([]);
			} finally {
				await reloaded.close();
			}
		} finally {
			await bridge.close();
			await agentSession.dispose();
			authStorage.close();
		}
	});
	for (const terminal of [
		{
			label: "failure",
			event: wireEvent(5, "turn_failed", {
				error: { code: "turn_execution_failed", message: "[redacted]" },
			}),
			stopReason: "error",
		},
		{
			label: "cancellation",
			event: wireEvent(5, "turn_cancelled", { reason: "user_requested" }),
			stopReason: "aborted",
		},
	] as const) {
		test(`preserves partial assistant text on turn ${terminal.label}`, async () => {
			const bridge = new E4AgentStreamBridge({
				async submissionOwned() {},
				session: openedSession(
					[
						started,
						wireEvent(3, "assistant.message.start", { message_id: "message-1" }),
						wireEvent(4, "assistant.message.delta", { text: "partial output" }),
						terminal.event,
					],
					[],
				),
				durableCursor: undefined,
				releaseAgentEvent() {},
				async projectionCommitted() {},
				async emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
			});

			const stream = await startBridgeStream(bridge, model, context);
			const result = await stream.result();

			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
			expect(result.stopReason).toBe(terminal.stopReason);
			await bridge.close();
		});
	}

	test("preserves partial assistant text when the event observer ends", async () => {
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(
				[
					started,
					wireEvent(3, "assistant.message.start", { message_id: "message-1" }),
					wireEvent(4, "assistant.message.delta", { text: "partial output" }),
				],
				[],
			),
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
		expect(result.stopReason).toBe("error");
		await bridge.close();
	});

	test("discards events from turns submitted by other session clients", async () => {
		const observed = Promise.withResolvers<void>();
		let external: LoggedSessionEvent | undefined = wireEvent(
			7,
			"assistant.message.delta",
			{ text: "external" },
			"external-turn-1",
		);
		const externalRef = new WeakRef(external);
		const session: OpenedSession = {
			...openedSession([], []),
			async *events(request) {
				yield external!;
				external = undefined;
				yield wireEvent(8, "turn_completed", {}, "external-turn-2");
				observed.resolve();
				if (request?.signal?.aborted) return;
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});
		bridge.start();

		try {
			await observed.promise;
			await Promise.resolve();
			Bun.gc(true);
			expect(externalRef.deref()).toBeUndefined();
		} finally {
			await bridge.close();
		}
	});

	test("replays local events that arrive before submit installs the turn sink", async () => {
		const submitted: SubmitInput[] = [];
		const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
		const racedDelta = {
			...wireEvent(3, "assistant.message.delta", { text: "raced" }),
			get turnId() {
				pendingSubmit.resolve(receipt);
				return started.turnId;
			},
		} as LoggedSessionEvent;
		const session: OpenedSession = {
			...openedSession([racedDelta, wireEvent(4, "turn_completed", {})], submitted),
			async submit(input) {
				submitted.push(input);
				return pendingSubmit.promise;
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		const result = await stream.result();

		expect(submitted).toHaveLength(1);
		expect(submitted[0]).toMatchObject({ text: "new prompt" });
		expect(typeof (submitted[0] as StructuredSubmit).clientMessageId).toBe("string");
		expect(result.content).toEqual([{ type: "text", text: "raced" }]);
		await bridge.close();
	});
	test("preserves partial text while failing and cancelling an active turn before closing the SDK session", async () => {
		const submitObserved = Promise.withResolvers<void>();
		const partialObserved = Promise.withResolvers<void>();
		const lifecycle: string[] = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				submitObserved.resolve();
				return receipt;
			},
			async cancel(request) {
				lifecycle.push(`cancel:${String(request.turnId)}`);
				return {} as CancellationReceipt;
			},
			async *events(request) {
				yield started;
				yield wireEvent(3, "assistant.message.delta", { text: "partial output" });
				partialObserved.resolve();
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				lifecycle.push("close");
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		await submitObserved.promise;
		await drainMicrotasks();
		await partialObserved.promise;
		await bridge.close();

		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
		expect(lifecycle).toEqual([`cancel:${String(receipt.turnId)}`, "close"]);
	});

	test("settles multiple pending submissions and their cancellations before closing the SDK session", async () => {
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: `${String(receipt.clientMessageId)}-2` as ClientMessageId,
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		const pendingSubmissions = [
			Promise.withResolvers<SubmitReceipt>(),
			Promise.withResolvers<SubmitReceipt>(),
			Promise.withResolvers<SubmitReceipt>(),
		];
		const allSubmissionsObserved = Promise.withResolvers<void>();
		const allCancellationsObserved = Promise.withResolvers<void>();
		const cancellationGates: Record<string, PromiseWithResolvers<CancellationReceipt>> = {
			[String(receipt.turnId)]: Promise.withResolvers<CancellationReceipt>(),
			[String(secondReceipt.turnId)]: Promise.withResolvers<CancellationReceipt>(),
		};
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		let submitIndex = 0;
		let sdkCloseCount = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				const pending = pendingSubmissions[submitIndex];
				submitIndex += 1;
				if (submitIndex === pendingSubmissions.length) allSubmissionsObserved.resolve();
				if (!pending) throw new Error("unexpected submission");
				return pending.promise;
			},
			async cancel(request) {
				cancelled.push(request);
				if (cancelled.length === 2) allCancellationsObserved.resolve();
				const gate = cancellationGates[String(request.turnId)];
				if (!gate) throw new Error(`unexpected cancellation ${String(request.turnId)}`);
				return gate.promise;
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				sdkCloseCount += 1;
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const streams = await Promise.all([
			startBridgeStream(bridge, model, context),
			startBridgeStream(bridge, model, context),
			startBridgeStream(bridge, model, context),
		]);
		await allSubmissionsObserved.promise;
		const close = bridge.close();
		await drainMicrotasks();
		expect(sdkCloseCount).toBe(0);

		pendingSubmissions[0]?.resolve(receipt);
		pendingSubmissions[1]?.resolve(secondReceipt);
		pendingSubmissions[2]?.reject(new Error("submit rejected during close"));
		await allCancellationsObserved.promise;
		expect(sdkCloseCount).toBe(0);
		expect(cancelled).toEqual([
			{ turnId: receipt.turnId, reason: "user_requested" },
			{ turnId: secondReceipt.turnId, reason: "user_requested" },
		]);

		cancellationGates[String(receipt.turnId)]?.resolve({} as CancellationReceipt);
		await drainMicrotasks();
		expect(sdkCloseCount).toBe(0);
		cancellationGates[String(secondReceipt.turnId)]?.resolve({} as CancellationReceipt);
		await close;

		expect(sdkCloseCount).toBe(1);
		const results = await Promise.all(streams.map(stream => stream.result()));
		expect(results.map(result => result.stopReason)).toEqual(["aborted", "aborted", "aborted"]);
	});

	test("closes the SDK session after cancellation rejects", async () => {
		const submitObserved = Promise.withResolvers<void>();
		const lifecycle: string[] = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				submitObserved.resolve();
				return receipt;
			},
			async cancel(request) {
				lifecycle.push(`cancel:${String(request.turnId)}`);
				throw new Error("cancel rejected");
			},
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				lifecycle.push("close");
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		await submitObserved.promise;
		await drainMicrotasks();
		await bridge.close();

		expect((await stream.result()).stopReason).toBe("aborted");
		expect(lifecycle).toEqual([`cancel:${String(receipt.turnId)}`, "close"]);
	});

	test("coalesces concurrent and repeated close calls", async () => {
		const releaseClose = Promise.withResolvers<void>();
		let sdkCloseCount = 0;
		const session: OpenedSession = {
			...openedSession([], []),
			async *events(request) {
				if (!request?.signal?.aborted) {
					await new Promise<void>(resolve =>
						request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
			},
			async close() {
				sdkCloseCount += 1;
				await releaseClose.promise;
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		const firstClose = bridge.close();
		const secondClose = bridge.close();
		let secondCloseSettled = false;
		void secondClose.then(() => {
			secondCloseSettled = true;
		});
		await drainMicrotasks();
		expect(sdkCloseCount).toBe(1);
		expect(secondCloseSettled).toBeFalse();

		releaseClose.resolve();
		await Promise.all([firstClose, secondClose]);
		await bridge.close();
		expect(sdkCloseCount).toBe(1);
	});

	const drainMicrotasks = async (): Promise<void> => {
		for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
	};
	const observerExits = [
		{ label: "rejects", errorMessage: "event observer failed", expectedMessage: "event observer failed" },
		{
			label: "ends unexpectedly",
			errorMessage: undefined,
			expectedMessage: "BreadBoard event observer ended unexpectedly",
		},
	] as const;

	for (const observerExit of observerExits) {
		test(`terminates a pending submit when the sole event observer ${observerExit.label} before receipt`, async () => {
			const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
			const submitStarted = Promise.withResolvers<void>();
			const submitSettled = Promise.withResolvers<void>();
			const observerExited = Promise.withResolvers<void>();
			const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
			const session: OpenedSession = {
				...openedSession([], []),
				async submit() {
					submitStarted.resolve();
					try {
						return await pendingSubmit.promise;
					} finally {
						submitSettled.resolve();
					}
				},
				async cancel(request) {
					cancelled.push(request);
					return {} as CancellationReceipt;
				},
				async *events() {
					await submitStarted.promise;
					observerExited.resolve();
					if (observerExit.errorMessage) {
						yield await Promise.reject<LoggedSessionEvent>(new Error(observerExit.errorMessage));
					}
				},
			};
			const bridge = new E4AgentStreamBridge({
				async submissionOwned() {},
				session,
				durableCursor: undefined,
				releaseAgentEvent() {},
				async projectionCommitted() {},
				async emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
			});

			try {
				const stream = await startBridgeStream(bridge, model, context);
				await observerExited.promise;
				await drainMicrotasks();
				expect(stream.resultSettled).toBeTrue();
				const result = await stream.result();

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe(observerExit.expectedMessage);

				pendingSubmit.resolve(receipt);
				await submitSettled.promise;
				await drainMicrotasks();
				expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
			} finally {
				pendingSubmit.resolve(receipt);
				await submitSettled.promise;
				await drainMicrotasks();
				await bridge.close();
			}
		});

		test(`cancels the admitted turn when its receipt races an observer that ${observerExit.label}`, async () => {
			const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
			const submitStarted = Promise.withResolvers<void>();
			const submitSettled = Promise.withResolvers<void>();
			const observerExited = Promise.withResolvers<void>();
			const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
			const session: OpenedSession = {
				...openedSession([], []),
				async submit() {
					submitStarted.resolve();
					try {
						return await pendingSubmit.promise;
					} finally {
						submitSettled.resolve();
					}
				},
				async cancel(request) {
					cancelled.push(request);
					return {} as CancellationReceipt;
				},
				async *events() {
					await submitStarted.promise;
					pendingSubmit.resolve(receipt);
					observerExited.resolve();
					if (observerExit.errorMessage) {
						yield await Promise.reject<LoggedSessionEvent>(new Error(observerExit.errorMessage));
					}
				},
			};
			const bridge = new E4AgentStreamBridge({
				async submissionOwned() {},
				session,
				durableCursor: undefined,
				releaseAgentEvent() {},
				async projectionCommitted() {},
				async emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
			});

			try {
				const stream = await startBridgeStream(bridge, model, context);
				await observerExited.promise;
				await submitSettled.promise;
				await drainMicrotasks();
				expect(stream.resultSettled).toBeTrue();
				const result = await stream.result();

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBe(observerExit.expectedMessage);
				expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
			} finally {
				await bridge.close();
			}
		});
	}

	test("keeps observer failure authoritative when the pending submit rejects", async () => {
		const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const submitSettled = Promise.withResolvers<void>();
		const observerExited = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				submitStarted.resolve();
				try {
					return await pendingSubmit.promise;
				} finally {
					submitSettled.resolve();
				}
			},
			async cancel(request) {
				cancelled.push(request);
				return {} as CancellationReceipt;
			},
			async *events() {
				await submitStarted.promise;
				observerExited.resolve();
				yield await Promise.reject<LoggedSessionEvent>(new Error("event observer failed"));
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const stream = await startBridgeStream(bridge, model, context);
			await observerExited.promise;
			await drainMicrotasks();
			expect(stream.resultSettled).toBeTrue();

			pendingSubmit.reject(new Error("submit failed"));
			await submitSettled.promise;
			await drainMicrotasks();
			const result = await stream.result();
			expect(result.errorMessage).toBe("event observer failed");
			expect(cancelled).toEqual([]);
		} finally {
			await bridge.close();
		}
	});

	test("cancels an admitted turn once when close races its observer failure", async () => {
		const pendingSubmit = Promise.withResolvers<SubmitReceipt>();
		const submitStarted = Promise.withResolvers<void>();
		const submitSettled = Promise.withResolvers<void>();
		const observerExited = Promise.withResolvers<void>();
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async submit() {
				submitStarted.resolve();
				try {
					return await pendingSubmit.promise;
				} finally {
					submitSettled.resolve();
				}
			},
			async cancel(request) {
				cancelled.push(request);
				throw new Error("session already closed");
			},
			async *events() {
				await submitStarted.promise;
				observerExited.resolve();
				yield await Promise.reject<LoggedSessionEvent>(new Error("event observer failed"));
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const stream = await startBridgeStream(bridge, model, context);
			await observerExited.promise;
			await drainMicrotasks();
			expect(stream.resultSettled).toBeTrue();
			const close = bridge.close();

			pendingSubmit.resolve(receipt);
			await close;
			await submitSettled.promise;
			await drainMicrotasks();
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "timeout" }]);
		} finally {
			pendingSubmit.resolve(receipt);
			await submitSettled.promise;
			await drainMicrotasks();
			await bridge.close();
		}
	});

	for (const decision of ["allow", "deny"] as const) {
		test(`hands ${decision} permission decisions back to E4`, async () => {
			const responded: Array<Parameters<OpenedSession["respondPermission"]>[0]> = [];
			const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
			const permission = permissionSession(responded, cancelled);
			let promptCount = 0;
			const bridge = new E4AgentStreamBridge({
				async submissionOwned() {},
				session: permission.session,
				durableCursor: undefined,
				releaseAgentEvent() {},
				async projectionCommitted() {},
				async emitAgentEvent() {},
				modelPolicy: { kind: "fixed", model: model },
				requestPermission: async request => {
					promptCount += 1;
					expect(request.tool).toBe("edit");
					expect(request.kind).toBe("write");
					return decision;
				},
			});

			try {
				const stream = await startBridgeStream(bridge, model, context);
				await permission.permissionObserved;
				expect(promptCount).toBe(1);
				await permission.actionObserved;
				const result = await stream.result();

				expect(result.content).toEqual([{ type: "text", text: "partial outputpermission handled" }]);
				expect(responded).toEqual([{ requestId: "permission-1", decision }]);
				expect(cancelled).toEqual([]);
			} finally {
				await bridge.close();
			}
		});
	}

	test("cancels the turn when the OMP permission UI is cancelled", async () => {
		const responded: Array<Parameters<OpenedSession["respondPermission"]>[0]> = [];
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const permission = permissionSession(responded, cancelled);
		let promptCount = 0;
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: permission.session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
			requestPermission: async () => {
				promptCount += 1;
				return "cancel";
			},
		});

		try {
			const stream = await startBridgeStream(bridge, model, context);
			await permission.permissionObserved;
			expect(promptCount).toBe(1);
			await permission.actionObserved;
			const result = await stream.result();

			expect(result.stopReason).toBe("aborted");
			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
			expect(responded).toEqual([{ requestId: "permission-1", decision: "deny" }]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "user_requested" }]);
		} finally {
			await bridge.close();
		}
	});

	test("fails and cancels the turn when the OMP permission UI errors", async () => {
		const responded: Array<Parameters<OpenedSession["respondPermission"]>[0]> = [];
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const permission = permissionSession(responded, cancelled);
		let promptCount = 0;
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: permission.session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
			requestPermission: async () => {
				promptCount += 1;
				throw new Error("permission UI failed");
			},
		});

		try {
			const stream = await startBridgeStream(bridge, model, context);
			await permission.permissionObserved;
			expect(promptCount).toBe(1);
			await permission.actionObserved;
			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
			expect(result.errorMessage).toBe("permission UI failed");
			expect(responded).toEqual([{ requestId: "permission-1", decision: "deny" }]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "user_requested" }]);
		} finally {
			await bridge.close();
		}
	});

	test("fails closed when permission UI wiring is missing", async () => {
		const responded: Array<Parameters<OpenedSession["respondPermission"]>[0]> = [];
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const permission = permissionSession(responded, cancelled);
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: permission.session,
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const stream = await startBridgeStream(bridge, model, context);
			await permission.permissionObserved;
			expect(stream.resultSettled).toBeTrue();
			await permission.actionObserved;
			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
			expect(result.errorMessage).toContain("permission UI");
			expect(responded).toEqual([{ requestId: "permission-1", decision: "deny" }]);
			expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "user_requested" }]);
		} finally {
			await bridge.close();
		}
	});

	test("fails closed when OMP selects a model the fixed E4 session cannot accept", async () => {
		const submitted: SubmitInput[] = [];
		const selectedModel = { ...model, id: `${model.id}-selected` };
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession([started, wireEvent(3, "turn_completed", {})], submitted),
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model: model },
		});

		try {
			const stream = await startBridgeStream(bridge, selectedModel, context);
			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("does not support per-turn model selection");
			expect(submitted).toEqual([]);
		} finally {
			await bridge.close();
		}
	});

	test("reconfigures the backend model before admitting a turn", async () => {
		const submitted: SubmitInput[] = [];
		const selectedModel = { ...model, provider: "cli_mock", id: "reference" };
		const selections: E4BackendModelAttribution[] = [];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession([started, wireEvent(3, "turn_completed", {})], submitted),
			durableCursor: undefined,
			releaseAgentEvent() {},
			async projectionCommitted() {},
			async emitAgentEvent() {},
			modelPolicy: { kind: "fixed", model },
			async selectModel(selected) {
				selections.push(selected);
				return selected;
			},
		});

		try {
			const result = await (await startBridgeStream(bridge, selectedModel, context)).result();

			expect(result.stopReason).toBe("stop");
			expect(result.provider).toBe("cli_mock");
			expect(result.model).toBe("reference");
			expect(submitted).toHaveLength(1);
			expect(selections).toEqual([{ api: selectedModel.api, provider: "cli_mock", id: "reference" }]);
		} finally {
			await bridge.close();
		}
	});
	test("does not observe before explicit activation and forwards the durable SDK cursor once", async () => {
		let observations = 0;
		let observedAfter: { eventId: string; sequence: number } | undefined;
		const observing = Promise.withResolvers<void>();
		const session: OpenedSession = {
			...openedSession([], []),
			async *events(request) {
				observations += 1;
				observedAfter = request?.after;
				observing.resolve();
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: { eventId: "event-41", sequence: 41 },
			async emitAgentEvent() {},
			releaseAgentEvent() {},
			async projectionCommitted() {},
			modelPolicy: { kind: "fixed", model },
		});

		expect(observations).toBe(0);
		bridge.start();
		bridge.start();
		await observing.promise;
		expect(observations).toBe(1);
		expect(observedAfter).toEqual({ eventId: "event-41", sequence: 41 });
		await bridge.close();
	});

	test("omits SDK after for a sequence-zero cursor and fails StreamFn closed before activation", async () => {
		let observedAfter: unknown = "not-observed";
		const observing = Promise.withResolvers<void>();
		const session: OpenedSession = {
			...openedSession([], []),
			async *events(request) {
				observedAfter = request?.after;
				observing.resolve();
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: { eventId: "event-0", sequence: 0 },
			async emitAgentEvent() {},
			releaseAgentEvent() {},
			async projectionCommitted() {},
			modelPolicy: { kind: "fixed", model },
		});

		const result = await (await bridge.stream(model, context)).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("not started");
		bridge.start();
		await observing.promise;
		expect(observedAfter).toBeUndefined();
		await bridge.close();
	});

	test("adopts an uncommitted final response as one durable native assistant message", async () => {
		const projected: AgentEvent[] = [];
		const projectionKeys: string[] = [];
		const releasedKeys: string[] = [];
		const committed = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const events = [
			started,
			wireEvent(3, "assistant.message.delta", { text: "replayed" }),
			wireEvent(4, "assistant.message.end", { text: "replayed" }),
			wireEvent(5, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, []),
			durableCursor: { eventId: "event-1", sequence: 1 },
			ownedSubmissions: [ownedReceipt],
			async emitAgentEvent(event, key) {
				projected.push(event);
				projectionKeys.push(key);
			},
			releaseAgentEvent(key) {
				releasedKeys.push(key);
				if (releasedKeys.length === 2) released.resolve();
			},
			async projectionCommitted(cursor) {
				if (cursor.sequence === 5) committed.resolve();
			},
			modelPolicy: { kind: "fixed", model },
		});

		bridge.start();
		await committed.promise;
		await released.promise;
		expect(projected.map(event => event.type)).toEqual(["message_start", "message_end"]);
		const terminal = projected[1];
		if (terminal?.type !== "message_end") throw new Error("expected adopted assistant message_end");
		if (terminal.message.role !== "assistant") throw new Error("expected adopted assistant message");
		expect(terminal.message.content).toEqual([{ type: "text", text: "replayed" }]);
		expect(terminal.message.responseId).toBe("breadboard:e4:event-5");
		expect(projectionKeys).toEqual(["event-5:message_start", "event-5:message_end"]);
		expect(releasedKeys).toEqual(projectionKeys);
		await bridge.close();
	});

	test("suppresses an adopted final response already proven by a durable projection receipt", async () => {
		const projected: AgentEvent[] = [];
		const releasedKeys: string[] = [];
		const committed = Promise.withResolvers<void>();
		const events = [
			started,
			wireEvent(3, "assistant.message.delta", { text: "already durable" }),
			wireEvent(4, "assistant.message.end", { text: "already durable" }),
			wireEvent(5, "turn_completed", {}),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, []),
			durableCursor: { eventId: "event-1", sequence: 1 },
			projectionReceiptEventIds: new Set(["event-5"]),
			ownedSubmissions: [ownedReceipt],
			async emitAgentEvent(event) {
				projected.push(event);
			},
			releaseAgentEvent(key) {
				releasedKeys.push(key);
			},
			async projectionCommitted(cursor) {
				if (cursor.sequence === 5) committed.resolve();
			},
			modelPolicy: { kind: "fixed", model },
		});

		bridge.start();
		await committed.promise;
		expect(projected).toEqual([]);
		expect(releasedKeys).toEqual([]);
		await bridge.close();
	});

	test("does not adopt another client's replayed turn from the same canonical session", async () => {
		const projected: AgentEvent[] = [];
		const commits: Array<{ eventId: string; sequence: number }> = [];
		const committed = Promise.withResolvers<void>();
		const events = [
			wireEvent(2, "turn_start", {}, "turn-2"),
			wireEvent(3, "assistant.message.delta", { text: "foreign" }, "turn-2"),
			wireEvent(4, "assistant.message.end", { text: "foreign" }, "turn-2"),
			wireEvent(5, "turn_completed", {}, "turn-2"),
		];
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session: openedSession(events, []),
			durableCursor: { eventId: "event-1", sequence: 1 },
			ownedSubmissions: [ownedReceipt],
			async emitAgentEvent(event) {
				projected.push(event);
			},
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				commits.push(cursor);
				if (cursor.sequence === 5) committed.resolve();
			},
			modelPolicy: { kind: "fixed", model },
		});

		bridge.start();
		await committed.promise;
		expect(projected).toEqual([]);
		expect(commits.map(cursor => cursor.sequence)).toEqual([2, 3, 4, 5]);
		await bridge.close();
	});

	test("holds the local terminal and later observed cursors until native persistence is proven by the next turn", async () => {
		const submitted: SubmitInput[] = [];
		const firstSubmitted = Promise.withResolvers<void>();
		const secondSubmitted = Promise.withResolvers<void>();
		const globalProcessed = Promise.withResolvers<void>();
		const commits: Array<{ eventId: string; sequence: number }> = [];
		const lifecycle: string[] = [];
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: "client-message-2" as ClientMessageId,
			inputId: "input-2" as SubmitReceipt["inputId"],
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		const session: OpenedSession = {
			...openedSession([], submitted),
			async submit(input) {
				submitted.push(input);
				if (submitted.length === 1) {
					firstSubmitted.resolve();
					return receipt;
				}
				lifecycle.push("submit:2");
				secondSubmitted.resolve();
				return secondReceipt;
			},
			async cancel() {
				return {} as CancellationReceipt;
			},
			async *events(request) {
				await firstSubmitted.promise;
				yield started;
				yield wireEvent(3, "assistant.message.delta", { text: "durable boundary" });
				yield wireEvent(4, "assistant.message.end", { text: "durable boundary" });
				yield wireEvent(5, "turn_completed", {});
				yield wireEvent(
					6,
					"todo_event",
					{
						todo: {
							op: "snapshot",
							scope_label: "Verification",
							items: [{ id: "task-1", title: "Hold the cursor", status: "done" }],
						},
					},
					null,
				);
				globalProcessed.resolve();
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			async emitAgentEvent() {},
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				commits.push(cursor);
				lifecycle.push(`commit:${cursor.sequence}`);
			},
			modelPolicy: { kind: "fixed", model },
		});

		const firstStream = await startBridgeStream(bridge, model, context);
		expect((await firstStream.result()).stopReason).toBe("stop");
		await globalProcessed.promise;
		expect(commits).toEqual([{ eventId: "event-2", sequence: 2 }]);
		const secondStream = await bridge.stream(model, context);
		await secondSubmitted.promise;
		expect(commits).toEqual([
			{ eventId: "event-2", sequence: 2 },
			{ eventId: "event-6", sequence: 6 },
		]);
		expect(lifecycle.slice(-2)).toEqual(["commit:6", "submit:2"]);
		await bridge.close();
		expect((await secondStream.result()).stopReason).toBe("aborted");
	});

	test("commits the held terminal cursor during close when no next turn is submitted", async () => {
		const submitted: SubmitInput[] = [];
		const admitted = Promise.withResolvers<void>();
		const globalProcessed = Promise.withResolvers<void>();
		const commits: Array<{ eventId: string; sequence: number }> = [];
		const session: OpenedSession = {
			...openedSession([], submitted),
			async submit(input) {
				submitted.push(input);
				admitted.resolve();
				return receipt;
			},
			async *events(request) {
				await admitted.promise;
				yield started;
				yield wireEvent(3, "assistant.message.delta", { text: "durable boundary" });
				yield wireEvent(4, "assistant.message.end", { text: "durable boundary" });
				yield wireEvent(5, "turn_completed", {});
				yield wireEvent(
					6,
					"todo_event",
					{
						todo: {
							op: "snapshot",
							scope_label: "Verification",
							items: [{ id: "task-1", title: "Commit on close", status: "done" }],
						},
					},
					null,
				);
				globalProcessed.resolve();
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			async emitAgentEvent() {},
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				commits.push(cursor);
			},
			modelPolicy: { kind: "fixed", model },
		});

		const stream = await startBridgeStream(bridge, model, context);
		expect((await stream.result()).stopReason).toBe("stop");
		await globalProcessed.promise;
		expect(commits).toEqual([{ eventId: "event-2", sequence: 2 }]);

		await bridge.close();
		expect(commits).toEqual([
			{ eventId: "event-2", sequence: 2 },
			{ eventId: "event-6", sequence: 6 },
		]);
	});

	test("settles a tool-owning permission cancellation before releasing keys or admitting the next turn", async () => {
		const submitted: SubmitInput[] = [];
		const firstSubmitted = Promise.withResolvers<void>();
		const cancellationAccepted = Promise.withResolvers<void>();
		const terminalProcessed = Promise.withResolvers<void>();
		const secondSubmitted = Promise.withResolvers<void>();
		const projectedKeys: string[] = [];
		const releasedKeys: string[] = [];
		const commits: Array<{ eventId: string; sequence: number }> = [];
		const responded: Array<Parameters<OpenedSession["respondPermission"]>[0]> = [];
		const cancelled: Array<Parameters<OpenedSession["cancel"]>[0]> = [];
		const secondReceipt: SubmitReceipt = {
			...receipt,
			clientMessageId: "client-message-2" as ClientMessageId,
			inputId: "input-2" as SubmitReceipt["inputId"],
			turnId: "turn-2" as SubmitReceipt["turnId"],
		};
		const session: OpenedSession = {
			...openedSession([], submitted),
			async submit(input) {
				submitted.push(input);
				if (submitted.length === 1) {
					firstSubmitted.resolve();
					return receipt;
				}
				secondSubmitted.resolve();
				return secondReceipt;
			},
			async cancel(request) {
				cancelled.push(request);
				if (String(request.turnId) === String(receipt.turnId)) cancellationAccepted.resolve();
				return {} as CancellationReceipt;
			},
			async respondPermission(request) {
				responded.push(request);
				return {
					requestId: request.requestId as PermissionDecisionReceipt["requestId"],
					decision: request.decision,
				};
			},
			async *events(request) {
				await firstSubmitted.promise;
				yield started;
				yield wireEvent(3, "tool_call", {
					call_id: "permission-tool",
					tool: "edit",
					arguments: { path: "README.md" },
					action: "write",
					diff_preview: null,
					progress: null,
				});
				yield wireEvent(4, "permission_request", {
					request_id: "permission-after-tool",
					tool: "edit",
					kind: "write",
					summary: "Update README.md",
					default_scope: null,
					rewindable: true,
				});
				await cancellationAccepted.promise;
				yield wireEvent(5, "turn_cancelled", { reason: "user_requested" });
				terminalProcessed.resolve();
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			async emitAgentEvent(_event, key) {
				projectedKeys.push(key);
			},
			releaseAgentEvent(key) {
				releasedKeys.push(key);
			},
			async projectionCommitted(cursor) {
				commits.push(cursor);
			},
			modelPolicy: { kind: "fixed", model },
			requestPermission: async () => "cancel",
		});

		const firstStream = await startBridgeStream(bridge, model, context);
		expect((await firstStream.result()).stopReason).toBe("aborted");
		await terminalProcessed.promise;
		expect(cancelled).toEqual([{ turnId: receipt.turnId, reason: "user_requested" }]);
		expect(responded).toEqual([{ requestId: "permission-after-tool", decision: "deny" }]);
		expect(commits).toEqual([{ eventId: "event-2", sequence: 2 }]);
		expect(releasedKeys).toEqual([]);
		const secondStream = await bridge.stream(model, context);
		await secondSubmitted.promise;
		expect(commits).toEqual([
			{ eventId: "event-2", sequence: 2 },
			{ eventId: "event-5", sequence: 5 },
		]);
		expect(projectedKeys).toEqual(["event-3:message_start", "event-3:message_end", "event-3:tool_execution_start"]);
		expect(releasedKeys).toEqual(projectedKeys);
		await bridge.close();
		expect((await secondStream.result()).stopReason).toBe("aborted");
	});

	test("answers one adopted replay permission before advancing its durable cursor", async () => {
		const permissionAnswered = Promise.withResolvers<void>();
		const terminalProcessed = Promise.withResolvers<void>();
		const lifecycle: string[] = [];
		const commits: Array<{ eventId: string; sequence: number }> = [];
		const responded: Array<Parameters<OpenedSession["respondPermission"]>[0]> = [];
		const session: OpenedSession = {
			...openedSession([], []),
			async respondPermission(request) {
				lifecycle.push("respond");
				responded.push(request);
				permissionAnswered.resolve();
				return {
					requestId: request.requestId as PermissionDecisionReceipt["requestId"],
					decision: request.decision,
				};
			},
			async *events(request) {
				yield started;
				yield wireEvent(3, "permission_request", {
					request_id: "adopted-permission",
					tool: "read",
					kind: "read",
					summary: "Inspect README.md",
					default_scope: null,
					rewindable: true,
				});
				await permissionAnswered.promise;
				yield wireEvent(4, "turn_completed", {});
				terminalProcessed.resolve();
				await new Promise<void>(resolve =>
					request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			},
		};
		const bridge = new E4AgentStreamBridge({
			async submissionOwned() {},
			session,
			durableCursor: { eventId: "event-1", sequence: 1 },
			ownedSubmissions: [ownedReceipt],
			async emitAgentEvent() {},
			releaseAgentEvent() {},
			async projectionCommitted(cursor) {
				commits.push(cursor);
				lifecycle.push(`commit:${cursor.sequence}`);
			},
			modelPolicy: { kind: "fixed", model },
			requestPermission: async () => {
				lifecycle.push("prompt");
				return "allow";
			},
		});

		bridge.start();
		await terminalProcessed.promise;
		expect(responded).toEqual([{ requestId: "adopted-permission", decision: "allow" }]);
		expect(commits).toEqual([
			{ eventId: "event-2", sequence: 2 },
			{ eventId: "event-3", sequence: 3 },
			{ eventId: "event-4", sequence: 4 },
		]);
		expect(lifecycle).toEqual(["commit:2", "prompt", "respond", "commit:3", "commit:4"]);
		await bridge.close();
	});
});
