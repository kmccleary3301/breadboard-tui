import type { AutocompleteItem, SlashCommand } from "@oh-my-pi/pi-tui";
import { NativeHarnessReloadError } from "@breadboard/harness";
import type { HarnessCommandSpec, HarnessSnapshot } from "../breadboard/harness-port";
import type { Settings } from "../config/settings";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";
import { parseSlashCommand, parseSubcommand } from "./helpers/parse";

export interface HarnessPaletteSettings {
	readonly defaultHarness: string;
	readonly paletteHeader: boolean;
	readonly unsupportedCommands: "dim" | "hide";
}

type PublicData = Readonly<Record<string, unknown>>;
interface PublicResult {
	readonly ok: boolean;
	readonly status: string;
	readonly data: PublicData;
	readonly error?: { readonly message?: string };
	readonly exit_code?: number;
}

interface HarnessControlClient {
	getHarness(id: string): Promise<PublicResult>;
	validateHarness(id: string): Promise<PublicResult>;
	explainHarness(id: string): Promise<PublicResult>;
	lockHarness(id: string): Promise<PublicResult>;
	getHarnessLock(id: string): Promise<PublicResult>;
}

async function resolveHarnessId(client: HarnessControlClient, requested: string): Promise<string> {
	const candidates =
		requested.includes("/") || /\.(?:yaml|yml|json)$/u.test(requested)
			? [requested]
			: [`agent_configs/v2/${requested}.yaml`, `agent_configs/${requested}.yaml`, `${requested}.yaml`, requested];
	for (const candidate of candidates) {
		try {
			const res = await client.getHarness(candidate);
			if (res && res.ok !== false) return candidate;
		} catch (error: unknown) {
			const status =
				typeof error === "object" && error !== null && "status" in error
					? (error as { status: unknown }).status
					: undefined;
			if (status !== 404) throw error;
		}
	}
	return requested;
}

const LOCK_COMMANDS = [
	["mode", "modes"],
	["model", "providers.models"],
	["role", "multi_agent.model_roles"],
	["skills", "skills"],
	["plan", "features.plan"],
	["todo", "features.todos.enabled"],
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

function record(value: unknown): PublicData | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as PublicData) : undefined;
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

function effectiveEntries(lock: Readonly<Record<string, unknown>>, prefix: string): readonly PublicData[] {
	const entries = lock.effective_values;
	if (!Array.isArray(entries)) return [];
	const visible: PublicData[] = [];
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
	if (
		path === "multi_agent.enabled" ||
		path === "long_running.enabled" ||
		path === "features.plan" ||
		path === "features.todos.enabled"
	)
		return entry.value === true;
	if (path === "modes") return Array.isArray(entry.value) && entry.value.length > 0;
	if (path === "skills") return Array.isArray(entry.value) && entry.value.length > 0;
	return entry.value !== undefined && entry.value !== null;
}

function noHostReason(source: string, name: string): string {
	if (name === "skills" && source === "skills") return "No skills leaf in harness lock";
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
		// Model selection is a live engine control, not a source-lock capability.
		const enabledByLock = name === "model" || isStaticPanelCommand(name) || lockFieldPresent(lock, source);
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
	const value = effectiveValue(
		lock,
		name === "mode" ? "modes" : name === "model" ? "providers.models" : "skills",
	).value;
	if (name === "mode" && Array.isArray(value)) {
		return value.flatMap(item => {
			const object = record(item);
			return object && typeof object.name === "string" ? [object.name] : [];
		});
	}
	if (name === "model" && Array.isArray(value)) {
		return value.flatMap(item => {
			const object = record(item);
			return object && typeof object.id === "string" ? [object.id] : [];
		});
	}
	if (name === "skills" && Array.isArray(value))
		return value.filter((item): item is string => typeof item === "string");
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
		if (snapshot && ["mode", "model", "role", "skills"].includes(spec.name)) {
			command.getArgumentCompletions = prefix => completionItems(snapshot, spec.name, prefix);
			if (spec.name === "skills" && completionValues(snapshot.lock ?? {}, "skills").length === 0) {
				command.getAutocompleteDescription = () => "Skills: no skills leaf in harness lock";
			}
		}
		return command;
	});
}

function harnessUse(runtime: TuiSlashCommandRuntime, target: string): Promise<boolean> {
	if (!runtime.ctx.startHarnessSession) {
		runtime.ctx.showStatus("/harness use is unavailable: no BreadBoard session route");
		return Promise.resolve(true);
	}
	return runtime.ctx.startHarnessSession(target);
}

async function harnessList(runtime: TuiSlashCommandRuntime, directory?: string): Promise<boolean> {
	const snapshot = runtime.ctx.harnessPort?.current() ?? null;
	const listChoices = runtime.ctx.harnessPort?.listHarnessChoices;
	if (!listChoices) {
		runtime.ctx.showStatus("Harness listing is unavailable: no BreadBoard control-plane client");
		return true;
	}
	try {
		const choices = directory === undefined ? await listChoices() : await listChoices(directory);
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
						choice.path === activeId ||
						choice.id === activeBasename ||
						choice.path === activeBasename,
				)
			: undefined;
		const rows = choices.map(choice =>
			choice === activeChoice
				? `* Active harness: ${choice.name} (${choice.path})`
				: `  ${choice.name} (${choice.path})`,
		);
		runtime.ctx.showStatus(rows.join("\n"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		runtime.ctx.showStatus(`Unable to list BreadBoard harnesses: ${detail}`);
	}
	return true;
}

function controlClient(runtime: TuiSlashCommandRuntime): HarnessControlClient | undefined {
	return runtime.ctx.harnessPort?.controlClient as HarnessControlClient | undefined;
}

function resultData(result: PublicResult, operation: string): PublicData {
	if (!result.ok || result.status !== "ok")
		throw new Error(`BreadBoard ${operation} failed: ${result.error?.message ?? `exit code ${result.exit_code}`}`);
	return result.data;
}

function resultString(data: PublicData, key: string): string | undefined {
	return typeof data[key] === "string" && data[key].length > 0 ? data[key] : undefined;
}

function lockRows(data: PublicData, operation: string): readonly PublicData[] {
	const lock = record(data.lock);
	if (!lock) throw new Error(`BreadBoard ${operation} response missing lock`);
	const rows = lock.effective_values;
	if (!Array.isArray(rows)) throw new Error(`BreadBoard ${operation} response missing effective_values`);
	return rows.flatMap(row => {
		const object = record(row);
		return object &&
			typeof object.path === "string" &&
			object.visibility !== "redacted" &&
			object.value_kind !== "secret-ref"
			? [object]
			: [];
	});
}

function displayValue(value: unknown): string {
	if (typeof value === "string") return value;
	const encoded = JSON.stringify(value);
	return encoded === undefined ? String(value) : encoded;
}

async function harnessExplain(runtime: TuiSlashCommandRuntime, path: string): Promise<boolean> {
	const snapshot = runtime.ctx.harnessPort?.current();
	const client = controlClient(runtime);
	if (!snapshot || !client) {
		runtime.ctx.showStatus("Harness explanation is unavailable: no BreadBoard control-plane client");
		return true;
	}
	try {
		const data = resultData(await client.explainHarness(snapshot.harnessId), "harness.explain");
		const field = Array.isArray(data.fields) ? data.fields.map(record).find(item => item?.path === path) : undefined;
		const lockRow = effectiveEntries(snapshot.lock ?? {}, path).find(item => item.path === path);
		if (!field || !lockRow) throw new Error(`No visible effective lock leaf exists at ${path}`);
		const source = typeof field.source_layer === "string" ? field.source_layer : "unknown";
		runtime.ctx.showStatus(
			`${path}: ${displayValue(lockRow.value)} (source layer ${source}, value kind ${String(lockRow.value_kind)}, visibility ${String(lockRow.visibility)})`,
		);
	} catch (error) {
		runtime.ctx.showStatus(error instanceof Error ? error.message : String(error));
	}
	return true;
}

async function harnessValidate(runtime: TuiSlashCommandRuntime): Promise<boolean> {
	const snapshot = runtime.ctx.harnessPort?.current();
	const client = controlClient(runtime);
	if (!snapshot || !client) {
		runtime.ctx.showStatus("Harness validation is unavailable: no BreadBoard control-plane client");
		return true;
	}
	try {
		const data = resultData(await client.validateHarness(snapshot.harnessId), "harness.validate");
		const problems = Array.isArray(data.problems) ? data.problems : [];
		if (problems.length > 0) {
			runtime.ctx.showStatus(`Harness validation: problems\n${problems.map(displayValue).join("\n")}`);
		} else {
			runtime.ctx.showStatus(
				`Harness validation: ok${resultString(data, "path") ? ` (${resultString(data, "path")})` : ""}`,
			);
		}
	} catch (error) {
		runtime.ctx.showStatus(error instanceof Error ? error.message : String(error));
	}
	return true;
}

async function harnessLock(runtime: TuiSlashCommandRuntime): Promise<boolean> {
	const snapshot = runtime.ctx.harnessPort?.current();
	const client = controlClient(runtime);
	if (!snapshot || !client) {
		runtime.ctx.showStatus("Harness lock is unavailable: no BreadBoard control-plane client");
		return true;
	}
	try {
		const data = resultData(await client.lockHarness(snapshot.harnessId), "harness.lock");
		const graphHash = resultString(data, "graph_hash");
		const path = resultString(data, "path");
		runtime.ctx.showStatus(`Harness lock: ${graphHash ?? "unknown graph hash"}${path ? `\nPath: ${path}` : ""}`);
	} catch (error) {
		runtime.ctx.showStatus(error instanceof Error ? error.message : String(error));
	}
	return true;
}

async function harnessDiff(runtime: TuiSlashCommandRuntime, args: string): Promise<boolean> {
	const client = controlClient(runtime);
	const [left, right] = args.trim().split(/\s+/u);
	if (!left || !right) {
		runtime.ctx.showStatus("Usage: /harness diff <a> <b>");
		return true;
	}
	if (!client) {
		runtime.ctx.showStatus("Harness diff is unavailable: no BreadBoard control-plane client");
		return true;
	}
	try {
		const [leftId, rightId] = await Promise.all([resolveHarnessId(client, left), resolveHarnessId(client, right)]);
		const [leftData, rightData] = await Promise.all([client.getHarnessLock(leftId), client.getHarnessLock(rightId)]);
		const leftRows = new Map(
			lockRows(resultData(leftData, "harness_lock.get"), "harness_lock.get").map(row => [
				row.path as string,
				row.value,
			]),
		);
		const rightRows = new Map(
			lockRows(resultData(rightData, "harness_lock.get"), "harness_lock.get").map(row => [
				row.path as string,
				row.value,
			]),
		);
		const added: string[] = [];
		const removed: string[] = [];
		const changed: string[] = [];
		for (const path of new Set([...leftRows.keys(), ...rightRows.keys()])) {
			const inLeft = leftRows.has(path);
			const inRight = rightRows.has(path);
			if (!inLeft) added.push(`${path}: ${displayValue(rightRows.get(path))}`);
			else if (!inRight) removed.push(`${path}: ${displayValue(leftRows.get(path))}`);
			else if (JSON.stringify(leftRows.get(path)) !== JSON.stringify(rightRows.get(path))) {
				changed.push(`${path}: ${displayValue(leftRows.get(path))} -> ${displayValue(rightRows.get(path))}`);
			}
		}
		const lines = [
			"Harness diff:",
			`Added: ${added.length ? added.join(", ") : "none"}`,
			`Removed: ${removed.length ? removed.join(", ") : "none"}`,
			`Changed: ${changed.length ? changed.join(", ") : "none"}`,
		];
		runtime.ctx.showStatus(lines.join("\n"));
	} catch (error) {
		runtime.ctx.showStatus(error instanceof Error ? error.message : String(error));
	}
	return true;
}

async function executeDynamicCommand(parsed: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<boolean> {
	const port = runtime.ctx.harnessPort;
	if (parsed.name === "plan" || parsed.name === "todo") return false;
	if (isStaticPanelCommand(parsed.name)) {
		runtime.ctx.showAgentHub({ initialSection: "harness", initialHarnessPanel: parsed.name });
		return true;
	}
	if (
		parsed.name === "spawn" ||
		parsed.name === "wait" ||
		parsed.name === "bus" ||
		parsed.name === "longrun" ||
		parsed.name === "checkpoint"
	) {
		runtime.ctx.showStatus(`/${parsed.name} unavailable: no host implementation`);
		return true;
	}
	if (!port) return false;
	try {
		if (parsed.name === "mode") {
			const mode = parsed.args.trim();
			if (!mode) {
				runtime.ctx.showStatus("Usage: /mode <name>");
				return true;
			}
			if (!port.setSessionMode) throw new Error("/mode unavailable: no BreadBoard engine control route");
			await port.setSessionMode(mode);
			runtime.ctx.showStatus(`Mode set to ${mode}.`);
			return true;
		}
		if (parsed.name === "model") {
			const model = parsed.args.trim();
			if (!model) {
				runtime.ctx.showModelSelector();
				return true;
			}
			if (!port.setSessionModel) throw new Error("/model unavailable: no BreadBoard engine control route");
			await port.setSessionModel(model);
			runtime.ctx.showStatus(`Model set to ${model}.`);
			return true;
		}
		if (parsed.name === "role") {
			const [role, model] = parsed.args.trim().split(/\s+/u);
			if (!role) {
				runtime.ctx.showStatus("Usage: /role <role> [model]");
				return true;
			}
			if (!port.setSessionRole) throw new Error("/role unavailable: no BreadBoard engine control route");
			await port.setSessionRole(role, model);
			runtime.ctx.showStatus(`Role set to ${role}.`);
			return true;
		}
		if (parsed.name === "skills") {
			if (!port.setSessionSkills) throw new Error("/skills unavailable: no BreadBoard engine control route");
			const skills = parsed.args.trim() ? parsed.args.trim().split(/\s+/u) : [];
			await port.setSessionSkills(skills);
			runtime.ctx.showStatus(skills.length ? `Skills set to ${skills.join(", ")}.` : "Skills cleared.");
			return true;
		}
	} catch (error) {
		runtime.ctx.showStatus(error instanceof Error ? error.message : String(error));
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
	const snapshot = runtime.ctx.harnessPort?.current() ?? null;
	const settings = readHarnessPaletteSettings(runtime.ctx.settings);
	// Hiding unavailable commands is presentation only; direct invocation must still reject.
	const specs = materializeHarnessCommands(snapshot, { ...settings, unsupportedCommands: "dim" });
	if (parsed.name === "harness") {
		const { verb, rest } = parseSubcommand(parsed.args);
		if (!verb) {
			runtime.ctx.showStatus(
				snapshot
					? `Active harness: ${snapshot.name} (${snapshot.harnessId})`
					: "No BreadBoard harness snapshot loaded",
			);
			return true;
		}
		if (verb === "list") return harnessList(runtime, rest || undefined);
		if (verb === "reload") {
			const port = runtime.ctx.harnessPort;
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
		if (verb === "explain") {
			if (!rest) {
				runtime.ctx.showStatus("Usage: /harness explain <dotted.path>");
				return true;
			}
			return harnessExplain(runtime, rest);
		}
		if (verb === "validate") return harnessValidate(runtime);
		if (verb === "lock") return harnessLock(runtime);
		if (verb === "diff") return harnessDiff(runtime, rest);
		runtime.ctx.showStatus(`Unknown /harness operation: ${verb}`);
		return true;
	}
	const spec = specs.find(item => item.name === parsed.name);
	if (!spec) return false;
	if (!spec.enabled) {
		runtime.ctx.showStatus(`/${spec.name} unavailable: ${spec.reason ?? "unsupported by harness lock"}`);
		return true;
	}
	if (!snapshot) return true;
	return executeDynamicCommand(parsed, runtime);
}

export const BUILTIN_HARNESS_SLASH_COMMANDS: readonly SlashCommandSpec[] = [
	{
		name: "harness",
		description: "Inspect and switch the active BreadBoard harness",
		allowArgs: true,
		subcommands: [
			{ name: "list", description: "List available harnesses", usage: "[directory]" },
			{ name: "reload", description: "Compile the workspace harness and apply it at the next turn", usage: "" },
			{ name: "use", description: "Start a new session on a harness", usage: "<name|path>" },
			{ name: "explain", description: "Show field provenance", usage: "[field]" },
			{ name: "diff", description: "Compare harness locks", usage: "<a> <b>" },
			{ name: "validate", description: "Validate a harness definition" },
			{ name: "lock", description: "Write and show the effective lock" },
		],
	},
];
