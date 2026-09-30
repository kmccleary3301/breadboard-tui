import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isJsonRecord, type JsonRecord, parseCanonicalJson } from "../canonical-json";
import {
	applyUnifiedPatchAdapter,
	createFileFromBlockAdapter,
	listDirAdapter,
	markTaskCompleteAdapter,
	readFileAdapter,
} from "./adapters";
import { RESEARCH_NATIVE_BINDINGS, researchBindingForTool } from "./research-bindings";
import { NativeHarnessReloadError, type LoadedNativeHarness, type NativeHarnessLiveState } from "./load-native-harness";
import { nativeLockValue } from "./lock-values";
import { frameNativeUserContent, type NativeUserTextBlock } from "./prompt-assembly";
import { createNativeStageMachine } from "./stage-machine";
import {
	evalOutcomeFromOmp,
	formatEvalResult,
	formatRunShellResult,
	type OmpBashDetails,
	type OmpEvalDetails,
	runShellOutcomeFromBash,
} from "./shell-eval-results";
import { formatTextToolResults, parseTextToolCalls } from "./text-calls";
import { TodoWriteState, todoCompletionGuardReason } from "./todo-write";
import { registerSessionTranscriptExport } from "./session-transcript";
import { NativeTurnPolicy } from "./turn-policy";
import type { NativeToolDefinition, NativeToolResult } from "./types";
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { NativeToolDelegate } from "@oh-my-pi/pi-coding-agent/sdk";

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
	/** Native implementation this tool's `ctx.invokeTool` runs. */
	readonly delegate?: NativeToolDelegate;
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
	const wallTimeMs =
		"wallTimeMs" in details && typeof details.wallTimeMs === "number" ? details.wallTimeMs : undefined;
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
	...RESEARCH_NATIVE_BINDINGS,
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
				evalOutcomeFromOmp({
					content: result.content,
					details: evalDetails(result.details),
					isError: result.isError,
				}),
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
			return {
				...output,
				details: { ...(isJsonRecord(output.details) ? output.details : {}), [GUARD_BLOCKED]: true },
			};
		},
	},
};

/**
 * Resolve from the tool's declared definition, without depending on registry paths. A definition
 * that declares the engine `eval` handler gets the engine's result shape; research packs' `eval`
 * declares none and delegates to OMP's eval.
 */
export function nativeBindingForTool(tool: NativeToolDefinition): NativeBinding | undefined {
	if (tool.handler === "eval") return NATIVE_BINDINGS.eval;
	if (Object.hasOwn(RESEARCH_NATIVE_BINDINGS, tool.name)) return researchBindingForTool(tool);
	return NATIVE_BINDINGS[tool.name];
}

/** Built-ins the harness's function tools delegate to, keyed by harness tool name. */
export function nativeToolDelegates(harness: LoadedNativeHarness): Record<string, NativeToolDelegate> {
	const delegates: Record<string, NativeToolDelegate> = {};
	for (const tool of harness.registeredToolSurface.native) {
		const delegate = nativeBindingForTool(tool)?.delegate;
		if (delegate !== undefined) delegates[tool.name] = delegate;
	}
	return delegates;
}

/**
 * The prompt-cache retention the lock's Anthropic system cache declaration implies, as Python's
 * `_build_system_prompt` applies `provider_tools.anthropic.prompt_cache`
 * (`provider/runtimes/anthropic.py:770-776`): `ttl: 1h` is long retention and any other ephemeral
 * cache control is short. Undefined when the lock declares no system cache control.
 */
export function nativeCacheRetention(harness: LoadedNativeHarness): "long" | "short" | undefined {
	const prefix = "provider_tools.anthropic.prompt_cache";
	if (nativeLockValue(harness.lock, `${prefix}.apply_to_system`) === false) return undefined;
	if (nativeLockValue(harness.lock, `${prefix}.cache_control.type`) !== "ephemeral") return undefined;
	return nativeLockValue(harness.lock, `${prefix}.cache_control.ttl`) === "1h" ? "long" : "short";
}

/**
 * The Responses chaining the lock declares with `provider_tools.responses_stateful`, which Python's
 * Responses runtime reads to decide whether a request continues `previous_response_id`
 * (`provider/runtimes/openai/responses.py:63-66`): `false` sends the full transcript on every
 * request. Undefined when the lock does not declare it, which leaves OMP's provider default.
 */
export function nativeStatefulResponses(harness: LoadedNativeHarness): boolean | undefined {
	const declared = nativeLockValue(harness.lock, "provider_tools.responses_stateful");
	return typeof declared === "boolean" ? declared : undefined;
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
				results.push({
					name: call.name,
					output: { error: PERMISSION_REJECTED, __mvi_text_output: PERMISSION_REJECTED },
				});
				continue;
			}
			const applied = await applyUnifiedPatchAdapter(
				harness.workspaceRoot,
				stringField(call.arguments, "patch") ?? "",
			);
			results.push({
				name: call.name,
				output: isJsonRecord(applied.details) ? applied.details : { output: applied.text },
			});
			continue;
		}
		throw new Error(`native harness text tool ${call.name} has no OMP binding`);
	}
	return formatTextToolResults(results);
}

function assertNativeHarnessBindings(harness: LoadedNativeHarness): void {
	for (const tool of harness.registeredToolSurface.native) {
		if (nativeBindingForTool(tool) === undefined)
			throw new Error(`native harness tool ${tool.name} has no OMP binding`);
	}
}

/**
 * Registers `harness`'s tools. Each call resolves against the generation active when it runs, so a
 * tool a later generation dropped fails instead of running with the old generation's definition.
 */
function registerFunctionTools(
	api: ExtensionAPI,
	harness: LoadedNativeHarness,
	getActiveHarness: () => LoadedNativeHarness,
	todos: TodoWriteState,
	guard: CompletionGuard,
): void {
	assertNativeHarnessBindings(harness);
	for (const tool of harness.registeredToolSurface.native) {
		const binding = nativeBindingForTool(tool);
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
				const activeHarness = getActiveHarness();
				const activeTool = activeHarness.registeredToolSurface.native.find(t => t.name === tool.name);
				const activeBinding = activeTool === undefined ? undefined : nativeBindingForTool(activeTool);
				if (activeBinding === undefined) {
					throw new Error(`Tool "${tool.name}" is not registered in the active generation`);
				}
				const input = parseCanonicalJson(JSON.stringify(params ?? null));
				if (!isJsonRecord(input)) throw new Error(`${tool.name} arguments must be an object`);
				const output = await activeBinding.run({
					input,
					harness: activeHarness,
					context,
					signal,
					onUpdate,
					todos,
					guard,
				});
				return {
					content: [{ type: "text", text: output.text }],
					details: output.details,
					...(output.isError === true ? { isError: true } : {}),
				};
			},
		});
	}
}
interface NativeHarnessSourceInfo {
	readonly mtimeMs: number;
	readonly size: number;
}

interface NativeHarnessWatchOptions {
	readonly live: NativeHarnessLiveState;
	readonly specPath: string;
	readonly context: ExtensionContext;
	readonly statFile?: (path: string) => Promise<NativeHarnessSourceInfo>;
	readonly readSource?: (path: string) => Promise<Uint8Array>;
}

function sha256Source(source: Uint8Array): string {
	return createHash("sha256").update(source).digest("hex");
}

export interface NativeHarnessWatcherHandle {
	readonly ready: Promise<void>;
	readonly dispose: () => void;
}

export function startNativeHarnessWatcher(options: NativeHarnessWatchOptions): NativeHarnessWatcherHandle {
	const statFile =
		options.statFile ??
		(async (path: string): Promise<NativeHarnessSourceInfo> => {
			const info = await stat(path);
			return { mtimeMs: info.mtimeMs, size: info.size };
		});
	const readSource = options.readSource ?? (async (path: string): Promise<Uint8Array> => readFile(path));
	let disposed = false;
	let lifecycle = 0;
	let observed: NativeHarnessSourceInfo | undefined;
	let lastObservedHash: string | undefined;
	let reloadInFlight: Promise<void> | undefined;
	let pendingHash: string | undefined;
	let reloadAgain = false;
	/** Once quiescent, the published generation's sourceHash equals the current disk hash. */
	let debounceTimer: Timer | undefined;
	let intervalTimer: Timer | undefined;
	const notifyReloadError = (error: unknown): void => {
		if (disposed) return;
		const message =
			error instanceof NativeHarnessReloadError
				? `Harness reload rejected [${error.code}] at generation ${error.generation}: ${error.message}`
				: `Harness reload rejected: ${error instanceof Error ? error.message : String(error)}`;
		options.context.ui.notify(message, "error");
	};
	const runReload = async (sourceHash: string): Promise<void> => {
		if (disposed) return;
		if (reloadInFlight !== undefined) {
			reloadAgain = true;
			pendingHash = sourceHash;
			return;
		}
		const reloadLifecycle = lifecycle;
		reloadInFlight = options.live
			.reload(next => {
				if (disposed || lifecycle !== reloadLifecycle) throw new Error("harness watcher disposed");
				assertNativeHarnessBindings(next);
			})
			.then(async loaded => {
				if (disposed || lifecycle !== reloadLifecycle) return;
				const currentSource = await readSource(options.specPath).catch(() => undefined);
				if (disposed || lifecycle !== reloadLifecycle || currentSource === undefined) return;
				const currentHash = sha256Source(currentSource);
				if (currentHash !== loaded.sourceHash) {
					reloadAgain = true;
					pendingHash = currentHash;
				}
			})
			.catch(notifyReloadError)
			.finally(() => {
				reloadInFlight = undefined;
				if (!disposed && reloadAgain) {
					reloadAgain = false;
					const nextHash = pendingHash ?? lastObservedHash;
					pendingHash = undefined;
					if (nextHash !== undefined) scheduleReload(nextHash);
				}
			});
		await reloadInFlight;
	};
	const scheduleReload = (sourceHash: string): void => {
		if (disposed) return;
		if (debounceTimer !== undefined) {
			options.context.clearTimer(debounceTimer);
			debounceTimer = undefined;
		}
		pendingHash = sourceHash;
		debounceTimer = options.context.setTimeout(() => {
			debounceTimer = undefined;
			if (!disposed) {
				const hash = pendingHash;
				pendingHash = undefined;
				if (hash !== undefined) void runReload(hash);
			}
		}, 150);
	};
	const poll = async (): Promise<void> => {
		if (disposed) return;
		const info = await statFile(options.specPath).catch(() => undefined);
		if (disposed || info === undefined) return;
		const source = await readSource(options.specPath).catch(() => undefined);
		if (disposed || source === undefined) return;
		const sourceHash = sha256Source(source);
		const metadataChanged =
			observed === undefined || observed.mtimeMs !== info.mtimeMs || observed.size !== info.size;
		observed = info;
		if (!metadataChanged && sourceHash === lastObservedHash) return;
		lastObservedHash = sourceHash;
		if (reloadInFlight !== undefined) {
			reloadAgain = true;
			pendingHash = sourceHash;
		} else {
			scheduleReload(sourceHash);
		}
	};
	const ready = (async (): Promise<void> => {
		const initialInfo = await statFile(options.specPath).catch(() => undefined);
		const initialSource = await readSource(options.specPath).catch(() => undefined);
		if (disposed) return;
		const loadedHash = options.live.current().sourceHash;
		lastObservedHash = loadedHash;
		if (initialInfo !== undefined && initialSource !== undefined) {
			observed = initialInfo;
			const diskHash = sha256Source(initialSource);
			if (diskHash !== loadedHash) {
				lastObservedHash = diskHash;
				scheduleReload(diskHash);
			}
		}
		intervalTimer = options.context.setInterval(() => {
			void poll();
		}, 1000);
	})();
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		lifecycle += 1;
		reloadAgain = false;
		pendingHash = undefined;
		if (debounceTimer !== undefined) {
			options.context.clearTimer(debounceTimer);
			debounceTimer = undefined;
		}
		if (intervalTimer !== undefined) {
			options.context.clearTimer(intervalTimer);
			intervalTimer = undefined;
		}
	};
	return { ready, dispose };
}

function developerRolePayload(payload: unknown): unknown {
	if (!isJsonRecord(payload as never)) return payload;
	const record = payload as JsonRecord;
	if (!Array.isArray(record.input)) return payload;
	const input = (record.input as unknown[]).map((item: unknown) => {
		if (!isJsonRecord(item as never)) return item;
		const itemRecord = item as JsonRecord;
		if (itemRecord.role !== "developer" || typeof itemRecord.content !== "string") return item;
		return { ...itemRecord, content: [{ type: "input_text", text: itemRecord.content }] };
	});
	return { ...record, input };
}

function instructionsPayload(payload: unknown): unknown {
	if (!isJsonRecord(payload as never) || !Array.isArray((payload as JsonRecord).input)) return payload;
	const record = payload as JsonRecord;
	let instructions = typeof record.instructions === "string" ? record.instructions : undefined;
	const input: unknown[] = [];
	for (const item of record.input as unknown[]) {
		if (!isJsonRecord(item as never) || (item as JsonRecord).role !== "developer") {
			input.push(item);
			continue;
		}
		const content = (item as JsonRecord).content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(
								(part): part is JsonRecord =>
									isJsonRecord(part) && part.type === "input_text" && typeof part.text === "string",
							)
							.map(part => part.text as string)
							.join("")
					: "";
		if (text) instructions = instructions === undefined ? text : `${instructions}\n\n${text}`;
	}
	return {
		...record,
		input,
		...(instructions === undefined ? {} : { instructions }),
	};
}

interface ResponsesSystem {
	readonly developer: readonly JsonRecord[];
	readonly instructions?: string;
}

/** The system prompt OMP put in a Responses payload, before any harness role conversion. */
function responsesSystem(payload: unknown): ResponsesSystem | undefined {
	if (!isJsonRecord(payload as never) || !Array.isArray((payload as JsonRecord).input)) return undefined;
	const record = payload as JsonRecord;
	const developer = (record.input as unknown[]).filter(
		(item): item is JsonRecord => isJsonRecord(item as never) && (item as JsonRecord).role === "developer",
	);
	return typeof record.instructions === "string" ? { developer, instructions: record.instructions } : { developer };
}

/** Puts `system` back on a chained request that carries none of its own. */
function withResponsesSystem(payload: unknown, system: ResponsesSystem): unknown {
	const record = payload as JsonRecord;
	if (typeof record.previous_response_id !== "string") return payload;
	const own = responsesSystem(payload);
	if (own === undefined || own.developer.length > 0 || own.instructions !== undefined) return payload;
	return {
		...record,
		input: [...system.developer, ...(record.input as unknown[])],
		...(system.instructions === undefined ? {} : { instructions: system.instructions }),
	};
}

function usesResponsesDialect(lock: JsonRecord): boolean {
	if (nativeLockValue(lock, "provider_tools.api_variant") === "responses") return true;
	const models = nativeLockValue(lock, "providers.models");
	return (
		Array.isArray(models) &&
		models.some(model => isJsonRecord(model as never) && model.adapter === "openai_responses")
	);
}

/**
 * The extension that makes an OMP session run a compiled BreadBoard harness, including stage
 * transitions between continuation requests. On a host surface it leaves OMP's tools and turns
 * alone and appends the harness prompt blocks after OMP's own system prompt.
 */
export function createNativeHarnessExtension(harness: LoadedNativeHarness): ExtensionFactory {
	return api => {
		let pendingGeneration: number | undefined;
		let activeHarness = harness;
		let pendingHarness = harness;
		const getActiveHarness = (): LoadedNativeHarness => activeHarness;
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
		// Python sends the system prompt on every Responses request (`responses.py:68-114`), including
		// requests chained with `previous_response_id`; OMP's delta input drops it after the first turn,
		// and a chained request does not inherit `instructions`. A chained request only happens when
		// the history prefix, system messages included, is unchanged, so the last full request's
		// system items are the ones in effect.
		let lastSystem: ResponsesSystem = { developer: [] };
		api.on("before_provider_request", event => {
			if (!usesResponsesDialect(activeHarness.lock)) return undefined;
			const current = responsesSystem(event.payload);
			if (current !== undefined && (current.developer.length > 0 || current.instructions !== undefined)) {
				lastSystem = current;
			}
			const payload = current === undefined ? event.payload : withResponsesSystem(event.payload, lastSystem);
			return nativeLockValue(activeHarness.lock, "provider_tools.responses_use_developer_role") === true
				? developerRolePayload(payload)
				: instructionsPayload(payload);
		});
		const applyStage = async (): Promise<void> => {
			const stage = stageMachine.current;
			promptOverride.splice(0, promptOverride.length, stage.systemPrompt);
			await api.setActiveTools(stage.toolSurface.native.map(tool => tool.name));
		};
		const commitPendingHarness = async (): Promise<void> => {
			if (pendingHarness === activeHarness) return;
			const next = pendingHarness;
			const generation = pendingGeneration;
			registerFunctionTools(api, next, getActiveHarness, todos, guard);
			activeHarness = next;
			transcript.specPath = next.harnessId;
			transcript.graphHash = next.graphHash;
			stageMachine = createNativeStageMachine(activeHarness.lock, activeHarness.stages);
			policy = new NativeTurnPolicy(activeHarness.registeredToolSurface);
			await applyStage();
			if (generation !== undefined) {
				recordGeneration(generation, activeHarness);
				if (pendingHarness === next && pendingGeneration === generation) pendingGeneration = undefined;
			}
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
		const live = activeHarness.live;
		live?.setReloadValidator(assertNativeHarnessBindings);
		registerFunctionTools(api, activeHarness, getActiveHarness, todos, guard);
		if (live?.editable) {
			api.on("session_start", async (_event, context) => {
				const watcher = startNativeHarnessWatcher({
					live,
					specPath: activeHarness.specPath,
					context,
				});
				api.on("session_shutdown", watcher.dispose);
				await watcher.ready;
			});
		}
		activeHarness.live?.subscribe(change => {
			pendingHarness = change.harness;
			pendingGeneration = change.generation;
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
				...(text === undefined
					? []
					: [{ customType: NATIVE_TEXT_RESULTS_MESSAGE_TYPE, content: text, display: true }]),
				...guard
					.takeAdvisories()
					.map(content => ({ customType: NATIVE_GUARD_MESSAGE_TYPE, content, display: true })),
			];
			return messages.length === 0 ? undefined : { messages };
		});
		api.on("agent_end", () => {
			for (const content of guard.takeAdvisories()) {
				api.sendMessage(
					{ customType: NATIVE_GUARD_MESSAGE_TYPE, content, display: true },
					{ deliverAs: "nextTurn" },
				);
			}
		});
		// Python frames a user message once, with the stage in effect when it was sent, and keeps that
		// framing in history (`prompt_planner.py:104-118`). OMP rebuilds the provider context every turn,
		// so remember each message's framing by its position among user messages and its timestamp.
		const framedUserMessages = new Map<string, { rawText: string; framed: string | NativeUserTextBlock[] }>();
		const framedOnce = (key: string, rawText: string): string | NativeUserTextBlock[] => {
			const cached = framedUserMessages.get(key);
			if (cached?.rawText === rawText) return cached.framed;
			const framed = frameNativeUserContent(rawText, stageMachine.current);
			framedUserMessages.set(key, { rawText, framed });
			return framed;
		};
		api.on("context", event => {
			let userIndex = 0;
			return {
				messages: event.messages.map(message => {
					if (
						message.role === "custom" &&
						(message.customType === NATIVE_TEXT_RESULTS_MESSAGE_TYPE ||
							message.customType === NATIVE_GUARD_MESSAGE_TYPE)
					) {
						return {
							role: "user",
							content:
								typeof message.content === "string"
									? [{ type: "text", text: message.content }]
									: message.content,
							attribution: "agent",
							timestamp: message.timestamp,
						};
					}
					if (message.role !== "user" || message.attribution === "agent") return message;
					const key = `${userIndex++}:${message.timestamp}`;
					if (typeof message.content === "string") {
						return { ...message, content: framedOnce(key, message.content) };
					}
					const first = message.content.findIndex(block => block.type === "text");
					if (first < 0) return message;
					const block = message.content[first];
					if (block.type !== "text") return message;
					const framed = framedOnce(key, block.text);
					if (typeof framed === "string") {
						return {
							...message,
							content: message.content.map((candidate, index) =>
								index === first && candidate.type === "text" ? { ...candidate, text: framed } : candidate,
							),
						};
					}
					return {
						...message,
						content: [...message.content.slice(0, first), ...framed, ...message.content.slice(first + 1)],
					};
				}),
			};
		});
	};
}
