/**
 * BreadBoard-owned runtime boundary.
 *
 * Session targeting, model authority, permission mediation, and E4 bridge
 * assembly live here so the CLI entry point only coordinates startup.
 */
import * as fsSync from "node:fs";
import { detectSensitiveValues, REDACTED_VALUE } from "@breadboard/sdk/session";
import type { AgentEvent, StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getProjectDir, IS_BREADBOARD_PRODUCT, logger, postmortem } from "@oh-my-pi/pi-utils";
import type { Args } from "../cli/args";
import type { ModelRegistry } from "../config/model-registry";
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
	type E4DurableCursor,
	type E4OwnedSubmission,
	type E4PermissionHandler,
} from "./e4-agent-stream";
import {
	type BreadboardEngineConnectionFailure,
	type BreadboardEnginePort,
	type BreadboardLifecycleFailureSignal,
	connectCanonicalBreadboardEnginePort,
	type BreadboardLifecycleFailureResult as EngineLifecycleFailureResult,
} from "./engine-port";
import { InstalledEngineDiscoveryError } from "./lifecycle/installed-engine-manifest";
import { formatInstalledEngineDiscoveryError } from "./lifecycle/installed-engine-selection";
import { writeLifecyclePresentation } from "./lifecycle/lifecycle-presenter";
import { resolveProductBreadboardRunConfig } from "./lifecycle/product-run-config";
import {
	BreadboardRunConfigError,
	hasExplicitEngineSelection,
	parseSelectedBreadboardConfig,
	resolveBreadboardRunConfig,
} from "./lifecycle/run-config";
import type { ProviderAuthPort } from "./provider-auth-port";
import { createBreadboardProviderFreeModel } from "./provider-free-model";
import {
	addOwnedSubmission,
	advanceProjectionBinding,
	BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
	type BreadboardSessionBindingData,
	type BreadboardSessionBindingManager,
	type BreadboardSessionBindingStore,
	BreadboardSessionTransitionError,
	durableBridgeCursor,
	parseBreadboardSessionBindingData,
	readBreadboardSessionBinding,
	validateBreadboardActivation,
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
) {
	const selectedConfig = parseSelectedBreadboardConfig(activeSettings.getRaw("breadboard"));
	return await resolveProductBreadboardRunConfig({
		cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
		selectedConfig,
		workspacePath,
		isBreadboardProduct: IS_BREADBOARD_PRODUCT,
	});
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
		return isBreadboardProduct ? {} : { engineMode: "off" };
	}
	try {
		const effective = resolveBreadboardRunConfig({
			cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
			selectedConfig,
			workspacePath,
		});
		return { engineMode: effective.mode, engineUrl: effective.endpoint };
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

export function startupBreadboardModeIsOff(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings,
	workspacePath: string,
	isBreadboardProduct: boolean,
): boolean {
	return (
		resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath, isBreadboardProduct).engineMode ===
		"off"
	);
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
		if (startupBreadboardModeIsOff(parsed, activeSettings, workspacePath, isBreadboardProduct)) return;
		throw new BreadboardSessionTransitionError(
			"BreadBoard cannot fork an OMP session at startup because the current E4 SDK cannot atomically rebind the bridge to the forked transcript. Start a new OMP session or run with BreadBoard mode off.",
		);
	};
}

export function rejectBreadboardSessionTransition(plan: SessionTransitionPlan): never {
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
	if (!normalized) return undefined;
	const separator = normalized.indexOf("/");
	if (separator <= 0 || separator === normalized.length - 1) return undefined;
	return {
		provider: normalized.slice(0, separator),
		id: normalized.slice(separator + 1),
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
	if (!isBreadboardProduct && sessionConfigPath === undefined) {
		throw new BreadboardRunConfigError(
			"invalid_session_config",
			"sessionConfigPath",
			"a selected sessionConfigPath is required to create a session",
		);
	}
	const hasOverrides = selectedModel !== undefined || approvalMode === "yolo";
	return {
		kind: "create",
		request: {
			workspace: workspacePath,
			permissionMode: "configured",
			...(sessionConfigPath === undefined ? {} : { configPath: sessionConfigPath }),
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

export interface PreparedBreadboardRuntime {
	readonly providerAuth: ProviderAuthPort;
	readonly stream: StreamFn;
	readonly sessionId: string;
	readonly model: Model;
	readonly models: readonly Model[];
	activate(sessionManager: BreadboardSessionBindingStore): Promise<void>;
	start(): void;
	close(): Promise<void>;
}

interface BreadboardRuntimeBridge {
	readonly stream: StreamFn;
	start(): void;
	close(): Promise<void>;
}

type BreadboardModelRegistry = Pick<ModelRegistry, "getAll">;

export interface BreadboardRuntimeAuthority {
	readonly modelRegistry: BreadboardModelRegistry;
	readonly requestPermission: E4PermissionHandler;
	readonly selectedModel?: Pick<Model, "provider" | "id">;
}

type ConnectedBreadboardEnginePort = Pick<
	BreadboardEnginePort,
	"lifecycleFailure" | "openSession" | "getModelCatalog" | "setSessionModel" | "providerAuth" | "close"
>;

export interface ConnectedBreadboardRuntimeOptions extends BreadboardRuntimeAuthority {
	readonly engine: ConnectedBreadboardEnginePort;
	readonly sessionTarget: OpenSession;
	readonly modelCatalogConfigPath?: string;
	readonly emitAgentEvent: (event: AgentEvent, idempotencyKey: string) => Promise<void>;
	readonly releaseAgentEvent: (idempotencyKey: string) => void;
	readonly sessionBinding?: BreadboardSessionBindingData;
	readonly allowTerminalSnapshotRecovery?: boolean;
	readonly createBridge?: (options: E4AgentStreamBridgeOptions) => BreadboardRuntimeBridge;
	readonly registerCleanup?: (close: () => Promise<void>) => () => void;
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

export function formatBreadboardStartupError(error: unknown): string | undefined {
	if (error instanceof BreadboardRunConfigError) {
		return `BreadBoard configuration error [${error.code}/${error.field}]: ${error.message}`;
	}
	if (error instanceof InstalledEngineDiscoveryError) {
		return formatInstalledEngineDiscoveryError(error);
	}
	if (error instanceof BreadboardSessionTransitionError) {
		return `BreadBoard session transition error [${error.code}]: ${error.message}`;
	}
	if (error instanceof BreadboardModelAuthorityError) {
		return `BreadBoard model authority error [${error.code}]: ${error.message}`;
	}
	return undefined;
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
	const models = new Map<string, Model>();
	for (const entry of catalog.models) {
		if (entry.source !== "configured" || entry.discovery !== "configured_only") {
			throw new BreadboardModelAuthorityError(
				"invalid_backend_catalog",
				"BreadBoard model catalog contains a non-configured model.",
			);
		}
		if (!entry.available) continue;
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
			const choice = await uiContext.select(title, ["Allow", "Deny"], { signal });
			if (signal.aborted) return "cancel";
			if (choice === "Allow") return "allow";
			if (choice === "Deny") return "deny";
			return "cancel";
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return "cancel";
			throw error;
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
	let activatedSessionManager: BreadboardSessionBindingStore | undefined;
	let durableBinding: BreadboardSessionBindingData | undefined;
	let bindingWritePromise = Promise.resolve();
	let runtimeStarted = false;
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
		const snapshot = await opened.snapshot();
		throwIfLifecycleFailed();
		const catalog = await options.engine.getModelCatalog(
			options.modelCatalogConfigPath ?? DEFAULT_BREADBOARD_MODEL_CATALOG_CONFIG_PATH,
		);
		const catalogModels = resolveBreadboardCatalogModels(catalog, options.modelRegistry);
		const catalogRegistry: BreadboardModelRegistry = { getAll: () => [...catalogModels] };
		const resumeBinding =
			options.sessionBinding === undefined ? undefined : parseBreadboardSessionBindingData(options.sessionBinding);
		const initialBinding = validateBreadboardSnapshot(opened.sessionId, snapshot, resumeBinding);
		let snapshotRecovery = false;
		let bridgeBinding = initialBinding;
		if (options.allowTerminalSnapshotRecovery && resumeBinding && snapshot.headEventId !== null) {
			const everyOwnedTurnIsTerminal =
				resumeBinding.ownedSubmissions.length > 0 &&
				resumeBinding.ownedSubmissions.every(submission =>
					snapshot.terminalTurns.some(
						terminal => terminal.inputId === submission.inputId && terminal.turnId === submission.turnId,
					),
				);
			if (everyOwnedTurnIsTerminal && resumeBinding.cursor.sequence < snapshot.headSequence) {
				snapshotRecovery = true;
				bridgeBinding = advanceProjectionBinding(
					initialBinding,
					{ eventId: snapshot.headEventId, sequence: snapshot.headSequence },
					initialBinding.ownedSubmissions,
				);
			}
		}
		const model = resolveBreadboardBackendModel(snapshot.model, catalogRegistry);
		const persistBinding = (
			update: (current: BreadboardSessionBindingData) => BreadboardSessionBindingData,
		): Promise<void> => {
			const operation = bindingWritePromise.then(async () => {
				const sessionManager = activatedSessionManager;
				if (!sessionManager) throw new Error("BreadBoard binding changed before runtime activation");
				const current = durableBinding;
				if (
					!current ||
					current.sessionId !== initialBinding.sessionId ||
					current.replayConfigurationDigest !== initialBinding.replayConfigurationDigest
				) {
					throw new BreadboardSessionTransitionError("BreadBoard durable session binding changed during runtime.");
				}
				const next = parseBreadboardSessionBindingData(update(current));
				sessionManager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, next);
				await sessionManager.flush();
				durableBinding = next;
			});
			bindingWritePromise = operation.catch(() => {});
			return operation;
		};
		const submissionOwned = (submission: E4OwnedSubmission): Promise<void> =>
			persistBinding(current => addOwnedSubmission(current, submission));
		const projectionCommitted = (
			cursor: E4DurableCursor,
			ownedSubmissions: readonly E4OwnedSubmission[],
		): Promise<void> => persistBinding(current => advanceProjectionBinding(current, cursor, ownedSubmissions));
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
		bridge = (options.createBridge ?? (bridgeOptions => new E4AgentStreamBridge(bridgeOptions)))({
			session: opened,
			durableCursor: durableBridgeCursor(bridgeBinding),
			projectionReceiptEventIds,
			ownedSubmissions: bridgeBinding.ownedSubmissions,
			emitAgentEvent: options.emitAgentEvent,
			releaseAgentEvent: options.releaseAgentEvent,
			submissionOwned,
			projectionCommitted,
			modelPolicy: { kind: "fixed", model },
			requestPermission: options.requestPermission,
			selectModel,
		});
		throwIfLifecycleFailed();
		cancelCleanup = (options.registerCleanup ?? (cleanup => postmortem.register("breadboard-runtime", cleanup)))(
			closePreparedRuntime,
		);
		throwIfLifecycleFailed();
		const activate = (sessionManager: BreadboardSessionBindingStore): Promise<void> => {
			activationPromise ??= (async () => {
				try {
					const existingBinding = readBreadboardSessionBinding(sessionManager);
					const activation = validateBreadboardActivation(
						existingBinding,
						initialBinding,
						resumeBinding !== undefined,
					);
					if (activation === "append") {
						sessionManager.appendCustomEntry(
							BREADBOARD_SESSION_BINDING_CUSTOM_TYPE,
							initialBinding satisfies BreadboardSessionBindingData,
						);
					}
					if (snapshotRecovery) {
						sessionManager.appendCustomEntry(BREADBOARD_SESSION_BINDING_CUSTOM_TYPE, bridgeBinding);
					}
					await sessionManager.flush();
					durableBinding = snapshotRecovery ? bridgeBinding : (existingBinding ?? initialBinding);
					for (const entry of sessionManager.getBranch()) {
						if (entry.type !== "message") continue;
						const eventId = breadboardProjectionEventId(entry.message);
						if (eventId) projectionReceiptEventIds.add(eventId);
					}
					activatedSessionManager = sessionManager;
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
			if (!activatedSessionManager) {
				throw new Error("BreadBoard runtime cannot start before AgentSession activation");
			}
			if (runtimeStarted) return;
			throwIfLifecycleFailed();
			bridge!.start();
			runtimeStarted = true;
		};
		return {
			stream: bridge.stream,
			sessionId: initialBinding.sessionId,
			providerAuth: options.engine.providerAuth,
			models: catalogModels,
			model,
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
): PreparedBreadboardRuntime {
	let current = initial;
	let activatedStore: BreadboardSessionBindingStore | undefined;
	let activationPromise: Promise<void> | undefined;
	let replacementPromise: Promise<BreadboardRuntimeGeneration> | undefined;
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
			await current.runtime.close();
			await Promise.all([...retiredClosures]);
		})();
		return closePromise;
	};
	cancelRegisteredCleanup = registerCleanup?.(close);

	return Object.freeze({
		get providerAuth() {
			return current.runtime.providerAuth;
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
		close,
	});
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
	const config = await resolveEffectiveBreadboardRunConfig(selected, activeSettings, workspacePath);
	if (config.mode === "off") return null;
	const sessionBinding =
		parsed.continue || parsed.resume === true || typeof parsed.resume === "string"
			? sessionManager && readBreadboardSessionBinding(sessionManager)
			: undefined;
	const target = resolveBreadboardSessionTarget(
		parsed,
		sessionManager,
		config.sessionConfigPath,
		workspacePath,
		IS_BREADBOARD_PRODUCT,
		authority.selectedModel ?? exactModelRoute(parsed.model),
		activeSettings.get("tools.approvalMode"),
	);

	const connectGeneration = async (
		sessionTarget: OpenSession,
		binding: BreadboardSessionBindingData | undefined,
		allowTerminalSnapshotRecovery = false,
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
		const runtime = await prepareConnectedBreadboardRuntime({
			engine: enginePort,
			modelCatalogConfigPath: config.sessionConfigPath ?? DEFAULT_BREADBOARD_MODEL_CATALOG_CONFIG_PATH,
			sessionTarget,
			emitAgentEvent: async (event, idempotencyKey) => {
				await emitAgentEvent(event, idempotencyKey);
			},
			releaseAgentEvent,
			sessionBinding: binding,
			allowTerminalSnapshotRecovery,
			modelRegistry: authority.modelRegistry,
			requestPermission: authority.requestPermission,
		});
		return { runtime, lifecycleFailure: enginePort.lifecycleFailure };
	};
	const initial = await connectGeneration(target, sessionBinding, sessionBinding !== undefined);
	return createRecoverableBreadboardRuntime(
		initial,
		(sessionId, binding) => connectGeneration({ kind: "attach", sessionId }, binding, true),
		cleanup => postmortem.register("breadboard-recoverable-runtime", cleanup),
	);
}
