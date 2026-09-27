/**
 * BreadBoard native runtime boundary.
 */
import { isAbsolute, join } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { builtinNativeHarness, DEFAULT_NATIVE_HARNESS_ID } from "@breadboard/harness";
import type { Model } from "@oh-my-pi/pi-ai";
import { createBreadboardProviderFreeModel } from "./provider-free-model";
import { getProjectDir, IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils";
import type { Args } from "../cli/args";
import { type Settings, settings } from "../config/settings";
import { BREADBOARD_PRODUCT_IDENTITY } from "../product-identity";
import {
	BreadboardRunConfigError,
	hasExplicitEngineSelection,
	parseSelectedBreadboardConfig,
	resolveBreadboardRunConfig,
} from "./lifecycle/run-config";

export class BreadboardProductApiKeyError extends Error {
	constructor() {
		super(
			`--api-key is not accepted in ${BREADBOARD_PRODUCT_IDENTITY.displayName} product mode; use /login to add an API key through the auth broker`,
		);
		this.name = "BreadboardProductApiKeyError";
	}
}

export function applyCliApiKeyOverride(
	authStorage: {
		keys?: { setRuntime(provider: string, apiKey: string): void };
	},
	input: {
		readonly apiKey: string;
		readonly provider?: string;
		readonly breadboardProductModeSelected: boolean;
	},
): void {
	if (input.breadboardProductModeSelected) throw new BreadboardProductApiKeyError();
	if (input.provider) {
		authStorage.keys?.setRuntime(input.provider, input.apiKey);
	}
}

export class BreadboardLifecycleStartupError extends Error {
	constructor(readonly result: unknown) {
		super(`BreadBoard lifecycle startup failed`);
		this.name = "BreadboardLifecycleStartupError";
	}
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
		return { engineMode: isBreadboardProduct ? "native" : "off" };
	}
	const effective = resolveBreadboardRunConfig({
		cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
		selectedConfig,
		workspacePath,
	});
	return {
		engineMode: effective.mode,
		engineUrl: undefined,
	};
}

export function resolveNativeHarnessSpec(
	parsed: Pick<Args, "engineMode" | "engineUrl" | "harness">,
	activeSettings: Settings,
	workspacePath: string,
	isBreadboardProduct: boolean,
): string | undefined {
	const selection = resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath, isBreadboardProduct);
	if (selection.engineMode !== "native") return undefined;
	const selectedConfig = parseSelectedBreadboardConfig(activeSettings.getRaw("breadboard"));
	resolveBreadboardRunConfig({
		cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
		selectedConfig,
		workspacePath,
	});
	const sessionConfig =
		typeof selectedConfig?.sessionConfigPath === "string" ? selectedConfig.sessionConfigPath : undefined;
	const configured = parsed.harness ?? sessionConfig ?? configuredHarnessId(activeSettings);
	const spec = configured === "daily_driver" ? DEFAULT_NATIVE_HARNESS_ID : configured;
	if (builtinNativeHarness(spec) === undefined && !/\.ya?ml$/u.test(spec)) {
		throw new BreadboardRunConfigError(
			"invalid_session_config",
			"sessionConfigPath",
			`native mode runs a built-in harness (${DEFAULT_NATIVE_HARNESS_ID}) or a harness spec (.yaml); "${spec}" is neither. Pass --harness <path/to/harness.yaml>.`,
		);
	}
	return spec;
}

export function startupBreadboardEngineOwnsTurns(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings,
	workspacePath: string,
	isBreadboardProduct: boolean,
): boolean {
	resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath, isBreadboardProduct);
	return false;
}

const ALLOW_STARTUP_FORK = (): void => {};

export function createBreadboardStartupForkPolicy(
	_parsed?: Pick<Args, "engineMode" | "engineUrl">,
	_activeSettings: Settings = settings,
	_workspacePath: string = getProjectDir(),
	_canPrepareBreadboardRuntime = true,
	_isBreadboardProduct = IS_BREADBOARD_PRODUCT,
): () => void {
	return ALLOW_STARTUP_FORK;
}

export function rejectBreadboardSessionTransition(_plan?: unknown): void {}

export class BreadboardModelAuthorityError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "BreadboardModelAuthorityError";
	}
}

export interface BreadboardModelRegistry {
	getAll(): readonly Model[];
}

const BREADBOARD_MODEL_PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	openai: "openai",
	anthropic: "anthropic",
	google: "google",
	codex: "openai-codex",
});

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

export function formatBreadboardStartupError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export { createBreadboardProviderFreeModel, isBreadboardProviderFreeModel } from "./provider-free-model";

export function resolveBreadboardOmpAgentDir(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const directory = value.trim();
	if (!directory || !isAbsolute(directory)) {
		throw new Error("BREADBOARD_OMP_AGENT_DIR must name an absolute existing OMP agent directory");
	}
	try {
		const canonical = realpathSync(directory);
		if (statSync(canonical).isDirectory() && statSync(join(canonical, "agent.db")).isFile()) return canonical;
	} catch {
		// Do not let auth discovery create an empty replacement for a mistyped vault.
	}
	throw new Error("BREADBOARD_OMP_AGENT_DIR must contain an existing OMP agent.db");
}

export interface PreparedBreadboardRuntime {
	readonly close: () => Promise<void>;
}

export async function prepareBreadboardRuntime(
	parsed: Pick<Args, "engineMode" | "engineUrl" | "harness">,
	activeSettings: Settings = settings,
	workspacePath: string = getProjectDir(),
): Promise<PreparedBreadboardRuntime | null> {
	resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath, IS_BREADBOARD_PRODUCT);
	return null;
}

export async function prepareBreadboardSetup(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings = settings,
	workspacePath: string = getProjectDir(),
): Promise<void> {
	resolveNativeSurfaceEngineSelection(parsed, activeSettings, workspacePath, IS_BREADBOARD_PRODUCT);
}
