import type { JsonRecord } from "../canonical-json";
import { isJsonRecord } from "../canonical-json";

const TODO_OPEN_STATUSES = ["todo", "in_progress", "blocked"] as const;
type TodoItem = { title: string; status: string; metadata: JsonRecord };

const STATUS_MAP: Readonly<Record<string, string>> = {
	pending: "todo",
	todo: "todo",
	in_progress: "in_progress",
	progress: "in_progress",
	active: "in_progress",
	completed: "done",
	complete: "done",
	done: "done",
	blocked: "blocked",
	canceled: "canceled",
	cancelled: "canceled",
};

const TODO_WRITE_SUCCESS =
	"Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. " +
	"Please proceed with the current tasks if applicable";

function pythonString(value: JsonRecord[string] | undefined): string {
	if (value === undefined || value === null || value === false) return "";
	if (typeof value === "string") return value;
	if (value === true) return "True";
	if (typeof value === "number") return String(value);
	return JSON.stringify(value);
}

function normalizedStatus(value: JsonRecord[string] | undefined): string {
	const source = pythonString(value).trim().toLowerCase();
	return source ? (STATUS_MAP[source] ?? "todo") : "todo";
}

function errorResult(message: string): JsonRecord {
	return { error: message, __mvi_text_output: message };
}

/**
 * Session-local Claude TodoWrite board. The status aliases and replacement
 * semantics mirror `todo/manager.py:132-177`; the returned success payload is
 * the exact Claude-facing result from `agent_llm_openai.py:5618-5636`.
 */
export class TodoWriteState {
	private items: TodoItem[] = [];

	apply(args: JsonRecord): JsonRecord {
		const todos = args.todos;
		if (!Array.isArray(todos)) {
			return errorResult("Error: TodoWrite missing required todos");
		}

		const existing = new Map<string, TodoItem>();
		for (const item of this.items) existing.set(item.title.trim().toLowerCase(), item);
		const ordered: TodoItem[] = [];
		for (const value of todos) {
			if (!isJsonRecord(value)) {
				return errorResult("TodoWrite entries must be objects with 'content' and 'status'.");
			}
			const title = pythonString(value.content ?? value.title).trim();
			if (!title) return errorResult("TodoWrite entries must include 'content'.");
			const key = title.toLowerCase();
			const status = normalizedStatus(value.status);
			let item = existing.get(key);
			if (!item) {
				item = { title, status: "todo", metadata: {} };
				existing.set(key, item);
			}
			if (status) item.status = status;
			const activeForm = value.activeForm;
			if (typeof activeForm === "string" && activeForm.trim()) item.metadata.active_form = activeForm.trim();
			ordered.push(item);
		}
		this.items = ordered;
		return { ok: true, __mvi_text_output: TODO_WRITE_SUCCESS };
	}

	/** Titles whose status belongs to Python's `TODO_OPEN_STATUSES` tuple. */
	get openItems(): readonly string[] {
		return this.items
			.filter(item => (TODO_OPEN_STATUSES as readonly string[]).includes(item.status))
			.map(item => item.title);
	}
	/** Whether the board contains any item, including completed and canceled entries. */
	get hasItems(): boolean {
		return this.items.length > 0;
	}
}

/** Return the strict completion-guard text, or undefined when no todo is open. */
export function todoCompletionGuardReason(state: TodoWriteState): string | undefined {
	const openTitles = state.openItems.slice(0, 3);
	if (openTitles.length === 0) return undefined;
	return `Outstanding todos must be completed or canceled before finishing. Pending items: ${openTitles.join("; ")}`;
}
