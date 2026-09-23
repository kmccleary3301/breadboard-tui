/**
 * Type mirror of https://breadboard.dev/contracts/public/schemas/bb.public_session_event.v1.schema.json.
 * Payload shapes mirror the lifecycle and kernel payload schemas bundled by snapshot-engine-data.ts.
 */
export type PublicSessionEventKind =
	| "session.started"
	| "input.accepted"
	| "approval.requested"
	| "approval.resolved"
	| "session.reconfigured"
	| "session.paused"
	| "session.resumed"
	| "session.completed"
	| "session.failed"
	| "session.canceled"
	| "assistant_message"
	| "tool_call"
	| "tool_result"
	| "annotation";

export interface PublicSessionEventVisibility {
	readonly model_visible: boolean;
	readonly provider_visible: boolean;
	readonly host_visible: boolean;
	readonly redaction_state: "none" | "redacted";
}

export interface PublicLifecyclePayload {
	readonly effective_lock_hash?: `sha256:${string}`;
	readonly task_hash?: `sha256:${string}`;
	readonly content_hash?: `sha256:${string}`;
	readonly attachments?: readonly [];
	readonly request_id?: string;
	readonly operation?: string;
	readonly decision?: "allow" | "deny" | "once" | "always" | "reject";
	readonly outcome?: "completed" | "failed" | "canceled";
	readonly summary?: string;
	readonly error?: string;
	readonly detail?: string;
	readonly reason?: string;
}

export interface PublicAssistantMessagePayload {
	readonly message_id?: string;
	readonly trajectory_id?: string;
	readonly seq?: number;
	readonly metadata?: Record<string, unknown>;
	readonly message?: unknown;
	readonly text?: string;
	readonly source?: string;
}

export interface PublicToolCallPayload {
	readonly seq?: number;
	readonly metadata?: Record<string, unknown>;
	readonly call?: Record<string, unknown>;
	readonly call_id?: string;
	readonly tool?: string;
	readonly tool_name?: string;
	readonly state?: string;
}

export interface PublicToolResultPayload {
	readonly seq?: number;
	readonly metadata?: Record<string, unknown>;
	readonly message?: unknown;
	readonly tool?: string;
	readonly success?: boolean;
	readonly status?: string;
	readonly error?: unknown;
	readonly call_id?: string;
	readonly todo?: unknown;
}

export type PublicSessionEventPayload =
	| PublicLifecyclePayload
	| PublicAssistantMessagePayload
	| PublicToolCallPayload
	| PublicToolResultPayload
	| Record<string, unknown>;

export interface PublicSessionEvent {
	readonly schema_version: "bb.public_session_event.v1";
	readonly event_id: string;
	readonly seq: number;
	readonly timestamp: string;
	readonly work_item_id: string | null;
	readonly parent_work_item_id: string | null;
	readonly attempt_id: string | null;
	readonly session_id: string;
	readonly span_id: string | null;
	readonly visibility: PublicSessionEventVisibility;
	readonly kind: PublicSessionEventKind;
	readonly payload: PublicSessionEventPayload;
	readonly payload_schema_version:
		| "bb.payload.product_session.lifecycle.v1"
		| "bb.payload.message.assistant.v1"
		| "bb.payload.tool.called.v1"
		| "bb.payload.tool.completed.v1"
		| "bb.payload.product_session.annotation.v1";
}
