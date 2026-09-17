import type { SettingPath } from "../config/settings-schema";
import type { Args } from "../cli/args";

/**
 * Native OMP controls that can mutate the turn lifecycle or issue work outside
 * the host-owned BreadBoard stream.
 */
export type NativeControl =
	| "subagents"
	| "prewalk"
	| "plan"
	| "compaction"
	| "advisor"
	| "automation"
	| "native-tools"
	| "model-roles"
	| "provider-state"
	| "thinking"
	| "context"
	| "native-session-transition"
	| "native-surface";

const RESTRICTIONS: Readonly<Record<NativeControl, string>> = {
	subagents:
		"BreadBoard owns turns; native subagent and task routing has no BreadBoard host route in this session, so native delegation is unavailable.",
	prewalk:
		"BreadBoard owns turns; native prewalk has no BreadBoard handoff route in this session, so it cannot run here.",
	plan: "BreadBoard owns turns; no BreadBoard plan/proposal route is exposed for native plan mode, so it cannot run here.",
	compaction:
		"BreadBoard owns turns; native compaction and handoff have no BreadBoard context-maintenance route, so they cannot run here.",
	advisor:
		"BreadBoard owns turns; native advisor inference has no BreadBoard provider route, so advisor work is unavailable here.",
	automation:
		"BreadBoard owns turns; native goal, loop, retry, or background automation has no BreadBoard continuation route, so it cannot start here.",
	"native-tools":
		"BreadBoard owns execution; native tool registries and live tool settings do not configure this engine. Inspect /harness explain modes for the engine tool set.",
	"model-roles":
		"BreadBoard owns turns; primary model selection remains available through the engine model route, but native helper-role mappings do not configure BreadBoard workers.",
	"provider-state":
		"BreadBoard owns provider execution; native request settings, account pinning, and quota-reset controls are unavailable here. Provider login and account inspection remain available.",
	thinking:
		"BreadBoard owns turns; no BreadBoard engine thinking-control route is exposed, so native thinking changes would only mutate local state.",
	context:
		"BreadBoard owns turn context; native context controls and inspection have no engine route. Use /harness to inspect the active configuration.",
	"native-session-transition":
		"BreadBoard owns session identity; no BreadBoard route can atomically rebind this live engine session to a native session transition.",
	"native-surface":
		"BreadBoard owns this session; print, JSON, RPC and ACP hosts have no BreadBoard transport route. Use the interactive host.",
};

/** Return the actionable reason a native control is unavailable, if any. */
export function nativeControlRestriction(control: NativeControl, externalTurnLifecycle: boolean): string | undefined {
	return externalTurnLifecycle ? RESTRICTIONS[control] : undefined;
}

function normalizeCommandName(commandName: string): string {
	return commandName
		.trim()
		.replace(/^\/+/, "")
		.split(/[\s:]+/, 1)[0]
		.toLowerCase();
}

const COMMAND_CONTROLS: Readonly<Record<string, NativeControl>> = {
	// Native delegation and relays.
	agents: "subagents",
	irc: "subagents",
	tan: "subagents",
	collab: "subagents",
	share: "subagents",
	join: "subagents",
	leave: "subagents",

	// Native planning and prewalk.
	prewalk: "prewalk",
	plan: "plan",
	"plan-review": "plan",

	// Native context maintenance.
	compact: "compaction",
	shake: "compaction",
	handoff: "compaction",
	"extended-context": "context",
	context: "context",
	dump: "context",

	// Native side agents and background work.
	advisor: "advisor",
	goal: "automation",
	"guided-goal": "automation",
	loop: "automation",
	vibe: "automation",
	queue: "automation",
	followup: "automation",
	retry: "automation",
	btw: "automation",
	omfg: "automation",
	force: "automation",
	cleanse: "subagents",
	fast: "thinking",
	skillful: "context",
	memory: "automation",
	security: "automation",
	usage: "provider-state",

	// Native tool execution and registries.
	todo: "native-tools",
	tools: "native-tools",
	computer: "native-tools",
	browser: "native-tools",
	live: "native-tools",
	pause: "native-tools",
	mcp: "native-tools",
	plugins: "native-tools",
	"reload-plugins": "native-tools",
	extensions: "native-tools",
	marketplace: "native-tools",

	// Native session transitions.
	new: "native-session-transition",
	fresh: "native-session-transition",
	clear: "native-session-transition",
	delete: "native-session-transition",
	resume: "native-session-transition",
	pin: "native-session-transition",
	branch: "native-session-transition",
	fork: "native-session-transition",
	tree: "native-session-transition",
	restart: "native-session-transition",
	move: "native-session-transition",
	worktree: "native-session-transition",
	wt: "native-session-transition",
	"add-dir": "native-session-transition",
	"remove-dir": "native-session-transition",
	dirs: "native-session-transition",
	session: "native-session-transition",
};

/** Canonical aliases used by command-policy checks. */
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
	plugin: "plugins",
	todos: "todo",
	status: "extensions",
	models: "model",
};

const READ_ONLY_NATIVE_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
	mcp: new Set(["help", "list", "test", "resources", "prompts", "notifications"]),
	plugins: new Set(["list"]),
};

function canonicalCommandName(commandName: string): string {
	const normalized = normalizeCommandName(commandName);
	return COMMAND_ALIASES[normalized] ?? normalized;
}

/** Return the actionable reason a native slash command is unavailable, if any. */
export function nativeCommandRestriction(
	commandName: string,
	externalTurnLifecycle: boolean,
	commandArgs = "",
): string | undefined {
	if (!externalTurnLifecycle) return undefined;
	const normalized = canonicalCommandName(commandName);
	const control = COMMAND_CONTROLS[normalized];
	if (control === undefined) return undefined;
	const readonly = READ_ONLY_NATIVE_SUBCOMMANDS[normalized];
	if (readonly !== undefined) {
		const subcommand = commandArgs.trim().split(/\s+/u)[0]?.toLowerCase();
		if (!subcommand || readonly.has(subcommand)) return undefined;
	}
	return nativeControlRestriction(control, true);
}

/**
 * Availability is stricter than execution for commands with both read-only
 * helpers and native mutations: do not advertise the mixed command at all.
 * Direct invocation still passes its arguments to nativeCommandRestriction(),
 * which preserves genuinely read-only helpers.
 */
export function nativeCommandAvailabilityRestriction(
	commandName: string,
	externalTurnLifecycle: boolean,
): string | undefined {
	if (!externalTurnLifecycle) return undefined;
	const normalized = canonicalCommandName(commandName);
	if (READ_ONLY_NATIVE_SUBCOMMANDS[normalized] !== undefined) {
		return nativeControlRestriction("native-tools", true);
	}
	return nativeCommandRestriction(commandName, true);
}

const STARTUP_CONTROLS = [
	["prewalk", "--prewalk", "prewalk"],
	["prewalkInto", "--prewalk-into", "prewalk"],
	["plan", "--plan", "plan"],
	["planYolo", "--plan-yolo", "plan"],
	["planYoloInto", "--plan-yolo-into", "plan"],
	["advisor", "--advisor", "advisor"],
	["thinking", "--thinking", "thinking"],
	["externalThinking", "--external-thinking", "thinking"],
	["serviceTier", "--service-tier", "thinking"],
	["smol", "--smol", "model-roles"],
	["slow", "--slow", "model-roles"],
	["models", "--models", "model-roles"],
	["systemPrompt", "--system-prompt", "context"],
	["appendSystemPrompt", "--append-system-prompt", "context"],
	["providerSessionId", "--provider-session-id", "context"],
	["providerPromptCacheKey", "--prompt-cache-key", "context"],
	["tools", "--tools", "context"],
	["noTools", "--no-tools", "context"],
	["skills", "--skills", "context"],
	["noSkills", "--no-skills", "context"],
	["noRules", "--no-rules", "context"],
	["addDir", "--add-dir", "native-session-transition"],
	["join", "join", "subagents"],
	["apiKey", "--api-key", "provider-state"],
	["fork", "--fork", "native-session-transition"],
	["fromClaude", "--from-claude", "context"],
	["fromCodex", "--from-codex", "context"],
	["printThoughts", "--print-thoughts", "native-surface"],
] satisfies ReadonlyArray<readonly [keyof Args, string, NativeControl]>;

/** Project startup admission policies into CLI help without changing parser metadata. */
export function nativeStartupFlagRestriction(flag: string, externalTurnLifecycle: boolean): string | undefined {
	if (!externalTurnLifecycle) return undefined;
	// Protocol admission owns its exit-code and stderr-only transport contract.
	if (flag === "--print" || flag === "--mode") return nativeControlRestriction("native-surface", true);
	const entry = STARTUP_CONTROLS.find(([, name]) => name === flag);
	return entry === undefined ? undefined : nativeControlRestriction(entry[2], true);
}

/** Explicit native execution flags reject; saved preferences remain stored but inactive. */
export function nativeStartupRestriction(parsed: Args, externalTurnLifecycle: boolean): string | undefined {
	if (!externalTurnLifecycle) return undefined;
	if (parsed.approvalMode !== undefined && parsed.approvalMode !== "yolo") {
		return "--approval-mode supports only yolo through the BreadBoard engine route; configure other permission policies in the harness.";
	}
	for (const [field, flag, control] of STARTUP_CONTROLS) {
		if (parsed[field] !== undefined && parsed[field] !== false) {
			return `${flag} is unavailable. ${RESTRICTIONS[control]}`;
		}
	}
	return undefined;
}

function normalizeGroupName(groupName: string): string {
	return groupName.trim().replace(/\s+/g, " ").toLowerCase();
}

const SETTINGS_GROUP_CONTROLS: Readonly<Record<string, NativeControl>> = {
	// Model-side controls without a BreadBoard propagation route.
	thinking: "thinking",
	sampling: "thinking",
	advisor: "advisor",
	prewalk: "prewalk",
	prompt: "context",
	"retry & fallback": "automation",

	// Interaction controls that arm native agents or relays.
	agent: "automation",
	"magic keywords": "automation",
	collab: "subagents",

	// Context rewrite and native background-memory controls.
	context: "context",
	compaction: "compaction",
	"rules (ttsr)": "context",
	experimental: "context",
	memory: "automation",
	"auto-learn": "automation",
	mnemopi: "automation",
	hindsight: "automation",
	sharpshooter: "automation",

	// Native task orchestration settings.
	tasks: "subagents",
	modes: "automation",
	subagents: "subagents",
	isolation: "subagents",
	computer: "native-tools",
	todos: "native-tools",
	"discovery & mcp": "native-tools",
	extensions: "native-tools",
};

const SETTING_CONTROLS: Readonly<Partial<Record<SettingPath, NativeControl>>> = {
	steeringMode: "automation",
	followUpMode: "automation",
	interruptMode: "automation",
	cycleOrder: "model-roles",
	"loop.mode": "automation",
	"loop.conditionTimeoutMs": "automation",
	"marketplace.autoUpdate": "native-tools",
	"tools.approval": "native-tools",
	"tools.approvalMode": "native-tools",
};

/** Frontend-only settings remain usable while BreadBoard owns execution. */
const FRONTEND_SETTINGS: Readonly<Record<string, true>> = {
	hideThinkingBlock: true,
	proseOnlyThinking: true,
	omitThinking: true,
	"read.toolResultPreview": true,
	"mcp.renderMarkdownResults": true,
	"providers.tinyModel": true,
	"providers.tinyModelDevice": true,
	"providers.tinyModelDtype": true,
	"providers.tts": true,
	"tts.localModel": true,
	"tts.localVoice": true,
	"speech.enabled": true,
	"speech.mode": true,
	"speech.enhanced": true,
	"speech.voice": true,
};

/** Return the actionable reason a native settings group is unavailable, if any. */
export function nativeSettingsGroupRestriction(groupName: string, externalTurnLifecycle: boolean): string | undefined {
	if (!externalTurnLifecycle) return undefined;
	const control = SETTINGS_GROUP_CONTROLS[normalizeGroupName(groupName)];
	return control === undefined ? undefined : nativeControlRestriction(control, true);
}

/**
 * Classify settings by the operation they affect, not only their UI group.
 * Mixed groups (Thinking, Available Tools, and Grep & Browser) therefore keep
 * frontend controls while hiding native execution controls.
 */
export function nativeSettingRestriction(
	settingPath: SettingPath,
	groupName: string | undefined,
	externalTurnLifecycle: boolean,
): string | undefined {
	if (!externalTurnLifecycle || settingPath.startsWith("breadboard.") || FRONTEND_SETTINGS[settingPath]) {
		return undefined;
	}
	const control = SETTING_CONTROLS[settingPath];
	if (control) return nativeControlRestriction(control, true);
	// Static CLI help also imports this policy; only settings UI needs the schema graph.
	const { getUi }: typeof import("../config/settings-schema") = require("../config/settings-schema");
	switch (getUi(settingPath)?.tab) {
		case "memory":
			return nativeControlRestriction("automation", true);
		case "context":
			return nativeControlRestriction("context", true);
		case "files":
		case "shell":
		case "tools":
			return nativeControlRestriction("native-tools", true);
		case "tasks":
			return nativeControlRestriction("subagents", true);
		case "providers":
			return nativeControlRestriction("provider-state", true);
	}
	if (
		settingPath.startsWith("browser.") ||
		settingPath.startsWith("computer.") ||
		settingPath.startsWith("todo.") ||
		settingPath.startsWith("lsp.")
	) {
		return nativeControlRestriction("native-tools", true);
	}
	return groupName === undefined ? undefined : nativeSettingsGroupRestriction(groupName, true);
}
