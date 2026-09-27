/**
 * Refusal for retired Python engine bridge modes and options.
 */
import * as path from "node:path";

export class BreadboardBridgeRefusalError extends Error {
	readonly source: string;
	readonly value: string;
	readonly exitCode = 2;

	constructor(source: string, value: string) {
		super(formatBridgeRefusal(source, value));
		this.name = "BreadboardBridgeRefusalError";
		this.source = source;
		this.value = value;
	}
}

export function formatBridgeRefusal(source: string, value: string): string {
	return `bb: the Python engine bridge was removed; ${source} requests "${value}". bb runs the native OMP loop; remove ${source} to use it.`;
}

/** `breadboard.*` settings that configured only the removed bridge; any value refuses launch. */
export const BRIDGE_SETTING_FIELDS = [
	"baseUrl",
	"auth",
	"tls",
	"engineArtifact",
	"workspaceId",
	"startupTimeoutMs",
	"requestTimeoutMs",
	"ownerExitPolicy",
] as const;

function displayValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string") {
		return (value as { path: string }).path;
	}
	return JSON.stringify(value) ?? String(value);
}

export interface BridgeRefusalCheckInput {
	readonly cli?: {
		readonly engineMode?: string;
		readonly engineUrl?: string;
	};
	readonly argv?: readonly string[];
	readonly environment?: Record<string, string | undefined>;
	readonly selectedConfig?: Record<string, unknown> | null;
}

function parseArgvFlags(argv: readonly string[]): { engineMode?: string; engineUrl?: string } {
	let engineMode: string | undefined;
	let engineUrl: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === "--engine-mode") {
			if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
				engineMode = argv[i + 1];
				i++;
			}
		} else if (arg.startsWith("--engine-mode=")) {
			engineMode = arg.slice("--engine-mode=".length);
		} else if (arg === "--engine-url") {
			if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
				engineUrl = argv[i + 1];
				i++;
			}
		} else if (arg.startsWith("--engine-url=")) {
			engineUrl = arg.slice("--engine-url=".length);
		}
	}

	return { engineMode, engineUrl };
}

export function detectBridgeRefusal(
	input: BridgeRefusalCheckInput,
): { readonly source: string; readonly value: string } | null {
	const argvParsed = input.argv ? parseArgvFlags(input.argv) : undefined;
	const cliEngineMode = input.cli?.engineMode ?? argvParsed?.engineMode;
	const cliEngineUrl = input.cli?.engineUrl ?? argvParsed?.engineUrl;
	const env = input.environment ?? process.env;
	const selected = input.selectedConfig;

	// 1. CLI flags
	if (cliEngineMode !== undefined && cliEngineMode !== "native" && cliEngineMode !== "off") {
		return { source: "--engine-mode", value: cliEngineMode };
	}
	if (cliEngineUrl !== undefined) {
		return { source: "--engine-url", value: cliEngineUrl };
	}

	// 2. Environment variables
	const envEngineMode = env.BREADBOARD_ENGINE_MODE;
	if (envEngineMode !== undefined && envEngineMode !== "native" && envEngineMode !== "off") {
		return { source: "BREADBOARD_ENGINE_MODE", value: envEngineMode };
	}
	const envApiUrl = env.BREADBOARD_API_URL;
	if (envApiUrl !== undefined && envApiUrl.trim().length > 0) {
		return { source: "BREADBOARD_API_URL", value: envApiUrl };
	}
	const envArtifact = env.BREADBOARD_ENGINE_ARTIFACT;
	if (envArtifact !== undefined && envArtifact.trim().length > 0) {
		return { source: "BREADBOARD_ENGINE_ARTIFACT", value: envArtifact };
	}

	// 3. Selected configuration / settings
	if (selected && typeof selected === "object" && !Array.isArray(selected)) {
		const mode = selected.engineMode;
		if (mode !== undefined && mode !== "native" && mode !== "off") {
			return { source: "breadboard.engineMode", value: displayValue(mode) };
		}
		for (const field of BRIDGE_SETTING_FIELDS) {
			if (selected[field] !== undefined)
				return { source: `breadboard.${field}`, value: displayValue(selected[field]) };
		}
	}

	return null;
}

export function assertNoBridgeRequested(input: BridgeRefusalCheckInput): void {
	const refusal = detectBridgeRefusal(input);
	if (refusal) {
		throw new BreadboardBridgeRefusalError(refusal.source, refusal.value);
	}
}

/** `--config` overlays and `--cwd`, read the way launch and `models` consume them (the next token, always). */
function settingsLocationFlags(argv: readonly string[]): { configFiles: string[]; cwd?: string } {
	const configFiles: string[] = [];
	let cwd: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if ((arg === "--config" || arg === "--cwd") && i + 1 < argv.length) {
			if (arg === "--config") configFiles.push(argv[i + 1]);
			else cwd = argv[i + 1];
			i++;
		} else if (arg.startsWith("--config=")) {
			configFiles.push(arg.slice("--config=".length));
		} else if (arg.startsWith("--cwd=")) {
			cwd = arg.slice("--cwd=".length);
		}
	}
	return { configFiles, cwd };
}

/**
 * Refusal requested by effective `breadboard.*` settings (global, project, `PI_CONFIG_FILES` and `--config`
 * overlays). Reads settings without opening agent.db, so a refused launch leaves no state behind, whatever
 * subcommand follows. Unreadable settings are left for the command's own settings load to report.
 */
export async function detectSettingsBridgeRefusal(
	argv: readonly string[],
): Promise<{ readonly source: string; readonly value: string } | null> {
	const { configFiles, cwd } = settingsLocationFlags(argv);
	const { Settings } = await import("../config/settings");
	let selected: unknown;
	try {
		const settings = await Settings.loadReadOnly({
			cwd: cwd === undefined ? undefined : path.resolve(cwd),
			configFiles,
		});
		selected = settings.getRaw("breadboard");
	} catch {
		return null;
	}
	if (typeof selected !== "object" || selected === null || Array.isArray(selected)) return null;
	return detectBridgeRefusal({ environment: {}, selectedConfig: selected as Record<string, unknown> });
}
