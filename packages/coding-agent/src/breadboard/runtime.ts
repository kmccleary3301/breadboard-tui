/**
 * BreadBoard-owned runtime boundary.
 *
 * Session targeting, model authority, permission mediation, and E4 bridge
 * assembly live here so the CLI entry point only coordinates startup.
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { BreadboardClient } from "@breadboard/sdk/engine";
import { detectSensitiveValues, REDACTED_VALUE } from "@breadboard/sdk/session";
import type { AgentEvent, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getProjectDir, IS_BREADBOARD_PRODUCT, logger, postmortem } from "@oh-my-pi/pi-utils";
import type { Args } from "../cli/args";
import type { ModelRegistry } from "../config/model-registry";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { type Settings, settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { BREADBOARD_PRODUCT_IDENTITY } from "../product-identity";
import type { SessionTransitionPlan } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import type { ApprovalMode } from "../tools/approval";
import {
	breadboardProjectionEventId,
	E4AgentStreamBridge,
	type E4AgentStreamBridgeOptions,
	type E4BackendModelAttribution,
	type E4PermissionHandler,
} from "./e4-agent-stream";
import {
	type BreadboardEngineConnectionFailure,
	type BreadboardEnginePort,
	type BreadboardLifecycleFailureSignal,
	connectCanonicalBreadboardEnginePort,
	type BreadboardLifecycleFailureResult as EngineLifecycleFailureResult,
} from "./engine-port";
import { acquireSharedBreadboardEngine, type AcquiredSharedBreadboardEngine } from "./shared-engine-client";
import { formatBreadboardConnectionError, writeLifecyclePresentation } from "./lifecycle/lifecycle-presenter";
import { resolveProductBreadboardRunConfig } from "./lifecycle/product-run-config";
import {
	BreadboardRunConfigError,
	hasExplicitEngineSelection,
	parseSelectedBreadboardConfig,
	resolveBreadboardRunConfig,
} from "./lifecycle/run-config";
import { resolveHarnessId } from "./harness-port-client";
import type { ProviderAuthPort } from "./provider-auth-port";
import { createBreadboardProviderFreeModel } from "./provider-free-model";
import {
	advanceProjectionBinding,
	type BreadboardSessionBindingData,
	type BreadboardSessionBindingManager,
	type BreadboardSessionBindingStore,
	BreadboardSessionTransitionError,
	createBreadboardSessionBindingPersistence,
	durableBridgeCursor,
	parseBreadboardSessionBindingData,
	readBreadboardSessionBinding,
	validateBreadboardSnapshot,
} from "./session-binding";
import type { OpenedSession, OpenSession } from "./session-port";

export class BreadboardProductApiKeyError extends Error {
	constructor() {
		super(
			`--api-key is not accepted in ${BREADBOARD_PRODUCT_IDENTITY.displayName} product mode; use /login to add an API key through the auth broker`,
		);
		this.name = "BreadboardProductApiKeyError";
	}
}

export function applyCliApiKeyOverride(
	authStorage: Pick<AuthStorage, "setRuntimeApiKey">,
	input: {
		readonly apiKey: string;
		readonly provider?: string;
		readonly breadboardProductModeSelected: boolean;
	},
): void {
	if (input.breadboardProductModeSelected) throw new BreadboardProductApiKeyError();
	if (input.provider) authStorage.setRuntimeApiKey(input.provider, input.apiKey);
}

type NonReadyLifecycleResult = BreadboardEngineConnectionFailure;

export class BreadboardLifecycleStartupError extends Error {
	constructor(readonly result: NonReadyLifecycleResult) {
		super(`BreadBoard lifecycle startup returned ${result.kind}`);
		this.name = "BreadboardLifecycleStartupError";
	}
}

export type BreadboardLifecycleFailureResult = EngineLifecycleFailureResult;
async function resolveEffectiveBreadboardRunConfig(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings,
	workspacePath: string,
	endpointOverride?: string,
) {
	const selectedConfig = parseSelectedBreadboardConfig(activeSettings.getRaw("breadboard"));
	return await resolveProductBreadboardRunConfig({
		cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
		selectedConfig,
		workspacePath,
		isBreadboardProduct: IS_BREADBOARD_PRODUCT,
		...(endpointOverride === undefined ? {} : { endpointOverride }),
	});
}

function configuredHarnessId(activeSettings: Settings): string {
	const raw = activeSettings.getRaw("breadboard");
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "daily_driver";
	const harness = (raw as Record<string, unknown>).harness;
	if (typeof harness !== "object" || harness === null || Array.isArray(harness)) return "daily_driver";
	const configured = (harness as Record<string, unknown>).default;
	return typeof configured === "string" && configured.trim() ? configured : "daily_driver";
}

export function resolveNativeSurfaceEngineSelection(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings,
	workspacePath: string,
	isBreadboardProduct = IS_BREADBOARD_PRODUCT,
): Pick<Args, "engineMode" | "engineUrl"> {
	const selectedConfig = parseSelectedBreadboardConfig(activeSettings.getRaw("breadboard"));
	const explicitSelection = hasExplicitEngineSelection({
		cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
		environment: process.env,
		selectedConfig,
	});
	if (!explicitSelection) {
		return { engineMode: isBreadboardProduct ? "local-owned" : "off" };
	}
	try {
		const effective = resolveBreadboardRunConfig({
			cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
			selectedConfig,
			workspacePath,
		});
		return {
			engineMode: effective.mode,
			engineUrl: effective.sources.endpoint === "derived-default" ? undefined : effective.endpoint,
		};
	} catch (error) {
		if (
			isBreadboardProduct &&
			error instanceof BreadboardRunConfigError &&
			error.code === "missing_engine_artifact"
		) {
			return { engineMode: "local-owned", engineUrl: parsed.engineUrl };
		}
		throw error;
	}
}

/**
 * The harness spec a native-mode session runs, or undefined outside native mode. Precedence:
 * `--harness`, the selected config's `sessionConfigPath`, then `breadboard.harness.default`.
 */
export function resolveNativeHarnessSpec(
	parsed: Pick<Args, "engineMode" | "engineUrl" | "harness">,
	activeSettings: Settings,
	workspacePath: string,
	isBreadboardProduct: boolean,
): string | undefined {
	const selection = resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath, isBreadboardProduct);
	if (selection.engineMode !== "native") return undefined;
	const effective = resolveBreadboardRunConfig({
		cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
		selectedConfig: parseSelectedBreadboardConfig(activeSettings.getRaw("breadboard")),
		workspacePath,
	});
	const spec = parsed.harness ?? effective.sessionConfigPath ?? configuredHarnessId(activeSettings);
	if (!/\.ya?ml$/u.test(spec)) {
		throw new BreadboardRunConfigError(
			"invalid_session_config",
			"sessionConfigPath",
			`native mode runs a harness spec (.yaml); "${spec}" is not one. Pass --harness <path/to/harness.yaml>.`,
		);
	}
	return spec;
}

/** Whether the selected mode hands turns to a BreadBoard engine; `off` and `native` run OMP's own loop. */
export function startupBreadboardEngineOwnsTurns(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings,
	workspacePath: string,
	isBreadboardProduct: boolean,
): boolean {
	const mode = resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath, isBreadboardProduct).engineMode;
	return mode !== "off" && mode !== "native";
}

const ALLOW_STARTUP_FORK = (): void => {};

export function createBreadboardStartupForkPolicy(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings = settings,
	workspacePath: string = getProjectDir(),
	canPrepareBreadboardRuntime = true,
	isBreadboardProduct = IS_BREADBOARD_PRODUCT,
): () => void {
	if (!canPrepareBreadboardRuntime) return ALLOW_STARTUP_FORK;
	return () => {
		if (!startupBreadboardEngineOwnsTurns(parsed, activeSettings, workspacePath, isBreadboardProduct)) return;
		throw new BreadboardSessionTransitionError(
			"BreadBoard cannot fork an OMP session at startup because the current E4 SDK cannot atomically rebind the bridge to the forked transcript. Start a new OMP session or run with BreadBoard mode off.",
		);
	};
}

export function rejectBreadboardSessionTransition(plan: SessionTransitionPlan): void {
	if (plan.reason === "harnessSwitch") return;
	const operation = (() => {
		switch (plan.reason) {
			case "new":
				return "start a new OMP session";
			case "resume":
				return `switch to OMP session "${plan.targetSessionFile}"`;
			case "handoff":
				return "hand off to a new OMP session";
			case "fork":
				return "fork the current OMP session";
			case "branch":
				return `branch the OMP session from entry "${plan.targetEntryId}"`;
			case "branchFromBtw":
				return `branch /btw from OMP entry "${plan.targetEntryId}"`;
			case "navigateTree":
				return `navigate the OMP session tree to entry "${plan.targetEntryId}"`;
		}
	})();
	throw new BreadboardSessionTransitionError(
		`BreadBoard cannot ${operation} while the current E4 session is bound to this OMP transcript; the current E4 SDK cannot atomically rebind the bridge to the requested transcript.`,
	);
}

function exactModelRoute(selector: string | undefined): Pick<Model, "provider" | "id"> | undefined {
	const normalized = selector?.trim();
	if (!normalized || normalized.includes("*") || normalized.includes("?") || normalized.includes("["))
		return undefined;
	const parsed = parseModelString(normalized);
	if (!parsed?.provider || !parsed.id) return undefined;
	return { provider: parsed.provider, id: parsed.id };
}
function siblingHarnessLockPath(harnessPath: string, workspacePath: string): string | undefined {
	const lockPath = harnessPath.endsWith(".yaml")
		? `${harnessPath.slice(0, -5)}.lock.json`
		: harnessPath.endsWith(".yml")
			? `${harnessPath.slice(0, -4)}.lock.json`
			: undefined;
	return lockPath !== undefined && fsSync.existsSync(path.resolve(workspacePath, lockPath)) ? lockPath : undefined;
}

function createBreadboardSessionTarget(
	sessionConfigPath: string | undefined,
	workspacePath: string,
	isBreadboardProduct: boolean,
	selectedModel?: Pick<Model, "provider" | "id">,
	approvalMode?: ApprovalMode,
): Extract<OpenSession, { readonly kind: "create" }> {
	if (!isBreadboardProduct && sessionConfigPath === undefined) {
		throw new BreadboardRunConfigError(
			"invalid_session_config",
			"sessionConfigPath",
			"a selected sessionConfigPath is required to create a session",
		);
	}
	const lockId =
		sessionConfigPath === undefined ? undefined : siblingHarnessLockPath(sessionConfigPath, workspacePath);
	const hasOverrides = selectedModel !== undefined || approvalMode === "yolo";
	return {
		kind: "create",
		request: {
			workspace: workspacePath,
			permissionMode: "configured",
			...(sessionConfigPath === undefined ? {} : { configPath: sessionConfigPath }),
			...(lockId === undefined ? {} : { lockId }),
			...(hasOverrides
				? {
						overrides: {
							...(selectedModel === undefined
								? {}
								: { "providers.default_model": `${selectedModel.provider}/${selectedModel.id}` }),
							...(approvalMode === "yolo"
								? {
										"permissions.options.default_response": "allow",
										"permissions.edit.default": "allow",
										"permissions.shell.default": "allow",
										"permissions.webfetch.default": "allow",
										"permissions.read.default": "allow",
									}
								: {}),
						},
					}
				: {}),
		},
	};
}

export function resolveBreadboardSessionTarget(
	parsed: Pick<Args, "continue" | "resume">,
	sessionManager: BreadboardSessionBindingManager | undefined,
	sessionConfigPath: string | undefined,
	workspacePath: string = getProjectDir(),
	isBreadboardProduct: boolean = IS_BREADBOARD_PRODUCT,
	selectedModel?: Pick<Model, "provider" | "id">,
	approvalMode?: ApprovalMode,
): OpenSession {
	if (parsed.continue || parsed.resume === true || typeof parsed.resume === "string") {
		const binding = sessionManager && readBreadboardSessionBinding(sessionManager);
		if (!binding) {
			throw new BreadboardSessionTransitionError(
				"BreadBoard cannot resume this OMP transcript because it has no durable BreadBoard session binding. Start a new OMP session instead.",
			);
		}
		return { kind: "attach", sessionId: binding.sessionId };
	}
	return createBreadboardSessionTarget(
		sessionConfigPath,
		workspacePath,
		isBreadboardProduct,
		selectedModel,
		approvalMode,
	);
}
export interface PreparedBreadboardRuntime {
	readonly providerAuth?: ProviderAuthPort;
	readonly nativeAuthStorage?: AuthStorage;
	readonly harnessClient?: BreadboardClient;
	readonly harnessId?: string;
	/** Apply the model control through the lifecycle-aware engine port. */
	readonly setSessionModel: (model: string) => Promise<void>;
	readonly stream: StreamFn;
	readonly sessionId: string;
	readonly model: Model;
	readonly models: readonly Model[];
	activate(sessionManager: BreadboardSessionBindingStore): Promise<void>;
	start(): void;
	/**
	 * Prepare a new engine generation on a validated harness lock, run the OMP
	 * session transition, then commit the new generation and binding together.
	 */
	readonly switchHarnessSession?: (
		configPath: string,
		lockId: string,
		transition: () => Promise<boolean>,
	) => Promise<boolean>;
	close(): Promise<void>;
}

interface BreadboardRuntimeBridge {
	readonly stream: StreamFn;
	readonly selectModel: (model: E4BackendModelAttribution) => Promise<E4BackendModelAttribution>;
	start(): void;
	close(): Promise<void>;
}
type BreadboardModelRegistry = Pick<ModelRegistry, "getAll">;

export interface BreadboardRuntimeAuthority {
	readonly modelRegistry: Pick<ModelRegistry, "getAll" | "refresh">;
	readonly ompAgentDir?: string;
	readonly nativeAuthStorage?: AuthStorage;
	readonly requestPermission: E4PermissionHandler;
	readonly selectedModel?: Pick<Model, "provider" | "id">;
}

export function resolveBreadboardStartupModelOverride(
	explicitModel: Pick<Model, "provider" | "id"> | undefined,
	requestedSelector: string | undefined,
	configuredDefaultSelector: string | undefined,
): Pick<Model, "provider" | "id"> | undefined {
	const requestedModel = explicitModel ?? exactModelRoute(requestedSelector);
	if (requestedSelector && !requestedModel) {
		throw new Error(
			`Cannot resolve requested BreadBoard model "${requestedSelector}". Use a qualified provider/model identifier.`,
		);
	}
	return requestedModel ?? exactModelRoute(configuredDefaultSelector);
}

type ConnectedBreadboardEnginePort = Pick<
	BreadboardEnginePort,
	| "harnessClient"
	| "lifecycleFailure"
	| "openSession"
	| "getModelCatalog"
	| "setSessionModel"
	| "providerAuth"
	| "close"
>;

export interface ConnectedBreadboardRuntimeOptions extends Omit<BreadboardRuntimeAuthority, "modelRegistry"> {
	readonly modelRegistry: BreadboardModelRegistry;
	readonly engine: ConnectedBreadboardEnginePort;
	readonly sessionTarget: OpenSession;
	readonly harnessId?: string;
	readonly modelCatalogConfigPath?: string;
	readonly terminalResumeTarget?: Extract<OpenSession, { readonly kind: "create" }>;
	readonly emitAgentEvent: (event: AgentEvent, idempotencyKey: string) => Promise<void>;
	readonly releaseAgentEvent: (idempotencyKey: string) => void;
	readonly sessionBinding?: BreadboardSessionBindingData;
	readonly allowTerminalSnapshotRecovery?: boolean;
	readonly createBridge?: (options: E4AgentStreamBridgeOptions) => BreadboardRuntimeBridge;
	readonly registerCleanup?: (close: () => Promise<void>) => () => void;
	/** Gateway mode keeps native OMP auth views backed by this process's AuthStorage. */
	readonly exposeProviderAuth?: boolean;
}

export type BreadboardModelAuthorityErrorCode =
	| "missing_backend_model"
	| "unresolved_backend_model"
	| "ambiguous_backend_model"
	| "invalid_backend_catalog";

export class BreadboardModelAuthorityError extends Error {
	constructor(
		readonly code: BreadboardModelAuthorityErrorCode,
		message: string,
	) {
		super(message);
		this.name = "BreadboardModelAuthorityError";
	}
}

export function formatBreadboardStartupError(error: unknown): string {
	const connectionError = formatBreadboardConnectionError(error);
	if (connectionError !== undefined) return connectionError;
	if (error instanceof BreadboardSessionTransitionError) {
		return `BreadBoard session transition error [${error.code}]: ${error.message}`;
	}
	if (error instanceof BreadboardModelAuthorityError) {
		return `BreadBoard model authority error [${error.code}]: ${error.message}`;
	}
	const object =
		typeof error === "object" && error !== null
			? (error as { readonly code?: unknown; readonly message?: unknown; readonly cause?: unknown })
			: undefined;
	const message =
		error instanceof Error && error.message
			? error.message
			: typeof object?.message === "string" && object.message
				? object.message
				: String(error);
	const code =
		error instanceof Error &&
		"code" in error &&
		typeof (error as Error & { readonly code?: unknown }).code === "string"
			? (error as Error & { readonly code: string }).code
			: typeof object?.code === "string"
				? object.code
				: undefined;
	const cause = error instanceof Error ? error.cause : object?.cause;
	const causeText =
		cause === undefined ? "" : ` (cause: ${cause instanceof Error && cause.message ? cause.message : String(cause)})`;
	return `BreadBoard startup error${code ? ` [${code}]` : ""}: ${message}${causeText}`;
}

const BREADBOARD_MODEL_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	// BreadBoard's engine owns the runtime id; OMP owns the catalog id.
	codex: "openai-codex",
};

const DEFAULT_BREADBOARD_MODEL_CATALOG_CONFIG_PATH = "agent_configs/templates/daily_driver.v1.yaml";

export function resolveBreadboardBackendModel(
	backendModel: string | null | undefined,
	modelRegistry: BreadboardModelRegistry,
): Model {
	const selector = backendModel?.trim();
	if (!selector) {
		throw new BreadboardModelAuthorityError(
			"missing_backend_model",
			"BreadBoard session snapshot does not identify its backend model.",
		);
	}

	const models = modelRegistry.getAll();
	const [backendProvider, ...backendModelParts] = selector.split("/");
	const catalogProvider =
		backendModelParts.length > 0 ? BREADBOARD_MODEL_PROVIDER_ALIASES[backendProvider] : undefined;
	const catalogSelector =
		catalogProvider === undefined ? undefined : `${catalogProvider}/${backendModelParts.join("/")}`;
	const providerQualifiedMatches = models.filter(model => `${model.provider}/${model.id}` === selector);
	const aliasedProviderMatches =
		providerQualifiedMatches.length === 0 && catalogSelector !== undefined
			? models.filter(model => `${model.provider}/${model.id}` === catalogSelector)
			: [];
	const matches =
		providerQualifiedMatches.length > 0
			? providerQualifiedMatches
			: aliasedProviderMatches.length > 0
				? aliasedProviderMatches
				: models.filter(model => model.id === selector);
	if (matches.length === 0) {
		const providerFreeModel = createBreadboardProviderFreeModel(selector);
		if (providerFreeModel !== undefined) return providerFreeModel;
		throw new BreadboardModelAuthorityError(
			"unresolved_backend_model",
			`BreadBoard backend model ${selector} is not present in the loaded OMP model registry.`,
		);
	}
	if (matches.length !== 1) {
		throw new BreadboardModelAuthorityError(
			"ambiguous_backend_model",
			`BreadBoard backend model ${selector} matches multiple loaded OMP models; use a provider-qualified backend model.`,
		);
	}
	return matches[0];
}

export function resolveBreadboardCatalogModels(
	catalog: Awaited<ReturnType<BreadboardEnginePort["getModelCatalog"]>>,
	modelRegistry: BreadboardModelRegistry,
): readonly Model[] {
	if (catalog.discovery_policy !== "configured_only") {
		throw new BreadboardModelAuthorityError(
			"invalid_backend_catalog",
			"BreadBoard model catalog widened beyond configured models.",
		);
	}
	const hasAvailable = catalog.models.some(entry => entry.available);
	const models = new Map<string, Model>();
	for (const entry of catalog.models) {
		if (entry.source !== "configured" || entry.discovery !== "configured_only") {
			throw new BreadboardModelAuthorityError(
				"invalid_backend_catalog",
				"BreadBoard model catalog contains a non-configured model.",
			);
		}
		if (!entry.available && hasAvailable) continue;
		const selector = entry.id.trim();
		if (!selector || selector !== entry.id || models.has(selector)) {
			throw new BreadboardModelAuthorityError(
				"invalid_backend_catalog",
				"BreadBoard model catalog contains an invalid or duplicate selector.",
			);
		}
		let model: Model;
		if (entry.support_tier === "evidence") {
			const provider = selector.split("/", 1)[0];
			if (entry.provider !== provider || entry.canonical_provider !== provider) {
				throw new BreadboardModelAuthorityError(
					"invalid_backend_catalog",
					`BreadBoard evidence model ${selector} has inconsistent provider identity.`,
				);
			}
			const providerFreeModel = createBreadboardProviderFreeModel(selector);
			if (!providerFreeModel) {
				throw new BreadboardModelAuthorityError(
					"invalid_backend_catalog",
					`BreadBoard evidence model ${selector} is not an admitted provider-free route.`,
				);
			}
			model = providerFreeModel;
		} else {
			model = resolveBreadboardBackendModel(selector, modelRegistry);
		}
		models.set(selector, model);
	}
	if (models.size === 0) {
		throw new BreadboardModelAuthorityError(
			"invalid_backend_catalog",
			"BreadBoard configured model catalog has no available models.",
		);
	}
	return [...models.values()];
}

const BREADBOARD_PERMISSION_TEXT_LIMIT = 240;

function safeBreadboardPermissionText(value: string | null): string | undefined {
	if (value === null) return undefined;
	const withoutTerminalControls = value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	const detection = detectSensitiveValues(withoutTerminalControls);
	if (detection.findings.length > 0 || detection.truncated) return REDACTED_VALUE;
	const compact = withoutTerminalControls.replace(/\s+/g, " ").trim();
	if (!compact) return undefined;
	return compact.length <= BREADBOARD_PERMISSION_TEXT_LIMIT
		? compact
		: `${compact.slice(0, BREADBOARD_PERMISSION_TEXT_LIMIT - 1)}…`;
}

export function createBreadboardPermissionHandler(
	getUIContext: () => ExtensionUIContext | undefined,
	onActivity?: (pending: boolean) => void,
): E4PermissionHandler {
	return async (request, signal) => {
		if (signal.aborted) return "cancel";
		const uiContext = getUIContext();
		if (!uiContext) return "cancel";

		const details = [
			safeBreadboardPermissionText(request.tool),
			safeBreadboardPermissionText(request.kind),
			safeBreadboardPermissionText(request.summary),
		].filter((value): value is string => value !== undefined);
		const title =
			details.length === 0
				? "BreadBoard permission request"
				: `BreadBoard permission request · ${details.join(" · ")}`;
		try {
			onActivity?.(true);
			const choice = await uiContext.select(title, ["Allow", "Deny"], { signal });
			if (signal.aborted) return "cancel";
			if (choice === "Allow") return "allow";
			if (choice === "Deny") return "deny";
			return "cancel";
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return "cancel";
			throw error;
		} finally {
			onActivity?.(false);
		}
	};
}

export async function prepareConnectedBreadboardRuntime(
	options: ConnectedBreadboardRuntimeOptions,
): Promise<PreparedBreadboardRuntime> {
	let opened: OpenedSession | undefined;
	let bridge: BreadboardRuntimeBridge | undefined;
	let cancelCleanup: (() => void) | undefined;
	let unsubscribeLifecycleState: (() => void) | undefined;
	let openedClosePromise: Promise<void> | undefined;
	let bridgeClosePromise: Promise<void> | undefined;
	let preparedClosePromise: Promise<void> | undefined;
	let activationPromise: Promise<void> | undefined;
	let lifecycleFailure: BreadboardLifecycleFailureResult | undefined;
	let runtimeStarted = false;
	let runtimeActivated = false;
	const projectionReceiptEventIds = new Set<string>();

	const closeOpened = (): Promise<void> => {
		if (!opened) return Promise.resolve();
		openedClosePromise ??= opened.close();
		return openedClosePromise;
	};
	const closeBridge = (): Promise<void> => {
		if (!bridge) return Promise.resolve();
		bridgeClosePromise ??= bridge.close();
		return bridgeClosePromise;
	};
	const releaseRegistrations = (): void => {
		const unsubscribe = unsubscribeLifecycleState;
		unsubscribeLifecycleState = undefined;
		unsubscribe?.();
		const cancel = cancelCleanup;
		cancelCleanup = undefined;
		cancel?.();
	};
	const cleanupAvailableResources = async (): Promise<void> => {
		releaseRegistrations();
		let runtimeError: unknown;
		try {
			if (bridge) await closeBridge();
			else await closeOpened();
		} catch (error) {
			runtimeError = error;
		}
		let engineError: unknown;
		try {
			await options.engine.close();
		} catch (error) {
			engineError = error;
		}
		if (runtimeError !== undefined && engineError !== undefined) {
			throw new AggregateError([runtimeError, engineError], "BreadBoard runtime cleanup failed");
		}
		if (runtimeError !== undefined) throw runtimeError;
		if (engineError !== undefined) throw engineError;
	};
	const closePreparedRuntime = (): Promise<void> => {
		preparedClosePromise ??= cleanupAvailableResources();
		return preparedClosePromise;
	};
	const handleLifecycleState = (): void => {
		const failure = options.engine.lifecycleFailure.failure();
		if (lifecycleFailure || !failure) return;
		lifecycleFailure = failure;
		const cleanup = bridge ? closePreparedRuntime() : cleanupAvailableResources();
		void cleanup.catch(error => {
			logger.warn("BreadBoard runtime invalidation cleanup failed", { error: String(error) });
		});
	};
	const throwIfLifecycleFailed = (): void => {
		if (lifecycleFailure) throw new BreadboardLifecycleStartupError(lifecycleFailure);
	};

	try {
		unsubscribeLifecycleState = options.engine.lifecycleFailure.subscribe(handleLifecycleState);
		handleLifecycleState();
		throwIfLifecycleFailed();
		opened = await options.engine.openSession(options.sessionTarget);
		throwIfLifecycleFailed();
		let snapshot = await opened.snapshot();
		throwIfLifecycleFailed();
		const resumeBinding =
			options.sessionBinding === undefined ? undefined : parseBreadboardSessionBindingData(options.sessionBinding);
		let activeResumeBinding = resumeBinding;
		let previousSessionId: string | null = null;
		if (
			options.allowTerminalSnapshotRecovery &&
			resumeBinding &&
			(snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "stopped")
		) {
			if (!options.terminalResumeTarget) {
				throw new BreadboardSessionTransitionError(
					"BreadBoard cannot continue a terminal session without a fresh session target.",
				);
			}
			await closeOpened();
			opened = await options.engine.openSession(options.terminalResumeTarget);
			openedClosePromise = undefined;
			snapshot = await opened.snapshot();
			throwIfLifecycleFailed();
			activeResumeBinding = undefined;
			previousSessionId = resumeBinding.sessionId;
		}
		const catalog = await options.engine.getModelCatalog(
			options.modelCatalogConfigPath ?? DEFAULT_BREADBOARD_MODEL_CATALOG_CONFIG_PATH,
		);
		const catalogModels = resolveBreadboardCatalogModels(catalog, options.modelRegistry);
		const catalogRegistry: BreadboardModelRegistry = { getAll: () => [...catalogModels] };
		const initialBinding = validateBreadboardSnapshot(
			opened.sessionId,
			snapshot,
			activeResumeBinding,
			previousSessionId,
		);
		let bridgeBinding = initialBinding;
		if (options.allowTerminalSnapshotRecovery && activeResumeBinding && snapshot.headEventId !== null) {
			const everyOwnedTurnIsTerminal =
				activeResumeBinding.ownedSubmissions.length > 0 &&
				activeResumeBinding.ownedSubmissions.every(submission =>
					snapshot.terminalTurns.some(
						terminal => terminal.inputId === submission.inputId && terminal.turnId === submission.turnId,
					),
				);
			if (everyOwnedTurnIsTerminal && activeResumeBinding.cursor.sequence < snapshot.headSequence) {
				bridgeBinding = advanceProjectionBinding(
					initialBinding,
					{ eventId: snapshot.headEventId, sequence: snapshot.headSequence },
					[],
				);
			}
		}
		const bindingPersistence = createBreadboardSessionBindingPersistence(
			initialBinding,
			bridgeBinding,
			resumeBinding !== undefined,
		);
		const model = resolveBreadboardBackendModel(snapshot.model, catalogRegistry);
		let activeModel = model;
		const selectModel = async (selected: E4BackendModelAttribution): Promise<E4BackendModelAttribution> => {
			const selector = `${selected.provider}/${selected.id}`;
			const expected = catalogModels.find(
				candidate =>
					candidate.api === selected.api &&
					candidate.provider === selected.provider &&
					candidate.id === selected.id,
			);
			if (!expected) {
				throw new BreadboardModelAuthorityError(
					"unresolved_backend_model",
					`BreadBoard model ${selector} is outside the configured session catalog.`,
				);
			}
			await options.engine.setSessionModel(opened!.sessionId, selector);
			throwIfLifecycleFailed();
			const selectedSnapshot = await opened!.snapshot();
			const confirmed = resolveBreadboardBackendModel(selectedSnapshot.model, catalogRegistry);
			if (
				confirmed.api !== expected.api ||
				confirmed.provider !== expected.provider ||
				confirmed.id !== expected.id
			) {
				throw new BreadboardModelAuthorityError(
					"unresolved_backend_model",
					`BreadBoard engine did not retain selected model ${selector}.`,
				);
			}
			return confirmed;
		};
		const bridgeOptions: E4AgentStreamBridgeOptions = {
			session: opened,
			durableCursor: durableBridgeCursor(bridgeBinding),
			projectionReceiptEventIds,
			ownedSubmissions: bridgeBinding.ownedSubmissions,
			emitAgentEvent: options.emitAgentEvent,
			releaseAgentEvent: options.releaseAgentEvent,
			submissionOwned: bindingPersistence.submissionOwned,
			projectionCommitted: bindingPersistence.projectionCommitted,
			modelPolicy: { kind: "fixed", model },
			requestPermission: options.requestPermission,
			selectModel,
		};
		if (options.createBridge) {
			bridge = options.createBridge(bridgeOptions);
		} else {
			const e4Bridge = new E4AgentStreamBridge(bridgeOptions);
			bridge = {
				stream: e4Bridge.stream,
				selectModel: model => e4Bridge.selectModel(model),
				start: () => e4Bridge.start(),
				close: async () => {
					const result = await e4Bridge.close();
					if (result.kind === "unresolved_cleanup") {
						logger.warn("BreadBoard E4 bridge close left cleanup unresolved", { reason: result.reason });
					}
				},
			};
		}
		const runtimeBridge = bridge;
		if (!runtimeBridge) throw new Error("BreadBoard runtime bridge was not created");
		const setSessionModel = async (selector: string): Promise<void> => {
			const requested = resolveBreadboardBackendModel(selector, catalogRegistry);
			const expected = catalogModels.find(
				candidate =>
					candidate.api === requested.api &&
					candidate.provider === requested.provider &&
					candidate.id === requested.id,
			);
			if (!expected) {
				throw new BreadboardModelAuthorityError(
					"unresolved_backend_model",
					`BreadBoard model ${selector} is outside the configured session catalog.`,
				);
			}
			const confirmed = await runtimeBridge.selectModel({
				api: expected.api,
				provider: expected.provider,
				id: expected.id,
			});
			if (
				confirmed.api !== expected.api ||
				confirmed.provider !== expected.provider ||
				confirmed.id !== expected.id
			) {
				throw new BreadboardModelAuthorityError(
					"unresolved_backend_model",
					`BreadBoard engine did not retain selected model ${expected.provider}/${expected.id}.`,
				);
			}
			activeModel = expected;
		};
		throwIfLifecycleFailed();
		cancelCleanup = (options.registerCleanup ?? (cleanup => postmortem.register("breadboard-runtime", cleanup)))(
			closePreparedRuntime,
		);
		throwIfLifecycleFailed();
		const activate = (sessionManager: BreadboardSessionBindingStore): Promise<void> => {
			activationPromise ??= (async () => {
				try {
					await bindingPersistence.activate(sessionManager);
					for (const entry of sessionManager.getBranch()) {
						if (entry.type !== "message") continue;
						const eventId = breadboardProjectionEventId(entry.message);
						if (eventId) projectionReceiptEventIds.add(eventId);
					}
					runtimeActivated = true;
					throwIfLifecycleFailed();
				} catch (error) {
					try {
						await closePreparedRuntime();
					} catch (cleanupError) {
						logger.warn("BreadBoard runtime activation cleanup failed", { error: String(cleanupError) });
					}
					throw error;
				}
			})();
			return activationPromise;
		};
		const start = (): void => {
			if (!runtimeActivated) {
				throw new Error("BreadBoard runtime cannot start before AgentSession activation");
			}
			if (runtimeStarted) return;
			throwIfLifecycleFailed();
			runtimeBridge.start();
			runtimeStarted = true;
		};
		return {
			stream: runtimeBridge.stream,
			harnessClient: options.engine.harnessClient,
			harnessId: options.harnessId,
			setSessionModel,
			providerAuth: options.exposeProviderAuth === false ? undefined : options.engine.providerAuth,
			nativeAuthStorage: options.exposeProviderAuth === false ? options.nativeAuthStorage : undefined,
			sessionId: initialBinding.sessionId,
			models: catalogModels,
			get model() {
				return activeModel;
			},
			activate,
			start,
			close: closePreparedRuntime,
		};
	} catch (error) {
		try {
			await cleanupAvailableResources();
		} catch (cleanupError) {
			logger.warn("BreadBoard runtime cleanup failed", { error: String(cleanupError) });
		}
		throw lifecycleFailure ? new BreadboardLifecycleStartupError(lifecycleFailure) : error;
	}
}

export interface BreadboardRuntimeGeneration {
	readonly runtime: PreparedBreadboardRuntime;
	readonly lifecycleFailure: BreadboardLifecycleFailureSignal;
}
export function createRecoverableBreadboardRuntime(
	initial: BreadboardRuntimeGeneration,
	reconnect: (sessionId: string, binding: BreadboardSessionBindingData) => Promise<BreadboardRuntimeGeneration>,
	registerCleanup?: (cleanup: () => Promise<void>) => () => void,
	prepareHarnessSwitch?: (
		sessionId: string,
		configPath: string,
		lockId: string,
	) => Promise<BreadboardRuntimeGeneration>,
	closeResource?: () => Promise<void>,
): PreparedBreadboardRuntime {
	let current = initial;
	let activatedStore: BreadboardSessionBindingStore | undefined;
	let activationPromise: Promise<void> | undefined;
	let replacementPromise: Promise<BreadboardRuntimeGeneration> | undefined;
	let harnessSwitchPromise: Promise<boolean> | undefined;
	let closePromise: Promise<void> | undefined;
	let started = false;
	let closed = false;
	const retiredClosures = new Set<Promise<void>>();

	const retire = (generation: BreadboardRuntimeGeneration): Promise<void> => {
		const closing = generation.runtime
			.close()
			.catch(error => logger.warn("Superseded BreadBoard runtime cleanup failed", { error: String(error) }));
		retiredClosures.add(closing);
		void closing.finally(() => retiredClosures.delete(closing));
		return closing;
	};
	const replace = async (expected: BreadboardRuntimeGeneration): Promise<BreadboardRuntimeGeneration> => {
		if (current !== expected) return current;
		if (replacementPromise) return replacementPromise;
		const store = activatedStore;
		if (!store) throw new Error("BreadBoard runtime replacement requires an active session binding");
		const binding = readBreadboardSessionBinding(store);
		if (!binding) {
			throw new BreadboardSessionTransitionError(
				"BreadBoard runtime replacement requires a durable session binding.",
			);
		}
		const pending = (async (): Promise<BreadboardRuntimeGeneration> => {
			await retire(expected);
			if (closed) throw new Error("BreadBoard runtime closed during replacement");
			const next = await reconnect(expected.runtime.sessionId, binding);
			if (closed) {
				await next.runtime.close();
				throw new Error("BreadBoard runtime closed during replacement");
			}
			await next.runtime.activate(store);
			if (started) next.runtime.start();
			current = next;
			return next;
		})();
		replacementPromise = pending;
		try {
			return await pending;
		} finally {
			if (replacementPromise === pending) replacementPromise = undefined;
		}
	};
	const switchSession = (
		prepare: (sessionId: string) => Promise<BreadboardRuntimeGeneration>,
		transition: () => Promise<boolean>,
	): Promise<boolean> => {
		if (harnessSwitchPromise) return harnessSwitchPromise;
		const expected = current;
		const store = activatedStore;
		if (!store) return Promise.reject(new Error("BreadBoard harness switch requires an active session binding"));
		const pending = (async (): Promise<boolean> => {
			const next = await prepare(expected.runtime.sessionId);
			try {
				if (closed) throw new Error("BreadBoard runtime closed during harness switch");
				if (!(await transition())) {
					await next.runtime.close();
					return false;
				}
				await next.runtime.activate(store);
				if (started) next.runtime.start();
				current = next;
				await retire(expected);
				return true;
			} catch (error) {
				await next.runtime.close().catch(closeError => {
					logger.warn("Prepared BreadBoard harness switch cleanup failed", { error: String(closeError) });
				});
				throw error;
			}
		})();
		harnessSwitchPromise = pending;
		void pending.finally(() => {
			if (harnessSwitchPromise === pending) harnessSwitchPromise = undefined;
		});
		return pending;
	};
	const stream: StreamFn = (model, context, streamOptions) => {
		const outer = new AssistantMessageEventStream();
		const run = async (): Promise<void> => {
			const generation = current;
			try {
				const inner = await generation.runtime.stream(model, context, streamOptions);
				for await (const event of inner) {
					if (
						event.type === "error" &&
						!closed &&
						!streamOptions?.signal?.aborted &&
						current === generation &&
						generation.lifecycleFailure.authorityDiscontinuity() !== undefined
					) {
						await replace(generation);
						outer.push(event);
						return;
					}
					outer.push(event);
				}
				if (!outer.done) outer.fail(new Error("BreadBoard runtime stream ended without a terminal event"));
			} catch (error) {
				if (
					!closed &&
					!streamOptions?.signal?.aborted &&
					current === generation &&
					generation.lifecycleFailure.authorityDiscontinuity() !== undefined
				) {
					await replace(generation);
				}
				throw error;
			}
		};
		void run().catch(error => {
			if (!outer.done) outer.fail(error);
		});
		return outer;
	};

	let cancelRegisteredCleanup: (() => void) | undefined;
	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			cancelRegisteredCleanup?.();
			cancelRegisteredCleanup = undefined;
			closed = true;
			if (replacementPromise) await replacementPromise.catch(() => {});
			let runtimeError: unknown;
			try {
				await current.runtime.close();
				await Promise.all(retiredClosures);
			} catch (error) {
				runtimeError = error;
			}
			try {
				await closeResource?.();
			} catch (resourceError) {
				if (runtimeError !== undefined)
					throw new AggregateError([runtimeError, resourceError], "BreadBoard runtime cleanup failed");
				throw resourceError;
			}
			if (runtimeError !== undefined) throw runtimeError;
		})();
		return closePromise;
	};
	cancelRegisteredCleanup = registerCleanup?.(close);

	return Object.freeze({
		get harnessClient() {
			return current.runtime.harnessClient;
		},
		get harnessId() {
			return current.runtime.harnessId;
		},
		get setSessionModel() {
			return current.runtime.setSessionModel;
		},
		get providerAuth() {
			return current.runtime.providerAuth;
		},
		get nativeAuthStorage() {
			return current.runtime.nativeAuthStorage;
		},
		stream,
		get sessionId() {
			return current.runtime.sessionId;
		},
		get model() {
			return current.runtime.model;
		},
		get models() {
			return current.runtime.models;
		},
		activate(store: BreadboardSessionBindingStore) {
			if (activatedStore && activatedStore !== store) {
				return Promise.reject(new Error("BreadBoard runtime is already bound to another AgentSession"));
			}
			activationPromise ??= current.runtime.activate(store).then(() => {
				activatedStore = store;
			});
			return activationPromise;
		},
		start() {
			if (started) return;
			if (!activatedStore) throw new Error("BreadBoard runtime cannot start before AgentSession activation");
			started = true;
			current.runtime.start();
		},
		switchHarnessSession(configPath: string, lockId: string, transition: () => Promise<boolean>) {
			if (!prepareHarnessSwitch) {
				return Promise.reject(new Error("BreadBoard harness switching is unavailable in this runtime"));
			}
			return switchSession(sessionId => prepareHarnessSwitch(sessionId, configPath, lockId), transition);
		},
		close,
	});
}

export interface BreadboardSetupAuthority {
	readonly ompAgentDir?: string;
	readonly nativeAuthStorage?: AuthStorage;
}

function assertSharedEngineAuthority(
	engine: BreadboardEnginePort,
	shared: AcquiredSharedBreadboardEngine | undefined,
): void {
	if (shared === undefined) return;
	const binding = engine.authority.binding;
	const expected = shared.info;
	if (
		binding.endpoint !== expected.endpoint ||
		binding.engineInstanceId !== expected.engineInstanceId ||
		binding.engineBootId !== expected.engineBootId ||
		binding.process.pid !== expected.pid ||
		binding.process.osProcessStartToken !== expected.osProcessStartToken
	) {
		throw new Error("BreadBoard connected engine does not match the shared lease identity");
	}
}

export interface PreparedBreadboardSetup {
	readonly providerAuth?: ProviderAuthPort;
	readonly nativeAuthStorage?: AuthStorage;
	readonly models: readonly Model[];
	refreshModels(): Promise<readonly Model[]>;
	close(): Promise<void>;
}

/**
 * Connect only the BreadBoard control plane needed by explicit setup. Unlike
 * {@link prepareBreadboardRuntime}, this path never opens an E4 coding session,
 * creates a turn, or registers a workspace checkpoint.
 */
export async function prepareBreadboardSetup(
	parsed: Pick<Args, "engineMode" | "engineUrl" | "harness">,
	modelRegistry: Pick<ModelRegistry, "getAll" | "refresh">,
	activeSettings: Settings = settings,
	authority?: BreadboardSetupAuthority,
): Promise<PreparedBreadboardSetup | null> {
	const workspacePath = fsSync.realpathSync(getProjectDir());
	const selected = resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath);
	let config = await resolveEffectiveBreadboardRunConfig(selected, activeSettings, workspacePath);
	if (config.mode === "off" || config.mode === "native") return null;
	if (
		authority?.ompAgentDir !== undefined &&
		(config.mode !== "local-owned" || config.ownerExitPolicy !== "attached")
	) {
		throw new Error("The OMP auth gateway requires an attached local-owned BreadBoard engine");
	}
	let shared: AcquiredSharedBreadboardEngine | undefined;
	if (config.mode === "local-owned" && config.ownerExitPolicy === "attached") {
		shared = await acquireSharedBreadboardEngine(config, workspacePath, authority?.ompAgentDir);
		config = shared.config;
	} else if (config.mode === "local-owned") {
		throw new Error("Explicit setup requires an attached local-owned BreadBoard engine");
	}
	let engine: BreadboardEnginePort | undefined;
	try {
		const connected = await connectCanonicalBreadboardEnginePort(config, {
			onLateSessionCloseError: error => {
				logger.warn("BreadBoard setup engine cleanup failed", { error: String(error) });
			},
		});
		if (connected.kind !== "ready") throw new BreadboardLifecycleStartupError(connected.result);
		engine = connected.port;
		assertSharedEngineAuthority(engine, shared);
	} catch (error) {
		const failures: unknown[] = [error];
		try {
			await engine?.close();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		try {
			await shared?.close();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		if (failures.length > 1) throw new AggregateError(failures, "BreadBoard setup startup and cleanup failed");
		throw error;
	}
	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			let engineError: unknown;
			try {
				await engine.close();
			} catch (error) {
				engineError = error;
			}
			try {
				await shared?.close();
			} catch (sharedError) {
				if (engineError !== undefined)
					throw new AggregateError([engineError, sharedError], "BreadBoard setup cleanup failed");
				throw sharedError;
			}
			if (engineError !== undefined) throw engineError;
		})();
		return closePromise;
	};
	try {
		const requestedHarnessId = IS_BREADBOARD_PRODUCT
			? (parsed.harness ?? configuredHarnessId(activeSettings))
			: config.sessionConfigPath;
		const catalogConfigPath =
			requestedHarnessId && engine.harnessClient && !requestedHarnessId.endsWith(".lock.json")
				? await resolveHarnessId(engine.harnessClient, requestedHarnessId)
				: (requestedHarnessId ?? DEFAULT_BREADBOARD_MODEL_CATALOG_CONFIG_PATH);
		const loadCatalogModels = async (): Promise<readonly Model[]> => {
			await shared?.refreshAuth();
			if (shared) await modelRegistry.refresh("offline");
			return resolveBreadboardCatalogModels(await engine.getModelCatalog(catalogConfigPath), modelRegistry);
		};
		let currentModels = await loadCatalogModels();
		return {
			providerAuth: authority?.ompAgentDir === undefined ? engine.providerAuth : undefined,
			nativeAuthStorage: authority?.ompAgentDir === undefined ? undefined : authority.nativeAuthStorage,
			get models() {
				return currentModels;
			},
			async refreshModels() {
				currentModels = await loadCatalogModels();
				return currentModels;
			},
			close,
		};
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "BreadBoard setup startup and cleanup failed");
		}
		throw error;
	}
}

export async function prepareBreadboardRuntime(
	parsed: Args,
	emitAgentEvent: (event: AgentEvent, idempotencyKey: string) => void | Promise<void>,
	authority: BreadboardRuntimeAuthority,
	activeSettings: Settings = settings,
	sessionManager?: BreadboardSessionBindingManager,
	releaseAgentEvent: (idempotencyKey: string) => void = () => {
		throw new Error("BreadBoard released an agent event without an active AgentSession binding");
	},
): Promise<PreparedBreadboardRuntime | null> {
	const workspacePath = fsSync.realpathSync(getProjectDir());
	const selected = resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath);
	let config = await resolveEffectiveBreadboardRunConfig(selected, activeSettings, workspacePath);
	let shared: AcquiredSharedBreadboardEngine | undefined;
	if (config.mode === "off" || config.mode === "native") return null;
	if (
		authority.ompAgentDir !== undefined &&
		(config.mode !== "local-owned" || config.ownerExitPolicy !== "attached")
	) {
		throw new Error("The OMP auth gateway requires an attached local-owned BreadBoard engine");
	}
	const sessionBinding =
		parsed.continue || parsed.resume === true || typeof parsed.resume === "string"
			? sessionManager && readBreadboardSessionBinding(sessionManager)
			: undefined;
	const startupModelOverride = resolveBreadboardStartupModelOverride(
		authority.selectedModel,
		parsed.model,
		activeSettings.getModelRole("default"),
	);
	const requestedHarnessId = IS_BREADBOARD_PRODUCT
		? (parsed.harness ?? configuredHarnessId(activeSettings))
		: config.sessionConfigPath;
	const target = resolveBreadboardSessionTarget(
		parsed,
		sessionManager,
		requestedHarnessId,
		workspacePath,
		IS_BREADBOARD_PRODUCT,
		startupModelOverride,
		activeSettings.get("tools.approvalMode"),
	);
	const terminalResumeTarget =
		sessionBinding === undefined
			? undefined
			: createBreadboardSessionTarget(
					requestedHarnessId,
					workspacePath,
					IS_BREADBOARD_PRODUCT,
					startupModelOverride,
					activeSettings.get("tools.approvalMode"),
				);
	const connectGeneration = async (
		sessionTarget: OpenSession,
		binding: BreadboardSessionBindingData | undefined,
		allowTerminalSnapshotRecovery = false,
		harnessRequestId = requestedHarnessId,
	): Promise<BreadboardRuntimeGeneration> => {
		const connected = await connectCanonicalBreadboardEnginePort(config, {
			onLateSessionCloseError: () => {
				process.stderr.write("BreadBoard session cleanup failed after caller abort.\n");
				process.exitCode = 1;
			},
			onLifecycleFailure: failure => {
				if (failure.state.reason === "identity_changed") return;
				process.exitCode = writeLifecyclePresentation(failure).exitCode || 1;
			},
		});
		if (connected.kind !== "ready") {
			process.exitCode = writeLifecyclePresentation(connected.result).exitCode || 1;
			throw new BreadboardLifecycleStartupError(connected.result);
		}
		const enginePort = connected.port;
		try {
			assertSharedEngineAuthority(enginePort, shared);
			await shared?.refreshAuth();
			if (shared) await authority.modelRegistry.refresh("offline");
			let resolvedHarnessId = harnessRequestId;
			let resolvedSessionTarget = sessionTarget;
			const usesDefaultTerminalResume = harnessRequestId === requestedHarnessId;
			let resolvedTerminalResumeTarget = usesDefaultTerminalResume ? terminalResumeTarget : undefined;
			const shouldResolveHarness =
				harnessRequestId !== undefined &&
				!harnessRequestId.endsWith(".lock.json") &&
				(sessionTarget.kind === "create" || resolvedTerminalResumeTarget !== undefined);
			if (shouldResolveHarness && enginePort.harnessClient) {
				resolvedHarnessId = await resolveHarnessId(enginePort.harnessClient, harnessRequestId);
				const lockId =
					sessionTarget.kind === "create"
						? (sessionTarget.request.lockId ?? siblingHarnessLockPath(resolvedHarnessId, workspacePath))
						: (resolvedTerminalResumeTarget?.request.lockId ??
							siblingHarnessLockPath(resolvedHarnessId, workspacePath));
				if (sessionTarget.kind === "create") {
					resolvedSessionTarget = {
						kind: "create",
						request: {
							...sessionTarget.request,
							configPath: resolvedHarnessId,
							lockId,
						},
					};
				}
				if (resolvedTerminalResumeTarget) {
					resolvedTerminalResumeTarget = {
						kind: "create",
						request: {
							...resolvedTerminalResumeTarget.request,
							configPath: resolvedHarnessId,
							lockId,
						},
					};
				}
			}
			const runtime = await prepareConnectedBreadboardRuntime({
				engine: enginePort,
				harnessId: resolvedHarnessId ?? DEFAULT_BREADBOARD_MODEL_CATALOG_CONFIG_PATH,
				modelCatalogConfigPath:
					resolvedHarnessId ?? config.sessionConfigPath ?? DEFAULT_BREADBOARD_MODEL_CATALOG_CONFIG_PATH,
				sessionTarget: resolvedSessionTarget,
				terminalResumeTarget: resolvedTerminalResumeTarget,
				emitAgentEvent: async (event, idempotencyKey) => {
					await emitAgentEvent(event, idempotencyKey);
				},
				releaseAgentEvent,
				sessionBinding: binding,
				allowTerminalSnapshotRecovery,
				modelRegistry: authority.modelRegistry,
				nativeAuthStorage: authority.nativeAuthStorage,
				requestPermission: authority.requestPermission,
				exposeProviderAuth: authority.ompAgentDir === undefined,
			});
			return { runtime, lifecycleFailure: enginePort.lifecycleFailure };
		} catch (error) {
			try {
				await enginePort.close();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "BreadBoard engine preparation and cleanup failed");
			}
			throw error;
		}
	};
	try {
		if (config.mode === "local-owned" && config.ownerExitPolicy === "attached") {
			shared = await acquireSharedBreadboardEngine(
				config,
				workspacePath,
				authority.ompAgentDir,
				target.kind === "attach" ? target.sessionId : undefined,
			);
			config = shared.config;
		}
		const initial = await connectGeneration(target, sessionBinding, sessionBinding !== undefined);
		return createRecoverableBreadboardRuntime(
			initial,
			(sessionId, binding) => connectGeneration({ kind: "attach", sessionId }, binding, true),
			cleanup => postmortem.register("breadboard-recoverable-runtime", cleanup),
			(_sessionId, configPath, lockId) => {
				const request = createBreadboardSessionTarget(
					configPath,
					workspacePath,
					IS_BREADBOARD_PRODUCT,
					startupModelOverride,
					activeSettings.get("tools.approvalMode"),
				).request;
				return connectGeneration(
					{
						kind: "create",
						request: { ...request, configPath, lockId },
					},
					undefined,
					false,
					configPath,
				);
			},
			shared?.close,
		);
	} catch (error) {
		try {
			await shared?.close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "BreadBoard runtime startup and shared cleanup failed");
		}
		throw error;
	}
}
