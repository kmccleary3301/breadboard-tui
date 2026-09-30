import type { AutocompleteItem, SlashCommand } from "@oh-my-pi/pi-tui";
import { NativeHarnessReloadError, builtinNativeHarnesses } from "@breadboard/harness";
import type { HarnessCommandSpec, HarnessPort, HarnessSnapshot } from "../breadboard/harness-port";
import type { Settings } from "../config/settings";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";
import { parseSlashCommand, parseSubcommand } from "./helpers/parse";
import { registerBuiltinSlashCommands } from "./builtin-registry";

export interface HarnessPaletteSettings {
	readonly defaultHarness: string;
	readonly paletteHeader: boolean;
	readonly unsupportedCommands: "dim" | "hide";
}

export const LOCK_COMMANDS = [
	["mode", "modes"],
	["role", "multi_agent.model_roles"],
	["team", "multi_agent.enabled"],
	["spawn", "multi_agent.enabled"],
	["wait", "multi_agent.enabled"],
	["bus", "multi_agent.enabled"],
	["longrun", "long_running.enabled"],
	["checkpoint", "long_running.enabled"],
	["prompts", "prompts.*"],
	["evidence", "evidence"],
] as const;
const NO_HOST_IMPLEMENTATION: Readonly<Record<string, true>> = {
	spawn: true,
	wait: true,
	bus: true,
	longrun: true,
	checkpoint: true,
};

function isStaticPanelCommand(name: string): name is "team" | "prompts" | "evidence" {
	return name === "team" || name === "prompts" || name === "evidence";
}
type LockRow = Readonly<Record<string, unknown>>;

function record(value: unknown): LockRow | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as LockRow) : undefined;
}

function settingValue(settings: Settings, key: string): unknown {
	const root = record(settings.getRaw("breadboard"));
	const harness = root ? record(root.harness) : undefined;
	return key.startsWith("harness.") && harness ? harness[key.slice("harness.".length)] : undefined;
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

function effectiveValue(lock: Readonly<Record<string, unknown>>, path: string): { found: boolean; value: unknown } {
	const entries = lock.effective_values;
	if (!Array.isArray(entries)) return { found: false, value: undefined };
	for (const entry of entries) {
		const object = record(entry);
		if (object?.path === path && object.visibility !== "redacted" && object.value_kind !== "secret-ref") {
			return { found: true, value: object.value };
		}
	}
	return { found: false, value: undefined };
}

function effectiveEntries(lock: Readonly<Record<string, unknown>>, prefix: string): readonly LockRow[] {
	const entries = lock.effective_values;
	if (!Array.isArray(entries)) return [];
	const visible: LockRow[] = [];
	for (const entry of entries) {
		const object = record(entry);
		if (!object || typeof object.path !== "string") continue;
		if (object.visibility === "redacted" || object.value_kind === "secret-ref") continue;
		if (object.path === prefix || object.path.startsWith(`${prefix}.`)) visible.push(object);
	}
	return visible;
}

function effectivePathPresent(lock: Readonly<Record<string, unknown>>, path: string): boolean {
	return effectiveEntries(lock, path.slice(0, -2)).length > 0;
}

function lockFieldPresent(lock: Readonly<Record<string, unknown>>, path: string): boolean {
	if (path === "prompts.*" || path === "multi_agent.model_roles")
		return effectivePathPresent(lock, path.endsWith(".*") ? path : `${path}.*`);
	const entry = effectiveValue(lock, path);
	if (!entry.found) return false;
	if (path === "multi_agent.enabled" || path === "long_running.enabled") return entry.value === true;
	if (path === "modes") return Array.isArray(entry.value) && entry.value.length > 0;
	return entry.value !== undefined && entry.value !== null;
}

function noHostReason(source: string, _name: string): string {
	return `Not enabled by harness lock section ${source}`;
}

export function materializeHarnessCommands(
	snapshot: HarnessSnapshot | null,
	settings: HarnessPaletteSettings,
): readonly HarnessCommandSpec[] {
	if (!snapshot) return [];
	const lock = snapshot.lock ?? {};
	const specs: HarnessCommandSpec[] = [{ name: "harness", source: "harness", enabled: true }];
	for (const [name, source] of LOCK_COMMANDS) {
		const enabledByLock = isStaticPanelCommand(name) || lockFieldPresent(lock, source);
		const hostAvailable = NO_HOST_IMPLEMENTATION[name] !== true;
		const enabled = enabledByLock && hostAvailable;
		const reason = enabled ? undefined : !enabledByLock ? noHostReason(source, name) : "no host implementation";
		if (enabled || settings.unsupportedCommands === "dim") specs.push({ name, source, enabled, reason });
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

function completionValues(lock: Readonly<Record<string, unknown>>, name: string): readonly string[] {
	if (name === "mode") {
		const value = effectiveValue(lock, "modes").value;
		if (Array.isArray(value)) {
			return value.flatMap(item => {
				const object = record(item);
				return object && typeof object.name === "string" ? [object.name] : [];
			});
		}
	}
	if (name === "role") {
		return effectiveEntries(lock, "multi_agent.model_roles").flatMap(item => {
			const path = item.path;
			return typeof path === "string" && path !== "multi_agent.model_roles"
				? [path.slice("multi_agent.model_roles.".length)]
				: [];
		});
	}
	return [];
}

function completionItems(snapshot: HarnessSnapshot, name: string, prefix: string): AutocompleteItem[] {
	const lowerPrefix = prefix.toLowerCase();
	return completionValues(snapshot.lock ?? {}, name)
		.filter(value => value.toLowerCase().startsWith(lowerPrefix))
		.map(value => ({ value, label: value }));
}

export function harnessCommandsAsSlashCommands(
	snapshot: HarnessSnapshot | null,
	settings: HarnessPaletteSettings,
): readonly SlashCommand[] {
	const header = harnessPaletteHeader(snapshot, settings);
	return materializeHarnessCommands(snapshot, settings).map(spec => {
		const command: SlashCommand = {
			name: spec.name,
			description: isStaticPanelCommand(spec.name)
				? "[Harness] Static harness panel"
				: spec.name === "harness" && header
					? `${header} · ${spec.enabled ? "Lock-derived command" : `Unavailable: ${spec.reason ?? "unsupported"}`}`
					: `[Harness] ${spec.enabled ? "Lock-derived command" : `Unavailable: ${spec.reason ?? "unsupported"}`}`,
			allowArgs: true,
		};
		if (snapshot && (spec.name === "mode" || spec.name === "role")) {
			command.getArgumentCompletions = prefix => completionItems(snapshot, spec.name, prefix);
		}
		return command;
	});
}

function getHarnessPort(runtime: TuiSlashCommandRuntime): HarnessPort | undefined {
	return runtime.ctx.harnessPort;
}

function harnessList(runtime: TuiSlashCommandRuntime): boolean {
	const snapshot = getHarnessPort(runtime)?.current() ?? null;
	const choices = builtinNativeHarnesses();
	if (choices.length === 0) {
		runtime.ctx.showStatus("No BreadBoard harnesses available");
		return true;
	}
	const activeId = snapshot?.verifiedIdentity?.harnessId;
	const activeBasename = activeId?.split(/[\\/]/u).at(-1);
	const activeChoice = activeId
		? choices.find(
				choice =>
					choice.id === activeId ||
					choice.sourceRef === activeId ||
					choice.id === activeBasename ||
					choice.sourceRef === activeBasename,
			)
		: undefined;
	const rows = choices.map(choice =>
		choice === activeChoice
			? `* Active harness: ${choice.id} (${choice.sourceRef})`
			: `  ${choice.id} (${choice.sourceRef})`,
	);
	// A spec-path harness is not built in; list it first so the active harness is always shown.
	if (activeId && !activeChoice) rows.unshift(`* Active harness: ${snapshot?.name ?? activeId} (${activeId})`);
	runtime.ctx.showStatus(rows.join("\n"));
	return true;
}

async function executeDynamicCommand(parsed: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<boolean> {
	if (isStaticPanelCommand(parsed.name)) {
		runtime.ctx.showAgentHub({ initialSection: "harness", initialHarnessPanel: parsed.name });
		return true;
	}
	if (
		parsed.name === "spawn" ||
		parsed.name === "wait" ||
		parsed.name === "bus" ||
		parsed.name === "longrun" ||
		parsed.name === "checkpoint" ||
		parsed.name === "mode" ||
		parsed.name === "role"
	) {
		runtime.ctx.showStatus(`/${parsed.name} unavailable: no host implementation`);
		return true;
	}
	return false;
}

export async function executeHarnessSlashCommand(
	text: string,
	runtime: TuiSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	if (parsed.name !== "harness" && !LOCK_COMMANDS.some(([name]) => name === parsed.name)) {
		return false;
	}
	const snapshot = getHarnessPort(runtime)?.current() ?? null;
	const settings = readHarnessPaletteSettings(runtime.ctx.settings);
	// Hiding unavailable commands is presentation only; direct invocation must still reject.
	const specs = materializeHarnessCommands(snapshot, { ...settings, unsupportedCommands: "dim" });
	if (parsed.name === "harness") {
		const { verb } = parseSubcommand(parsed.args);
		if (!verb) {
			runtime.ctx.showStatus(
				snapshot
					? `Active harness: ${snapshot.name} (${snapshot.harnessId})`
					: "No BreadBoard harness snapshot loaded",
			);
			return true;
		}
		if (verb === "list") return harnessList(runtime);
		if (verb === "reload") {
			const port = getHarnessPort(runtime);
			if (!port?.reloadNativeHarness) {
				runtime.ctx.showStatus("Harness reload unavailable: this session has no live native harness.");
				return true;
			}
			try {
				const next = await port.reloadNativeHarness();
				runtime.ctx.showStatus(
					next === null
						? "Harness reload produced no snapshot."
						: `Harness reloaded at generation ${next.generation}.`,
				);
			} catch (error) {
				if (error instanceof NativeHarnessReloadError) {
					runtime.ctx.showStatus(
						`Harness reload rejected [${error.code}] at generation ${error.generation}: ${error.message}`,
					);
				} else {
					runtime.ctx.showStatus(
						`Harness reload rejected: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			return true;
		}
		runtime.ctx.showStatus(`Unknown /harness operation: ${verb}`);
		return true;
	}
	const spec = specs.find(item => item.name === parsed.name);
	if (!spec) {
		if (isStaticPanelCommand(parsed.name)) {
			runtime.ctx.showAgentHub({ initialSection: "harness", initialHarnessPanel: parsed.name });
			return true;
		}
		runtime.ctx.showStatus(`/${parsed.name} unavailable: No BreadBoard harness snapshot loaded`);
		return true;
	}
	if (!spec.enabled) {
		runtime.ctx.showStatus(`/${spec.name} unavailable: ${spec.reason ?? "unsupported by harness lock"}`);
		return true;
	}
	if (!snapshot) return true;
	return executeDynamicCommand(parsed, runtime);
}

async function handleHarnessSlashCommand(parsed: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<void> {
	const text = `/${parsed.name}${parsed.args ? ` ${parsed.args}` : ""}`;
	await executeHarnessSlashCommand(text, runtime);
}

export const BUILTIN_HARNESS_SLASH_COMMANDS: readonly SlashCommandSpec[] = [
	{
		name: "harness",
		description: "Inspect and reload the active BreadBoard harness",
		allowArgs: true,
		subcommands: [
			{ name: "list", description: "List available harnesses" },
			{ name: "reload", description: "Compile the workspace harness and apply it at the next turn", usage: "" },
		],
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "team",
		description: "Open the harness team panel",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "prompts",
		description: "Open the harness prompts panel",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "evidence",
		description: "Open the harness evidence panel",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "mode",
		description: "Harness execution mode",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "role",
		description: "Harness model role",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "spawn",
		description: "Harness agent spawn",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "wait",
		description: "Harness agent wait",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "bus",
		description: "Harness message bus",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "longrun",
		description: "Harness long running execution",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
	{
		name: "checkpoint",
		description: "Harness state checkpoint",
		allowArgs: true,
		handleTui: async (command, runtime) => handleHarnessSlashCommand(command, runtime),
	},
];

/** Names of the harness commands, as registered in bb. */
export const HARNESS_COMMAND_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_HARNESS_SLASH_COMMANDS.map(spec => spec.name),
);

let unregisterHarnessCommands: (() => void) | undefined;

/** Adds the harness commands to the builtin registry; bb calls this, plain omp never does. */
export function registerHarnessCommands(): () => void {
	if (unregisterHarnessCommands) return unregisterHarnessCommands;
	const unregister = registerBuiltinSlashCommands(BUILTIN_HARNESS_SLASH_COMMANDS);
	unregisterHarnessCommands = () => {
		unregister();
		unregisterHarnessCommands = undefined;
	};
	return unregisterHarnessCommands;
}
