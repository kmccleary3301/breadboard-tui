import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { decodeLoggedSessionEvent, type LoggedSessionEvent } from "@breadboard/sdk/session";
import { E4AgentStreamBridge } from "../../src/breadboard/e4-agent-stream";
import type { OpenedSession } from "../../src/breadboard/session-port";
import type { CustomMessage } from "../../src/session/messages";

function sessionScopedEvent(sequence: number, type: string): LoggedSessionEvent {
	return decodeLoggedSessionEvent({
		stable_cursor: true,
		id: `event-${sequence}`,
		seq: sequence,
		session_id: "session-1",
		input_id: null,
		turn_id: null,
		timestamp_ms: sequence,
		type,
		payload: {},
	});
}

function observedSession(events: readonly LoggedSessionEvent[]): OpenedSession {
	return {
		sessionId: events[0]!.sessionId,
		async snapshot() {
			throw new Error("snapshot is not used by this fixture");
		},
		async submit() {
			throw new Error("submit is not used by this fixture");
		},
		async cancel() {
			throw new Error("cancel is not used by this fixture");
		},
		async respondPermission() {
			throw new Error("respondPermission is not used by this fixture");
		},
		async *events(request) {
			for (const event of events) {
				if (request?.signal?.aborted) return;
				yield event;
			}
			// Hold the stream open like a live session so the observer does not report an unexpected end.
			await new Promise<void>(resolve =>
				request?.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
		},
		async close() {},
	} as OpenedSession;
}

describe("E4 observation notices", () => {
	test("renders a session-scoped observation as one displayed transcript notice, released on commit", async () => {
		const emitted: Array<{ event: AgentEvent; key: string }> = [];
		const released: string[] = [];
		const committed: number[] = [];
		// Settles once the commit released both notice keys, or on a commit that carried no notice (unwired bridge).
		const settled = Promise.withResolvers<void>();
		const bridge = new E4AgentStreamBridge({
			session: observedSession([sessionScopedEvent(7, "checkpoint_list")]),
			emitAgentEvent: async (event, key) => {
				emitted.push({ event, key });
			},
			releaseAgentEvent: key => {
				released.push(key);
				if (released.length === 2) settled.resolve();
			},
			submissionOwned: async () => {},
			projectionCommitted: async cursor => {
				committed.push(cursor.sequence);
				if (emitted.length === 0) settled.resolve();
			},
		});
		bridge.start();
		await settled.promise;
		await bridge.close();

		expect(emitted.map(entry => entry.event.type)).toEqual(["message_start", "message_end"]);
		expect(emitted.map(entry => entry.key)).toEqual([
			"event-7:observation_message_start",
			"event-7:observation_message_end",
		]);
		const message = (emitted[0]!.event as { message: CustomMessage<unknown> }).message;
		expect(message).toMatchObject({
			role: "custom",
			customType: "breadboard:e4-observation",
			content: "Checkpoints listed",
			display: true,
			details: { kind: "checkpoint_list_observed", level: "info" },
		});
		expect(committed).toEqual([7]);
		expect(released).toEqual(["event-7:observation_message_start", "event-7:observation_message_end"]);
	});
});
