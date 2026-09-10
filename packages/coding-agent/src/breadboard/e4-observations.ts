import type { LoggedSessionEvent } from "./session-port";

export type E4ObservationEvent = Extract<
	LoggedSessionEvent,
	{
		readonly kind:
			| "todo_updated"
			| "stream_gap_observed"
			| "session_control_observed"
			| "checkpoint_list_observed"
			| "checkpoint_restored";
	}
>;

export type E4ObservationKind = E4ObservationEvent["kind"];
export type E4ObservationLevel = "info" | "warning";

export interface E4ObservationNotice {
	readonly kind: E4ObservationKind;
	readonly text: string;
	readonly level: E4ObservationLevel;
}

const NOTICE_BY_KIND: Record<E4ObservationKind, Readonly<{ text: string; level: E4ObservationLevel }>> = {
	todo_updated: { text: "Todo updated", level: "info" },
	stream_gap_observed: { text: "Stream gap observed", level: "warning" },
	session_control_observed: { text: "Session control observed", level: "info" },
	checkpoint_list_observed: { text: "Checkpoints listed", level: "info" },
	checkpoint_restored: { text: "Checkpoint restored", level: "info" },
};

/** Convert a canonical E4 session observation into one compact user-facing notice. */
export function mapE4Observation(event: E4ObservationEvent): E4ObservationNotice {
	return { kind: event.kind, ...NOTICE_BY_KIND[event.kind] };
}
