import { LifecycleE4ClientError } from "@breadboard/sdk/lifecycle";
import {
	CanonicalE4ClientError,
	type CanonicalJsonObject,
	deterministicSerialize,
	type StructuredSubmit,
	type SubmitReceipt,
	sha256Bytes,
} from "@breadboard/sdk/session";
import type { AgentEvent, AgentToolResult, StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	breadboardCancellationRequestKey,
	type LoggedSessionEvent,
	type OpenedSession,
	type PermissionDecisionReceipt,
	type TurnId,
} from "./session-port";
import { mapE4Observation, type E4ObservationEvent, type E4ObservationNotice } from "./e4-observations";
import type { CustomMessage } from "../session/messages";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const CLOSE_SUBMISSION_GRACE_MS = 250;
const ABORT_RECOVERY_GRACE_MS = 2_000;
const ACTIVE_TURN_CLOSE_TIMEOUT_MS = 3_000;
const CLOSE_DEADLINE_EXCEEDED = Symbol("session close deadline exceeded");
const UNRESOLVED_SUBMISSION_ERROR = "BreadBoard previous submission remains unresolved after cancellation";

export type E4CloseResult =
	| { readonly kind: "closed" }
	| { readonly kind: "unresolved_cleanup"; readonly reason: string };

type PermissionTeardownState = "idle" | "responding" | "denying" | "cancelled" | "closed";
type PermissionResponseState = {
	readonly decision: Exclude<E4PermissionDecision, "cancel">;
	readonly response: Promise<PermissionDecisionReceipt>;
};

async function raceWithCloseDeadline<T>(
	operation: Promise<T>,
	deadline: number,
): Promise<T | typeof CLOSE_DEADLINE_EXCEEDED> {
	const remaining = Math.max(0, deadline - Date.now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<typeof CLOSE_DEADLINE_EXCEEDED>(resolve => {
				timer = setTimeout(() => resolve(CLOSE_DEADLINE_EXCEEDED), remaining);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export type E4BackendModelAttribution = Readonly<Pick<Model, "api" | "provider" | "id">>;

export interface E4BackendModelPolicy {
	readonly kind: "fixed";
	readonly model: E4BackendModelAttribution;
}

export type E4PermissionRequest = Extract<LoggedSessionEvent, { readonly kind: "permission_requested" }>["payload"];
export type E4PermissionDecision = "allow" | "deny" | "cancel";
export type E4PermissionHandler = (request: E4PermissionRequest, signal: AbortSignal) => Promise<E4PermissionDecision>;

type AssistantReasoningEvent = Extract<
	LoggedSessionEvent,
	{ readonly kind: "assistant_reasoning_delta" | "assistant_thought_summary_delta" }
>;
type AssistantToolStreamEvent = Extract<
	LoggedSessionEvent,
	{
		readonly kind: "assistant_tool_call_started" | "assistant_tool_call_delta" | "assistant_tool_call_completed";
	}
>;

type SessionObservationEvent = Extract<
	LoggedSessionEvent,
	{
		readonly kind:
			| "todo_updated"
			| "stream_gap_observed"
			| "session_control_observed"
			| "checkpoint_list_observed"
			| "checkpoint_restored"
			| "skills_catalog_observed"
			| "skills_selection_observed"
			| "ctree_node_observed"
			| "ctree_snapshot_observed";
	}
>;
type RuntimeErrorEvent = Extract<LoggedSessionEvent, { readonly kind: "runtime_error_observed" }>;
type SessionRuntimeErrorEvent = Extract<RuntimeErrorEvent, { readonly scope: "session" }>;
type TurnRuntimeErrorEvent = Extract<RuntimeErrorEvent, { readonly scope: "turn" }>;
type TurnEvent = Exclude<LoggedSessionEvent, SessionObservationEvent | RuntimeErrorEvent> | TurnRuntimeErrorEvent;

type ClassifiedEvent =
	| { readonly scope: "session-observation"; readonly event: SessionObservationEvent }
	| { readonly scope: "session-failure"; readonly event: SessionRuntimeErrorEvent }
	| { readonly scope: "turn"; readonly event: TurnEvent };

function assertNever(_value: never): never {
	throw new Error("BreadBoard unsupported canonical runtime event family");
}

function classifyEvent(event: LoggedSessionEvent): ClassifiedEvent {
	switch (event.kind) {
		case "todo_updated":
		case "stream_gap_observed":
		case "session_control_observed":
		case "checkpoint_list_observed":
		case "checkpoint_restored":
		case "skills_catalog_observed":
		case "skills_selection_observed":
		case "ctree_node_observed":
		case "ctree_snapshot_observed":
			return { scope: "session-observation", event };
		case "runtime_error_observed":
			return event.scope === "session" ? { scope: "session-failure", event } : { scope: "turn", event };
		case "input_observed":
		case "turn_started":
		case "assistant_text_delta":
		case "assistant_text_completed":
		case "turn_completed":
		case "turn_failed":
		case "turn_cancelled":
		case "conversation_compaction_started":
		case "conversation_compaction_completed":
		case "assistant_message_started":
		case "assistant_reasoning_delta":
		case "assistant_thought_summary_delta":
		case "assistant_tool_call_started":
		case "assistant_tool_call_delta":
		case "assistant_tool_call_completed":
		case "tool_execution_started":
		case "tool_execution_stdout_delta":
		case "tool_execution_stderr_delta":
		case "tool_execution_completed":
		case "tool_called":
		case "tool_result_observed":
		case "permission_requested":
		case "permission_responded":
		case "task_event_observed":
		case "warning_observed":
		case "reward_updated":
		case "limits_updated":
		case "completion_observed":
		case "log_linked":
		case "run_finished":
			return { scope: "turn", event };
		default:
			return assertNever(event);
	}
}

const E4_OBSERVATION_MESSAGE_TYPE = "breadboard:e4-observation";

function e4ObservationMessage(event: E4ObservationEvent): CustomMessage<E4ObservationNotice> {
	const notice = mapE4Observation(event);
	return {
		role: "custom",
		customType: E4_OBSERVATION_MESSAGE_TYPE,
		content: notice.text,
		display: true,
		details: notice,
		timestamp: event.occurredAtMs,
	};
}

interface StreamedToolCallState {
	readonly callId: string;
	index: number;
	tool: string | null;
	argumentsJson: string;
	ended: boolean;
}

interface TurnSink {
	readonly model: E4BackendModelAttribution;
	readonly stream: AssistantMessageEventStream | undefined;
	readonly adopted: boolean;
	readonly permissionAbort: AbortController;
	permissionRequestId: string | undefined;
	permissionResponses?: Map<string, PermissionResponseState>;
	permissionTeardown: Promise<boolean> | undefined;
	permissionTeardownState: PermissionTeardownState;
	readonly toolCallsByCallId: Map<string, Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>>;
	readonly projectedToolCallIds: Set<string>;
	readonly projectedToolResultIds: Set<string>;
	readonly pendingProjectionKeys: string[];
	readonly streamedToolCallsByCallId: Map<string, StreamedToolCallState>;
	turnId: TurnId | undefined;
	cancellationRequestKey: string | undefined;
	cancelRequested: boolean;
	text: string;
	messageText: string;
	started: boolean;
	textStarted: boolean;
	failureDelivered: boolean;
	terminal: boolean;
	thinkingText: string;
	reasoningStarted: boolean;
	pendingReasoningEvent: AssistantReasoningEvent | undefined;
	pendingTextCompletion: Extract<LoggedSessionEvent, { readonly kind: "assistant_text_completed" }> | undefined;
}

interface PendingSubmit {
	readonly canonicalDigest: string;
	readonly input: StructuredSubmit;
	recoveringAfterAbort: boolean;
	recovery?: Promise<void>;
	turnId: TurnId | undefined;
}

export interface E4DurableCursor {
	readonly eventId: string;
	readonly sequence: number;
}

export const E4_PROJECTION_RECEIPT_PREFIX = "breadboard:e4:";

export function breadboardProjectionEventId(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	if ("responseId" in message && typeof message.responseId === "string") {
		if (message.responseId.startsWith(E4_PROJECTION_RECEIPT_PREFIX)) {
			return message.responseId.slice(E4_PROJECTION_RECEIPT_PREFIX.length) || undefined;
		}
	}
	if (!("details" in message) || !message.details || typeof message.details !== "object") return undefined;
	if (!("breadboardProjectionEventId" in message.details)) return undefined;
	const eventId = message.details.breadboardProjectionEventId;
	return typeof eventId === "string" && eventId ? eventId : undefined;
}

export interface E4OwnedSubmission {
	readonly clientMessageId: string;
	readonly inputId: string;
	readonly turnId: string;
}

export interface E4AgentStreamBridgeOptions {
	readonly session: OpenedSession;
	readonly durableCursor?: E4DurableCursor;
	readonly projectionReceiptEventIds?: ReadonlySet<string>;
	readonly ownedSubmissions?: readonly E4OwnedSubmission[];
	readonly emitAgentEvent: (event: AgentEvent, idempotencyKey: string) => Promise<void>;
	readonly releaseAgentEvent: (idempotencyKey: string) => void;
	readonly submissionOwned: (submission: E4OwnedSubmission) => Promise<void>;
	readonly projectionCommitted: (
		cursor: E4DurableCursor,
		ownedSubmissions: readonly E4OwnedSubmission[],
	) => Promise<void>;
	readonly modelPolicy?: E4BackendModelPolicy;
	readonly selectModel?: (model: E4BackendModelAttribution) => Promise<E4BackendModelAttribution>;
	readonly requestPermission?: E4PermissionHandler;
}

/**
 * Adapts one canonical BreadBoard E4 session to OMP's provider-stream seam.
 *
 * OMP remains authoritative for CLI parsing, the AgentSession state machine,
 * InteractiveMode, composer, commands, selectors, transcript, and terminal
 * cleanup. BreadBoard owns durable turn admission and execution. The bridge
 * projects backend assistant/tool events into the native OMP event contracts;
 * it never implements a second UI or command shell.
 */
export class E4AgentStreamBridge {
	readonly stream: StreamFn;
	readonly #session: OpenedSession;
	readonly #emitAgentEvent: E4AgentStreamBridgeOptions["emitAgentEvent"];
	readonly #releaseAgentEvent: E4AgentStreamBridgeOptions["releaseAgentEvent"];
	readonly #projectionCommitted: E4AgentStreamBridgeOptions["projectionCommitted"];
	readonly #submissionOwned: E4AgentStreamBridgeOptions["submissionOwned"];
	readonly #receipts: ReadonlySet<string>;
	readonly #selectModel: E4AgentStreamBridgeOptions["selectModel"];
	readonly #requestPermission: E4PermissionHandler | undefined;
	readonly #initialCursor: E4DurableCursor | undefined;
	readonly #observeAbort = new AbortController();
	readonly #closeAdmissionAbort = new AbortController();
	readonly #sinks = new Map<string, TurnSink>();
	readonly #adoptedTerminalTurnIds = new Set<string>();
	readonly #ownedSubmissions = new Map<string, E4OwnedSubmission>();
	readonly #submittingSinks = new Set<TurnSink>();
	readonly #submissionsInFlight = new Set<Promise<void>>();
	readonly #lateSubmissionRecoveries = new Set<Promise<void>>();
	readonly #undurableSinks = new Set<TurnSink>();
	readonly #deferredProjectionKeys: string[] = [];
	readonly #cancellationsInFlight = new Set<Promise<boolean>>();
	readonly #eventApplicationsInFlight = new Set<Promise<void>>();
	readonly #ownershipWaiters = new Set<() => void>();
	readonly #cancellationRequests = new Map<
		string,
		{ readonly key: string; accepted: boolean; inFlight?: Promise<boolean> }
	>();
	#activeModel: E4BackendModelAttribution | undefined;
	#modelSelectionBarrier = Promise.resolve();
	#started = false;
	#closed = false;
	#observeFailure: Error | undefined;
	#observeFailureProjectionEventId: string | undefined;
	#pendingSubmit: PendingSubmit | undefined;
	#terminalCursor: E4DurableCursor | undefined;
	#closePromise: Promise<E4CloseResult> | undefined;

	constructor(options: E4AgentStreamBridgeOptions) {
		this.#session = options.session;
		this.#emitAgentEvent = options.emitAgentEvent;
		this.#releaseAgentEvent = options.releaseAgentEvent;
		this.#projectionCommitted = options.projectionCommitted;
		this.#submissionOwned = options.submissionOwned;
		this.#receipts = options.projectionReceiptEventIds ?? new Set();
		this.#activeModel = options.modelPolicy?.model;
		this.#selectModel = options.selectModel;
		this.#requestPermission = options.requestPermission;
		this.#initialCursor = options.durableCursor;
		for (const submission of options.ownedSubmissions ?? []) {
			const key = String(submission.turnId);
			const previous = this.#ownedSubmissions.get(key);
			if (
				previous &&
				(previous.inputId !== submission.inputId || previous.clientMessageId !== submission.clientMessageId)
			) {
				throw new Error(`BreadBoard owned submission ${key} has conflicting correlation`);
			}
			this.#ownedSubmissions.set(key, submission);
		}
		this.stream = (model, context, streamOptions) => {
			const stream = new AssistantMessageEventStream();
			if (!this.#started) {
				this.#pushStandaloneError(stream, model, "BreadBoard E4 bridge is not started", "error");
				return stream;
			}
			const admission: Promise<void> = this.#startTurn(model, context, stream, streamOptions?.signal).finally(() => {
				this.#submissionsInFlight.delete(admission);
			});
			this.#submissionsInFlight.add(admission);
			return stream;
		};
	}

	start(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		void this.#observe();
	}

	close(): Promise<E4CloseResult> {
		this.#closePromise ??= this.#performClose();
		return this.#closePromise;
	}

	async #waitForSubmissionCleanup(deadline: number): Promise<string | undefined> {
		while (Date.now() < deadline) {
			const pending = [...this.#submissionsInFlight, ...this.#lateSubmissionRecoveries];
			if (pending.length === 0 && this.#pendingSubmit === undefined) return undefined;
			const settled = await raceWithCloseDeadline(Promise.allSettled(pending), deadline);
			if (settled === CLOSE_DEADLINE_EXCEEDED) return "submission ownership cleanup timed out";
		}
		return "submission ownership cleanup timed out";
	}

	async #waitForActiveTurnsToSettle(deadline: number): Promise<string | undefined> {
		while (Date.now() < deadline) {
			let activeTurnId: TurnId | null;
			try {
				const snapshot = await raceWithCloseDeadline(this.#session.snapshot(), deadline);
				if (snapshot === CLOSE_DEADLINE_EXCEEDED) return "active-turn snapshot timed out";
				activeTurnId = snapshot.activeTurnId;
			} catch (error) {
				return `active-turn snapshot failed: ${safeErrorMessage(error)}`;
			}
			if (activeTurnId === null) return undefined;
			const cancellation = await raceWithCloseDeadline(
				this.#requestCancellation(activeTurnId, "user_requested"),
				deadline,
			);
			if (cancellation === CLOSE_DEADLINE_EXCEEDED) return "active-turn cancellation timed out";
			if (!cancellation) return "active-turn cancellation failed";
			const remaining = deadline - Date.now();
			if (remaining <= 0) return "active turn remained active until the close deadline";
			await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remaining)));
		}
		return "active turn remained active until the close deadline";
	}

	async #performClose(): Promise<E4CloseResult> {
		this.#closed = true;
		this.#observeAbort.abort();
		this.#closeAdmissionAbort.abort();
		this.#notifyOwnershipWaiters();
		const deadline = Date.now() + ACTIVE_TURN_CLOSE_TIMEOUT_MS;
		const reasons: string[] = [];
		const sinks = [...this.#sinks.values(), ...this.#submittingSinks];
		const teardownPromises: Promise<boolean>[] = [];
		for (const sink of sinks) {
			const teardown = this.#cancelSink(sink, "user_requested");
			if (teardown) teardownPromises.push(teardown);
			this.#failSink(sink, "BreadBoard session closed", "aborted");
		}
		if (teardownPromises.length > 0) {
			const teardown = await raceWithCloseDeadline(
				Promise.all(teardownPromises).then(results => results.every(Boolean)),
				deadline,
			);
			if (teardown === CLOSE_DEADLINE_EXCEEDED) reasons.push("sink teardown timed out");
			else if (!teardown) reasons.push("sink teardown failed");
		}
		const submissionCleanup = await this.#waitForSubmissionCleanup(deadline);
		if (submissionCleanup) reasons.push(submissionCleanup);
		const activeTurnCleanup = await this.#waitForActiveTurnsToSettle(deadline);
		if (activeTurnCleanup) reasons.push(activeTurnCleanup);
		let cursor: void | typeof CLOSE_DEADLINE_EXCEEDED;
		try {
			cursor = await raceWithCloseDeadline(this.#commitTerminalCursor(), deadline);
		} catch (error) {
			reasons.push(`terminal cursor commit failed: ${safeErrorMessage(error)}`);
			cursor = undefined;
		}
		if (cursor === CLOSE_DEADLINE_EXCEEDED) reasons.push("terminal cursor commit timed out");
		let closeResult: void | typeof CLOSE_DEADLINE_EXCEEDED;
		try {
			closeResult = await raceWithCloseDeadline(this.#session.close(), deadline);
		} catch (error) {
			reasons.push(`SDK session close failed: ${safeErrorMessage(error)}`);
			closeResult = undefined;
		}
		if (closeResult === CLOSE_DEADLINE_EXCEEDED) reasons.push("SDK session close timed out");
		for (const sink of sinks) sink.permissionTeardownState = "closed";
		this.#adoptedTerminalTurnIds.clear();
		this.#submittingSinks.clear();
		if (reasons.length > 0) {
			return { kind: "unresolved_cleanup", reason: reasons.join("; ") };
		}
		return { kind: "closed" };
	}

	async #commitTerminalCursor(): Promise<void> {
		const cursor = this.#terminalCursor;
		if (!cursor) return;
		if (this.#undurableSinks.size > 0) {
			throw new Error("BreadBoard cannot commit a terminal cursor while replay projection is incomplete");
		}
		await this.#projectionCommitted(cursor, this.#ownedSubmissionSnapshot());
		for (const key of this.#deferredProjectionKeys.splice(0)) this.#releaseAgentEvent(key);
		this.#terminalCursor = undefined;
	}

	#newSink(model: E4BackendModelAttribution, stream?: AssistantMessageEventStream): TurnSink {
		return {
			model,
			stream,
			adopted: !stream,
			permissionAbort: new AbortController(),
			permissionRequestId: undefined,
			permissionTeardown: undefined,
			permissionTeardownState: "idle",
			toolCallsByCallId: new Map(),
			projectedToolCallIds: new Set(),
			projectedToolResultIds: new Set(),
			streamedToolCallsByCallId: new Map(),
			pendingProjectionKeys: [],
			turnId: undefined,
			cancellationRequestKey: undefined,
			cancelRequested: false,
			text: "",
			messageText: "",
			started: false,
			textStarted: false,
			thinkingText: "",
			reasoningStarted: false,
			pendingReasoningEvent: undefined,
			failureDelivered: false,
			terminal: false,
			pendingTextCompletion: undefined,
		};
	}

	#ensureCancellationRequest(turnId: TurnId): {
		readonly key: string;
		accepted: boolean;
		inFlight?: Promise<boolean>;
	} {
		const requestId = `${String(this.#session.sessionId)}:${String(turnId)}`;
		const existing = this.#cancellationRequests.get(requestId);
		if (existing) return existing;
		const created = { key: breadboardCancellationRequestKey(this.#session.sessionId, turnId), accepted: false };
		this.#cancellationRequests.set(requestId, created);
		return created;
	}

	#requestCancellation(turnId: TurnId, reason: "user_requested" | "timeout"): Promise<boolean> {
		const state = this.#ensureCancellationRequest(turnId);
		if (state.accepted) return Promise.resolve(true);
		if (state.inFlight) return state.inFlight;
		const request = this.#cancel(turnId, reason, state.key).then(result => {
			if (result) state.accepted = true;
			return result;
		});
		let tracked: Promise<boolean>;
		tracked = request.finally(() => {
			state.inFlight = undefined;
			this.#cancellationsInFlight.delete(tracked);
		});
		this.#cancellationsInFlight.add(tracked);
		state.inFlight = tracked;
		return tracked;
	}

	#ownedSubmissionSnapshot(): readonly E4OwnedSubmission[] {
		return [...this.#ownedSubmissions.values()].sort((left, right) => left.turnId.localeCompare(right.turnId));
	}

	#notifyOwnershipWaiters(): void {
		for (const resolve of this.#ownershipWaiters) resolve();
		this.#ownershipWaiters.clear();
	}

	#waitForOwnershipChange(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ownershipWaiters.add(resolve);
		return promise;
	}
	async #waitForSubmissionsOrOwnershipChange(submissions: readonly Promise<void>[]): Promise<void> {
		if (this.#closed) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ownershipWaiters.add(resolve);
		try {
			await Promise.race([Promise.all(submissions), promise]);
		} finally {
			this.#ownershipWaiters.delete(resolve);
		}
	}

	async #recordOwnedCorrelation(submission: E4OwnedSubmission, turnId: TurnId, notifyWaiters = true): Promise<void> {
		const previous = this.#ownedSubmissions.get(submission.turnId);
		if (
			previous &&
			(previous.inputId !== submission.inputId || previous.clientMessageId !== submission.clientMessageId)
		) {
			throw new Error(`BreadBoard submission receipt collided with owned turn ${submission.turnId}`);
		}
		if (previous) return;
		try {
			await this.#submissionOwned(submission);
			const persisted = this.#ownedSubmissions.get(submission.turnId);
			if (
				persisted &&
				(persisted.inputId !== submission.inputId || persisted.clientMessageId !== submission.clientMessageId)
			) {
				throw new Error(`BreadBoard durable submission ownership collided for turn ${submission.turnId}`);
			}
			this.#ownedSubmissions.set(submission.turnId, persisted ?? submission);
			if (notifyWaiters) this.#notifyOwnershipWaiters();
		} catch (error) {
			this.#invalidateBridge(`BreadBoard submission ownership persistence failed: ${safeErrorMessage(error)}`);
			await this.#requestCancellation(turnId, "user_requested");
			throw error;
		}
	}

	async #recordOwnedSubmission(receipt: SubmitReceipt, notifyWaiters = true): Promise<void> {
		await this.#recordOwnedCorrelation(
			{
				clientMessageId: String(receipt.clientMessageId),
				inputId: String(receipt.inputId),
				turnId: String(receipt.turnId),
			},
			receipt.turnId,
			notifyWaiters,
		);
	}

	async #finishInterruptedSubmission(attempt: PendingSubmit, receipt: SubmitReceipt): Promise<void> {
		try {
			const turnKey = String(receipt.turnId);
			if (this.#closed || this.#observeFailure) {
				attempt.turnId = receipt.turnId;
				await this.#requestCancellation(receipt.turnId, "user_requested");
				return;
			}
			if (this.#adoptedTerminalTurnIds.has(turnKey)) {
				attempt.turnId = receipt.turnId;
				return;
			}
			await this.#recordOwnedSubmission(receipt);
			attempt.turnId = receipt.turnId;
			if (this.#adoptedTerminalTurnIds.has(turnKey)) return;
			await this.#requestCancellation(receipt.turnId, "user_requested");
		} finally {
			attempt.recoveringAfterAbort = false;
			if (this.#pendingSubmit === attempt) {
				this.#pendingSubmit = undefined;
				this.#notifyOwnershipWaiters();
			}
		}
	}

	#trackLateSubmissionRecovery(operation: Promise<void>): Promise<void> {
		const recovery: Promise<void> = operation
			.catch(error => {
				if (!this.#closed) {
					this.#invalidateBridge(`BreadBoard aborted submission recovery failed: ${safeErrorMessage(error)}`);
				}
			})
			.finally(() => {
				this.#lateSubmissionRecoveries.delete(recovery);
			});
		this.#lateSubmissionRecoveries.add(recovery);
		return recovery;
	}

	#handleInterruptedSubmissionRejection(attempt: PendingSubmit, error: unknown): void {
		attempt.recoveringAfterAbort = false;
		if (this.#pendingSubmit === attempt && !isAmbiguousSubmitFailure(error)) {
			this.#pendingSubmit = undefined;
			this.#notifyOwnershipWaiters();
		}
		if (isUncorrelatedSubmitReceiptFailure(error)) {
			this.#invalidateBridge("BreadBoard submission response lost canonical ownership correlation");
		}
	}

	async #submitAttempt(
		attempt: PendingSubmit,
		sink: TurnSink,
		signal: AbortSignal | undefined,
	): Promise<SubmitReceipt | undefined> {
		if (signal?.aborted) {
			this.#failSink(sink, "BreadBoard submission cancelled before admission", "aborted");
			return undefined;
		}
		const submission = this.#session.submit(attempt.input);
		const interruptedToken = Symbol("interrupted");
		const { promise: interrupted, resolve: resolveInterrupted } = Promise.withResolvers<typeof interruptedToken>();
		const interruptSubmission = () => resolveInterrupted(interruptedToken);
		const closeSignal = this.#closeAdmissionAbort.signal;
		if (signal?.aborted || closeSignal.aborted) interruptSubmission();
		signal?.addEventListener("abort", interruptSubmission, { once: true });
		closeSignal.addEventListener("abort", interruptSubmission, { once: true });
		let result: SubmitReceipt | typeof interruptedToken;
		try {
			result = await Promise.race([submission, interrupted]);
		} catch (error) {
			if (isUncorrelatedSubmitReceiptFailure(error)) {
				this.#invalidateBridge("BreadBoard submission response lost canonical ownership correlation");
			}
			throw error;
		} finally {
			signal?.removeEventListener("abort", interruptSubmission);
			closeSignal.removeEventListener("abort", interruptSubmission);
		}
		if (result !== interruptedToken) return result;

		attempt.recoveringAfterAbort = true;
		this.#pendingSubmit ??= attempt;
		const recovery = Promise.withResolvers<void>();
		attempt.recovery = recovery.promise;
		void submission.then(
			receipt => {
				const tracked = this.#trackLateSubmissionRecovery(this.#finishInterruptedSubmission(attempt, receipt));
				void tracked.then(recovery.resolve, recovery.reject);
			},
			error => {
				this.#handleInterruptedSubmissionRejection(attempt, error);
				recovery.resolve();
			},
		);
		const failure = this.#currentObserveFailure();
		this.#failSink(
			sink,
			failure?.message ?? "BreadBoard submission cancelled while admission was in progress",
			failure ? "error" : "aborted",
			failure ? this.#observeFailureProjectionEventId : undefined,
		);
		return undefined;
	}

	async #awaitPendingSubmitRecovery(attempt: PendingSubmit): Promise<void> {
		const recovery = attempt.recovery;
		if (!attempt.recoveringAfterAbort || !recovery) return;
		const outcome = await Promise.race([
			recovery.then(() => "settled" as const),
			new Promise<"grace-expired">(resolve => setTimeout(() => resolve("grace-expired"), ABORT_RECOVERY_GRACE_MS)),
		]);
		if (outcome === "grace-expired" && attempt.recoveringAfterAbort) {
			throw new Error(UNRESOLVED_SUBMISSION_ERROR);
		}
	}

	async #startTurn(
		model: Model,
		context: Context,
		stream: AssistantMessageEventStream,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (this.#closed || this.#observeFailure) {
			this.#pushStandaloneError(
				stream,
				model,
				this.#observeFailure?.message ?? "BreadBoard session is closed",
				"error",
				this.#observeFailure ? this.#observeFailureProjectionEventId : undefined,
			);
			return;
		}
		if (this.#terminalCursor) {
			try {
				await this.#commitTerminalCursor();
			} catch (error) {
				const message = `BreadBoard projection cursor commit failed: ${safeErrorMessage(error)}`;
				this.#invalidateBridge(message);
				this.#pushStandaloneError(stream, model, message, "error");
				return;
			}
		}
		let backendModel = this.#activeModel;
		if (!backendModel) {
			this.#pushStandaloneError(stream, model, "BreadBoard backend model attribution is not configured", "error");
			return;
		}
		if (backendModel.api !== model.api || backendModel.provider !== model.provider || backendModel.id !== model.id) {
			const selectedModel = { api: model.api, provider: model.provider, id: model.id };
			const selection = this.#modelSelectionBarrier.then(async () => {
				const current = this.#activeModel;
				if (
					current &&
					current.api === selectedModel.api &&
					current.provider === selectedModel.provider &&
					current.id === selectedModel.id
				) {
					return current;
				}
				if (!this.#selectModel) {
					throw new Error(
						`BreadBoard E4 session uses ${current?.provider}/${current?.id} (${current?.api}), but OMP selected ${model.provider}/${model.id} (${model.api}); E4 does not support per-turn model selection`,
					);
				}
				const selected = await this.#selectModel(selectedModel);
				if (
					selected.api !== selectedModel.api ||
					selected.provider !== selectedModel.provider ||
					selected.id !== selectedModel.id
				) {
					throw new Error("BreadBoard backend selected a different model than requested");
				}
				this.#activeModel = selected;
				return selected;
			});
			this.#modelSelectionBarrier = selection.then(
				() => {},
				() => {},
			);
			try {
				backendModel = await selection;
			} catch (error) {
				this.#pushStandaloneError(stream, model, safeErrorMessage(error), "error");
				return;
			}
		}
		const sink = this.#newSink(backendModel, stream);
		this.#submittingSinks.add(sink);
		let attempt: PendingSubmit | undefined;
		let ownershipNotificationPending = false;
		try {
			const input = submitInputFromContext(context);
			const canonicalDigest = await canonicalSubmitDigest(input);
			const pendingAttempt = this.#pendingSubmit;
			if (pendingAttempt?.recoveringAfterAbort) {
				await this.#awaitPendingSubmitRecovery(pendingAttempt);
			}
			if (this.#pendingSubmit && this.#pendingSubmit.canonicalDigest !== canonicalDigest) {
				throw new Error("BreadBoard previous submission is unresolved; retry the unchanged input");
			}
			// Only an unresolved attempt is retried under its clientMessageId. Any other submit,
			// including a prompt identical to an earlier one, is a new logical submission.
			attempt = this.#pendingSubmit ?? {
				canonicalDigest,
				input: { ...input, clientMessageId: crypto.randomUUID() },
				recoveringAfterAbort: false,
				turnId: undefined,
			};
			const receipt = await this.#submitAttempt(attempt, sink, signal);
			if (!receipt) return;
			attempt.turnId = receipt.turnId;
			const turnKey = String(receipt.turnId);
			const observedSink = this.#sinks.get(turnKey);
			if (observedSink?.adopted || this.#adoptedTerminalTurnIds.has(turnKey)) {
				if (this.#pendingSubmit === attempt) this.#pendingSubmit = undefined;
				this.#failSink(
					sink,
					"BreadBoard submission was already observed; its result is already in the transcript",
					"error",
				);
				return;
			}
			if (observedSink) {
				this.#invalidateBridge(`BreadBoard submission receipt collided with observed turn ${turnKey}`);
				return;
			}
			await this.#recordOwnedSubmission(receipt, false);
			ownershipNotificationPending = true;
			if (this.#pendingSubmit === attempt) this.#pendingSubmit = undefined;
			sink.turnId = receipt.turnId;
			sink.cancellationRequestKey = this.#ensureCancellationRequest(receipt.turnId).key;
			const failure = this.#currentObserveFailure();
			if (failure) {
				const cancellation = this.#trackCancellation(sink, "timeout");
				if (cancellation) await cancellation;
				this.#failSink(sink, failure.message, "error", this.#observeFailureProjectionEventId);
				return;
			}
			if (this.#closed) {
				this.#failSink(sink, "BreadBoard session is closed", "error");
				this.#cancelSink(sink, "user_requested");
				return;
			}
			this.#sinks.set(turnKey, sink);
			const cancel = () => {
				sink.permissionAbort.abort();
				const cancellation =
					sink.permissionRequestId === undefined
						? this.#trackCancellation(sink, "user_requested")
						: this.#denyPermissionAndCancel(sink, sink.permissionRequestId);
				void cancellation;
				void this.#finishAbortedSink(sink);
			};
			if (signal?.aborted) cancel();
			else signal?.addEventListener("abort", cancel, { once: true });
		} catch (error) {
			if (attempt && isAmbiguousSubmitFailure(error)) this.#pendingSubmit ??= attempt;
			const failure = this.#currentObserveFailure();
			this.#failSink(
				sink,
				failure?.message ?? safeErrorMessage(error),
				"error",
				failure ? this.#observeFailureProjectionEventId : undefined,
			);
		} finally {
			if (ownershipNotificationPending) this.#notifyOwnershipWaiters();
			this.#submittingSinks.delete(sink);
		}
	}

	async #trackEventApplication(application: Promise<void>): Promise<void> {
		this.#eventApplicationsInFlight.add(application);
		try {
			await application;
		} finally {
			this.#eventApplicationsInFlight.delete(application);
		}
	}
	async #emitObservationNotice(event: SessionObservationEvent): Promise<string[]> {
		switch (event.kind) {
			case "todo_updated":
			case "stream_gap_observed":
			case "session_control_observed":
			case "checkpoint_list_observed":
			case "checkpoint_restored": {
				const message = e4ObservationMessage(event);
				const startKey = `${String(event.eventId)}:observation_message_start`;
				const endKey = `${String(event.eventId)}:observation_message_end`;
				await this.#emitAgentEvent({ type: "message_start", message }, startKey);
				await this.#emitAgentEvent({ type: "message_end", message }, endKey);
				return [startKey, endKey];
			}
			default:
				return [];
		}
	}

	async #observe(): Promise<void> {
		try {
			const after = this.#initialCursor && this.#initialCursor.sequence > 0 ? this.#initialCursor : undefined;
			for await (const event of this.#session.events({ signal: this.#observeAbort.signal, after })) {
				if (this.#closed) break;
				const classified = classifyEvent(event);
				switch (classified.scope) {
					case "session-observation": {
						const noticeKeys = await this.#emitObservationNotice(classified.event);
						await this.#trackEventApplication(this.#commit(classified.event, noticeKeys));
						break;
					}
					case "session-failure":
						await this.#trackEventApplication(this.#terminalSessionFailure(classified.event));
						return;
					case "turn":
						await this.#applyTurnEvent(classified.event);
						break;
					default:
						assertNever(classified);
				}
			}
			if (!this.#closed) throw new Error("BreadBoard event observer ended unexpectedly");
		} catch (error) {
			if (!this.#closed && !this.#observeAbort.signal.aborted) this.#invalidateBridge(safeErrorMessage(error));
		}
	}

	async #applyTurnEvent(event: TurnEvent): Promise<void> {
		if (event.turnId === null || event.inputId === null) {
			throw new Error("BreadBoard turn-owned canonical event is missing correlation");
		}
		const turnKey = String(event.turnId);
		let sink = this.#sinks.get(turnKey);
		if (!sink && this.#submissionsInFlight.size && !this.#pendingSubmit?.recoveringAfterAbort) {
			await this.#waitForSubmissionsOrOwnershipChange([...this.#submissionsInFlight]);
			sink = this.#sinks.get(turnKey);
			if (this.#closed || this.#observeFailure) return;
		}
		let ownership = this.#ownedSubmissions.get(turnKey);
		const pendingAttempt = this.#pendingSubmit;
		if (!sink && !ownership && pendingAttempt && pendingAttempt.turnId === undefined) {
			await this.#waitForOwnershipChange();
			if (this.#closed || this.#observeFailure) return;
			sink = this.#sinks.get(turnKey);
			ownership = this.#ownedSubmissions.get(turnKey);
		}
		if (!sink && !ownership) {
			await this.#trackEventApplication(this.#commit(event, []));
			return;
		}
		if (ownership && ownership.inputId !== String(event.inputId)) {
			throw new Error(`BreadBoard owned turn ${turnKey} changed input correlation`);
		}
		if (!sink) {
			const backendModel = this.#activeModel;
			if (!backendModel) throw new Error("BreadBoard backend model attribution is not configured");
			sink = this.#newSink(backendModel);
			sink.turnId = event.turnId;
			sink.cancellationRequestKey = this.#ensureCancellationRequest(event.turnId).key;
			this.#sinks.set(turnKey, sink);
		}
		await this.#trackEventApplication(this.#applyEvent(sink, event));
	}

	async #applyEvent(sink: TurnSink, event: TurnEvent): Promise<void> {
		if (sink.terminal) return;
		switch (event.kind) {
			case "turn_started":
				await this.#flushReasoning(sink);
				await this.#flushAssistantText(sink);
				this.#ensureStarted(sink);
				await this.#commit(event, []);
				return;
			case "assistant_message_started":
				await this.#flushReasoning(sink);
				await this.#flushAssistantText(sink);
				this.#ensureStarted(sink);
				await this.#commit(event, []);
				return;
			case "assistant_reasoning_delta":
			case "assistant_thought_summary_delta":
				await this.#projectReasoningDelta(sink, event);
				return;
			case "assistant_text_delta":
				await this.#flushReasoning(sink);
				this.#appendText(sink, event.payload.text);
				if (event.payload.text) this.#undurableSinks.add(sink);
				return;
			case "assistant_text_completed":
				if (event.payload.text !== null && event.payload.text !== sink.messageText) {
					if (!event.payload.text.startsWith(sink.messageText)) {
						throw new Error("BreadBoard assistant stream did not match its completion");
					}
					this.#appendText(sink, event.payload.text.slice(sink.messageText.length));
				}
				sink.pendingTextCompletion = event;
				return;
			case "assistant_tool_call_started":
				await this.#projectStreamingToolStart(sink, event);
				return;
			case "assistant_tool_call_delta":
				await this.#projectStreamingToolDelta(sink, event);
				return;
			case "assistant_tool_call_completed":
				await this.#projectStreamingToolEnd(sink, event);
				return;
			case "tool_called":
				await this.#flushReasoning(sink);
				if (!sink.projectedToolCallIds.has(String(event.payload.callId))) {
					await this.#flushAssistantText(sink);
					await this.#projectToolCall(sink, event);
				}
				return;
			case "tool_result_observed":
				await this.#projectToolResult(sink, event);
				return;
			case "permission_requested":
				if ((await this.#handlePermissionRequest(sink, event)) && !sink.messageText) {
					await this.#commit(event, []);
				}
				return;
			case "turn_completed":
				await this.#flushReasoning(sink);
				await this.#completeSink(sink, event);
				return;
			case "turn_failed":
				await this.#flushReasoning(sink);
				await this.#terminalFailure(sink, event, `BreadBoard turn failed [${event.payload.error.code}]`, "error");
				return;
			case "turn_cancelled":
				await this.#flushReasoning(sink);
				await this.#terminalFailure(sink, event, `BreadBoard turn cancelled [${event.payload.reason}]`, "aborted");
				return;
			case "runtime_error_observed": {
				await this.#flushReasoning(sink);
				const message = `BreadBoard runtime error [${event.payload.error.code}]: ${event.payload.error.message}`;
				this.#failSinkPendingTerminal(sink, message, "error", String(event.eventId));
				const cancellation = this.#trackCancellation(sink, "timeout");
				if (cancellation) await cancellation;
				await this.#terminalFailure(sink, event, message, "error");
				return;
			}
			case "input_observed":
			case "conversation_compaction_started":
			case "conversation_compaction_completed":
			case "tool_execution_started":
			case "tool_execution_stdout_delta":
			case "tool_execution_stderr_delta":
			case "tool_execution_completed":
			case "permission_responded":
			case "task_event_observed":
			case "warning_observed":
			case "reward_updated":
			case "limits_updated":
			case "completion_observed":
			case "log_linked":
			case "run_finished":
				if (!sink.messageText && sink.projectedToolCallIds.size === sink.projectedToolResultIds.size) {
					await this.#commit(event, []);
				}
				return;
			default:
				return assertNever(event);
		}
	}

	async #projectReasoningDelta(sink: TurnSink, event: AssistantReasoningEvent): Promise<void> {
		this.#ensureStarted(sink);
		if (!sink.reasoningStarted) {
			sink.reasoningStarted = true;
			if (!this.#receipts.has(String(event.eventId))) {
				const initial = assistantThinkingMessage(sink.model, "", String(event.eventId));
				await this.#emit(event, "reasoning_message_start", { type: "message_start", message: initial }, sink);
				await this.#emit(
					event,
					"reasoning_start",
					{
						type: "message_update",
						message: initial,
						assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: initial },
					},
					sink,
				);
			}
		}
		sink.thinkingText += event.payload.text;
		sink.pendingReasoningEvent = event;
		if (!this.#receipts.has(String(event.eventId))) {
			const message = assistantThinkingMessage(sink.model, sink.thinkingText, String(event.eventId));
			await this.#emit(
				event,
				"reasoning_delta",
				{
					type: "message_update",
					message,
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						delta: event.payload.text,
						partial: message,
					},
				},
				sink,
			);
		}
	}

	async #flushReasoning(sink: TurnSink): Promise<void> {
		const event = sink.pendingReasoningEvent;
		if (!sink.reasoningStarted || !event) return;
		const thinking = sink.thinkingText;
		if (!this.#receipts.has(String(event.eventId))) {
			const message = assistantThinkingMessage(sink.model, thinking, String(event.eventId));
			await this.#emit(
				event,
				"reasoning_end",
				{
					type: "message_update",
					message,
					assistantMessageEvent: {
						type: "thinking_end",
						contentIndex: 0,
						content: thinking,
						partial: message,
					},
				},
				sink,
			);
			await this.#emit(event, "reasoning_message_end", { type: "message_end", message }, sink);
		}
		sink.thinkingText = "";
		sink.reasoningStarted = false;
		sink.pendingReasoningEvent = undefined;
	}

	async #projectStreamingToolStart(
		sink: TurnSink,
		event: Extract<AssistantToolStreamEvent, { readonly kind: "assistant_tool_call_started" }>,
	): Promise<void> {
		await this.#flushReasoning(sink);
		await this.#flushAssistantText(sink);
		const callId = String(event.payload.callId);
		const existing = sink.streamedToolCallsByCallId.get(callId);
		const state: StreamedToolCallState = existing ?? {
			callId,
			index: event.payload.index,
			tool: event.payload.tool,
			argumentsJson: "",
			ended: false,
		};
		state.index = event.payload.index;
		state.tool = event.payload.tool ?? state.tool;
		sink.streamedToolCallsByCallId.set(callId, state);
		if (existing || this.#receipts.has(String(event.eventId))) return;
		const message = streamedToolCallMessage(sink.model, state, String(event.eventId));
		await this.#emit(event, "streamed_tool_message_start", { type: "message_start", message }, sink);
		await this.#emit(
			event,
			"streamed_tool_start",
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
			},
			sink,
		);
	}

	async #projectStreamingToolDelta(
		sink: TurnSink,
		event: Extract<AssistantToolStreamEvent, { readonly kind: "assistant_tool_call_delta" }>,
	): Promise<void> {
		const callId = String(event.payload.callId);
		let state = sink.streamedToolCallsByCallId.get(callId);
		if (!state) {
			await this.#projectStreamingToolStart(sink, {
				...event,
				kind: "assistant_tool_call_started",
				payload: {
					index: event.payload.index,
					callId: event.payload.callId,
					tool: event.payload.tool,
				},
			});
			state = sink.streamedToolCallsByCallId.get(callId);
		}
		if (!state) throw new Error("BreadBoard tool-call delta has no start state");
		state.tool = event.payload.tool ?? state.tool;
		state.argumentsJson += event.payload.argumentsDelta;
		if (this.#receipts.has(String(event.eventId))) return;
		const message = streamedToolCallMessage(sink.model, state, String(event.eventId));
		await this.#emit(
			event,
			"streamed_tool_delta",
			{
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: event.payload.argumentsDelta,
					partial: message,
				},
			},
			sink,
		);
	}

	async #projectStreamingToolEnd(
		sink: TurnSink,
		event: Extract<AssistantToolStreamEvent, { readonly kind: "assistant_tool_call_completed" }>,
	): Promise<void> {
		const callId = String(event.payload.callId);
		let state = sink.streamedToolCallsByCallId.get(callId);
		if (!state) {
			await this.#projectStreamingToolStart(sink, {
				...event,
				kind: "assistant_tool_call_started",
				payload: {
					index: event.payload.index,
					callId: event.payload.callId,
					tool: event.payload.tool,
				},
			});
			state = sink.streamedToolCallsByCallId.get(callId);
		}
		if (!state) throw new Error("BreadBoard tool-call completion has no start state");
		state.tool = event.payload.tool ?? state.tool;
		state.argumentsJson = event.payload.arguments;
		state.ended = true;
		if (this.#receipts.has(String(event.eventId))) return;
		const message = streamedToolCallMessage(sink.model, state, String(event.eventId));
		const toolCall = message.content[0];
		if (toolCall?.type !== "toolCall") throw new Error("BreadBoard streamed tool-call projection is invalid");
		await this.#emit(
			event,
			"streamed_tool_end",
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall, partial: message },
			},
			sink,
		);
		await this.#emit(event, "streamed_tool_message_end", { type: "message_end", message }, sink);
	}

	async #projectToolCall(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>,
	): Promise<void> {
		const toolCallId = String(event.payload.callId);
		if (sink.projectedToolCallIds.has(toolCallId)) return;
		this.#undurableSinks.add(sink);
		sink.projectedToolCallIds.add(toolCallId);
		sink.toolCallsByCallId.set(toolCallId, event);
		if (this.#receipts.has(String(event.eventId))) return;
		const wasStreamed = sink.streamedToolCallsByCallId.has(toolCallId);
		if (!wasStreamed) {
			const message = assistantToolCallMessage(sink.model, event);
			await this.#emit(event, "message_start", { type: "message_start", message }, sink);
			await this.#emit(event, "message_end", { type: "message_end", message }, sink);
		}
		await this.#emit(
			event,
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId,
				toolName: event.payload.tool,
				args: event.payload.arguments,
				intent: event.payload.action ?? undefined,
			},
			sink,
		);
	}

	async #projectToolResult(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "tool_result_observed" }>,
	): Promise<void> {
		const toolCallId = String(event.payload.callId);
		if (sink.projectedToolResultIds.has(toolCallId)) return;
		const toolCall = sink.toolCallsByCallId.get(toolCallId);
		if (!toolCall) throw new Error("BreadBoard replay began mid-tool without the retained tool call");
		sink.projectedToolResultIds.add(toolCallId);
		sink.streamedToolCallsByCallId.delete(toolCallId);
		if (!this.#receipts.has(String(event.eventId))) {
			const toolName = toolCall.payload.tool;
			const result = toolResult(event.payload.result, event.payload.artifactRef, String(event.eventId));
			await this.#emit(
				event,
				"tool_execution_end",
				{ type: "tool_execution_end", toolCallId, toolName, result, isError: event.payload.error },
				sink,
			);
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName,
				content: result.content,
				details: result.details,
				isError: event.payload.error,
				timestamp: event.occurredAtMs,
			};
			await this.#emit(event, "message_start", { type: "message_start", message }, sink);
			await this.#emit(event, "message_end", { type: "message_end", message }, sink);
		}
		this.#undurableSinks.delete(sink);
		await this.#commit(event, sink.pendingProjectionKeys.splice(0));
		sink.toolCallsByCallId.delete(toolCallId);
	}

	async #handlePermissionRequest(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "permission_requested" }>,
	): Promise<boolean> {
		const requestId = String(event.payload.requestId);
		sink.permissionRequestId = requestId;
		try {
			const requestPermission = this.#requestPermission;
			if (!requestPermission) {
				this.#failSinkPendingTerminal(
					sink,
					"BreadBoard permission request requires OMP permission UI wiring",
					"error",
				);
				return this.#denyPermissionAndCancel(sink, requestId);
			}
			let decision: E4PermissionDecision;
			try {
				decision = await requestPermission(event.payload, sink.permissionAbort.signal);
			} catch (error) {
				this.#failSinkPendingTerminal(sink, safeErrorMessage(error), "error");
				return this.#denyPermissionAndCancel(sink, requestId);
			}
			if (sink.terminal || sink.permissionAbort.signal.aborted || this.#closed) return false;
			if (decision === "cancel") {
				this.#failSinkPendingTerminal(sink, "BreadBoard permission request cancelled in OMP", "aborted");
				return this.#denyPermissionAndCancel(sink, requestId);
			}
			if (sink.permissionTeardownState !== "idle") return false;
			sink.permissionTeardownState = "responding";
			try {
				const response = this.#permissionResponse(sink, requestId, decision);
				await this.#awaitPermissionResponse(requestId, response);
				if (this.#permissionTeardownClaimed(sink) && decision === "allow") return false;
				return !this.#permissionTeardownClaimed(sink);
			} catch (error) {
				this.#failSinkPendingTerminal(sink, safeErrorMessage(error), "error");
				return this.#denyPermissionAndCancel(sink, requestId);
			}
		} finally {
			if (sink.permissionRequestId === requestId) sink.permissionRequestId = undefined;
			if (sink.permissionTeardownState === "responding") sink.permissionTeardownState = "idle";
		}
	}

	#ensureStarted(sink: TurnSink): void {
		if (sink.started) return;
		sink.started = true;
		sink.stream?.push({ type: "start", partial: assistantMessage(sink.model, sink.text, "stop") });
	}

	#appendText(sink: TurnSink, delta: string): void {
		if (!delta) return;
		this.#ensureStarted(sink);
		if (!sink.textStarted) {
			sink.textStarted = true;
			sink.stream?.push({
				type: "text_start",
				contentIndex: 0,
				partial: assistantMessage(sink.model, sink.text, "stop"),
			});
		}
		sink.text += delta;
		sink.messageText += delta;
		sink.stream?.push({
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: assistantMessage(sink.model, sink.text, "stop"),
		});
	}

	async #flushAssistantText(sink: TurnSink): Promise<void> {
		if (!sink.messageText) return;
		const completion = sink.pendingTextCompletion;
		if (!completion) throw new Error("BreadBoard replay began mid-message without a completion boundary");
		const text = sink.messageText;
		const message = assistantMessage(sink.model, text, "stop", undefined, String(completion.eventId));
		if (sink.textStarted) sink.stream?.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		if (!this.#receipts.has(String(completion.eventId))) {
			await this.#emit(completion, "message_start", { type: "message_start", message }, sink);
			await this.#emit(completion, "message_end", { type: "message_end", message }, sink);
		}
		this.#undurableSinks.delete(sink);
		await this.#commit(completion, sink.pendingProjectionKeys.splice(0));
		sink.text = "";
		sink.messageText = "";
		sink.textStarted = false;
		sink.pendingTextCompletion = undefined;
		sink.stream?.push({ type: "start", partial: assistantMessage(sink.model, "", "stop") });
	}

	#settlePendingSubmit(sink: TurnSink): void {
		const attempt = this.#pendingSubmit;
		if (!attempt || sink.turnId === undefined || attempt.turnId !== sink.turnId) return;
		this.#pendingSubmit = undefined;
	}

	#rememberAdoptedTerminal(sink: TurnSink): void {
		if (sink.turnId === undefined) return;
		this.#adoptedTerminalTurnIds.add(String(sink.turnId));
		while (this.#adoptedTerminalTurnIds.size > 16) {
			const oldest = this.#adoptedTerminalTurnIds.values().next().value;
			if (oldest === undefined) break;
			this.#adoptedTerminalTurnIds.delete(oldest);
		}
	}

	async #terminalSessionFailure(event: SessionRuntimeErrorEvent): Promise<void> {
		const message = `BreadBoard runtime error [${event.payload.error.code}]: ${event.payload.error.message}`;
		if (!this.#recordObserveFailure(message)) return;
		this.#observeFailureProjectionEventId = String(event.eventId);
		this.#observeAbort.abort();
		this.#closeAdmissionAbort.abort();
		this.#notifyOwnershipWaiters();
		const sinks = [...this.#sinks.values()];
		for (const sink of sinks) {
			this.#cancelSink(sink, "timeout");
		}
		await Promise.all(this.#submissionsInFlight);
		await Promise.all(this.#cancellationsInFlight);
		for (const sink of sinks) {
			await this.#terminalFailure(sink, event, message, "error", true);
		}
		this.#ownedSubmissions.clear();
		this.#pendingSubmit = undefined;
		this.#terminalCursor = cursorFor(event);
		this.#notifyOwnershipWaiters();
	}

	async #completeSink(
		sink: TurnSink,
		event: Extract<LoggedSessionEvent, { readonly kind: "turn_completed" }>,
	): Promise<void> {
		this.#ensureStarted(sink);
		const reason = completionStopReason(event);
		const usage = completionUsage(event);
		const errorMessage = completionErrorMessage(reason);
		if (sink.adopted) {
			if (sink.messageText && !sink.pendingTextCompletion) {
				throw new Error("BreadBoard replay ended mid-message without a completion boundary");
			}
			await this.#projectAdoptedTerminal(sink, event, reason, errorMessage, sink.messageText, usage);
			this.#undurableSinks.delete(sink);
			await this.#commit(event, sink.pendingProjectionKeys.splice(0));
		} else {
			const message = assistantMessage(sink.model, sink.text, reason, errorMessage, String(event.eventId), usage);
			if (sink.textStarted) {
				sink.stream?.push({ type: "text_end", contentIndex: 0, content: sink.text, partial: message });
			}
			if (reason === "error" || reason === "aborted") {
				sink.stream?.push({ type: "error", reason, error: message });
			} else {
				sink.stream?.push({ type: "done", reason, message });
			}
			this.#undurableSinks.delete(sink);
			this.#deferredProjectionKeys.push(...sink.pendingProjectionKeys.splice(0));
			this.#terminalCursor = cursorFor(event);
		}
		this.#settlePendingSubmit(sink);
		if (sink.adopted) this.#rememberAdoptedTerminal(sink);
		sink.terminal = true;
		this.#removeSink(sink);
	}

	async #terminalFailure(
		sink: TurnSink,
		event: Extract<
			LoggedSessionEvent,
			{ readonly kind: "turn_failed" | "turn_cancelled" | "runtime_error_observed" }
		>,
		message: string,
		reason: "error" | "aborted",
		holdCursor = false,
	): Promise<void> {
		if (sink.turnId !== undefined) this.#ownedSubmissions.delete(String(sink.turnId));
		if (sink.adopted) {
			if (event.kind !== "runtime_error_observed" && sink.messageText && !sink.pendingTextCompletion) {
				throw new Error("BreadBoard replay ended mid-message without a completion boundary");
			}
			await this.#projectAdoptedTerminal(sink, event, reason, message, sink.messageText);
			this.#undurableSinks.delete(sink);
			const projectionKeys = sink.pendingProjectionKeys.splice(0);
			if (holdCursor) this.#deferredProjectionKeys.push(...projectionKeys);
			else await this.#commit(event, projectionKeys);
		} else {
			if (!sink.failureDelivered) {
				sink.stream?.push({
					type: "error",
					reason,
					error: assistantMessage(sink.model, sink.text, reason, message, String(event.eventId)),
				});
			}
			this.#undurableSinks.delete(sink);
			this.#deferredProjectionKeys.push(...sink.pendingProjectionKeys.splice(0));
			this.#terminalCursor = cursorFor(event);
		}
		this.#settlePendingSubmit(sink);
		if (sink.adopted) this.#rememberAdoptedTerminal(sink);
		sink.terminal = true;
		this.#removeSink(sink);
	}

	async #projectAdoptedTerminal(
		sink: TurnSink,
		event: LoggedSessionEvent,
		reason: AssistantMessage["stopReason"],
		errorMessage?: string,
		text = "",
		usage?: Usage,
	): Promise<void> {
		if ((!text && !errorMessage && usage === undefined) || this.#receipts.has(String(event.eventId))) return;
		const message = assistantMessage(sink.model, text, reason, errorMessage, String(event.eventId), usage);
		const turnSuffix = event.turnId === null && sink.turnId !== undefined ? `:${String(sink.turnId)}` : "";
		await this.#emit(event, `message_start${turnSuffix}`, { type: "message_start", message }, sink);
		await this.#emit(event, `message_end${turnSuffix}`, { type: "message_end", message }, sink);
	}

	async #emit(event: LoggedSessionEvent, suffix: string, agentEvent: AgentEvent, sink: TurnSink): Promise<void> {
		const key = `${String(event.eventId)}:${suffix}`;
		await this.#emitAgentEvent(agentEvent, key);
		sink.pendingProjectionKeys.push(key);
	}

	async #commit(event: LoggedSessionEvent, keys: string[]): Promise<void> {
		this.#deferredProjectionKeys.push(...keys);
		if (this.#undurableSinks.size > 0) return;
		if (this.#terminalCursor) {
			this.#terminalCursor = cursorFor(event);
			return;
		}
		await this.#projectionCommitted(cursorFor(event), this.#ownedSubmissionSnapshot());
		for (const key of this.#deferredProjectionKeys.splice(0)) this.#releaseAgentEvent(key);
	}
	#permissionTeardownClaimed(sink: TurnSink): boolean {
		return (
			sink.permissionTeardownState === "denying" ||
			sink.permissionTeardownState === "cancelled" ||
			sink.permissionTeardownState === "closed"
		);
	}

	#permissionResponse(
		sink: TurnSink,
		requestId: string,
		decision: Exclude<E4PermissionDecision, "cancel">,
	): PermissionResponseState {
		const responses = (sink.permissionResponses ??= new Map());
		const existing = responses.get(requestId);
		if (existing !== undefined) {
			if (existing.decision !== decision) {
				throw new Error(`BreadBoard permission request ${requestId} received conflicting decisions`);
			}
			return existing;
		}
		const state: PermissionResponseState = {
			decision,
			response: this.#session.respondPermission({ requestId, decision }),
		};
		responses.set(requestId, state);
		return state;
	}

	async #awaitPermissionResponse(requestId: string, state: PermissionResponseState): Promise<void> {
		const receipt = await state.response;
		if (receipt.requestId !== requestId || receipt.decision !== state.decision) {
			throw new Error(`BreadBoard permission response correlation mismatch for ${requestId}`);
		}
	}

	async #cancel(
		turnId: TurnId,
		reason: "user_requested" | "timeout",
		cancellationRequestKey: string,
	): Promise<boolean> {
		try {
			await this.#session.cancel({ turnId, reason, cancellationRequestKey });
			return true;
		} catch (error) {
			const message = safeErrorMessage(error);
			const sink = this.#sinks.get(String(turnId));
			if (sink) this.#failSinkPendingTerminal(sink, message, "error");
			if (!this.#closed) this.#invalidateBridge(`BreadBoard turn cancellation failed: ${message}`);
			return false;
		}
	}

	async #finishAbortedSink(sink: TurnSink): Promise<void> {
		const deadline = Date.now() + ACTIVE_TURN_CLOSE_TIMEOUT_MS;
		const permissionTeardown = sink.permissionTeardown;
		if (permissionTeardown !== undefined) {
			await raceWithCloseDeadline(permissionTeardown, deadline);
		}
		while (!sink.terminal && Date.now() < deadline) {
			await new Promise<void>(resolve => setTimeout(resolve, 50));
		}
		if (!sink.terminal) {
			this.#failSinkPendingTerminal(sink, "BreadBoard turn cancel timed out", "aborted");
		}
	}

	#trackCancellation(sink: TurnSink, reason: "user_requested" | "timeout"): Promise<boolean> | undefined {
		if (sink.cancelRequested || sink.turnId === undefined) return undefined;
		sink.cancelRequested = true;
		sink.cancellationRequestKey = this.#ensureCancellationRequest(sink.turnId).key;
		return this.#requestCancellation(sink.turnId, reason);
	}

	async #denyPermissionAndCancel(sink: TurnSink, requestId: string): Promise<boolean> {
		const existing = sink.permissionTeardown;
		if (existing !== undefined) return existing;
		if (sink.permissionTeardownState === "closed" || sink.permissionTeardownState === "cancelled") return false;
		sink.permissionTeardownState = "denying";
		const teardown = (async (): Promise<boolean> => {
			try {
				const response = sink.permissionResponses?.get(requestId);
				if (response !== undefined) {
					await this.#awaitPermissionResponse(requestId, response);
					if (response.decision !== "deny") {
						this.#invalidateBridge("BreadBoard permission allow crossed cancellation teardown boundary");
						return false;
					}
				} else {
					await this.#awaitPermissionResponse(requestId, this.#permissionResponse(sink, requestId, "deny"));
				}
				sink.permissionTeardownState = "cancelled";
			} catch (error) {
				this.#invalidateBridge(`BreadBoard permission rejection failed: ${safeErrorMessage(error)}`);
				return false;
			}
			const cancellation = this.#trackCancellation(sink, "user_requested");
			return cancellation ? await cancellation : false;
		})();
		sink.permissionTeardown = teardown;
		return teardown;
	}

	#cancelSink(sink: TurnSink, reason: "user_requested" | "timeout"): Promise<boolean> | undefined {
		const requestId = sink.permissionRequestId;
		if (requestId !== undefined) return this.#denyPermissionAndCancel(sink, requestId);
		return this.#trackCancellation(sink, reason);
	}

	#recordObserveFailure(message: string): boolean {
		if (this.#observeFailure) return false;
		this.#observeFailure = new Error(message);
		return true;
	}

	#invalidateBridge(message: string): void {
		if (!this.#recordObserveFailure(message)) return;
		this.#observeAbort.abort();
		this.#notifyOwnershipWaiters();
		for (const sink of [...this.#sinks.values(), ...this.#submittingSinks]) {
			this.#cancelSink(sink, "timeout");
			this.#failSink(sink, message, "error");
		}
		this.#sinks.clear();
	}

	#currentObserveFailure(): Error | undefined {
		return this.#observeFailure;
	}

	#failSink(sink: TurnSink, message: string, reason: "error" | "aborted", projectionEventId?: string): void {
		if (sink.terminal) return;
		sink.terminal = true;
		if (!sink.failureDelivered) {
			sink.stream?.push({
				type: "error",
				reason,
				error: assistantMessage(sink.model, sink.text, reason, message, projectionEventId),
			});
		}
		this.#removeSink(sink);
	}

	#failSinkPendingTerminal(
		sink: TurnSink,
		message: string,
		reason: "error" | "aborted",
		projectionEventId?: string,
	): void {
		if (sink.terminal || sink.failureDelivered) return;
		sink.failureDelivered = true;
		sink.stream?.push({
			type: "error",
			reason,
			error: assistantMessage(sink.model, sink.text, reason, message, projectionEventId),
		});
	}

	#pushStandaloneError(
		stream: AssistantMessageEventStream,
		model: E4BackendModelAttribution,
		message: string,
		reason: "error" | "aborted",
		projectionEventId?: string,
	): void {
		stream.push({
			type: "error",
			reason,
			error: assistantMessage(model, "", reason, message, projectionEventId),
		});
	}

	#removeSink(sink: TurnSink): void {
		sink.permissionAbort.abort();
		if (sink.turnId === undefined) return;
		this.#sinks.delete(String(sink.turnId));
	}
}

function submitInputFromContext(context: Context): LogicalSubmit {
	const message = lastUserMessage(context);
	if (typeof message.content === "string") return { text: message.content };
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	if (images.length === 0) return { text };
	return {
		text,
		attachments: images.map((image, index) => ({
			kind: "upload" as const,
			filename: `attachment-${index + 1}.${extensionForMimeType(image.mimeType)}`,
			data: new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }),
		})),
	};
}

type LogicalSubmit = Omit<StructuredSubmit, "clientMessageId">;

async function canonicalSubmitDigest(input: LogicalSubmit): Promise<string> {
	const attachments: Array<
		| { readonly kind: "handle"; readonly id: string }
		| {
				readonly kind: "upload";
				readonly filename: string;
				readonly contentType: string;
				readonly size: number;
				readonly contentDigest: string;
		  }
	> = [];
	for (const attachment of input.attachments ?? []) {
		if (typeof attachment === "string") {
			attachments.push({ kind: "handle", id: attachment.trim() });
			continue;
		}
		if (attachment.kind === "handle") {
			attachments.push(attachment);
			continue;
		}
		const bytes = new Uint8Array(await attachment.data.arrayBuffer());
		try {
			attachments.push({
				kind: "upload",
				filename: attachment.filename,
				contentType: attachment.data.type,
				size: attachment.data.size,
				contentDigest: await sha256Bytes(bytes),
			});
		} finally {
			bytes.fill(0);
		}
	}
	const serialized = deterministicSerialize({ text: input.text, attachments });
	try {
		return await sha256Bytes(serialized);
	} finally {
		serialized.fill(0);
	}
}

function assistantThinkingMessage(
	model: E4BackendModelAttribution,
	thinking: string,
	projectionEventId: string,
): AssistantMessage {
	const content: ThinkingContent = { type: "thinking", thinking };
	return {
		role: "assistant",
		content: [content],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		responseId: `${E4_PROJECTION_RECEIPT_PREFIX}${projectionEventId}`,
		timestamp: Date.now(),
	};
}

function streamedToolCallMessage(
	model: E4BackendModelAttribution,
	state: StreamedToolCallState,
	projectionEventId: string,
): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: state.callId,
		name: state.tool ?? "unknown",
		arguments: nativeToolArguments(state.argumentsJson),
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		responseId: `${E4_PROJECTION_RECEIPT_PREFIX}${projectionEventId}`,
		timestamp: Date.now(),
	};
}
function isUncorrelatedSubmitReceiptFailure(error: unknown): boolean {
	return (
		error instanceof CanonicalE4ClientError &&
		error.failure.kind === "protocol" &&
		error.failure.code === "invalid_client_message_id"
	);
}
function isAmbiguousSubmitFailure(error: unknown): boolean {
	if (!(error instanceof CanonicalE4ClientError || error instanceof LifecycleE4ClientError)) return false;
	return (
		error.failure.kind === "timeout" ||
		error.failure.kind === "caller-abort" ||
		(error.failure.kind === "http" && error.failure.status === 0)
	);
}

function lastUserMessage(context: Context): UserMessage {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "user") return message;
	}
	throw new Error("BreadBoard turn requires a user message");
}

function extensionForMimeType(mimeType: string): string {
	const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
	if (!subtype) return "bin";
	return subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9.+-]/g, "") || "bin";
}

type TurnCompletedEvent = Extract<LoggedSessionEvent, { readonly kind: "turn_completed" }>;

function completionStopReason(event: TurnCompletedEvent): AssistantMessage["stopReason"] {
	const reason = event.payload.finishReason;
	if (reason === null) throw new Error("BreadBoard turn completion omitted the provider finish reason");
	return reason;
}

function completionUsage(event: TurnCompletedEvent): Usage {
	const usage = event.payload.usage;
	if (
		usage === null ||
		usage.inputTokens === undefined ||
		usage.outputTokens === undefined ||
		usage.cacheReadTokens === undefined ||
		usage.cacheWriteTokens === undefined ||
		usage.totalTokens === undefined
	) {
		throw new Error("BreadBoard turn completion omitted exact provider usage");
	}
	return {
		input: usage.inputTokens,
		output: usage.outputTokens,
		cacheRead: usage.cacheReadTokens,
		cacheWrite: usage.cacheWriteTokens,
		totalTokens: usage.totalTokens,
		...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function completionErrorMessage(reason: AssistantMessage["stopReason"]): string | undefined {
	switch (reason) {
		case "error":
			return "BreadBoard provider reported an error finish";
		case "aborted":
			return "BreadBoard provider reported an aborted finish";
		case "stop":
		case "length":
		case "toolUse":
			return undefined;
		default:
			return assertNever(reason);
	}
}

function assistantMessage(
	model: E4BackendModelAttribution,
	text: string,
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
	projectionEventId?: string,
	usage: Usage = ZERO_USAGE,
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		errorMessage,
		responseId: projectionEventId ? `${E4_PROJECTION_RECEIPT_PREFIX}${projectionEventId}` : undefined,
		timestamp: Date.now(),
	};
}

function isCanonicalJsonObject(value: unknown): value is CanonicalJsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeToolArguments(value: unknown): Record<string, unknown> {
	if (value === null) return {};
	if (isCanonicalJsonObject(value)) return { ...value };
	if (typeof value === "string") {
		if (!value.trim()) return {};
		try {
			const parsed: unknown = JSON.parse(value);
			if (isCanonicalJsonObject(parsed)) return { ...parsed };
			return { value: parsed };
		} catch {
			return { value };
		}
	}
	return { value };
}

function assistantToolCallMessage(
	model: E4BackendModelAttribution,
	event: Extract<LoggedSessionEvent, { readonly kind: "tool_called" }>,
): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: String(event.payload.callId),
		name: event.payload.tool,
		arguments: nativeToolArguments(event.payload.arguments),
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		responseId: `${E4_PROJECTION_RECEIPT_PREFIX}${String(event.eventId)}`,
		timestamp: event.occurredAtMs,
	};
}

function toolResult(result: unknown, artifactRef: unknown, projectionEventId: string): AgentToolResult<unknown> {
	const content: string[] = [];
	if (result !== null) content.push(canonicalText(result));
	if (artifactRef !== null) content.push(`Artifact: ${canonicalText(artifactRef)}`);
	return {
		content: [{ type: "text", text: content.join("\n") || "Completed" }],
		details: { result, artifactRef, breadboardProjectionEventId: projectionEventId },
	};
}

function cursorFor(event: LoggedSessionEvent): E4DurableCursor {
	return { eventId: String(event.eventId), sequence: event.sequence };
}

function canonicalText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "BreadBoard runtime request failed";
}
