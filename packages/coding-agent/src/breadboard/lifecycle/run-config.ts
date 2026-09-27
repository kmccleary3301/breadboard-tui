import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { JSONC, YAML } from "bun";
import { assertNoBridgeRequested } from "../bridge-refusal";

export const BREADBOARD_ENGINE_MODES = ["native", "off"] as const;
export type BreadboardEngineMode = (typeof BREADBOARD_ENGINE_MODES)[number];
export type ConfigSource = "cli" | "environment" | "selected-config" | "derived-installed-artifact" | "derived-default";

export interface BreadboardRunConfig {
	readonly mode: BreadboardEngineMode;
	readonly sessionConfigPath?: string;
	readonly workspaceId: `workspace:v1:sha256:${string}`;
	readonly sources: Readonly<Record<RunConfigField, ConfigSource>>;
	readonly configDigest: `sha256:${string}`;
}

export type RunConfigField =
	| "mode"
	| "endpoint"
	| "auth"
	| "tls"
	| "engineArtifact"
	| "workspaceId"
	| "startupTimeoutMs"
	| "requestTimeoutMs"
	| "ownerExitPolicy"
	| "sessionConfigPath";

export interface SelectedBreadboardConfig {
	readonly engineMode?: unknown;
	readonly baseUrl?: unknown;
	readonly auth?: unknown;
	readonly tls?: unknown;
	readonly engineArtifact?: unknown;
	readonly workspaceId?: unknown;
	readonly startupTimeoutMs?: unknown;
	readonly requestTimeoutMs?: unknown;
	readonly ownerExitPolicy?: unknown;
	readonly sessionConfigPath?: unknown;
	readonly harness?: unknown;
}

export interface ResolveBreadboardRunConfigInput {
	readonly cli?: { readonly engineMode?: string; readonly engineUrl?: string; readonly ownerExitPolicy?: string };
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly selectedConfig?: SelectedBreadboardConfig;
	readonly workspacePath: string;
	readonly derivedOwnerExitPolicy?: "attached" | "detached";
	readonly canonicalizeWorkspace?: (path: string) => string;
	readonly installedEngineArtifact?: unknown;
	readonly installedEngineIdentity?: unknown;
	readonly endpointOverride?: string;
}

export type RunConfigErrorCode =
	| "invalid_selected_config"
	| "invalid_mode"
	| "invalid_url"
	| "invalid_auth"
	| "invalid_tls"
	| "invalid_artifact"
	| "missing_engine_artifact"
	| "invalid_workspace"
	| "invalid_timeout"
	| "invalid_exit_policy"
	| "invalid_session_config"
	| "mode_endpoint_conflict"
	| "mode_auth_conflict"
	| "missing_endpoint"
	| "missing_auth";

export class BreadboardRunConfigError extends Error {
	override readonly name = "BreadboardRunConfigError";
	constructor(
		readonly code: RunConfigErrorCode,
		readonly field: RunConfigField,
		message: string,
	) {
		super(message);
	}
}

const WORKSPACE_ID = /^workspace:v1:sha256:[0-9a-f]{64}$/;
const SELECTED_CONFIG_FIELDS = new Set([
	"engineMode",
	"baseUrl",
	"auth",
	"tls",
	"engineArtifact",
	"workspaceId",
	"startupTimeoutMs",
	"requestTimeoutMs",
	"ownerExitPolicy",
	"sessionConfigPath",
	"harness",
]);

function fail(code: RunConfigErrorCode, field: RunConfigField, message: string): never {
	throw new BreadboardRunConfigError(code, field, message);
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

function isOwnEnumerable(value: object, key: PropertyKey): boolean {
	return Object.prototype.propertyIsEnumerable.call(value, key);
}

function canonicalWorkspace(workspacePath: string, canonicalizeWorkspace?: (path: string) => string): string {
	let target = workspacePath;
	try {
		target = canonicalizeWorkspace ? canonicalizeWorkspace(target) : realpathSync(target);
	} catch {}
	return `workspace:v1:sha256:${createHash("sha256").update(target).digest("hex")}`;
}

function parseSessionConfigPath(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		fail("invalid_session_config", "sessionConfigPath", "sessionConfigPath must be a non-empty string path");
	}
	const trimmed = value.trim();
	if (isAbsolute(trimmed)) return trimmed;
	return resolve(trimmed);
}

function parseMode(value: unknown, field: RunConfigField = "mode"): BreadboardEngineMode {
	if (typeof value !== "string" || !BREADBOARD_ENGINE_MODES.includes(value as BreadboardEngineMode)) {
		fail("invalid_mode", field, "engine mode must be native or off");
	}
	return value as BreadboardEngineMode;
}

export function hasExplicitEngineSelection(
	input: Pick<ResolveBreadboardRunConfigInput, "cli" | "environment" | "selectedConfig">,
): boolean {
	if (input.cli?.engineMode !== undefined || input.cli?.engineUrl !== undefined) return true;
	if (
		input.selectedConfig !== undefined &&
		typeof input.selectedConfig === "object" &&
		input.selectedConfig !== null &&
		!Array.isArray(input.selectedConfig)
	) {
		const sel = input.selectedConfig as Record<string, unknown>;
		if (sel.engineMode !== undefined || sel.baseUrl !== undefined || sel.engineArtifact !== undefined) return true;
	}
	if (input.environment !== undefined) {
		if (
			input.environment.BREADBOARD_ENGINE_MODE !== undefined ||
			input.environment.BREADBOARD_API_URL !== undefined ||
			input.environment.BREADBOARD_ENGINE_ARTIFACT !== undefined
		) {
			return true;
		}
	}
	return false;
}

export function resolveBreadboardRunConfig(input: ResolveBreadboardRunConfigInput): BreadboardRunConfig {
	const environment = input.environment ?? process.env;
	const selected = (input.selectedConfig ?? {}) as Record<string, unknown>;
	if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
		fail("invalid_selected_config", "mode", "selected config must be an object");
	}
	for (const key of Object.keys(selected)) {
		if (!SELECTED_CONFIG_FIELDS.has(key)) {
			fail("invalid_selected_config", "mode", "selected BreadBoard configuration contains an unsupported field");
		}
	}

	// Refuse bridge modes and bridge implied options
	assertNoBridgeRequested({
		cli: input.cli,
		environment,
		selectedConfig: selected,
	});

	const sessionConfigPath = parseSessionConfigPath(selected.sessionConfigPath);

	const cliMode = input.cli?.engineMode;
	const envMode = environment.BREADBOARD_ENGINE_MODE;
	const selectedMode = selected.engineMode;

	let modeChoice: { value: BreadboardEngineMode; source: ConfigSource; explicit: boolean };
	if (cliMode !== undefined) {
		modeChoice = { value: parseMode(cliMode), source: "cli", explicit: true };
	} else if (envMode !== undefined) {
		modeChoice = { value: parseMode(envMode), source: "environment", explicit: true };
	} else if (selectedMode !== undefined) {
		modeChoice = { value: parseMode(selectedMode), source: "selected-config", explicit: true };
	} else {
		modeChoice = { value: "native", source: "derived-default", explicit: false };
	}

	const workspaceChoice =
		environment.BREADBOARD_WORKSPACE_ID !== undefined
			? { value: environment.BREADBOARD_WORKSPACE_ID, source: "environment" as const }
			: hasOwn(selected, "workspaceId")
				? { value: selected.workspaceId, source: "selected-config" as const }
				: {
						value: canonicalWorkspace(input.workspacePath, input.canonicalizeWorkspace),
						source: "derived-default" as const,
					};
	if (typeof workspaceChoice.value !== "string" || !WORKSPACE_ID.test(workspaceChoice.value)) {
		fail("invalid_workspace", "workspaceId", "workspace identity must be a versioned SHA-256 value");
	}

	const mode = modeChoice.value;
	const sources: Record<RunConfigField, ConfigSource> = {
		mode: modeChoice.source,
		endpoint: "derived-default",
		auth: "derived-default",
		tls: "derived-default",
		engineArtifact: "derived-default",
		workspaceId: workspaceChoice.source,
		startupTimeoutMs: "derived-default",
		requestTimeoutMs: "derived-default",
		ownerExitPolicy: "derived-default",
		sessionConfigPath: sessionConfigPath === undefined ? "derived-default" : "selected-config",
	};

	const safeDigestInput = JSON.stringify({
		mode,
		workspaceId: workspaceChoice.value,
		sessionConfigPathSha256:
			sessionConfigPath === undefined
				? undefined
				: `sha256:${createHash("sha256").update("breadboard-session-config-path-v1\0").update(sessionConfigPath).digest("hex")}`,
		sources,
	});
	const configHash = createHash("sha256").update("breadboard-run-config-v2\0").update(safeDigestInput);

	return Object.freeze({
		mode,
		workspaceId: workspaceChoice.value as `workspace:v1:sha256:${string}`,
		...(sessionConfigPath === undefined ? {} : { sessionConfigPath }),
		sources: Object.freeze(sources),
		configDigest: `sha256:${configHash.digest("hex")}` as `sha256:${string}`,
	});
}

export function parseSelectedBreadboardConfig(breadboard: unknown): SelectedBreadboardConfig {
	if (breadboard === undefined) return {};
	if (typeof breadboard !== "object" || breadboard === null || Array.isArray(breadboard)) {
		fail("invalid_selected_config", "mode", "selected OMP breadboard config must be an object");
	}
	for (const key of Reflect.ownKeys(breadboard)) {
		if (!isOwnEnumerable(breadboard, key)) continue;
		if (typeof key !== "string" || !SELECTED_CONFIG_FIELDS.has(key)) {
			fail(
				"invalid_selected_config",
				"mode",
				`selected OMP breadboard config contains unsupported field ${JSON.stringify(String(key))}`,
			);
		}
	}
	const selected = breadboard as Record<string, unknown>;
	return {
		...(isOwnEnumerable(selected, "engineMode") ? { engineMode: selected.engineMode } : {}),
		...(isOwnEnumerable(selected, "baseUrl") ? { baseUrl: selected.baseUrl } : {}),
		...(isOwnEnumerable(selected, "auth") ? { auth: selected.auth } : {}),
		...(isOwnEnumerable(selected, "tls") ? { tls: selected.tls } : {}),
		...(isOwnEnumerable(selected, "engineArtifact") ? { engineArtifact: selected.engineArtifact } : {}),
		...(isOwnEnumerable(selected, "workspaceId") ? { workspaceId: selected.workspaceId } : {}),
		...(isOwnEnumerable(selected, "startupTimeoutMs") ? { startupTimeoutMs: selected.startupTimeoutMs } : {}),
		...(isOwnEnumerable(selected, "requestTimeoutMs") ? { requestTimeoutMs: selected.requestTimeoutMs } : {}),
		...(isOwnEnumerable(selected, "ownerExitPolicy") ? { ownerExitPolicy: selected.ownerExitPolicy } : {}),
		...(isOwnEnumerable(selected, "sessionConfigPath") ? { sessionConfigPath: selected.sessionConfigPath } : {}),
		...(isOwnEnumerable(selected, "harness") ? { harness: selected.harness } : {}),
	};
}

export async function loadSelectedBreadboardConfig(configFile: string): Promise<SelectedBreadboardConfig> {
	const file = Bun.file(configFile);
	if (!(await file.exists())) return {};
	let parsed: unknown;
	try {
		const text = await file.text();
		parsed = [".yaml", ".yml"].includes(extname(configFile).toLowerCase()) ? YAML.parse(text) : JSONC.parse(text);
	} catch {
		fail("invalid_selected_config", "mode", "selected OMP config is unreadable or malformed");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		fail("invalid_selected_config", "mode", "selected OMP config must be an object");
	}
	return parseSelectedBreadboardConfig("breadboard" in parsed ? parsed.breadboard : undefined);
}
