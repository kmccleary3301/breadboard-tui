import { isJsonRecord, type CanonicalJson } from "../canonical-json";
import type { PublicSessionCancelRequest, PublicSessionStartRequest } from "@breadboard/sdk";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcPromptResultFrame,
	RpcReadyFrame,
	RpcResponse,
	RpcSessionEventFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { RpcFrameDecoder, encodeRpcFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type { SessionTranscriptV2 } from "../native/session-transcript";

/** The two harness selectors accepted by the native CLI. */
export type NativeHarnessSelection =
	| { readonly kind: "builtin"; readonly id: string }
	| { readonly kind: "path"; readonly path: string };

/** Convert the ergonomic string form to an explicit selection kind. */
export function normalizeHarnessSelection(selection: string | NativeHarnessSelection): NativeHarnessSelection {
	if (typeof selection !== "string") return selection;
	return selection.endsWith(".yaml") || selection.endsWith(".yml")
		? { kind: "path", path: selection }
		: { kind: "builtin", id: selection };
}

/** A typed policy result for an OMP extension approval request. */
export type NativeApprovalDecision =
	| { readonly decision: "allow" }
	| { readonly decision: "deny"; readonly reason?: string };

export interface NativeApprovalRequest {
	readonly id: string;
	readonly method: "confirm" | "select";
	readonly title: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly timeout?: number;
}

export type NativeApprovalHandler = (
	request: NativeApprovalRequest,
) => NativeApprovalDecision | Promise<NativeApprovalDecision>;

/**
 * Headless approval is fail-closed by default. `deny` answers OMP's confirm or
 * select request with the protocol's false/deny value; `forward` delegates the
 * typed request to the SDK caller and sends the caller's allow/deny decision.
 */
export type NativeApprovalPolicy =
	| { readonly kind: "deny"; readonly reason?: string }
	| { readonly kind: "forward"; readonly decide: NativeApprovalHandler };

export interface NativeRpcEvent {
	readonly kind: "session" | "ui" | "prompt_result";
	readonly frame: RpcSessionEventFrame | RpcExtensionUIRequest | RpcPromptResultFrame;
}

/** Process seam used by tests and by non-local SDK hosts. */
export interface NativeRpcProcess {
	readonly stdin: { write(data: string | Uint8Array): unknown };
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	kill(signal?: number | string, graceMs?: number): void;
}

export interface NativeRpcSpawnOptions {
	readonly cwd?: string;
	readonly env: Record<string, string>;
}

export type NativeRpcSpawn = (
	argv: readonly string[],
	options: NativeRpcSpawnOptions,
) => NativeRpcProcess | Promise<NativeRpcProcess>;

export interface NativeRpcTransportOptions {
	/** Installed `bb`/`omp` executable. */
	readonly binaryPath: string;
	readonly harness?: string | NativeHarnessSelection;
	readonly cwd?: string;
	/** Environment overrides; set `inheritEnv: false` for isolated candidate launches. */
	readonly env?: Readonly<Record<string, string>>;
	readonly inheritEnv?: boolean;
	readonly model?: string;
	readonly provider?: string;
	readonly sessionDir?: string;
	/** Resume this OMP session file when the RPC process starts. */
	readonly resumeSession?: string;
	readonly approval?: NativeApprovalPolicy;
	readonly spawn?: NativeRpcSpawn;
	readonly startupTimeoutMs?: number;
	readonly commandTimeoutMs?: number;
	readonly transcriptTimeoutMs?: number;
}

/** Native RPC create request reuses the public HTTP task/session-id shape. */
export type NativeSessionCreateRequest = Omit<PublicSessionStartRequest, "lock_id"> & { readonly lock_id?: string };

/** RPC has no server clock; `created_at` is the client observation time. */
export interface NativeSessionCreateResponse {
	readonly session_id: string;
	readonly status: NativeSessionStatus;
	readonly created_at: string;
	readonly logging_dir: string | null;
	readonly transport: "omp-rpc";
}

export type NativeSessionStatus =
	| "starting"
	| "running"
	| "awaiting_approval"
	| "paused"
	| "completed"
	| "failed"
	| "canceled"
	| "stopped";

export interface NativeSessionHandle {
	readonly session_id: string;
	readonly session_file?: string;
	readonly status: NativeSessionStatus;
}

type RpcCommandBody = RpcCommand extends infer Command
	? Command extends RpcCommand
		? Omit<Command, "id">
		: never
	: never;
type RpcSuccessResponse<Command extends RpcCommandBody["type"]> = Extract<
	RpcResponse,
	{ readonly type: "response"; readonly command: Command; readonly success: true }
>;
type RpcResponseFor<Command extends RpcCommandBody["type"]> = Extract<
	RpcResponse,
	{ readonly type: "response"; readonly command: Command }
>;

type ResponseData<Command extends RpcCommandBody["type"]> =
	RpcSuccessResponse<Command> extends infer Response
		? Response extends { data: infer Data }
			? Data
			: undefined
		: never;

type UiNotifyRequest = Extract<RpcExtensionUIRequest, { readonly method: "notify" }>;
type UiConfirmRequest = Extract<RpcExtensionUIRequest, { readonly method: "confirm" }>;
type UiSelectRequest = Extract<RpcExtensionUIRequest, { readonly method: "select" }>;

class AsyncQueue<T> {
	#values: T[] = [];
	#waiters: Array<(result: IteratorResult<T>) => void> = [];
	#closed = false;

	push(value: T): void {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value });
		else this.#values.push(value);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}

	async *iterate(): AsyncGenerator<T, void, void> {
		while (true) {
			if (this.#values.length > 0) {
				yield this.#values.shift() as T;
				continue;
			}
			if (this.#closed) return;
			const next = await new Promise<IteratorResult<T>>(resolve => this.#waiters.push(resolve));
			if (next.done) return;
			yield next.value;
		}
	}
}

function isReady(value: unknown): value is RpcReadyFrame {
	const candidate = value as CanonicalJson;
	if (!isJsonRecord(candidate)) return false;
	return candidate.type === "ready" && candidate.protocolVersion === 1;
}

function isResponse(value: unknown): value is RpcResponse {
	const candidate = value as CanonicalJson;
	if (!isJsonRecord(candidate)) return false;
	return (
		candidate.type === "response" && typeof candidate.command === "string" && typeof candidate.success === "boolean"
	);
}

function isUiRequest(value: unknown): value is RpcExtensionUIRequest {
	const candidate = value as CanonicalJson;
	if (!isJsonRecord(candidate)) return false;
	return (
		candidate.type === "extension_ui_request" &&
		typeof candidate.id === "string" &&
		typeof candidate.method === "string"
	);
}

function isPromptResult(value: unknown): value is RpcPromptResultFrame {
	const candidate = value as CanonicalJson;
	if (!isJsonRecord(candidate)) return false;
	return candidate.type === "prompt_result" && typeof candidate.agentInvoked === "boolean";
}

function isSessionEvent(value: unknown): value is RpcSessionEventFrame {
	const candidate = value as CanonicalJson;
	if (!isJsonRecord(candidate)) return false;
	return (
		typeof candidate.type === "string" &&
		candidate.type !== "response" &&
		candidate.type !== "ready" &&
		candidate.type !== "extension_ui_request" &&
		candidate.type !== "prompt_result"
	);
}
function toEnvironment(
	overrides: Readonly<Record<string, string>> | undefined,
	inheritEnv: boolean,
): Record<string, string> {
	const inherited = inheritEnv
		? Object.fromEntries(
				Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			)
		: {};
	return { ...inherited, ...overrides };
}

function statusForState(isStreaming: boolean): NativeSessionStatus {
	return isStreaming ? "running" : "completed";
}

/**
 * Minimal JSONL client for the installed native product. It intentionally does
 * not modify coding-agent's RPC mode: the harness package owns this transport
 * and consumes only the exported RPC wire types and frame codec.
 */
export class NativeRpcTransport {
	readonly #options: NativeRpcTransportOptions;
	readonly #events = new AsyncQueue<NativeRpcEvent>();
	readonly #pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
	readonly #notifyWaiters: Array<(request: UiNotifyRequest) => void> = [];
	#process: NativeRpcProcess | undefined;
	#readerTask: Promise<void> | undefined;
	#readyResolve: (() => void) | undefined;
	#readyReject: ((error: Error) => void) | undefined;
	#ready = false;
	#requestId = 0;
	#resumeSession: string | undefined;
	#session: NativeSessionHandle | undefined;
	#stopping = false;

	constructor(options: NativeRpcTransportOptions) {
		if (!options.binaryPath) throw new Error("Native RPC transport requires binaryPath");
		this.#options = options;
		this.#resumeSession = options.resumeSession;
	}

	/** Build the exact CLI args used for native RPC startup. */
	buildArguments(): string[] {
		const args = ["--mode", "rpc", "--engine-mode", "native"];
		if (this.#options.harness !== undefined) {
			const selection = normalizeHarnessSelection(this.#options.harness);
			args.push("--harness", selection.kind === "builtin" ? selection.id : selection.path);
		}
		if (this.#options.provider !== undefined) args.push("--provider", this.#options.provider);
		if (this.#options.model !== undefined) args.push("--model", this.#options.model);
		if (this.#options.sessionDir !== undefined) args.push("--session-dir", this.#options.sessionDir);
		if (this.#resumeSession !== undefined) args.push("--resume", this.#resumeSession);
		return args;
	}

	async start(): Promise<void> {
		if (this.#process) return;
		const spawn = this.#options.spawn ?? defaultSpawn;
		const argv = [this.#options.binaryPath, ...this.buildArguments()];
		const child = await spawn(argv, {
			cwd: this.#options.cwd,
			env: toEnvironment(this.#options.env, this.#options.inheritEnv !== false),
		});
		this.#process = child;
		this.#stopping = false;
		const ready = new Promise<void>((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});
		this.#readerTask = this.#read(child);
		const timeout = this.#options.startupTimeoutMs ?? 30_000;
		let timeoutId: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				ready,
				new Promise<never>((_, reject) => {
					timeoutId = setTimeout(() => reject(new Error("Timed out waiting for native RPC ready")), timeout);
				}),
			]);
		} catch (error) {
			await this.stop();
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	async createSession(request: NativeSessionCreateRequest): Promise<NativeSessionCreateResponse> {
		await this.start();
		if (this.#session) {
			const result = await this.#send({ type: "new_session" });
			const newSession = this.#data<"new_session", { cancelled: boolean }>(result);
			if (newSession.cancelled) throw new Error("Native RPC session creation was cancelled");
		}
		const state = await this.#state();
		this.#session = {
			session_id: state.sessionId,
			...(state.sessionFile === undefined ? {} : { session_file: state.sessionFile }),
			status: "starting",
		};
		await this.prompt(request.task);
		const running = await this.#state();
		const response: NativeSessionCreateResponse = {
			session_id: running.sessionId,
			status: statusForState(running.isStreaming),
			created_at: new Date().toISOString(),
			logging_dir: running.sessionFile === undefined ? null : running.sessionFile,
			transport: "omp-rpc",
		};
		this.#session = {
			session_id: running.sessionId,
			...(running.sessionFile === undefined ? {} : { session_file: running.sessionFile }),
			status: response.status,
		};
		return response;
	}

	async resumeSession(sessionFile: string): Promise<NativeSessionCreateResponse> {
		if (!sessionFile) throw new Error("resumeSession requires a session file");
		if (!this.#process) {
			this.#resumeSession = sessionFile;
			await this.start();
		} else {
			const response = await this.#send({ type: "switch_session", sessionPath: sessionFile });
			const result = this.#data<"switch_session", { cancelled: boolean }>(response);
			if (result.cancelled) throw new Error("Native RPC session resume was cancelled");
		}
		const state = await this.#state();
		this.#session = {
			session_id: state.sessionId,
			...(state.sessionFile === undefined ? {} : { session_file: state.sessionFile }),
			status: "paused",
		};
		return {
			session_id: state.sessionId,
			status: "paused",
			created_at: new Date().toISOString(),
			logging_dir: state.sessionFile === undefined ? null : state.sessionFile,
			transport: "omp-rpc",
		};
	}

	async prompt(message: string): Promise<void> {
		await this.#send({ type: "prompt", message });
	}

	async cancel(request?: PublicSessionCancelRequest): Promise<void> {
		void request;
		await this.#send({ type: "abort" });
	}

	/** Request the native `/bb-transcript` exporter and return its announced path. */
	async exportTranscript(): Promise<string | undefined> {
		const result = new Promise<string | undefined>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				const index = this.#notifyWaiters.indexOf(onNotify);
				if (index >= 0) this.#notifyWaiters.splice(index, 1);
				reject(new Error("Timed out waiting for the native transcript exporter"));
			}, this.#options.transcriptTimeoutMs ?? 30_000);
			const onNotify = (request: UiNotifyRequest): void => {
				clearTimeout(timeoutId);
				if (request.message.startsWith("Transcript written to "))
					resolve(request.message.slice("Transcript written to ".length));
				else if (request.message.startsWith("No session file yet")) resolve(undefined);
				else return;
				const index = this.#notifyWaiters.indexOf(onNotify);
				if (index >= 0) this.#notifyWaiters.splice(index, 1);
			};
			this.#notifyWaiters.push(onNotify);
		});
		await this.prompt("/bb-transcript");
		return result;
	}

	/** Top-level session events and headless UI requests in arrival order. */
	events(): AsyncGenerator<NativeRpcEvent, void, void> {
		return this.#events.iterate();
	}

	async stop(): Promise<void> {
		if (!this.#process) return;
		this.#stopping = true;
		this.#events.close();
		this.#process.kill();
		await this.#process.exited.catch(() => undefined);
		await this.#readerTask?.catch(() => undefined);
		this.#process = undefined;
	}

	async #state(): Promise<ResponseData<"get_state">> {
		const response = await this.#send({ type: "get_state" });
		return this.#data<"get_state", ResponseData<"get_state">>(response);
	}

	async #send<Command extends RpcCommandBody>(command: Command): Promise<RpcResponseFor<Command["type"]>> {
		if (!this.#process) throw new Error("Native RPC transport is not started");
		const id = `bb_sdk_${++this.#requestId}`;
		const frame = { ...command, id } as RpcCommand;
		const response = new Promise<RpcResponse>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
		try {
			this.#process.stdin.write(`${encodeRpcFrame(frame)}\n`);
		} catch (error) {
			this.#pending.delete(id);
			throw error;
		}
		const timeoutId = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			pending.reject(new Error(`Timed out waiting for native RPC ${command.type}`));
		}, this.#options.commandTimeoutMs ?? 30_000);
		try {
			return (await response) as RpcResponseFor<Command["type"]>;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	#data<Command extends RpcCommandBody["type"], Data>(response: RpcResponseFor<Command>): Data {
		if (!response.success) throw new Error(`${response.command}: ${response.error}`);
		return ("data" in response ? response.data : undefined) as Data;
	}

	async #read(child: NativeRpcProcess): Promise<void> {
		const decoder = new TextDecoder();
		const frameDecoder = new RpcFrameDecoder();
		const reader = child.stdout.getReader();
		let buffer = "";
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				buffer += decoder.decode(next.value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) {
						const parsed: unknown = JSON.parse(line);
						const decoded = frameDecoder.push(parsed);
						if (decoded !== undefined) this.#handle(decoded);
					}
					newline = buffer.indexOf("\n");
				}
			}
		} catch (error) {
			const reason = error instanceof Error ? error : new Error(String(error));
			this.#readyReject?.(reason);
			for (const pending of this.#pending.values()) pending.reject(reason);
			this.#pending.clear();
		} finally {
			reader.releaseLock();
			if (!this.#ready && !this.#stopping) this.#readyReject?.(new Error("Native RPC output ended before ready"));
			this.#events.close();
		}
	}

	#handle(value: unknown): void {
		if (!this.#ready && isReady(value)) {
			this.#ready = true;
			this.#readyResolve?.();
			return;
		}
		if (isResponse(value)) {
			if (value.id !== undefined) {
				const pending = this.#pending.get(value.id);
				if (pending) {
					this.#pending.delete(value.id);
					pending.resolve(value);
					return;
				}
			}
			return;
		}
		if (isUiRequest(value)) {
			this.#events.push({ kind: "ui", frame: value });
			if (value.method === "confirm" || value.method === "select") void this.#resolveApproval(value);
			if (value.method === "notify") {
				for (const waiter of [...this.#notifyWaiters]) waiter(value);
			}
			return;
		}
		if (isPromptResult(value)) {
			this.#events.push({ kind: "prompt_result", frame: value });
			return;
		}
		if (isSessionEvent(value)) this.#events.push({ kind: "session", frame: value });
	}

	async #resolveApproval(request: UiConfirmRequest | UiSelectRequest): Promise<void> {
		const policy = this.#options.approval ?? { kind: "deny" as const };
		let allowed = false;
		if (policy.kind === "forward") {
			const decision = await policy.decide({
				id: request.id,
				method: request.method,
				title: request.title,
				...(request.method === "confirm" ? { message: request.message } : { options: request.options }),
				...(request.timeout === undefined ? {} : { timeout: request.timeout }),
			});
			allowed = decision.decision === "allow";
		}
		const response: RpcExtensionUIResponse =
			request.method === "confirm"
				? { type: "extension_ui_response", id: request.id, confirmed: allowed }
				: {
						type: "extension_ui_response",
						id: request.id,
						value: allowed
							? (request.options.find(option => option.toLowerCase() === "approve") ??
								request.options[0] ??
								"Approve")
							: (request.options.find(option => option.toLowerCase() === "deny") ??
								request.options.at(-1) ??
								"Deny"),
					};
		this.#process?.stdin.write(`${encodeRpcFrame(response)}\n`);
	}
}

async function defaultSpawn(argv: readonly string[], options: NativeRpcSpawnOptions): Promise<NativeRpcProcess> {
	const child = Bun.spawn([...argv], {
		cwd: options.cwd,
		env: options.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return child;
}

/** Keep the generated transcript contract reachable from the SDK package surface. */
export type { SessionTranscriptV2 };
