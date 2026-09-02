import { describe, expect, test } from "bun:test";
import {
	type EventId,
	REPLAY_RETENTION_MAX_AGE_MS,
	REPLAY_RETENTION_MAX_EVENTS,
	type ReplayContractDigest,
	type SessionId,
	type SessionSnapshot,
} from "@breadboard/sdk/session";
import {
	addOwnedSubmission,
	advanceProjectionBinding,
	BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
	type BreadboardSessionBindingData,
	BreadboardSessionTransitionError,
	durableBridgeCursor,
	parseBreadboardSessionBindingData,
	readBreadboardSessionBinding,
	validateBreadboardActivation,
	validateBreadboardSnapshot,
} from "./session-binding";

const replayDigest = "sha256:replay" as ReplayContractDigest;

const binding = (overrides: Partial<BreadboardSessionBindingData> = {}): BreadboardSessionBindingData => ({
	schemaVersion: "breadboard.session-binding.v3",
	sessionId: "session-1",
	replayConfigurationDigest: replayDigest,
	cursor: { eventId: "event-5", sequence: 5 },
	ownedSubmissions: [],
	...overrides,
});

const owned = (suffix: string) => ({
	clientMessageId: `client-${suffix}`,
	inputId: `input-${suffix}`,
	turnId: `turn-${suffix}`,
});

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
	sessionId: "session-1" as SessionId,
	status: "running",
	createdAt: "2026-08-28T00:00:00.000Z",
	lastActivityAt: "2026-08-28T00:00:01.000Z",
	model: "mock/reference",
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
	earliestRetainedSequence: 1,
	earliestRetainedEventId: "event-1" as EventId,
	headSequence: 8,
	headEventId: "event-8" as EventId,
	retainedHistory: "complete",
	sessionReplayContractDigest: replayDigest,
	...overrides,
});

const customEntry = (data: unknown) => ({
	type: "custom",
	customType: BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
	data,
});

describe("BreadBoard session binding", () => {
	test("rejects malformed v3 data and duplicate correlation identities", () => {
		expect(() => parseBreadboardSessionBindingData({ ...binding(), extra: true })).toThrow(
			BreadboardSessionTransitionError,
		);
		for (const duplicate of [
			[owned("1"), { ...owned("2"), clientMessageId: "client-1" }],
			[owned("1"), { ...owned("2"), inputId: "input-1" }],
			[owned("1"), { ...owned("2"), turnId: "turn-1" }],
		]) {
			expect(() => parseBreadboardSessionBindingData(binding({ ownedSubmissions: duplicate }))).toThrow(
				BreadboardSessionTransitionError,
			);
		}
	});

	test("accepts additive same-cursor lineage and rejects rollback or ownership loss", () => {
		const first = binding({ ownedSubmissions: [owned("1")] });
		const second = binding({ ownedSubmissions: [owned("1"), owned("2")] });
		expect(readBreadboardSessionBinding({ getBranch: () => [customEntry(first), customEntry(second)] })).toEqual(
			second,
		);
		expect(() =>
			readBreadboardSessionBinding({ getBranch: () => [customEntry(second), customEntry(first)] }),
		).toThrow("rolls back its durable cursor");
		expect(() =>
			readBreadboardSessionBinding({
				getBranch: () => [
					customEntry(first),
					customEntry(binding({ cursor: { eventId: "event-4", sequence: 4 } })),
				],
			}),
		).toThrow("rolls back its durable cursor");
		expect(() =>
			readBreadboardSessionBinding({
				getBranch: () => [customEntry(first), customEntry(binding({ sessionId: "session-2" }))],
			}),
		).toThrow("conflicts with the active transcript");
	});

	test("validates fresh history and the exact retained resume boundary", () => {
		const fresh = validateBreadboardSnapshot(
			"session-1",
			snapshot({
				headSequence: 0,
				headEventId: null,
				earliestRetainedSequence: null,
				earliestRetainedEventId: null,
			}),
			undefined,
		);
		expect(fresh.cursor).toEqual({ eventId: null, sequence: 0 });
		expect(() =>
			validateBreadboardSnapshot("session-1", snapshot({ retainedHistory: "partial" }), undefined),
		).toThrow("partial retained history");

		const retained = binding({ cursor: { eventId: "event-5", sequence: 5 } });
		expect(
			validateBreadboardSnapshot(
				"session-1",
				snapshot({
					retainedHistory: "partial",
					earliestRetainedSequence: 5,
					earliestRetainedEventId: "event-5" as EventId,
				}),
				retained,
			),
		).toBe(retained);
		expect(() =>
			validateBreadboardSnapshot(
				"session-1",
				snapshot({
					retainedHistory: "partial",
					earliestRetainedSequence: 6,
					earliestRetainedEventId: "event-6" as EventId,
				}),
				retained,
			),
		).toThrow("no longer retains its cursor");
	});

	test("applies ownership and projection transitions without cursor ambiguity", () => {
		const initial = binding({ ownedSubmissions: [owned("1")] });
		const withSecond = addOwnedSubmission(initial, owned("2"));
		expect(withSecond.ownedSubmissions.map(item => item.turnId)).toEqual(["turn-1", "turn-2"]);
		expect(addOwnedSubmission(withSecond, owned("2"))).toBe(withSecond);
		expect(() => addOwnedSubmission(withSecond, { ...owned("2"), inputId: "other-input" })).toThrow(
			"conflicts with the durable binding",
		);

		const sameCursor = advanceProjectionBinding(withSecond, { eventId: "event-5", sequence: 5 }, [owned("2")]);
		expect(sameCursor.cursor).toEqual({ eventId: "event-5", sequence: 5 });
		expect(sameCursor.ownedSubmissions).toEqual([owned("2")]);
		expect(() => advanceProjectionBinding(withSecond, { eventId: "other-event", sequence: 5 }, [])).toThrow(
			"conflicts with or rolls back",
		);
		expect(() => advanceProjectionBinding(withSecond, { eventId: "event-4", sequence: 4 }, [])).toThrow(
			"conflicts with or rolls back",
		);
	});

	test("rejects activation collisions and reconstructs the durable cursor", () => {
		const initial = binding();
		expect(validateBreadboardActivation(undefined, initial, false)).toBe("append");
		expect(validateBreadboardActivation(initial, initial, true)).toBe("reuse");
		expect(() => validateBreadboardActivation(initial, initial, false)).toThrow("cannot replace an existing");
		expect(() =>
			validateBreadboardActivation(binding({ cursor: { eventId: "event-4", sequence: 4 } }), initial, true),
		).toThrow("does not match the durable OMP binding");
		expect(durableBridgeCursor(initial)).toEqual({ eventId: "event-5", sequence: 5 });
		expect(durableBridgeCursor(binding({ cursor: { eventId: null, sequence: 0 } }))).toBeUndefined();
	});
});
