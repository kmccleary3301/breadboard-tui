import type { SlashCommand } from "@oh-my-pi/pi-tui";
import type { HarnessCommandSpec, HarnessSnapshot } from "../breadboard/harness-port";
import type { Settings } from "../config/settings";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";
import { parseSlashCommand, parseSubcommand } from "./helpers/parse";

export interface HarnessPaletteSettings {
	readonly defaultHarness: string;
	readonly paletteHeader: boolean;
	readonly unsupportedCommands: "dim" | "hide";
}

const LOCK_COMMANDS = [
	["mode", "modes"],
	["role", "roles"],
	["team", "team"],
	["spawn", "multi_agent"],
	["wait", "long_running"],
	["bus", "multi_agent"],
	["longrun", "long_running"],
	["checkpoint", "checkpoint"],
	["prompts", "prompts"],
	["evidence", "evidence"],
] as const;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function effectiveValue(
	lock: Readonly<Record<string, unknown>>,
	path: string,
): { readonly found: boolean; readonly value: unknown } {
	const entries = lock.effective_values;
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			const object = record(entry);
			if (object?.path !== path) continue;
			return { found: true, value: object.visibility === "redacted" ? undefined : object.value };
		}
	}
	return { found: false, value: undefined };
}

function effectivePathPresent(lock: Readonly<Record<string, unknown>>, path: string): boolean {
	const entries = lock.effective_values;
	return (
		Array.isArray(entries) &&
		entries.some(entry => {
			const object = record(entry);
			return object?.path === path || (typeof object?.path === "string" && object.path.startsWith(`${path}.`));
		})
	);
}

function valueAt(lock: Readonly<Record<string, unknown>>, path: string): unknown {
	const projected = effectiveValue(lock, path);
	if (projected.found) return projected.value;
	let value: unknown = lock;
	for (const part of path.split(".")) {
		const current = record(value);
		if (!current) return undefined;
		value = current[part];
	}
	return value;
}

function strings(value: unknown): readonly string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string") return [value];
	return [];
}

function settingValue(settings: Settings, key: string): unknown {
	const root = record(settings.getRaw("breadboard"));
	return root ? valueAt(root, key) : undefined;
}

export function readHarnessPaletteSettings(settings: Settings): HarnessPaletteSettings {
	const defaultHarness = settingValue(settings, "harness.default");
	const paletteHeader = settingValue(settings, "harness.paletteHeader");
	const unsupportedCommands = settingValue(settings, "harness.unsupportedCommands");
	return {
		defaultHarness: typeof defaultHarness === "string" && defaultHarness.trim() ? defaultHarness : "daily_driver",
		paletteHeader: typeof paletteHeader === "boolean" ? paletteHeader : true,
		unsupportedCommands: unsupportedCommands === "hide" ? "hide" : "dim",
	};
}

function commandNames(value: unknown): ReadonlySet<string> {
	const names = new Set<string>();
	for (const name of strings(value)) names.add(name.replace(/^\//u, ""));
	const object = record(value);
	if (object) for (const name of Object.keys(object)) names.add(name.replace(/^\//u, ""));
	return names;
}

function unsupportedReasons(lock: Readonly<Record<string, unknown>>): ReadonlyMap<string, string> {
	const raw = valueAt(lock, "unsupported_commands") ?? valueAt(lock, "unsupportedCommands");
	const object = record(raw);
	const reasons = new Map<string, string>();
	if (!object) return reasons;
	for (const [name, reason] of Object.entries(object)) {
		if (typeof reason === "string" && reason.trim()) reasons.set(name.replace(/^\//u, ""), reason);
	}
	return reasons;
}

function lockFieldPresent(lock: Readonly<Record<string, unknown>>, path: string): boolean {
	const value = valueAt(lock, path);
	const present = value !== undefined && value !== null ? true : effectivePathPresent(lock, path);
	if (!present) return false;
	if (path === "long_running" || path === "multi_agent") {
		const enabled = valueAt(lock, `${path}.enabled`);
		return enabled !== false;
	}
	return Array.isArray(value) ? value.length > 0 : true;
}

export function materializeHarnessCommands(
	snapshot: HarnessSnapshot | null,
	settings: HarnessPaletteSettings,
): readonly HarnessCommandSpec[] {
	if (!snapshot) return [];
	const lock = snapshot.lock ?? {};
	const reasons = unsupportedReasons(lock);
	const specs: HarnessCommandSpec[] = [{ name: "harness", source: "harness", enabled: true }];
	for (const [name, source] of LOCK_COMMANDS) {
		const explicitReason = reasons.get(name);
		const enabled = explicitReason === undefined && lockFieldPresent(lock, source);
		const reason = explicitReason ?? (enabled ? undefined : `Not enabled by harness lock section ${source}`);
		if (enabled || settings.unsupportedCommands === "dim") specs.push({ name, source, enabled, reason });
	}
	const hostNames = new Set([
		...commandNames(valueAt(lock, "host_commands")),
		...commandNames(valueAt(lock, "terminal_sessions")),
	]);
	for (const name of [...hostNames].sort()) {
		if (!name) continue;
		const explicitReason = reasons.get(name);
		const enabled = explicitReason === undefined;
		if (enabled || settings.unsupportedCommands === "dim") {
			specs.push({
				name,
				source: "host_commands",
				enabled,
				reason: explicitReason ?? (enabled ? undefined : `Unsupported by harness lock: ${name}`),
			});
		}
	}
	return specs;
}

export function harnessPaletteHeader(
	snapshot: HarnessSnapshot | null,
	settings: HarnessPaletteSettings,
): string | undefined {
	if (!settings.paletteHeader || !snapshot) return undefined;
	const details = [`Harness: ${snapshot.name}`];
	if (snapshot.mode) details.push(snapshot.mode);
	if (snapshot.generation) details.push(`generation ${snapshot.generation}`);
	return details.join(" · ");
}

export function harnessCommandsAsSlashCommands(
	snapshot: HarnessSnapshot | null,
	settings: HarnessPaletteSettings,
): readonly SlashCommand[] {
	const header = harnessPaletteHeader(snapshot, settings);
	return materializeHarnessCommands(snapshot, settings).map(spec => ({
		name: spec.name,
		description:
			spec.name === "harness" && header
				? `${header} · ${spec.enabled ? "Lock-derived command" : `Unavailable: ${spec.reason ?? "unsupported"}`}`
				: `[Harness] ${spec.enabled ? "Lock-derived command" : `Unavailable: ${spec.reason ?? "unsupported"}`}`,
		allowArgs: true,
	}));
}

function harnessUse(runtime: TuiSlashCommandRuntime, target: string): Promise<boolean> {
	if (!runtime.ctx.startHarnessSession) {
		runtime.ctx.showStatus("/harness use is unavailable: no BreadBoard session route");
		return Promise.resolve(true);
	}
	return runtime.ctx.startHarnessSession(target);
}

export async function executeHarnessSlashCommand(
	text: string,
	runtime: TuiSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const snapshot = runtime.ctx.harnessPort?.current() ?? null;
	const settings = readHarnessPaletteSettings(runtime.ctx.settings);
	const specs = materializeHarnessCommands(snapshot, settings);
	if (parsed.name === "harness") {
		const { verb, rest } = parseSubcommand(parsed.args);
		if (!verb || verb === "list") {
			runtime.ctx.showStatus(
				snapshot
					? `Active harness: ${snapshot.name} (${snapshot.harnessId})`
					: "No BreadBoard harness snapshot loaded",
			);
			return true;
		}
		if (verb === "use") {
			if (!rest) {
				runtime.ctx.showStatus("Usage: /harness use <name|path>");
				return true;
			}
			if (rest.split(/\s+/u).includes("--here")) {
				runtime.ctx.showStatus(
					"A BreadBoard session is pinned to its engine session and lock; an in-process harness switch is not possible.",
				);
				return true;
			}
			return harnessUse(runtime, rest);
		}
		if (verb === "explain" || verb === "diff" || verb === "validate" || verb === "lock") {
			runtime.ctx.showStatus(`/harness ${verb} is read-only and available through the BreadBoard control plane`);
			return true;
		}
		runtime.ctx.showStatus(`Unknown /harness operation: ${verb}`);
		return true;
	}
	const spec = specs.find(item => item.name === parsed.name);
	if (!spec) return false;
	if (!spec.enabled) {
		runtime.ctx.showStatus(`/${spec.name} unavailable: ${spec.reason ?? "unsupported by harness lock"}`);
		return true;
	}
	runtime.ctx.showStatus(`/${spec.name} is admitted by the active harness (${spec.source})`);
	return true;
}
export const BUILTIN_HARNESS_SLASH_COMMANDS: readonly SlashCommandSpec[] = [
	{
		name: "harness",
		description: "Inspect and switch the active BreadBoard harness",
		allowArgs: true,
		subcommands: [
			{ name: "list", description: "List available harnesses" },
			{ name: "use", description: "Start a new session on a harness", usage: "<name|path>" },
			{ name: "explain", description: "Show field provenance", usage: "[field]" },
			{ name: "diff", description: "Compare harness locks", usage: "<other>" },
			{ name: "validate", description: "Validate a harness definition" },
			{ name: "lock", description: "Show the effective lock" },
		],
	},
];
