import { getStatusLinePreset } from "../status-line/presets";
import type { HarnessSnapshot } from "../status-line/types";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

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

export interface BreadboardFieldOption<T extends string = string> {
	readonly value: T;
	readonly label: string;
	readonly description?: string;
}

export interface BreadboardFieldDefinition<K extends BreadboardFieldKey = BreadboardFieldKey> {
	readonly key: K;
	readonly label: string;
	readonly description: string;
	readonly options: readonly BreadboardFieldOption[];
}

const PRESET_OPTION: BreadboardFieldOption = {
	value: "preset",
	label: "Preset default",
	description: "Inherit this field behavior from the active layout preset.",
};

const VISIBILITY_OPTIONS: readonly BreadboardFieldOption[] = [
	PRESET_OPTION,
	{ value: "shown", label: "Always show" },
	{ value: "hidden", label: "Always hide" },
];

export const BREADBOARD_FIELD_DEFINITIONS: readonly BreadboardFieldDefinition[] = [
	{
		key: "folder",
		label: "Folder",
		description: "Display the active project or worktree folder.",
		options: [
			PRESET_OPTION,
			{ value: "name", label: "Folder name" },
			{ value: "full", label: "Full path" },
			{ value: "hidden", label: "Always hide" },
		],
	},
	{ key: "session", label: "Session", description: "Display the session title.", options: VISIBILITY_OPTIONS },
	{
		key: "branch",
		label: "Branch",
		description: "Display the active git or Jujutsu branch.",
		options: VISIBILITY_OPTIONS,
	},
	{ key: "model", label: "Model", description: "Display the active model.", options: VISIBILITY_OPTIONS },
	{
		key: "harness",
		label: "Harness",
		description: "Display the active harness name and mode.",
		options: VISIBILITY_OPTIONS,
	},
	{
		key: "effort",
		label: "Effort",
		description: "Display the current thinking budget or effort level.",
		options: VISIBILITY_OPTIONS,
	},
	{
		key: "context",
		label: "Context",
		description: "Display context window utilization.",
		options: [
			PRESET_OPTION,
			{ value: "percent", label: "Percentage" },
			{ value: "tokens", label: "Tokens used" },
			{ value: "pressure", label: "Only under pressure" },
			{ value: "hidden", label: "Always hide" },
		],
	},
	{
		key: "spend",
		label: "Spend",
		description: "Display accumulated session cost.",
		options: [
			PRESET_OPTION,
			{ value: "session", label: "Session total" },
			{ value: "turn", label: "Last turn" },
			{ value: "hidden", label: "Always hide" },
		],
	},
	{
		key: "activity",
		label: "Activity",
		description: "Display tool and agent activity indicators.",
		options: VISIBILITY_OPTIONS,
	},
	{ key: "elapsed", label: "Elapsed", description: "Display the active turn duration.", options: VISIBILITY_OPTIONS },
];

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

export function isBreadboardFieldKey(value: string): value is BreadboardFieldKey {
	return (BREADBOARD_FIELD_KEYS as readonly string[]).includes(value);
}

export function updateBreadboardField(
	settings: BreadboardFieldSettings,
	key: BreadboardFieldKey,
	value: string,
): BreadboardFieldSettings | undefined {
	const definition = BREADBOARD_FIELD_DEFINITIONS.find(def => def.key === key);
	if (!definition?.options.some(opt => opt.value === value)) return undefined;
	return { ...settings, [key]: value };
}

export function isBreadboardPreset(preset: string | undefined): boolean {
	return preset === "bb-balanced" || preset === "bb-quiet" || preset === "bb-detailed";
}

export interface BreadboardComposerActivity {
	readonly kind: "working" | "tool" | "approval" | "cancelling" | "error";
	readonly label: string;
}

export interface BreadboardStatusSnapshot {
	readonly modelName: string;
	readonly workspace: string;
	readonly workspacePath?: string;
	readonly sessionName?: string | null;
	readonly harness?: HarnessSnapshot | null;
	readonly branch?: string | null;
	readonly effort?: ThinkingLevel | null;
	readonly spend?: {
		readonly sessionUsd: number | null;
		readonly turnUsd: number | null;
		readonly estimated: boolean;
	} | null;
	readonly activity?: BreadboardComposerActivity | null;
	readonly elapsedMs?: number | null;
	readonly backgroundWait?: number;
	readonly context?: { readonly tokens: number; readonly capacity: number } | null;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly vim?: string;
}

export function renderBreadboardStatusLine(
	snapshot: BreadboardStatusSnapshot,
	preset: string,
	width: number,
	layout: "box" | "band" | "plain-full" | "plain-left" | "plain-right" = "box",
	fields?: Partial<BreadboardFieldSettings>,
): string {
	const reg = getStatusLinePreset(preset);
	if (reg?.render) {
		const result = reg.render({
			session: {} as any,
			ctx: { snapshot, harness: snapshot.harness } as any,
			width,
			layout,
			preset,
			options: {},
			config: fields,
		});
		return result.content;
	}
	return "";
}

export function renderBreadboardStatusRows(
	snapshot: BreadboardStatusSnapshot,
	preset: string,
	width: number,
	layout: "box" | "band" | "plain-right" = "box",
	fields?: Partial<BreadboardFieldSettings>,
): { top: string; bottom: string } {
	const reg = getStatusLinePreset(preset);
	if (reg?.renderRows) {
		return reg.renderRows({
			session: {} as any,
			ctx: { snapshot, harness: snapshot.harness } as any,
			width,
			layout,
			preset,
			options: {},
			config: fields,
		});
	}
	return { top: "", bottom: "" };
}
