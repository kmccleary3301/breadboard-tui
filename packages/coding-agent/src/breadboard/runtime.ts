/**
 * BreadBoard native runtime boundary: engine-mode and harness selection.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { builtinNativeHarness, DEFAULT_NATIVE_HARNESS_ID } from "@breadboard/harness";
import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils";
import type { Args } from "../cli/args";
import type { Settings } from "../config/settings";
import { assertNoBridgeRequested, BRIDGE_SETTING_FIELDS } from "./bridge-refusal";

/** `native` runs OMP's loop on a BreadBoard harness; `off` runs the upstream loop without BreadBoard. */
export type BreadboardEngineMode = "native" | "off";

/** Invalid `breadboard` settings or harness selection; startup exits 2 with the message. */
export class BreadboardSettingsError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(`bb: ${message}`);
		this.name = "BreadboardSettingsError";
	}
}

const BREADBOARD_SETTING_FIELDS = new Set(["engineMode", "sessionConfigPath", "harness", ...BRIDGE_SETTING_FIELDS]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBreadboardSettings(activeSettings: Settings): Record<string, unknown> {
	const raw = activeSettings.getRaw("breadboard");
	if (raw === undefined) return {};
	if (!isRecord(raw)) throw new BreadboardSettingsError("the breadboard setting must be an object.");
	for (const key of Object.keys(raw)) {
		if (!BREADBOARD_SETTING_FIELDS.has(key)) {
			throw new BreadboardSettingsError(`breadboard.${key} is not a BreadBoard setting; remove it.`);
		}
	}
	return raw;
}

/**
 * Resolves the engine mode from `--engine-mode`, then `BREADBOARD_ENGINE_MODE`, then
 * `breadboard.engineMode`. Unset means `native` for the product and `off` for stock OMP.
 * The product throws `BreadboardBridgeRefusalError` for any request for the removed Python bridge;
 * stock OMP never refuses and runs native only on an explicit `native` request.
 */
export function resolveBreadboardEngineMode(
	parsed: Pick<Args, "engineMode" | "engineUrl">,
	activeSettings: Settings,
	isBreadboardProduct = IS_BREADBOARD_PRODUCT,
	environment: Readonly<Record<string, string | undefined>> = process.env,
): BreadboardEngineMode {
	if (!isBreadboardProduct) {
		const raw = activeSettings.getRaw("breadboard");
		const configured = isRecord(raw) ? raw.engineMode : undefined;
		return (parsed.engineMode ?? environment.BREADBOARD_ENGINE_MODE ?? configured) === "native" ? "native" : "off";
	}
	const selected = readBreadboardSettings(activeSettings);
	assertNoBridgeRequested({
		cli: { engineMode: parsed.engineMode, engineUrl: parsed.engineUrl },
		environment,
		selectedConfig: selected,
	});
	// The refusal admits only native and off from every source.
	const explicit = (parsed.engineMode ?? environment.BREADBOARD_ENGINE_MODE ?? selected.engineMode) as
		| BreadboardEngineMode
		| undefined;
	return explicit ?? (isBreadboardProduct ? "native" : "off");
}

function configuredHarnessId(selected: Record<string, unknown>): string {
	const harness = selected.harness;
	if (!isRecord(harness)) return "daily_driver";
	const configured = harness.default;
	return typeof configured === "string" && configured.trim() ? configured : "daily_driver";
}

/**
 * The harness a native session runs: `--harness`, then `breadboard.sessionConfigPath`, then
 * `breadboard.harness.default`. `daily_driver` names the built-in `bb-omp.native`.
 * Undefined outside native mode.
 */
export function resolveNativeHarnessSpec(
	parsed: Pick<Args, "engineMode" | "engineUrl" | "harness">,
	activeSettings: Settings,
	isBreadboardProduct: boolean,
): string | undefined {
	if (resolveBreadboardEngineMode(parsed, activeSettings, isBreadboardProduct) !== "native") return undefined;
	const selected = readBreadboardSettings(activeSettings);
	const sessionConfigPath = selected.sessionConfigPath;
	if (sessionConfigPath !== undefined && (typeof sessionConfigPath !== "string" || !sessionConfigPath.trim())) {
		throw new BreadboardSettingsError("breadboard.sessionConfigPath must be a non-empty harness spec path.");
	}
	const configured = parsed.harness ?? sessionConfigPath?.trim() ?? configuredHarnessId(selected);
	const spec = configured === "daily_driver" ? DEFAULT_NATIVE_HARNESS_ID : configured;
	if (builtinNativeHarness(spec) === undefined && !/\.ya?ml$/u.test(spec)) {
		throw new BreadboardSettingsError(
			`native mode runs a built-in harness (${DEFAULT_NATIVE_HARNESS_ID}) or a harness spec (.yaml); "${spec}" is neither. Pass --harness <path/to/harness.yaml>.`,
		);
	}
	return spec;
}

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
