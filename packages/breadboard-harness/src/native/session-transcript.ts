import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
	readonly header: CanonicalJson;
	readonly branch: readonly CanonicalJson[];
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

/**
 * Read the header and the active branch (root to `leafId`) from an OMP session file. The exporter reads the file,
 * not the in-memory entries, because persistence rewrites entries on the way to disk (long strings truncated, images
 * moved to blobs, replayed reasoning signatures dropped); the transcript describes what resume will load.
 */
export async function readSessionTranscriptSource(
	sessionFile: string,
	leafId: string | null,
): Promise<SessionTranscriptSource> {
	let header: CanonicalJson | undefined;
	const entries = new Map<string, JsonRecord>();
	for (const [index, line] of (await readFile(sessionFile, "utf8")).split("\n").entries()) {
		if (line.trim().length === 0) continue;
		// `JSON.parse` yields only JSON values.
		const value = JSON.parse(line) as CanonicalJson;
		if (!isJsonRecord(value)) throw new Error(`${sessionFile}:${index + 1} is not a JSON object`);
		if (value.type === "session") header = value;
		else if (typeof value.id === "string") entries.set(value.id, value);
	}
	if (header === undefined) throw new Error(`${sessionFile} has no session header`);
	const branch: JsonRecord[] = [];
	const seen = new Set<string>();
	for (let id = leafId; id !== null;) {
		const entry = entries.get(id);
		if (entry === undefined) throw new Error(`${sessionFile} does not contain entry ${id} on the active branch`);
		if (seen.has(id)) throw new Error(`${sessionFile} has a parent cycle at entry ${id}`);
		seen.add(id);
		branch.push(entry);
		id = typeof entry.parentId === "string" ? entry.parentId : null;
	}
	return { header, branch: branch.reverse() };
}

/**
 * Build `bb.session_transcript.v2` from an OMP session. The OMP session file stays authoritative for resume; this
 * is a derived view with one item per entry on the active branch, in order.
 */
export function buildSessionTranscript(
	source: SessionTranscriptSource,
	options: SessionTranscriptOptions,
): SessionTranscriptV2 {
	const header = source.header;
	if (!isJsonRecord(header) || typeof header.id !== "string" || header.id.length === 0) {
		throw new Error("OMP session header has no id");
	}
	const items = source.branch.map((entry, seq): TranscriptItem => {
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
	const generations = items.flatMap(item => {
		const content = isJsonRecord(item.content as CanonicalJson) ? (item.content as JsonRecord) : undefined;
		if (content === undefined || content.type !== "custom") return [];
		if (content.customType !== "breadboard-native-harness-generation") return [];
		const data = isJsonRecord(content.data) ? content.data : undefined;
		if (data === undefined || typeof data.generation !== "number") return [];
		return [
			{
				generation: data.generation,
				spec_path: typeof data.spec_path === "string" ? data.spec_path : null,
				graph_hash: typeof data.graph_hash === "string" ? data.graph_hash : null,
			},
		];
	});
	if (generations.length > 0) metadata.harness_generations = generations;
	if (options.harness !== undefined) {
		metadata.harness = { spec_path: options.harness.specPath, graph_hash: options.harness.graphHash };
	}
	return { schema_version: "bb.session_transcript.v2", session_id: header.id, items, metadata };
}

/** Schema findings for a transcript against the bundled `bb.session_transcript.v2` closure; empty when valid. */
export function validateSessionTranscript(value: unknown): readonly HarnessValidationFinding[] {
	return validateBundledSchema(SESSION_TRANSCRIPT_SCHEMA_ID, value);
}

const SESSION_ID_FILE_NAME = /^[A-Za-z0-9._-]+$/u;

/**
 * Where the transcript for session `sessionId` goes: `bb-transcript.v2.<sessionId>.json` in the session's artifacts
 * directory (`<session file without .jsonl>/`). OMP moves and deletes that directory with the session, and session
 * listing reads only `*.jsonl` there. The id in the name keeps a copy honest: `/fork` copies the parent's artifacts
 * into the child's, and the copied file still names the parent session it describes.
 */
export function sessionTranscriptPath(artifactsDir: string, sessionId: string): string {
	if (!SESSION_ID_FILE_NAME.test(sessionId) || sessionId === "." || sessionId === "..") {
		throw new Error(`OMP session id ${JSON.stringify(sessionId)} cannot name a transcript file`);
	}
	return join(artifactsDir, `bb-transcript.v2.${sessionId}.json`);
}

/**
 * Validate and write the transcript into the session's artifacts directory, replacing any earlier export
 * atomically. Throws with the findings when the transcript does not validate, and writes nothing then.
 */
export async function writeSessionTranscript(artifactsDir: string, transcript: SessionTranscriptV2): Promise<string> {
	const findings = validateSessionTranscript(transcript);
	if (findings.length > 0) {
		const summary = findings
			.slice(0, 5)
			.map(finding => `${finding.pointer}: ${finding.message}`)
			.join("; ");
		throw new Error(`bb.session_transcript.v2 export is invalid (${findings.length} finding(s)): ${summary}`);
	}
	const path = sessionTranscriptPath(artifactsDir, transcript.session_id);
	await mkdir(artifactsDir, { recursive: true });
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
	const artifactsDir = context.sessionManager.getArtifactsDir();
	// Sessions persist lazily; with no session file on disk there is nothing to export.
	if (sessionFile === undefined || artifactsDir === null) return undefined;
	if (!(await stat(sessionFile).catch(() => undefined))?.isFile()) return undefined;
	const source = await readSessionTranscriptSource(sessionFile, context.sessionManager.getLeafId());
	const transcript = buildSessionTranscript(source, { reason, ...(harness === undefined ? {} : { harness }) });
	return writeSessionTranscript(artifactsDir, transcript);
}

/** Export `bb.session_transcript.v2` into the session's artifacts directory at shutdown and on `/bb-transcript`. */
export function registerSessionTranscriptExport(
	api: ExtensionAPI,
	harness?: SessionTranscriptOptions["harness"],
): void {
	api.registerCommand(SESSION_TRANSCRIPT_COMMAND, {
		description: "Write this session as bb.session_transcript.v2 into its OMP artifacts directory",
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
