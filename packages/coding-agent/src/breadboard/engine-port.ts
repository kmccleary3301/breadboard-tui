import { type BreadboardClient, createBreadboardClient } from "@breadboard/sdk/engine";
import type { LifecycleEngineBinding } from "@breadboard/sdk/lifecycle";
import { createCanonicalE4Client } from "@breadboard/sdk/session";
import { logger } from "@oh-my-pi/pi-utils";
import { CanonicalE4SessionPort } from "./canonical-e4-session-port";
import { createProductionLifecycleSupervisor } from "./lifecycle/lifecycle-production";
import {
	isLifecycleAuthorityDiscontinuityState,
	isLifecycleFailureState as isLifecycleFailureStateName,
	type LifecycleReadyHandle,
	type LifecycleResult,
	type LifecycleState,
	lifecycleFailure,
} from "./lifecycle/lifecycle-state";
import type { LifecycleSupervisor, StopOptions } from "./lifecycle/lifecycle-supervisor";
import type { BreadboardRunConfig } from "./lifecycle/run-config";
import { createBreadboardModelRolePort, type ModelRolePort } from "./model-role-port";
import { createBreadboardProviderAuthPort } from "./provider-auth-adapter";
import type { ProviderAuthPort } from "./provider-auth-port";
import type { BreadboardCreateSessionRequest, OpenedSession, OpenSession } from "./session-port";

type AsyncResult<Operation> = Operation extends (...args: never[]) => Promise<infer Result> ? Result : never;
type FirstParameter<Operation> = Operation extends (input: infer Input, ...args: never[]) => Promise<unknown>
	? Input
	: never;
type EngineStatusResponse = AsyncResult<BreadboardClient["engineStatus"]>;
type ModelCatalogResponse = AsyncResult<BreadboardClient["getModelCatalog"]>;
type ProviderAuthAttachRequest = FirstParameter<BreadboardClient["providerAuthAttach"]>;
type ProviderAuthAttachResponse = AsyncResult<BreadboardClient["providerAuthAttach"]>;
type ProviderAuthDetachRequest = FirstParameter<BreadboardClient["providerAuthDetach"]>;
type ProviderAuthDetachResponse = AsyncResult<BreadboardClient["providerAuthDetach"]>;
type ProviderAuthStatusResponse = AsyncResult<BreadboardClient["providerAuthStatus"]>;

type BreadboardEngineReadyHandle = Pick<
	LifecycleReadyHandle,
	"mode" | "binding" | "requestFetch" | "registration" | "ownerGeneration"
>;

export type BreadboardLifecycleFailureResult = Extract<LifecycleResult, { readonly kind: "failure" }>;
export type BreadboardEngineConnectionFailure = Exclude<LifecycleResult, { readonly kind: "ready" }>;

export interface BreadboardEngineAuthorityIdentity {
	readonly mode: LifecycleReadyHandle["mode"];
	readonly engineInstanceId: string;
	readonly engineBootId: string;
	readonly registrationId: string;
	readonly registrationGeneration: number;
	readonly ownerGeneration?: number;
}

export interface BreadboardEngineAuthorityDiscontinuity {
	readonly previous: BreadboardEngineAuthorityIdentity;
	readonly trigger: LifecycleState;
}

export interface BreadboardLifecycleFailureSignal {
	failure(): BreadboardLifecycleFailureResult | undefined;
	authorityDiscontinuity(): BreadboardEngineAuthorityDiscontinuity | undefined;
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
	setSessionModel(sessionId: string, model: string): Promise<void>;
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
}

export type BreadboardEngineConnectionResult =
	| { readonly kind: "ready"; readonly port: BreadboardEnginePort }
	| { readonly kind: "failure"; readonly result: BreadboardEngineConnectionFailure };

export interface LifecycleMonitor {
	readonly signal: BreadboardLifecycleFailureSignal;
	readonly stateChanged: (state: LifecycleState) => void;
	activateAuthority(authority: BreadboardEngineAuthorityIdentity): void;
}

function isLifecycleFailureResultState(state: LifecycleState): state is BreadboardLifecycleFailureResult["state"] {
	return isLifecycleFailureStateName(state.name) && state.reason !== undefined;
}

export function createLifecycleMonitor(
	onLifecycleFailure?: BreadboardEngineConnectionOptions["onLifecycleFailure"],
): LifecycleMonitor {
	let failure: BreadboardLifecycleFailureResult | undefined;
	let activeAuthority: BreadboardEngineAuthorityIdentity | undefined;
	let discontinuity: BreadboardEngineAuthorityDiscontinuity | undefined;
	const listeners = new Set<(state: LifecycleState) => void>();
	const latchFailure = (next: BreadboardLifecycleFailureResult): void => {
		if (failure !== undefined) return;
		failure = next;
		try {
			onLifecycleFailure?.(next);
		} catch (error) {
			logger.warn("BreadBoard lifecycle failure presentation failed", { error: String(error) });
		}
	};
	const stateChanged = (state: LifecycleState): void => {
		if (
			failure === undefined &&
			activeAuthority !== undefined &&
			isLifecycleAuthorityDiscontinuityState(state.name)
		) {
			discontinuity = Object.freeze({ previous: activeAuthority, trigger: state });
			const result = lifecycleFailure(activeAuthority.mode, "identity-changed", "identity_changed", state.attempt);
			if (result.kind !== "failure") throw new Error("BreadBoard authority discontinuity was not terminal");
			latchFailure(result);
		} else if (failure === undefined && isLifecycleFailureResultState(state)) {
			latchFailure({ kind: "failure", state });
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
			authorityDiscontinuity: () => discontinuity,
			subscribe: (listener: (state: LifecycleState) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		}),
		stateChanged,
		activateAuthority(authority) {
			if (activeAuthority !== undefined) {
				throw new Error("BreadBoard lifecycle monitor authority is already active");
			}
			activeAuthority = Object.freeze({ ...authority });
		},
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

function authorityIdentity(handle: BreadboardEngineReadyHandle): BreadboardEngineAuthorityIdentity {
	return Object.freeze({
		mode: handle.mode,
		engineInstanceId: handle.binding.engineInstanceId,
		engineBootId: handle.binding.engineBootId,
		registrationId: handle.registration.id,
		registrationGeneration: handle.registration.generation,
		ownerGeneration: handle.ownerGeneration,
	});
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

export function createCanonicalEventFetch(requestFetch: typeof fetch): typeof fetch {
	return Object.assign(
		async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
			if (url.pathname.endsWith("/events")) {
				url.searchParams.set("schema", "2");
				url.searchParams.set("include_legacy", "false");
			}
			return await requestFetch(url, init);
		},
		{ preconnect: requestFetch.preconnect },
	);
}

function createConnectedPort(
	handle: BreadboardEngineReadyHandle,
	supervisor: LifecycleSupervisor,
	monitor: LifecycleMonitor,
	options: BreadboardEngineConnectionOptions,
): BreadboardEnginePort {
	const authority = authorityFacts(handle);
	monitor.activateAuthority(authorityIdentity(handle));
	const strictEventFetch = createCanonicalEventFetch(handle.requestFetch);
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
	const modelRoles = createBreadboardModelRolePort({
		resolveModelRoles(input) {
			assertOperational();
			return controlClient.resolveModelRoles(input);
		},
	});
	const providerAuth = createBreadboardProviderAuthPort({
		listProviders() {
			assertOperational();
			return controlClient.listProviders();
		},
		listCredentials(providerId) {
			assertOperational();
			return controlClient.listCredentials(providerId);
		},
		beginLogin(input) {
			assertOperational();
			return controlClient.beginLogin(input);
		},
		getLogin(loginSessionId) {
			assertOperational();
			return controlClient.getLogin(loginSessionId);
		},
		completeLogin(input) {
			assertOperational();
			return controlClient.completeLogin(input);
		},
		cancelLogin(loginSessionId) {
			assertOperational();
			return controlClient.cancelLogin(loginSessionId);
		},
		putApiKey(providerId, accountLabel, input) {
			assertOperational();
			return controlClient.putApiKey(providerId, accountLabel, input);
		},
		logout(input) {
			assertOperational();
			return controlClient.logout(input);
		},
		revoke(input) {
			assertOperational();
			return controlClient.revoke(input);
		},
	});
	const port: BreadboardEnginePort = {
		authority,
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
		setSessionModel: async (sessionId, model) => {
			assertOperational();
			const response = await controlClient.postCommand(sessionId, {
				command: "set_model",
				payload: { model },
			});
			if (response.detail?.status !== "ok" || response.detail.model !== model) {
				throw new Error("BreadBoard engine returned an invalid model-selection receipt");
			}
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
		modelRoles,
		close,
		providerAuth,
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
	const supervisor = createProductionLifecycleSupervisor(config, monitor.stateChanged);
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
