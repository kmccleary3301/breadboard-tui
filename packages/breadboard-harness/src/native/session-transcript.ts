import { rename, stat, writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { validateBundledSchema, type HarnessValidationFinding } from "../compiler/validate";
import { type CanonicalJson, isJsonRecord, type JsonRecord } from "../canonical-json";

export const SESSION_TRANSCRIPT_SCHEMA_ID =
	"https://breadboard.dev/contracts/kernel/schemas/bb.session_transcript.v2.schema.json";

/** Each item's `content` is one OMP session entry, exactly as the session file stores it. */
export const OMP_SESSION_ENTRY_CONTENT_SCHEMA = "omp.session_entry.v3";

/** Visibility triple from `bb.kernel.common.v1` `#/$defs/visibility`. */
export interface TranscriptVisibility {
	model_visible: boolean;
	provider_visible: boolean;
	host_visible: boolean;
	redaction_state?: "none" | "redacted" | "summarized" | "elided";
}

export interface TranscriptItem {
	kind: string;
	visibility: TranscriptVisibility;
	content: unknown;
	content_schema_version: string | null;
	call_id?: string;
	event_id?: string;
	seq?: number;
	metadata?: JsonRecord;
}

/**
 * `bb.session_transcript.v2`, as generated in the snapshot at
 * `sdk/ts-kernel-contracts/src/generated/types/bb.session_transcript.v2.ts`.
 */
export interface SessionTranscriptV2 {
	schema_version: "bb.session_transcript.v2";
	session_id: string;
	run_id?: string;
	event_cursor?: number | null;
	items: TranscriptItem[];
	metadata?: JsonRecord;
}

/** The parts of an OMP session the exporter reads: its header and the entries on the active branch, root first. */
export interface SessionTranscriptSource {
	readonly header: unknown;
	readonly branch: readonly unknown[];
}

export interface SessionTranscriptOptions {
	/** Why the transcript was written, e.g. `session_end` or `on_demand` (Python's `metadata.reason`). */
	readonly reason: string;
	readonly harness?: { readonly specPath: string; readonly graphHash: string };
}

const MODEL = Object.freeze({ model_visible: true, provider_visible: true, host_visible: true });
const SUMMARY = Object.freeze({
	model_visible: true,
	provider_visible: true,
	host_visible: true,
	redaction_state: "summarized" as const,
});
const HOST = Object.freeze({ model_visible: false, provider_visible: false, host_visible: true });

/** Kinds for message roles. The first three are Python's (`session_state.py:870-872`). */
const MESSAGE_KINDS: Readonly<Record<string, string>> = {
	user: "user_message",
	assistant: "assistant_message",
	toolResult: "tool_result",
	developer: "developer_message",
	bashExecution: "bash_execution",
	pythonExecution: "python_execution",
	custom: "custom_message",
	hookMessage: "hook_message",
	branchSummary: "branch_summary",
	compactionSummary: "compaction_summary",
	fileMention: "file_mention",
};

function snakeCase(value: string): string {
	return value.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`).replace(/[^a-z0-9_]/gu, "_");
}

/**
 * Kind and visibility of one entry. Message roles that OMP sends to the model are model-visible, except shell and
 * eval runs the user excluded from context; compaction and branch summaries reach the model as summaries; custom
 * messages always reach it (`display` only controls rendering). Every other entry is session bookkeeping.
 */
function classify(entry: JsonRecord): { kind: string; visibility: TranscriptVisibility } {
	const type = typeof entry.type === "string" ? entry.type : "unknown";
	if (type === "message" && isJsonRecord(entry.message)) {
		const role = typeof entry.message.role === "string" ? entry.message.role : "unknown";
		const kind = MESSAGE_KINDS[role] ?? `message.${snakeCase(role)}`;
		if (entry.message.excludeFromContext === true) return { kind, visibility: HOST };
		if (role === "branchSummary" || role === "compactionSummary") return { kind, visibility: SUMMARY };
		return { kind, visibility: MESSAGE_KINDS[role] === undefined ? HOST : MODEL };
	}
	if (type === "compaction" || type === "branch_summary") return { kind: type, visibility: SUMMARY };
	if (type === "custom_message") return { kind: type, visibility: MODEL };
	if (type === "custom" && typeof entry.customType === "string" && entry.customType.length > 0) {
		return { kind: `custom.${snakeCase(entry.customType)}`, visibility: HOST };
	}
	return { kind: snakeCase(type), visibility: HOST };
}

/** A JSON copy: what the session file holds, with `undefined` fields dropped. `JSON.parse` yields only JSON values. */
function jsonCopy(value: unknown): CanonicalJson {
	return JSON.parse(JSON.stringify(value) ?? "null") as CanonicalJson;
}

/**
 * Build `bb.session_transcript.v2` from an OMP session. The OMP session file stays authoritative for resume; this
 * is a derived view with one item per entry on the active branch, in order.
 */
export function buildSessionTranscript(
	source: SessionTranscriptSource,
	options: SessionTranscriptOptions,
): SessionTranscriptV2 {
	const header = jsonCopy(source.header);
	if (!isJsonRecord(header) || typeof header.id !== "string" || header.id.length === 0) {
		throw new Error("OMP session header has no id");
	}
	const items = source.branch.map((raw, seq): TranscriptItem => {
		const entry = jsonCopy(raw);
		if (!isJsonRecord(entry)) throw new Error(`OMP session entry ${seq} is not an object`);
		const item: TranscriptItem = {
			...classify(entry),
			content: entry,
			content_schema_version: OMP_SESSION_ENTRY_CONTENT_SCHEMA,
		};
		const message = isJsonRecord(entry.message) ? entry.message : undefined;
		if (message?.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId.length > 0) {
			item.call_id = message.toolCallId;
		}
		if (typeof entry.id === "string" && entry.id.length > 0) item.event_id = entry.id;
		item.seq = seq;
		return item;
	});
	const last = items.at(-1);
	const metadata: JsonRecord = {
		reason: options.reason,
		exporter: "@breadboard/harness",
		omp_session: {
			version: typeof header.version === "number" ? header.version : null,
			cwd: typeof header.cwd === "string" ? header.cwd : null,
			parent_session: typeof header.parentSession === "string" ? header.parentSession : null,
			leaf_id: last?.event_id ?? null,
		},
	};
	if (options.harness !== undefined) {
		metadata.harness = { spec_path: options.harness.specPath, graph_hash: options.harness.graphHash };
	}
	return { schema_version: "bb.session_transcript.v2", session_id: header.id, items, metadata };
}

/** Schema findings for a transcript against the bundled `bb.session_transcript.v2` closure; empty when valid. */
export function validateSessionTranscript(value: unknown): readonly HarnessValidationFinding[] {
	return validateBundledSchema(SESSION_TRANSCRIPT_SCHEMA_ID, value);
}

/** Where the transcript for an OMP session file goes: beside it, under a name session listing never reads. */
export function sessionTranscriptPath(sessionFile: string): string {
	return `${sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile}.bb-transcript.v2.json`;
}

/**
 * Validate and write the transcript beside the session file, replacing any earlier export atomically. Throws with
 * the findings when the transcript does not validate, and writes nothing then.
 */
export async function writeSessionTranscript(sessionFile: string, transcript: SessionTranscriptV2): Promise<string> {
	const findings = validateSessionTranscript(transcript);
	if (findings.length > 0) {
		const summary = findings
			.slice(0, 5)
			.map(finding => `${finding.pointer}: ${finding.message}`)
			.join("; ");
		throw new Error(`bb.session_transcript.v2 export is invalid (${findings.length} finding(s)): ${summary}`);
	}
	const path = sessionTranscriptPath(sessionFile);
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
	await rename(temporary, path);
	return path;
}

/** Slash command that writes the transcript on demand. */
export const SESSION_TRANSCRIPT_COMMAND = "bb-transcript";

async function exportFromContext(
	context: ExtensionContext,
	reason: string,
	harness: SessionTranscriptOptions["harness"],
): Promise<string | undefined> {
	const sessionFile = context.sessionManager.getSessionFile();
	// Sessions persist lazily; with no session file on disk there is nothing to sit beside.
	if (sessionFile === undefined || !(await stat(sessionFile).catch(() => undefined))?.isFile()) return undefined;
	const transcript = buildSessionTranscript(
		{ header: context.sessionManager.getHeader(), branch: context.sessionManager.getBranch() },
		{ reason, ...(harness === undefined ? {} : { harness }) },
	);
	return writeSessionTranscript(sessionFile, transcript);
}

/** Export `bb.session_transcript.v2` beside the OMP session when it shuts down and on `/bb-transcript`. */
export function registerSessionTranscriptExport(
	api: ExtensionAPI,
	harness?: SessionTranscriptOptions["harness"],
): void {
	api.registerCommand(SESSION_TRANSCRIPT_COMMAND, {
		description: "Write this session as bb.session_transcript.v2 beside its OMP session file",
		handler: async (_args, context) => {
			try {
				const path = await exportFromContext(context, "on_demand", harness);
				context.ui.notify(
					path === undefined ? "No session file yet; nothing to export." : `Transcript written to ${path}`,
					path === undefined ? "warning" : "info",
				);
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	api.on("session_shutdown", async (_event, context) => {
		await exportFromContext(context, "session_end", harness);
	});
}
