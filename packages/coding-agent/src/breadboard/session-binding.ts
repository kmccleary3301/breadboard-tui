import type { SessionSnapshot } from "@breadboard/sdk/internal";
import type { E4DurableCursor, E4OwnedSubmission } from "./e4-agent-stream";

export const BREADBOARD_SESSION_BINDING_CUSTOM_TYPE = "breadboard.session-binding";
const BREADBOARD_SESSION_BINDING_SCHEMA_VERSION = "breadboard.session-binding.v3";

export interface BreadboardSessionBindingData {
	readonly schemaVersion: "breadboard.session-binding.v3";
	readonly sessionId: string;
	readonly replayConfigurationDigest: string;
	readonly cursor: {
		readonly eventId: string | null;
		readonly sequence: number;
	};
	readonly ownedSubmissions: readonly E4OwnedSubmission[];
}

interface BreadboardSessionBindingEntry {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly message?: unknown;
}

export interface BreadboardSessionBindingManager {
	getBranch(): readonly BreadboardSessionBindingEntry[];
}

export interface BreadboardSessionBindingStore extends BreadboardSessionBindingManager {
	appendCustomEntry(customType: string, data?: unknown): void;
	flush(): Promise<void>;
}

export class BreadboardSessionTransitionError extends Error {
	readonly code = "unsupported_resume_transition";

	constructor(message: string) {
		super(message);
		this.name = "BreadboardSessionTransitionError";
	}
}

function isExactSafeString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value && !/[\p{Cc}]/u.test(value);
}

export function parseBreadboardSessionBindingData(value: unknown): BreadboardSessionBindingData {
	const fail = (): never => {
		throw new BreadboardSessionTransitionError(
			"BreadBoard session binding is malformed or incompatible with the required schema.",
		);
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).length !== 5 ||
		data.schemaVersion !== BREADBOARD_SESSION_BINDING_SCHEMA_VERSION ||
		!isExactSafeString(data.sessionId) ||
		!isExactSafeString(data.replayConfigurationDigest) ||
		!data.cursor ||
		typeof data.cursor !== "object" ||
		Array.isArray(data.cursor) ||
		!Array.isArray(data.ownedSubmissions) ||
		data.ownedSubmissions.length > 10_000
	) {
		return fail();
	}
	const cursor = data.cursor as Record<string, unknown>;
	const cursorSequence = cursor.sequence;
	const cursorEventId = cursor.eventId;
	if (
		Object.keys(cursor).length !== 2 ||
		typeof cursorSequence !== "number" ||
		!Number.isSafeInteger(cursorSequence) ||
		cursorSequence < 0
	) {
		return fail();
	}
	let normalizedCursorEventId: string | null;
	if (cursorSequence === 0) {
		if (cursorEventId !== null) return fail();
		normalizedCursorEventId = null;
	} else {
		if (!isExactSafeString(cursorEventId)) return fail();
		normalizedCursorEventId = cursorEventId;
	}
	const ownedSubmissions: E4OwnedSubmission[] = [];
	const clientMessageIds = new Set<string>();
	const inputIds = new Set<string>();
	const turnIds = new Set<string>();
	for (const item of data.ownedSubmissions) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return fail();
		const submission = item as Record<string, unknown>;
		if (
			Object.keys(submission).length !== 3 ||
			!isExactSafeString(submission.clientMessageId) ||
			!isExactSafeString(submission.inputId) ||
			!isExactSafeString(submission.turnId) ||
			clientMessageIds.has(submission.clientMessageId) ||
			inputIds.has(submission.inputId) ||
			turnIds.has(submission.turnId)
		) {
			return fail();
		}
		clientMessageIds.add(submission.clientMessageId);
		inputIds.add(submission.inputId);
		turnIds.add(submission.turnId);
		ownedSubmissions.push({
			clientMessageId: submission.clientMessageId,
			inputId: submission.inputId,
			turnId: submission.turnId,
		});
	}
	return {
		schemaVersion: BREADBOARD_SESSION_BINDING_SCHEMA_VERSION,
		sessionId: data.sessionId,
		replayConfigurationDigest: data.replayConfigurationDigest,
		cursor: { eventId: normalizedCursorEventId, sequence: cursorSequence },
		ownedSubmissions,
	};
}

function sameOwnedSubmissions(left: readonly E4OwnedSubmission[], right: readonly E4OwnedSubmission[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(item, index) =>
				item.clientMessageId === right[index]?.clientMessageId &&
				item.inputId === right[index]?.inputId &&
				item.turnId === right[index]?.turnId,
		)
	);
}

function containsOwnedSubmissions(
	candidate: readonly E4OwnedSubmission[],
	required: readonly E4OwnedSubmission[],
): boolean {
	const byTurnId = new Map(candidate.map(submission => [submission.turnId, submission]));
	return required.every(submission => {
		const found = byTurnId.get(submission.turnId);
		return found?.clientMessageId === submission.clientMessageId && found.inputId === submission.inputId;
	});
}

export function readBreadboardSessionBinding(
	sessionManager: BreadboardSessionBindingManager,
): BreadboardSessionBindingData | undefined {
	let binding: BreadboardSessionBindingData | undefined;
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== BREADBOARD_SESSION_BINDING_CUSTOM_TYPE) continue;
		const candidate = parseBreadboardSessionBindingData(entry.data);
		if (
			binding &&
			(candidate.sessionId !== binding.sessionId ||
				candidate.replayConfigurationDigest !== binding.replayConfigurationDigest ||
				candidate.cursor.sequence < binding.cursor.sequence ||
				(candidate.cursor.sequence === binding.cursor.sequence &&
					(candidate.cursor.eventId !== binding.cursor.eventId ||
						!containsOwnedSubmissions(candidate.ownedSubmissions, binding.ownedSubmissions))))
		) {
			throw new BreadboardSessionTransitionError(
				"BreadBoard session binding conflicts with the active transcript or rolls back its durable cursor.",
			);
		}
		binding = candidate;
	}
	return binding;
}

export function validateBreadboardSnapshot(
	openedSessionId: unknown,
	snapshot: SessionSnapshot,
	resumeBinding: BreadboardSessionBindingData | undefined,
): BreadboardSessionBindingData {
	const sessionId: unknown = snapshot.sessionId;
	const replayConfigurationDigest: unknown = snapshot.replayRetention.configurationDigest;
	const headSequence = snapshot.headSequence;
	const headEventId: unknown = snapshot.headEventId;
	const earliestRetainedSequence = snapshot.earliestRetainedSequence;
	const earliestRetainedEventId: unknown = snapshot.earliestRetainedEventId;
	const invalid =
		!isExactSafeString(openedSessionId) ||
		!isExactSafeString(sessionId) ||
		sessionId !== openedSessionId ||
		!isExactSafeString(replayConfigurationDigest) ||
		!Number.isSafeInteger(headSequence) ||
		headSequence < 0 ||
		(headSequence === 0 ? headEventId !== null : !isExactSafeString(headEventId)) ||
		(headSequence === 0
			? earliestRetainedSequence !== null || earliestRetainedEventId !== null
			: !Number.isSafeInteger(earliestRetainedSequence) ||
				earliestRetainedSequence === null ||
				earliestRetainedSequence < 1 ||
				earliestRetainedSequence > headSequence ||
				!isExactSafeString(earliestRetainedEventId) ||
				(earliestRetainedSequence === headSequence && earliestRetainedEventId !== headEventId)) ||
		(snapshot.retainedHistory === "complete"
			? headSequence > 0 && earliestRetainedSequence !== 1
			: snapshot.retainedHistory !== "partial");
	if (invalid) {
		throw new BreadboardSessionTransitionError("BreadBoard returned an impossible or malformed session snapshot.");
	}
	if (!resumeBinding) {
		if (snapshot.retainedHistory === "partial") {
			throw new BreadboardSessionTransitionError(
				"BreadBoard returned partial retained history for a session without a durable resume cursor.",
			);
		}
		return {
			schemaVersion: BREADBOARD_SESSION_BINDING_SCHEMA_VERSION,
			sessionId,
			replayConfigurationDigest,
			cursor: { eventId: headEventId as string | null, sequence: headSequence },
			ownedSubmissions: [],
		};
	}
	if (
		resumeBinding.sessionId !== sessionId ||
		resumeBinding.replayConfigurationDigest !== replayConfigurationDigest ||
		resumeBinding.cursor.sequence > headSequence ||
		(resumeBinding.cursor.sequence === headSequence && resumeBinding.cursor.eventId !== headEventId) ||
		(resumeBinding.cursor.sequence > 0 &&
			(earliestRetainedSequence === null || resumeBinding.cursor.sequence < earliestRetainedSequence)) ||
		(snapshot.retainedHistory === "partial" && resumeBinding.cursor.sequence === 0)
	) {
		throw new BreadboardSessionTransitionError(
			"BreadBoard resume snapshot conflicts with the durable OMP session binding or no longer retains its cursor.",
		);
	}
	return resumeBinding;
}

export function durableBridgeCursor(binding: BreadboardSessionBindingData): E4DurableCursor | undefined {
	return binding.cursor.eventId === null
		? undefined
		: { eventId: binding.cursor.eventId, sequence: binding.cursor.sequence };
}

export function addOwnedSubmission(
	current: BreadboardSessionBindingData,
	submission: E4OwnedSubmission,
): BreadboardSessionBindingData {
	const existing = current.ownedSubmissions.find(item => item.turnId === submission.turnId);
	if (
		existing &&
		(existing.clientMessageId !== submission.clientMessageId || existing.inputId !== submission.inputId)
	) {
		throw new BreadboardSessionTransitionError(
			`BreadBoard owned submission ${submission.turnId} conflicts with the durable binding.`,
		);
	}
	if (existing) return current;
	return parseBreadboardSessionBindingData({
		...current,
		ownedSubmissions: [...current.ownedSubmissions, submission].sort((left, right) =>
			left.turnId.localeCompare(right.turnId),
		),
	});
}

export function advanceProjectionBinding(
	current: BreadboardSessionBindingData,
	cursor: E4DurableCursor,
	ownedSubmissions: readonly E4OwnedSubmission[],
): BreadboardSessionBindingData {
	if (
		!isExactSafeString(cursor.eventId) ||
		!Number.isSafeInteger(cursor.sequence) ||
		cursor.sequence <= 0 ||
		cursor.sequence < current.cursor.sequence ||
		(cursor.sequence === current.cursor.sequence && cursor.eventId !== current.cursor.eventId)
	) {
		throw new BreadboardSessionTransitionError(
			"BreadBoard projection cursor conflicts with or rolls back the durable OMP session binding.",
		);
	}
	return parseBreadboardSessionBindingData({
		...current,
		cursor: { eventId: cursor.eventId, sequence: cursor.sequence },
		ownedSubmissions,
	});
}

export function validateBreadboardActivation(
	existingBinding: BreadboardSessionBindingData | undefined,
	initialBinding: BreadboardSessionBindingData,
	resuming: boolean,
): "append" | "reuse" {
	if (resuming) {
		if (
			!existingBinding ||
			existingBinding.sessionId !== initialBinding.sessionId ||
			existingBinding.replayConfigurationDigest !== initialBinding.replayConfigurationDigest ||
			existingBinding.cursor.sequence !== initialBinding.cursor.sequence ||
			existingBinding.cursor.eventId !== initialBinding.cursor.eventId ||
			!sameOwnedSubmissions(existingBinding.ownedSubmissions, initialBinding.ownedSubmissions)
		) {
			throw new BreadboardSessionTransitionError(
				"BreadBoard resumed session identity or cursor does not match the durable OMP binding.",
			);
		}
		return "reuse";
	}
	if (existingBinding) {
		throw new BreadboardSessionTransitionError(
			"BreadBoard fresh session cannot replace an existing durable OMP binding.",
		);
	}
	return "append";
}
