/** Schema-independent display definitions for the settings overlay. */
import type { SymbolKey } from "../theme/symbols";

export const BUILTIN_SETTING_TABS = [
	"appearance",
	"model",
	"interaction",
	"context",
	"memory",
	"files",
	"shell",
	"tools",
	"tasks",
	"providers",
] as const;

export type BuiltinSettingTab = (typeof BUILTIN_SETTING_TABS)[number];
export type SettingTab = BuiltinSettingTab | (string & {});

/** Tab display metadata - icon is resolved via theme.symbol() */
export type TabMetadata = { label: string; icon: Extract<SymbolKey, `tab.${string}`> | `tab.${string}` };

export const BUILTIN_TAB_METADATA: Record<BuiltinSettingTab, TabMetadata> = {
	appearance: { label: "Appearance", icon: "tab.appearance" },
	model: { label: "Model", icon: "tab.model" },
	interaction: { label: "Interaction", icon: "tab.interaction" },
	context: { label: "Context", icon: "tab.context" },
	memory: { label: "Memory", icon: "tab.memory" },
	files: { label: "Files", icon: "tab.files" },
	shell: { label: "Shell", icon: "tab.shell" },
	tools: { label: "Tools", icon: "tab.tools" },
	tasks: { label: "Tasks", icon: "tab.tasks" },
	providers: { label: "Providers", icon: "tab.providers" },
};

export const BUILTIN_TAB_GROUPS: Record<BuiltinSettingTab, readonly string[]> = {
	appearance: ["Theme", "Composer", "Status Line", "Display", "Images"],
	model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
	interaction: [
		"Input",
		"Approvals",
		"Notifications",
		"Speech",
		"Collab",
		"Stream",
		"Magic Keywords",
		"Startup & Updates",
		"Power",
		"Agent",
		"Git",
		"Skills",
	],
	context: ["General", "Compaction", "Rules (TTSR)", "Experimental"],
	memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"],
	files: ["Editing", "Reading", "Read Summaries", "LSP"],
	shell: ["Bash", "Eval & Runtimes"],
	tools: [
		"Available Tools",
		"Todos",
		"Grep & Browser",
		"Computer",
		"GitHub",
		"Output Limits",
		"Execution",
		"Discovery & MCP",
		"Extensions",
		"Developer",
	],
	tasks: ["Modes", "Subagents", "Isolation", "Commands & Skills"],
	providers: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
};

export interface SettingsTabRegistration {
	readonly id: string;
	readonly label: string;
	readonly icon: Extract<SymbolKey, `tab.${string}`> | `tab.${string}`;
	readonly sections: readonly string[];
	readonly itemProvider?: (entries: readonly SettingsDisplayEntry[]) => SettingDef[];
	readonly getItems?: (entries: readonly SettingsDisplayEntry[]) => SettingDef[];
}

const customTabs = new Map<string, SettingsTabRegistration>();
const activeTabs: SettingTab[] = [...BUILTIN_SETTING_TABS];

/** Ordered list of tabs for UI rendering */
export const SETTING_TABS: SettingTab[] = activeTabs;
export const TAB_METADATA: Record<string, TabMetadata> = { ...BUILTIN_TAB_METADATA };
export const TAB_GROUPS: Record<string, readonly string[]> = { ...BUILTIN_TAB_GROUPS };

function rebuildSettingsTabs(): void {
	activeTabs.length = 0;
	activeTabs.push(...BUILTIN_SETTING_TABS);
	for (const key of Object.keys(TAB_METADATA)) {
		if (!BUILTIN_SETTING_TABS.includes(key as BuiltinSettingTab)) delete TAB_METADATA[key];
	}
	for (const key of Object.keys(TAB_GROUPS)) {
		if (!BUILTIN_SETTING_TABS.includes(key as BuiltinSettingTab)) delete TAB_GROUPS[key];
	}
	for (const [id, tab] of customTabs) {
		activeTabs.push(id);
		TAB_METADATA[id] = { label: tab.label, icon: tab.icon };
		TAB_GROUPS[id] = tab.sections;
	}
}

export function registerSettingsTab(registration: SettingsTabRegistration): () => void {
	customTabs.set(registration.id, registration);
	rebuildSettingsTabs();
	return () => {
		if (customTabs.get(registration.id) === registration) {
			customTabs.delete(registration.id);
			rebuildSettingsTabs();
		}
	};
}

export function resetSettingsTabs(): void {
	customTabs.clear();
	rebuildSettingsTabs();
}

export function getSettingTabs(): readonly SettingTab[] {
	return [...activeTabs];
}

export interface SettingsCustomEditorContext {
	readonly def: SettingDef;
	readonly currentValue: unknown;
	readonly done: (value?: unknown) => void;
	readonly context: unknown;
	readonly callbacks: unknown;
}

export type SettingsCustomEditorFactory = (ctx: SettingsCustomEditorContext) => unknown;

const customSettingEditors = new Map<string, SettingsCustomEditorFactory>();

export function registerSettingCustomEditor(path: string, factory: SettingsCustomEditorFactory): () => void {
	customSettingEditors.set(path, factory);
	return () => {
		if (customSettingEditors.get(path) === factory) customSettingEditors.delete(path);
	};
}

export function getSettingCustomEditor(path: string): SettingsCustomEditorFactory | undefined {
	return customSettingEditors.get(path);
}

/** Submenu choice metadata. */
export type SubmenuOption<V extends string = string> = {
	value: V;
	label: string;
	description?: string;
};

export interface UiBase {
	tab: SettingTab;
	/** Section within the tab; must be listed in TAB_GROUPS[tab]. Ungrouped settings render at the top. */
	group?: string;
	label: string;
	description: string;
	/**
	 * Risk note. Marks the settings row with a warning glyph and renders above
	 * the description in warning styling. For settings that can get the user
	 * rate-limited, flagged, or banned — not for merely advanced options.
	 */
	warning?: string;
	/** Condition function name - setting only shown when true */
	condition?: string;
	/** Render an informational value without an editor or mutation callback. */
	readonly?: boolean;
}

/** Wide ui shape exposed to consumers that walk the schema generically. */
export type AnyUiMetadata = UiBase & {
	options?: ReadonlyArray<SubmenuOption> | "runtime";
	secret?: boolean;
	ordered?: boolean;
};

/** Structural schema entries supplied by the application host. */
export interface SettingsDisplayEntry {
	path: string;
	type: string;
	defaultValue: unknown;
	ui?: AnyUiMetadata;
	enumValues?: readonly string[];
	credential?: boolean;
	condition?: () => boolean;
}

export interface SettingsHost {
	entries: readonly SettingsDisplayEntry[];
	get(path: string): unknown;
	set(path: string, value: unknown): void;
	normalizeProviderLimits(value: unknown): Record<string, number>;
	validateProviderLimits(value: unknown): Record<string, number>;
}


/** Primitive value displayed by a settings control. */
export type SettingsDisplayValue = boolean | string;

interface BaseSettingDef {
	path: string;
	defaultValue: unknown;
	schemaType: string;
	label: string;
	description: string;
	/** Risk note shown in warning styling; set for settings that can get the user flagged or banned. */
	warning?: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	condition?: () => boolean;
	/** Render an informational value without an editor or mutation callback. */
	readonly?: boolean;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

export interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

/** Array-of-enum setting edited as a toggle list; `ordered` lists render positions and support reordering. */
export interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: OptionList;
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| TextInputSettingDef
	| ProviderLimitsSettingDef
	| MultiSelectSettingDef;

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

function entryToSettingDef(entry: SettingsDisplayEntry): SettingDef | null {
	const { path, ui } = entry;
	if (!ui) return null;

	const schemaType = entry.type;
	const condition = entry.condition;
	const base = {
		path,
		defaultValue: entry.defaultValue,
		schemaType,
		label: ui.label,
		description: ui.description,
		warning: ui.warning,
		tab: ui.tab,
		group: ui.group,
		condition,
		readonly: ui.readonly,
	};

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui);

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: entry.enumValues ?? [] };
		}
		// "runtime" is not a valid sentinel for enums — schema types prevent this,
		// but treat defensively as an empty submenu.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		// Read-only numbers can be sourced from a runtime snapshot rather than
		// Settings, so keep them in the definitions even without edit options.
		if (!options || options === "runtime") {
			return ui.readonly ? { ...base, type: "text", secret: false } : null;
		}
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "string") {
		if (options === "runtime") {
			// Empty list now; the selector layer (theme handling, etc.) injects choices.
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}
		// One classification drives both surfaces: a setting marked `credential`
		// masks here too, so the panel cannot display one that only the CLI knows
		// to redact.
		return { ...base, type: "text", secret: entry.credential === true };
	}

	if (schemaType === "array") {
		// Arrays without declared options stay config-file only (free-form lists
		// like extension paths have no finite choice set to toggle).
		if (!options || options === "runtime") return null;
		return { ...base, type: "multiselect", options, ordered: ui.ordered === true };
	}

	if (schemaType === "record") {
		return path === "providers.maxInFlightRequests"
			? { ...base, type: "providerLimits" }
			: { ...base, type: "text", secret: false };
	}

	return null;
}

const definitions = new WeakMap<readonly SettingsDisplayEntry[], SettingDef[]>();

/** Get all setting definitions with UI, retaining live host visibility predicates. */
export function getAllSettingDefs(entries: readonly SettingsDisplayEntry[]): SettingDef[] {
	let defs = definitions.get(entries);
	if (!defs) {
		defs = [];
		for (const entry of entries) {
			const def = entryToSettingDef(entry);
			if (def) defs.push(def);
		}
		definitions.set(entries, defs);
	}
	return defs;
}

/** Get settings ordered by their tab's section layout. */
export function getSettingsForTab(entries: readonly SettingsDisplayEntry[], tab: SettingTab): SettingDef[] {
	const custom = customTabs.get(tab);
	let defs: SettingDef[];
	if (custom?.itemProvider) {
		defs = [...custom.itemProvider(entries)];
	} else if (custom?.getItems) {
		defs = [...custom.getItems(entries)];
	} else {
		defs = getAllSettingDefs(entries).filter(def => def.tab === tab);
	}
	const order = TAB_GROUPS[tab] ?? custom?.sections ?? [];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Find the display definition for a host setting path. */
export function getSettingDef(entries: readonly SettingsDisplayEntry[], path: string): SettingDef | undefined {
	return getAllSettingDefs(entries).find(def => def.path === path);
}

/** Format a setting's declared default for display. */
export function getDisplayDefault(entries: readonly SettingsDisplayEntry[], path: string): string {
	const value = entries.find(entry => entry.path === path)?.defaultValue;
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
