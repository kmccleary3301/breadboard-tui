import { join } from "node:path";
import {
	createBreadboardClient,
	type EngineStatusResponse,
	type ModelCatalogResponse,
	type ProviderAuthAttachRequest,
	type ProviderAuthAttachResponse,
	type ProviderAuthDetachRequest,
	type ProviderAuthDetachResponse,
	type ProviderAuthStatusResponse,
} from "@breadboard/sdk";
import type { LifecycleEngineBinding } from "@breadboard/sdk/internal";
import { createCanonicalE4Client } from "@breadboard/sdk/internal";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { CanonicalE4SessionPort } from "./canonical-e4-session-port";
import {
	LIFECYCLE_FAILURE_STATES,
	type LifecycleReadyHandle,
	type LifecycleResult,
	type LifecycleState,
} from "./lifecycle/lifecycle-state";
import {
	LifecycleSupervisor,
	type LifecycleSupervisorDependencies,
	type StopOptions,
} from "./lifecycle/lifecycle-supervisor";
import { LocalAuthorityStore } from "./lifecycle/local-authority-store";
import type { BreadboardRunConfig } from "./lifecycle/run-config";
import type { ModelRolePort } from "./model-role-port";
import { createBreadboardModelRolePort } from "./model-role-port";
import { createBreadboardProviderAuthPort } from "./provider-auth-adapter";
import type { ProviderAuthPort } from "./provider-auth-port";
import type { BreadboardCreateSessionRequest, OpenedSession, OpenSession } from "./session-port";

type BreadboardEngineReadyHandle = Pick<
	LifecycleReadyHandle,
	"mode" | "binding" | "requestFetch" | "registration" | "ownerGeneration"
>;

export type BreadboardLifecycleFailureResult = Extract<LifecycleResult, { readonly kind: "failure" }>;
export type BreadboardEngineConnectionFailure = Exclude<LifecycleResult, { readonly kind: "ready" }>;

export interface BreadboardLifecycleFailureSignal {
	failure(): BreadboardLifecycleFailureResult | undefined;
	subscribe(listener: (state: LifecycleState) => void): () => void;
}

export interface BreadboardEngineAuthorityFacts {
	readonly mode: LifecycleReadyHandle["mode"];
	readonly binding: LifecycleEngineBinding;
	readonly registration: LifecycleReadyHandle["registration"];
	readonly ownerGeneration?: number;
}

export class BreadboardEngineLifecycleError extends Error {
	override readonly name = "BreadboardEngineLifecycleError";

	constructor(readonly result: BreadboardLifecycleFailureResult) {
		super(`BreadBoard lifecycle entered ${result.state.name}`);
	}
}

export interface BreadboardEnginePort {
	readonly authority: BreadboardEngineAuthorityFacts;
	readonly lifecycleFailure: BreadboardLifecycleFailureSignal;
	openSession(target: OpenSession, signal?: AbortSignal): Promise<OpenedSession>;
	/** Explicit control-plane calls; native OMP remains provider/UI authority until invoked. */
	getFeatures(): Promise<EngineStatusResponse>;
	getModelCatalog(configPath: string): Promise<ModelCatalogResponse>;
	getProviderAuthStatus(): Promise<ProviderAuthStatusResponse>;
	readonly modelRoles: ModelRolePort;
	attachProviderAuth(request: ProviderAuthAttachRequest): Promise<ProviderAuthAttachResponse>;
	detachProviderAuth(request: ProviderAuthDetachRequest): Promise<ProviderAuthDetachResponse>;
	readonly providerAuth: ProviderAuthPort;
	close(): Promise<void>;
}

export interface BreadboardEngineConnectionOptions {
	readonly onLateSessionCloseError: (error: unknown) => void;
	readonly onLifecycleFailure?: (result: BreadboardLifecycleFailureResult) => void;
	readonly dependencies?: LifecycleSupervisorDependencies;
}

export type BreadboardEngineConnectionResult =
	| { readonly kind: "ready"; readonly port: BreadboardEnginePort }
	| { readonly kind: "failure"; readonly result: BreadboardEngineConnectionFailure };

interface LifecycleMonitor {
	readonly signal: BreadboardLifecycleFailureSignal;
	readonly stateChanged: (state: LifecycleState) => void;
}

function isLifecycleFailureState(state: LifecycleState): state is BreadboardLifecycleFailureResult["state"] {
	return (LIFECYCLE_FAILURE_STATES as readonly LifecycleState["name"][]).includes(state.name);
}

function createLifecycleMonitor(
	onLifecycleFailure?: BreadboardEngineConnectionOptions["onLifecycleFailure"],
): LifecycleMonitor {
	let failure: BreadboardLifecycleFailureResult | undefined;
	const listeners = new Set<(state: LifecycleState) => void>();
	const stateChanged = (state: LifecycleState): void => {
		if (failure === undefined && isLifecycleFailureState(state)) {
			failure = { kind: "failure", state };
			try {
				onLifecycleFailure?.(failure);
			} catch (error) {
				logger.warn("BreadBoard lifecycle failure presentation failed", { error: String(error) });
			}
		}
		for (const listener of listeners) {
			try {
				listener(state);
			} catch (error) {
				logger.warn("BreadBoard lifecycle state listener failed", { error: String(error) });
			}
		}
	};
	return {
		signal: Object.freeze({
			failure: () => failure,
			subscribe: (listener: (state: LifecycleState) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		}),
		stateChanged,
	};
}

function authorityFacts(handle: BreadboardEngineReadyHandle): BreadboardEngineAuthorityFacts {
	return Object.freeze({
		mode: handle.mode,
		binding: Object.freeze({ ...handle.binding }),
		registration: Object.freeze({ ...handle.registration }),
		ownerGeneration: handle.ownerGeneration,
	});
}
const SESSION_SCOPED_EVENT_TYPES = new Set([
	"todo_updated",
	"checkpoint_list",
	"checkpoint_restored",
	"skills_catalog",
	"skills_selection",
	"ctree_node",
	"ctree_snapshot",
]);

function visibleAssistantText(payload: unknown): string {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
	const text = (payload as Record<string, unknown>).text;
	return typeof text === "string" ? text.replace(/\n*>>>>>> END RESPONSE\s*$/, "") : "";
}

interface BreadboardSessionCreatePayload {
	readonly config_path?: string;
	readonly task: string;
	readonly overrides?: BreadboardCreateSessionRequest["overrides"];
	readonly metadata?: BreadboardCreateSessionRequest["metadata"];
	readonly workspace: string;
	readonly max_steps?: BreadboardCreateSessionRequest["maxSteps"];
	readonly permission_mode?: BreadboardCreateSessionRequest["permissionMode"];
	readonly stream?: BreadboardCreateSessionRequest["stream"];
}

export function buildBreadboardSessionCreatePayload(
	request: BreadboardCreateSessionRequest,
): BreadboardSessionCreatePayload {
	if (request.workspace.length === 0) {
		throw new Error("BreadBoard session create request requires a workspace");
	}
	if (request.configPath !== undefined && request.configPath.length === 0) {
		throw new Error("BreadBoard session create request contains an empty config path");
	}
	return {
		...(request.configPath === undefined ? {} : { config_path: request.configPath }),
		task: request.task ?? "",
		...(request.overrides === undefined ? {} : { overrides: request.overrides }),
		...(request.metadata === undefined ? {} : { metadata: request.metadata }),
		workspace: request.workspace,
		...(request.maxSteps === undefined ? {} : { max_steps: request.maxSteps }),
		...(request.permissionMode === undefined ? {} : { permission_mode: request.permissionMode }),
		...(request.stream === undefined ? {} : { stream: request.stream }),
	};
}

export function filterUncorrelatedCanonicalEvents(response: Response): Response {
	if (!response.body) return response;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending = "";
	let block = "";
	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			pending += decoder.decode(chunk, { stream: true });
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline < 0) break;
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (line.length > 0) {
					block += `${line}\n`;
					continue;
				}
				let drop = false;
				const data = block
					.split("\n")
					.filter(line => line.startsWith("data:"))
					.map(line => line.slice(5).trimStart())
					.join("\n");
				if (data) {
					try {
						const raw = JSON.parse(data) as Record<string, unknown>;
						if (raw.type === "assistant_message") {
							raw.type = "assistant.message.end";
							raw.payload = { text: visibleAssistantText(raw.payload) };
						}
						const turn = raw.turn;
						if (
							raw.stable_cursor === true &&
							Number.isSafeInteger(turn) &&
							raw.turn_id == null &&
							raw.input_id == null
						) {
							raw.turn_id = `turn-${turn}`;
							raw.input_id = `input-${turn}`;
						}
						if (raw.stable_cursor === true && raw.turn_id != null && raw.input_id != null) {
							const lines = block.split("\n");
							const dataIndex = lines.findIndex(line => line.startsWith("data:"));
							if (dataIndex >= 0) lines[dataIndex] = `data: ${JSON.stringify(raw)}`;
							block = lines.join("\n");
						}
						drop =
							raw.stable_cursor === true &&
							(raw.turn_id == null || raw.input_id == null) &&
							typeof raw.type === "string" &&
							!SESSION_SCOPED_EVENT_TYPES.has(raw.type);
					} catch {
						drop = false;
					}
				}
				if (!drop) controller.enqueue(encoder.encode(`${block}\n`));
				block = "";
			}
		},
		flush(controller) {
			pending += decoder.decode();
			if (pending.length > 0) block += pending;
			if (block.length > 0) controller.enqueue(encoder.encode(block));
		},
	});
	return new Response(response.body.pipeThrough(transform), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function createConnectedPort(
	handle: BreadboardEngineReadyHandle,
	supervisor: LifecycleSupervisor,
	monitor: LifecycleMonitor,
	options: BreadboardEngineConnectionOptions,
): BreadboardEnginePort {
	const strictEventFetch = Object.assign(
		async (input: Parameters<typeof handle.requestFetch>[0], init: Parameters<typeof handle.requestFetch>[1]) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
			if (url.pathname.endsWith("/events")) {
				url.searchParams.set("schema", "2");
				url.searchParams.set("include_legacy", "false");
			}
			const response = await handle.requestFetch(url, init);
			return url.pathname.endsWith("/events") ? filterUncorrelatedCanonicalEvents(response) : response;
		},
		{ preconnect: handle.requestFetch.preconnect },
	);
	const clientConfig = {
		baseUrl: handle.binding.endpoint,
		requestTimeoutMs: supervisor.config.requestTimeoutMs,
		fetch: strictEventFetch,
	};
	const canonicalClient = createCanonicalE4Client(clientConfig);
	const controlClient = createBreadboardClient(clientConfig);
	const sessionClient = {
		...canonicalClient,
		async create(request: BreadboardCreateSessionRequest) {
			const created = await controlClient.createSession(buildBreadboardSessionCreatePayload(request));
			return await canonicalClient.attach({ sessionId: created.session_id });
		},
	};
	const sessionPort = new CanonicalE4SessionPort(sessionClient, {
		onLateCloseError: options.onLateSessionCloseError,
	});
	const sessions = new Set<OpenedSession>();
	let closed = false;
	let closePromise: Promise<void> | undefined;

	const assertOperational = (): void => {
		const failure = monitor.signal.failure();
		if (failure) throw new BreadboardEngineLifecycleError(failure);
		if (closed) throw new Error("BreadBoard engine port is closed");
	};
	const openSession = async (target: OpenSession, signal?: AbortSignal): Promise<OpenedSession> => {
		assertOperational();
		const runtime = await sessionPort.open(target, signal);
		let sessionClosePromise: Promise<void> | undefined;
		let opened: OpenedSession;
		const adapted: OpenedSession = {
			sessionId: runtime.sessionId,
			snapshot: () => runtime.snapshot(),
			submit: input => runtime.submit(input),
			cancel: request => runtime.cancel(request),
			respondPermission: request => runtime.respondPermission(request),
			events: request => runtime.events(request),
			close: () => {
				sessionClosePromise ??= runtime.close().finally(() => sessions.delete(opened));
				return sessionClosePromise;
			},
		};
		opened = Object.freeze(adapted);
		if (closed || monitor.signal.failure()) {
			await opened.close().catch(() => {});
			const failure = monitor.signal.failure();
			if (failure) throw new BreadboardEngineLifecycleError(failure);
			throw new Error("BreadBoard engine port is closed");
		}
		sessions.add(opened);
		return opened;
	};
	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			closed = true;
			let sessionError: unknown;
			for (const session of sessions) {
				try {
					await session.close();
				} catch (error) {
					sessionError ??= error;
				}
			}
			sessions.clear();
			let lifecycleError: unknown;
			try {
				const outcome = await supervisor.close({ consumerClosed: true } satisfies StopOptions);
				if (outcome.kind === "failure") monitor.stateChanged(outcome.state);
			} catch (error) {
				lifecycleError = error;
			}
			if (sessionError !== undefined && lifecycleError !== undefined)
				throw new AggregateError([sessionError, lifecycleError], "BreadBoard engine close failed");
			if (sessionError !== undefined) throw sessionError;
			if (lifecycleError !== undefined) throw lifecycleError;
		})();
		return closePromise;
	};
	const port: BreadboardEnginePort = {
		authority: authorityFacts(handle),
		lifecycleFailure: monitor.signal,
		openSession,
		getFeatures: async () => {
			assertOperational();
			return controlClient.engineStatus();
		},
		getModelCatalog: async configPath => {
			assertOperational();
			return controlClient.getModelCatalog(configPath);
		},
		getProviderAuthStatus: async () => {
			assertOperational();
			return controlClient.providerAuthStatus();
		},
		attachProviderAuth: async request => {
			assertOperational();
			return controlClient.providerAuthAttach(request);
		},
		detachProviderAuth: async request => {
			assertOperational();
			return controlClient.providerAuthDetach(request);
		},
		modelRoles: createBreadboardModelRolePort(controlClient),
		close,
		providerAuth: createBreadboardProviderAuthPort(controlClient),
	};
	return Object.freeze(port);
}

/**
 * The sole production engine connection entrypoint. It owns lifecycle
 * supervisor construction, local-owned authority storage, canonical session
 * adaptation, control-plane transport, and close/drain/detach handling.
 */
export async function connectCanonicalBreadboardEnginePort(
	config: BreadboardRunConfig,
	options: BreadboardEngineConnectionOptions,
): Promise<BreadboardEngineConnectionResult> {
	const monitor = createLifecycleMonitor(options.onLifecycleFailure);
	const suppliedDependencies = options.dependencies ?? {};
	const store =
		config.mode === "local-owned"
			? (suppliedDependencies.store ?? new LocalAuthorityStore(join(getAgentDir(), "breadboard", "lifecycle")))
			: undefined;
	const supervisor = new LifecycleSupervisor(config, {
		...suppliedDependencies,
		...(store === undefined ? { store: undefined } : { store }),
		stateChanged: monitor.stateChanged,
	});
	const connected = await supervisor.connect();
	if (connected.kind !== "ready") {
		await supervisor.close({ consumerClosed: true });
		return { kind: "failure", result: connected };
	}
	return {
		kind: "ready",
		port: createConnectedPort(connected.handle, supervisor, monitor, options),
	};
}
