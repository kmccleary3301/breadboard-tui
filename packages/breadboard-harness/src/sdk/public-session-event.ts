/**
 * Type mirror of https://breadboard.dev/contracts/public/schemas/bb.public_session_event.v1.schema.json.
 * Payloads mirror the lifecycle and kernel payload schemas bundled by snapshot-engine-data.ts.
 */
export type Sha256 = `sha256:${string}`;

export interface PublicSessionEventVisibility {
	readonly model_visible: boolean;
	readonly provider_visible: boolean;
	readonly host_visible: boolean;
	readonly redaction_state: "none" | "redacted";
}

export interface PublicLineage {
	readonly parent_session_id: string;
	readonly root_session_id: string;
	readonly parent_work_item_id: string;
	readonly child_work_item_id: string;
}

export interface PublicAttachment {
	readonly digest: Sha256;
	readonly size_bytes: number;
	readonly media_type: string;
}

export interface PublicSessionStartedPayload {
	readonly effective_lock_hash: Sha256;
	readonly task_hash: Sha256;
	readonly lineage?: PublicLineage;
}

export interface PublicInputAcceptedPayload {
	readonly content_hash: Sha256;
	readonly attachments: readonly PublicAttachment[];
}

export interface PublicApprovalRequestedPayload {
	readonly request_id: string;
	readonly operation: string;
}

export interface PublicApprovalResolvedPayload {
	readonly request_id: string;
	readonly decision: "allow" | "deny" | "once" | "always" | "reject";
}

export interface PublicSessionReconfiguredPayload {
	readonly effective_lock_hash: Sha256;
	readonly reason: string;
}

export interface PublicSessionPausedPayload {
	readonly reason: string;
}

export type PublicSessionResumedPayload = Record<never, never>;

export interface PublicSessionCompletedPayload {
	readonly outcome: "completed";
	readonly summary: string;
	readonly lineage?: PublicLineage;
}

export interface PublicSessionFailedPayload {
	readonly outcome: "failed";
	readonly error: string;
	readonly detail: string;
	readonly lineage?: PublicLineage;
}

export interface PublicSessionCanceledPayload {
	readonly outcome: "canceled";
	readonly reason: string;
	readonly lineage?: PublicLineage;
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

export interface PublicAnnotationPayload {
	readonly annotation_id: string;
	readonly message_id: string;
	readonly trajectory_id: string;
	readonly label: string;
	readonly author: string;
	readonly generation: string;
}

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

type PublicEventBase = {
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
};

type PublicLifecycleEvent =
	| { readonly kind: "session.started"; readonly payload: PublicSessionStartedPayload }
	| { readonly kind: "input.accepted"; readonly payload: PublicInputAcceptedPayload }
	| { readonly kind: "approval.requested"; readonly payload: PublicApprovalRequestedPayload }
	| { readonly kind: "approval.resolved"; readonly payload: PublicApprovalResolvedPayload }
	| { readonly kind: "session.reconfigured"; readonly payload: PublicSessionReconfiguredPayload }
	| { readonly kind: "session.paused"; readonly payload: PublicSessionPausedPayload }
	| { readonly kind: "session.resumed"; readonly payload: PublicSessionResumedPayload }
	| { readonly kind: "session.completed"; readonly payload: PublicSessionCompletedPayload }
	| { readonly kind: "session.failed"; readonly payload: PublicSessionFailedPayload }
	| { readonly kind: "session.canceled"; readonly payload: PublicSessionCanceledPayload };

export type PublicSessionEvent = PublicEventBase &
	(
		| (PublicLifecycleEvent & { readonly payload_schema_version: "bb.payload.product_session.lifecycle.v1" })
		| {
				readonly kind: "assistant_message";
				readonly payload: PublicAssistantMessagePayload;
				readonly payload_schema_version: "bb.payload.message.assistant.v1";
		  }
		| {
				readonly kind: "tool_call";
				readonly payload: PublicToolCallPayload;
				readonly payload_schema_version: "bb.payload.tool.called.v1";
		  }
		| {
				readonly kind: "tool_result";
				readonly payload: PublicToolResultPayload;
				readonly payload_schema_version: "bb.payload.tool.completed.v1";
		  }
		| {
				readonly kind: "annotation";
				readonly payload: PublicAnnotationPayload;
				readonly payload_schema_version: "bb.payload.product_session.annotation.v1";
		  }
	);
