import type { StatusLinePreset } from "./schema";

export const BREADBOARD_FIELD_KEYS = [
	"folder",
	"session",
	"branch",
	"model",
	"harness",
	"effort",
	"context",
	"spend",
	"activity",
	"elapsed",
] as const;

export type BreadboardFieldKey = (typeof BREADBOARD_FIELD_KEYS)[number];
export type BreadboardVisibilityChoice = "preset" | "shown" | "hidden";
export type BreadboardFolderChoice = "preset" | "name" | "full" | "hidden";
export type BreadboardContextChoice = "preset" | "percent" | "tokens" | "pressure" | "hidden";
export type BreadboardSpendChoice = "preset" | "session" | "turn" | "hidden";

/** Persisted field preferences. `preset` delegates to the selected layout preset. */
export interface BreadboardFieldSettings {
	readonly folder: BreadboardFolderChoice;
	readonly session: BreadboardVisibilityChoice;
	readonly branch: BreadboardVisibilityChoice;
	readonly model: BreadboardVisibilityChoice;
	readonly harness: BreadboardVisibilityChoice;
	readonly effort: BreadboardVisibilityChoice;
	readonly context: BreadboardContextChoice;
	readonly spend: BreadboardSpendChoice;
	readonly activity: BreadboardVisibilityChoice;
	readonly elapsed: BreadboardVisibilityChoice;
}

export interface ResolvedBreadboardFieldSettings {
	readonly folder: Exclude<BreadboardFolderChoice, "preset">;
	readonly session: Exclude<BreadboardVisibilityChoice, "preset">;
	readonly branch: Exclude<BreadboardVisibilityChoice, "preset">;
	readonly model: Exclude<BreadboardVisibilityChoice, "preset">;
	readonly harness: Exclude<BreadboardVisibilityChoice, "preset">;
	readonly effort: Exclude<BreadboardVisibilityChoice, "preset">;
	readonly context: Exclude<BreadboardContextChoice, "preset">;
	readonly spend: Exclude<BreadboardSpendChoice, "preset">;
	readonly activity: Exclude<BreadboardVisibilityChoice, "preset">;
	readonly elapsed: Exclude<BreadboardVisibilityChoice, "preset">;
}

export interface BreadboardFieldOption<T extends string = string> {
	readonly value: T;
	readonly label: string;
	readonly description: string;
}

export interface BreadboardFieldDefinition<K extends BreadboardFieldKey = BreadboardFieldKey> {
	readonly key: K;
	readonly label: string;
	readonly options: readonly BreadboardFieldOption[];
}

const PRESET_OPTION: BreadboardFieldOption = {
	value: "preset",
	label: "Preset",
	description: "Follow the selected Balanced, Quiet, or Detailed layout",
};

const VISIBILITY_OPTIONS: readonly BreadboardFieldOption[] = [
	PRESET_OPTION,
	{ value: "shown", label: "Shown", description: "Keep this field in the compact status line" },
	{ value: "hidden", label: "Hidden", description: "Omit this field from the status line" },
];

export const BREADBOARD_FIELD_DEFINITIONS = [
	{
		key: "folder",
		label: "Folder",
		options: [
			PRESET_OPTION,
			{ value: "name", label: "Name", description: "Workspace folder name" },
			{ value: "full", label: "Full path", description: "Full workspace path when it fits" },
			{ value: "hidden", label: "Hidden", description: "Omit the workspace folder" },
		],
	},
	{ key: "session", label: "Session", options: VISIBILITY_OPTIONS },
	{ key: "branch", label: "Branch", options: VISIBILITY_OPTIONS },
	{ key: "model", label: "Model", options: VISIBILITY_OPTIONS },
	{ key: "harness", label: "Harness", options: VISIBILITY_OPTIONS },
	{ key: "effort", label: "Effort", options: VISIBILITY_OPTIONS },
	{
		key: "context",
		label: "Context",
		options: [
			PRESET_OPTION,
			{ value: "percent", label: "Percent", description: "Context usage as a compact percentage" },
			{ value: "tokens", label: "Tokens", description: "Used and capacity token counts" },
			{ value: "pressure", label: "Pressure", description: "Context pressure without capacity prose" },
			{ value: "hidden", label: "Hidden", description: "Omit context accounting" },
		],
	},
	{
		key: "spend",
		label: "Spend",
		options: [
			PRESET_OPTION,
			{ value: "session", label: "Session", description: "Session spend when accounting is available" },
			{ value: "turn", label: "Turn", description: "Current-turn spend when accounting is available" },
			{ value: "hidden", label: "Hidden", description: "Omit spend accounting" },
		],
	},
	{ key: "activity", label: "Activity", options: VISIBILITY_OPTIONS },
	{ key: "elapsed", label: "Elapsed", options: VISIBILITY_OPTIONS },
] as const satisfies readonly BreadboardFieldDefinition[];

export const DEFAULT_BREADBOARD_FIELD_SETTINGS: BreadboardFieldSettings = {
	folder: "preset",
	session: "preset",
	branch: "preset",
	model: "preset",
	harness: "preset",
	effort: "preset",
	context: "preset",
	spend: "preset",
	activity: "preset",
	elapsed: "preset",
};

const BALANCED_FIELDS: ResolvedBreadboardFieldSettings = {
	folder: "name",
	session: "shown",
	branch: "shown",
	model: "shown",
	harness: "hidden",
	effort: "shown",
	context: "percent",
	spend: "session",
	activity: "shown",
	elapsed: "shown",
};

const QUIET_FIELDS: ResolvedBreadboardFieldSettings = {
	folder: "name",
	session: "hidden",
	branch: "hidden",
	model: "shown",
	harness: "hidden",
	effort: "shown",
	context: "pressure",
	spend: "hidden",
	activity: "shown",
	elapsed: "shown",
};

const DETAILED_FIELDS: ResolvedBreadboardFieldSettings = {
	folder: "name",
	session: "shown",
	branch: "shown",
	model: "shown",
	harness: "shown",
	effort: "shown",
	context: "tokens",
	spend: "session",
	activity: "shown",
	elapsed: "shown",
};

function presetFields(preset: StatusLinePreset): ResolvedBreadboardFieldSettings {
	if (preset === "bb-quiet") return QUIET_FIELDS;
	if (preset === "bb-detailed") return DETAILED_FIELDS;
	return BALANCED_FIELDS;
}

/** Resolve persisted choices against a layout preset without retaining `preset` values. */
export function resolveBreadboardFields(
	preset: StatusLinePreset,
	overrides?: Partial<BreadboardFieldSettings>,
): ResolvedBreadboardFieldSettings {
	const defaults = presetFields(preset);
	return {
		folder: overrides?.folder === undefined || overrides.folder === "preset" ? defaults.folder : overrides.folder,
		session:
			overrides?.session === undefined || overrides.session === "preset" ? defaults.session : overrides.session,
		branch: overrides?.branch === undefined || overrides.branch === "preset" ? defaults.branch : overrides.branch,
		model: overrides?.model === undefined || overrides.model === "preset" ? defaults.model : overrides.model,
		harness:
			overrides?.harness === undefined || overrides.harness === "preset" ? defaults.harness : overrides.harness,
		effort: overrides?.effort === undefined || overrides.effort === "preset" ? defaults.effort : overrides.effort,
		context:
			overrides?.context === undefined || overrides.context === "preset" ? defaults.context : overrides.context,
		spend: overrides?.spend === undefined || overrides.spend === "preset" ? defaults.spend : overrides.spend,
		activity:
			overrides?.activity === undefined || overrides.activity === "preset" ? defaults.activity : overrides.activity,
		elapsed:
			overrides?.elapsed === undefined || overrides.elapsed === "preset" ? defaults.elapsed : overrides.elapsed,
	};
}

/** Return a copy with one validated field choice changed. */
export function updateBreadboardField(
	settings: BreadboardFieldSettings,
	key: BreadboardFieldKey,
	choice: string,
): BreadboardFieldSettings | undefined {
	switch (key) {
		case "folder":
			return choice === "preset" || choice === "name" || choice === "full" || choice === "hidden"
				? { ...settings, folder: choice }
				: undefined;
		case "context":
			return choice === "preset" ||
				choice === "percent" ||
				choice === "tokens" ||
				choice === "pressure" ||
				choice === "hidden"
				? { ...settings, context: choice }
				: undefined;
		case "spend":
			return choice === "preset" || choice === "session" || choice === "turn" || choice === "hidden"
				? { ...settings, spend: choice }
				: undefined;
		case "session":
			return choice === "preset" || choice === "shown" || choice === "hidden"
				? { ...settings, session: choice }
				: undefined;
		case "branch":
			return choice === "preset" || choice === "shown" || choice === "hidden"
				? { ...settings, branch: choice }
				: undefined;
		case "model":
			return choice === "preset" || choice === "shown" || choice === "hidden"
				? { ...settings, model: choice }
				: undefined;
		case "harness":
			return choice === "preset" || choice === "shown" || choice === "hidden"
				? { ...settings, harness: choice }
				: undefined;
		case "effort":
			return choice === "preset" || choice === "shown" || choice === "hidden"
				? { ...settings, effort: choice }
				: undefined;
		case "activity":
			return choice === "preset" || choice === "shown" || choice === "hidden"
				? { ...settings, activity: choice }
				: undefined;
		case "elapsed":
			return choice === "preset" || choice === "shown" || choice === "hidden"
				? { ...settings, elapsed: choice }
				: undefined;
	}
}

export function isBreadboardFieldKey(value: string): value is BreadboardFieldKey {
	switch (value) {
		case "folder":
		case "session":
		case "branch":
		case "model":
		case "harness":
		case "effort":
		case "context":
		case "spend":
		case "activity":
		case "elapsed":
			return true;
		default:
			return false;
	}
}
