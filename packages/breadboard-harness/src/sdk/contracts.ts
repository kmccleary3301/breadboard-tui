import type { JsonRecord } from "../canonical-json";
/** Generated ts-kernel-contracts bb.session_transcript.v2 shape bundled in engine-data. */
export interface NativeTranscriptVisibility {
	readonly model_visible: boolean;
	readonly provider_visible: boolean;
	readonly host_visible: boolean;
	readonly redaction_state?: "none" | "redacted" | "summarized" | "elided";
}

export interface NativeTranscriptItem {
	readonly kind: string;
	readonly visibility: NativeTranscriptVisibility;
	readonly content: unknown;
	readonly content_schema_version: string | null;
	readonly call_id?: string;
	readonly event_id?: string;
	readonly seq?: number;
	readonly metadata?: JsonRecord;
}

export interface NativeSessionTranscriptV2 {
	readonly schema_version: "bb.session_transcript.v2";
	readonly session_id: string;
	readonly run_id?: string;
	readonly event_cursor?: number | null;
	readonly items: ReadonlyArray<NativeTranscriptItem>;
	readonly metadata?: JsonRecord;
}
