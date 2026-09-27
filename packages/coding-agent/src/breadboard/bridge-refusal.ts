/**
 * Refusal for retired Python engine bridge modes and options.
 */

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
		if (
			"engineMode" in selected &&
			selected.engineMode !== undefined &&
			selected.engineMode !== "native" &&
			selected.engineMode !== "off"
		) {
			return { source: "breadboard.engineMode", value: String(selected.engineMode) };
		}
		if ("baseUrl" in selected && selected.baseUrl !== undefined) {
			return { source: "breadboard.baseUrl", value: String(selected.baseUrl) };
		}
		if ("engineArtifact" in selected && selected.engineArtifact !== undefined) {
			const val = selected.engineArtifact;
			const displayVal =
				typeof val === "string"
					? val
					: typeof val === "object" &&
						  val !== null &&
						  "path" in val &&
						  typeof (val as Record<string, unknown>).path === "string"
						? String((val as Record<string, unknown>).path)
						: JSON.stringify(val);
			return { source: "breadboard.engineArtifact", value: displayVal };
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
