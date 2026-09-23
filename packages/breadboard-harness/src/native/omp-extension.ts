import { stat } from "node:fs/promises";
import { isJsonRecord, type JsonRecord, parseCanonicalJson } from "../canonical-json";
import { applyUnifiedPatchAdapter, createFileFromBlockAdapter, listDirAdapter, markTaskCompleteAdapter, readFileAdapter } from "./adapters";
import { NativeHarnessReloadError, type LoadedNativeHarness } from "./load-native-harness";
import { frameNativeUserMessage } from "./prompt-assembly";
import { createNativeStageMachine } from "./stage-machine";
import { evalOutcomeFromOmp, formatEvalResult, formatRunShellResult, type OmpBashDetails, type OmpEvalDetails, runShellOutcomeFromBash } from "./shell-eval-results";
import { formatTextToolResults, parseTextToolCalls } from "./text-calls";
import { TodoWriteState, todoCompletionGuardReason } from "./todo-write";
import { registerSessionTranscriptExport } from "./session-transcript";
import { NativeTurnPolicy } from "./turn-policy";
import { type NativeToolResult } from "./types";
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** Custom message type carrying text-dialect tool results; the model receives it as a user message. */
export const NATIVE_TEXT_RESULTS_MESSAGE_TYPE = "breadboard-native-text-results";

/** Custom message type for Python's completion-guard advisory, also sent as a user message. */
export const NATIVE_GUARD_MESSAGE_TYPE = "breadboard-native-completion-guard";
export const NATIVE_HARNESS_GENERATION_ENTRY = "breadboard-native-harness-generation";

/** Details key marking a `mark_task_complete` result the completion guard held (Python `_completion_guard_blocked`). */
const GUARD_BLOCKED = "completion_guard_blocked";

/** Python's `COMPLETION_GUARD_ABORT_THRESHOLD` (`agent_llm_openai.py:168`); R39 configures no guard handler. */
const COMPLETION_GUARD_ABORT_THRESHOLD = 2;

/**
 * Python's completion guard (`guardrails/orchestrator.py:617-680`): each held completion adds a
 * `<VALIDATION_ERROR>` user message; the threshold-th one ends the run. Failures count per run,
 * as `SessionState` is created per `run_agentic_loop` call.
 */
class CompletionGuard {
	#failures = 0;
	#pending: string[] = [];
	#abort = false;

	beginRun(): void {
		this.#failures = 0;
		this.#pending = [];
		this.#abort = false;
	}

	block(reason: string): void {
		this.#failures += 1;
		const remaining = Math.max(COMPLETION_GUARD_ABORT_THRESHOLD - this.#failures, 0);
		this.#abort = this.#failures >= COMPLETION_GUARD_ABORT_THRESHOLD;
		this.#pending.push(
			remaining > 0
				? `<VALIDATION_ERROR>\n${reason}\nCompletion guard engaged. Provide concrete file edits and successful tests. Warnings remaining before abort: ${remaining}.\n</VALIDATION_ERROR>`
				: `<VALIDATION_ERROR>\n${reason}\nCompletion guard engaged repeatedly. The run will now terminate to avoid wasting budget.\n</VALIDATION_ERROR>`,
		);
	}

	/** Whether a successful `mark_task_complete` result ends the run. */
	endsRun(details: unknown): boolean {
		const blocked = typeof details === "object" && details !== null && GUARD_BLOCKED in details;
		return !blocked || this.#abort;
	}

	takeAdvisories(): string[] {
		return this.#pending.splice(0);
	}
}

/** Python's refusal when the user rejects a permission prompt (`permissions/broker.py:459-461`). */
const PERMISSION_REJECTED =
	"The user rejected permission to use this specific tool call. You may try again with different parameters.";

export interface NativeCall {
	readonly input: JsonRecord;
	readonly harness: LoadedNativeHarness;
	readonly context: ExtensionContext;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<unknown> | undefined;
	readonly todos: TodoWriteState;
	readonly guard: CompletionGuard;
}

export interface NativeBinding {
	/** OMP approval tier. `always-ask` prompts for `write` and `exec`, as Python's prompt mode asks for edit and shell. */
	readonly approval: "read" | "write" | "exec";
	/** Built-in whose implementation this tool's `ctx.invokeTool` runs. */
	readonly delegate?: string;
	run(call: NativeCall): Promise<NativeToolResult>;
}

function stringField(input: JsonRecord, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(input: JsonRecord, key: string): number | undefined {
	const value = input[key];
	return typeof value === "number" ? value : undefined;
}

function bashDetails(details: unknown): OmpBashDetails | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const exitCode = "exitCode" in details && typeof details.exitCode === "number" ? details.exitCode : undefined;
	const timedOut = "timedOut" in details && details.timedOut === true ? true : undefined;
	const wallTimeMs = "wallTimeMs" in details && typeof details.wallTimeMs === "number" ? details.wallTimeMs : undefined;
	return { exitCode, timedOut, wallTimeMs };
}

function evalDetails(details: unknown): OmpEvalDetails | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const language =
		"language" in details && (details.language === "python" || details.language === "py" || details.language === "js")
			? details.language
			: undefined;
	const cells =
		"cells" in details && Array.isArray(details.cells)
			? details.cells.map((cell: unknown) => ({
					exitCode:
						typeof cell === "object" && cell !== null && "exitCode" in cell && typeof cell.exitCode === "number"
							? cell.exitCode
							: undefined,
				}))
			: undefined;
	const isError = "isError" in details && details.isError === true ? true : undefined;
	return { language, cells, isError };
}

async function invokeBuiltin(call: NativeCall, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
	const invoke = call.context.invokeTool;
	if (invoke === undefined) throw new Error("native harness tool has no built-in to delegate to");
	return await invoke(params, { signal: call.signal, onUpdate: call.onUpdate });
}

/**
 * How each R39 function tool executes. Names, schemas and descriptions come from the vendored
 * tool definitions; execution is OMP's (`bash`, `eval`) or an adapter tested against Python fixtures.
 */
export const NATIVE_BINDINGS: Readonly<Record<string, NativeBinding>> = {
	read_file: {
		approval: "read",
		run: call =>
			readFileAdapter(call.harness.workspaceRoot, {
				path: stringField(call.input, "path") ?? "",
				offset: numberField(call.input, "offset"),
				limit: numberField(call.input, "limit"),
			}),
	},
	list_dir: {
		approval: "read",
		run: call =>
			listDirAdapter(call.harness.workspaceRoot, {
				path: stringField(call.input, "path") ?? "",
				depth: numberField(call.input, "depth"),
			}),
	},
	create_file_from_block: {
		approval: "write",
		run: call =>
			createFileFromBlockAdapter(call.harness.workspaceRoot, {
				filePath: stringField(call.input, "filePath"),
				file_name: stringField(call.input, "file_name"),
				content: stringField(call.input, "content") ?? "",
			}),
	},
	run_shell: {
		approval: "exec",
		delegate: "bash",
		async run(call) {
			// The schema's default (`timeout: 60`) is what Python applies when the model omits it.
			const result = await invokeBuiltin(call, {
				command: stringField(call.input, "command") ?? "",
				timeout: numberField(call.input, "timeout") ?? 60,
			});
			return formatRunShellResult(
				runShellOutcomeFromBash({
					content: result.content,
					details: bashDetails(result.details),
					isError: result.isError,
				}),
			);
		},
	},
	eval: {
		approval: "exec",
		delegate: "eval",
		async run(call) {
			const result = await invokeBuiltin(call, call.input);
			return formatEvalResult(
				evalOutcomeFromOmp({ content: result.content, details: evalDetails(result.details), isError: result.isError }),
			);
		},
	},
	mark_task_complete: {
		approval: "read",
		async run(call) {
			const output = markTaskCompleteAdapter();
			// Strict todos hold completion while items are open (`guardrails/orchestrator.py:495-510`);
			// the call still returns its normal result (`conductor/turn_runtime.py:583-615`).
			const reason =
				call.harness.todos.enabled && call.harness.todos.strict ? todoCompletionGuardReason(call.todos) : undefined;
			if (reason === undefined) return output;
			call.guard.block(reason);
			return { ...output, details: { ...(isJsonRecord(output.details) ? output.details : {}), [GUARD_BLOCKED]: true } };
		},
	},
};

/** Built-ins the harness's function tools delegate to, keyed by harness tool name. */
export function nativeToolDelegates(harness: LoadedNativeHarness): Record<string, string> {
	const delegates: Record<string, string> = {};
	for (const tool of harness.toolSurface.native) {
		const delegate = NATIVE_BINDINGS[tool.name]?.delegate;
		if (delegate !== undefined) delegates[tool.name] = delegate;
	}
	return delegates;
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
}

/** Runs the text-dialect calls in one assistant message and returns Python's result text, if any. */
async function runTextCalls(
	message: AgentMessage,
	harness: LoadedNativeHarness,
	policy: NativeTurnPolicy,
	todos: TodoWriteState,
	context: ExtensionContext,
): Promise<string | undefined> {
	const { calls } = parseTextToolCalls(assistantText(message), harness.toolSurface.textInvoked);
	if (calls.length === 0) return undefined;
	const results: Array<{ name: string; output: JsonRecord }> = [];
	for (const call of calls) {
		const blocked = policy.admit(call.name);
		if (blocked !== undefined) {
			results.push({ name: call.name, output: { error: blocked.reason, __mvi_text_output: blocked.reason } });
			continue;
		}
		if (call.name === "TodoWrite") {
			results.push({ name: call.name, output: todos.apply(call.arguments) });
			continue;
		}
		if (call.name === "apply_unified_patch") {
			// Python's prompt mode asks before an edit (`permissions/broker.py:122-128,808-825`).
			const approved =
				harness.permissions.mode !== "prompt" ||
				(context.hasUI && (await context.ui.confirm("Apply patch?", stringField(call.arguments, "patch") ?? "")));
			if (!approved) {
				results.push({ name: call.name, output: { error: PERMISSION_REJECTED, __mvi_text_output: PERMISSION_REJECTED } });
				continue;
			}
			const applied = await applyUnifiedPatchAdapter(harness.workspaceRoot, stringField(call.arguments, "patch") ?? "");
			results.push({ name: call.name, output: isJsonRecord(applied.details) ? applied.details : { output: applied.text } });
			continue;
		}
		throw new Error(`native harness text tool ${call.name} has no OMP binding`);
	}
	return formatTextToolResults(results);
}

function registerFunctionTools(
	api: ExtensionAPI,
	harness: LoadedNativeHarness,
	todos: TodoWriteState,
	guard: CompletionGuard,
): void {
	for (const tool of harness.registeredToolSurface.native) {
		const binding = NATIVE_BINDINGS[tool.name];
		if (binding === undefined) throw new Error(`native harness tool ${tool.name} has no OMP binding`);
		api.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: structuredClone(tool.parameters) as Record<string, unknown>,
			...(tool.strict === undefined ? {} : { strict: tool.strict }),
			loadMode: "essential",
			approval: binding.approval,
			...(tool.name === "mark_task_complete" ? { terminal: result => guard.endsRun(result.details) } : {}),
			async execute(_toolCallId, params, signal, onUpdate, context) {
				const input = parseCanonicalJson(JSON.stringify(params ?? null));
				if (!isJsonRecord(input)) throw new Error(`${tool.name} arguments must be an object`);
				const output = await binding.run({ input, harness, context, signal, onUpdate, todos, guard });
				return {
					content: [{ type: "text", text: output.text }],
					details: output.details,
					...(output.isError === true ? { isError: true } : {}),
				};
			},
		});
	}
}

/**
 * The extension that makes an OMP session run a compiled BreadBoard harness, including stage
 * transitions between continuation requests. On a host surface it leaves OMP's tools and turns
 * alone and appends the harness prompt blocks after OMP's own system prompt.
 */
export function createNativeHarnessExtension(harness: LoadedNativeHarness): ExtensionFactory {
	return api => {
		let activeHarness = harness;
		let pendingHarness = harness;
		let stageMachine = createNativeStageMachine(activeHarness.lock, activeHarness.stages);
		let policy = new NativeTurnPolicy(activeHarness.registeredToolSurface);
		const todos = new TodoWriteState();
		const guard = new CompletionGuard();
		const promptOverride = [stageMachine.current.systemPrompt];
		const transcript = { specPath: harness.harnessId, graphHash: harness.graphHash };
		const recordGeneration = (generation: number, current: LoadedNativeHarness): void => {
			api.appendEntry(NATIVE_HARNESS_GENERATION_ENTRY, {
				generation,
				spec_path: current.harnessId,
				graph_hash: current.graphHash,
			});
		};
		const applyStage = async (): Promise<void> => {
			const stage = stageMachine.current;
			promptOverride.splice(0, promptOverride.length, stage.systemPrompt);
			await api.setActiveTools(stage.toolSurface.native.map(tool => tool.name));
		};
		const commitPendingHarness = async (): Promise<void> => {
			if (pendingHarness === activeHarness) return;
			activeHarness = pendingHarness;
			stageMachine = createNativeStageMachine(activeHarness.lock, activeHarness.stages);
			policy = new NativeTurnPolicy(activeHarness.registeredToolSurface);
			await applyStage();
		};

		registerSessionTranscriptExport(api, transcript);
		api.on("session_start", () => {
			recordGeneration(activeHarness.live?.generation ?? 1, activeHarness);
		});
		if (activeHarness.hostSurface) {
			const blocks = activeHarness.systemPrompt ? [activeHarness.systemPrompt] : [];
			api.on("before_agent_start", event => ({ systemPrompt: [...event.systemPrompt, ...blocks] }));
			return;
		}

		registerFunctionTools(api, activeHarness, todos, guard);
		const live = activeHarness.live;
		if (live?.editable) {
			api.on("session_start", async (_event, context) => {
				let observedMtime = (await stat(activeHarness.specPath).catch(() => undefined))?.mtimeMs ?? 0;
				const poll = async (): Promise<void> => {
					const mtime = (await stat(activeHarness.specPath).catch(() => undefined))?.mtimeMs;
					if (mtime === undefined || mtime <= observedMtime) return;
					observedMtime = mtime;
					try {
						await live.reload();
					} catch (error) {
						const message =
							error instanceof NativeHarnessReloadError
								? `Harness reload rejected [${error.code}] at generation ${error.generation}: ${error.message}`
								: `Harness reload rejected: ${error instanceof Error ? error.message : String(error)}`;
						context.ui.notify(message, "error");
					}
				};
				context.setInterval(() => {
					void poll();
				}, 1000);
			});
		}
		activeHarness.live?.subscribe(change => {
			pendingHarness = change.harness;
			registerFunctionTools(api, change.harness, todos, guard);
			recordGeneration(change.generation, change.harness);
		});
		api.on("agent_start", async () => {
			await commitPendingHarness();
			stageMachine.reset();
			guard.beginRun();
			await applyStage();
		});
		api.on("before_agent_start", () => ({ systemPrompt: promptOverride }));
		api.on("turn_start", async () => {
			await commitPendingHarness();
			policy.beginTurn();
			await applyStage();
		});
		api.on("turn_prepare", async () => {
			await commitPendingHarness();
			const stage = stageMachine.current;
			return {
				mode: stage.mode,
				systemPrompt: stage.systemPrompt,
				activeToolNames: stage.toolSurface.native.map(tool => tool.name),
			};
		});
		api.on("tool_call", event => policy.admit(event.toolName));
		api.on("turn_settle", async (event, context) => {
			const text = await runTextCalls(event.message, activeHarness, policy, todos, context);
			stageMachine.endTurn(todos.hasItems);
			const messages = [
				...(text === undefined ? [] : [{ customType: NATIVE_TEXT_RESULTS_MESSAGE_TYPE, content: text, display: true }]),
				...guard.takeAdvisories().map(content => ({ customType: NATIVE_GUARD_MESSAGE_TYPE, content, display: true })),
			];
			return messages.length === 0 ? undefined : { messages };
		});
		api.on("agent_end", () => {
			for (const content of guard.takeAdvisories()) {
				api.sendMessage({ customType: NATIVE_GUARD_MESSAGE_TYPE, content, display: true }, { deliverAs: "nextTurn" });
			}
		});
		api.on("context", event => ({
			messages: event.messages.map(message => {
				if (
					message.role === "custom" &&
					(message.customType === NATIVE_TEXT_RESULTS_MESSAGE_TYPE || message.customType === NATIVE_GUARD_MESSAGE_TYPE)
				) {
					return {
						role: "user",
						content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
						attribution: "agent",
						timestamp: message.timestamp,
					};
				}
				if (message.role !== "user" || message.attribution === "agent") return message;
				if (typeof message.content === "string") {
					return { ...message, content: frameNativeUserMessage(message.content, stageMachine.current.perTurnPrompt) };
				}
				const first = message.content.findIndex(block => block.type === "text");
				if (first < 0) return message;
				return {
					...message,
					content: message.content.map((block, index) =>
						index === first && block.type === "text"
							? { ...block, text: frameNativeUserMessage(block.text, stageMachine.current.perTurnPrompt) }
							: block,
					),
				};
			}),
		}));
	};
}
