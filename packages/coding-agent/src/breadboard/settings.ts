/**
 * BreadBoard-owned settings. Importing this module registers the `breadboard.*` and
 * `statusLine.breadboard` settings; their rows live on the `breadboard` settings tab, which only
 * `bb` registers (`ui/settings-tab.ts`), so stock `omp` never lists them.
 * {@link registerBreadboardSettings} moves the shared subagent limits onto that tab and puts the
 * BreadBoard status-line presets first.
 */
import type { SubmenuOption } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { type DefinitionOverride, overrideDefinitions, register, type UiString } from "../config/registry";
import { cfgStatusLinePreset } from "../modes/settings";
import { cfgTaskMaxConcurrency, cfgTaskMaxRecursionDepth, cfgTaskMaxRuntimeMs } from "../task/settings";
import {
	assertBreadboardFieldSettings,
	type BreadboardFieldSettings,
	DEFAULT_BREADBOARD_FIELD_SETTINGS,
} from "./ui/status-line/breadboard-fields";

export const cfgBreadboardSessionConfigPath = register({
	id: "breadboard.sessionConfigPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "breadboard",
		group: "Harness",
		label: "Session config path",
		description: "Path to the session configuration used by the selected harness",
	},
});

export const cfgBreadboardHarnessDefault = register({
	id: "breadboard.harness.default",
	type: "string",
	default: "daily_driver",
	ui: {
		tab: "breadboard",
		group: "Harness",
		label: "Default harness",
		description: "Harness name or definition path selected when --harness is omitted",
	},
});

export const cfgBreadboardHarnessPaletteHeader = register({
	id: "breadboard.harness.paletteHeader",
	type: "boolean",
	default: true,
	ui: {
		tab: "breadboard",
		group: "Harness",
		label: "Palette header",
		description: "Show the active harness identity in the command palette",
	},
});

export const cfgBreadboardHarnessUnsupportedCommands = register({
	id: "breadboard.harness.unsupportedCommands",
	type: "string",
	default: "dim",
	ui: {
		tab: "breadboard",
		group: "Harness",
		label: "Unsupported commands",
		description: "How commands unavailable to the active harness appear in the palette",
		options: [
			{ value: "dim", label: "Dim" },
			{ value: "hide", label: "Hide" },
		],
	},
});

export const cfgBreadboardHarnessMaxConcurrentAgents = register({
	id: "breadboard.harness.max_concurrent_agents",
	type: "number",
	default: undefined,
	ui: {
		tab: "breadboard",
		group: "Subagents",
		label: "Harness max concurrent agents",
		description: "Effective lock limit for concurrent agents (read-only)",
		readonly: true,
	},
});

export const cfgStatusLineBreadboard = register({
	id: "statusLine.breadboard",
	type: "record",
	default: DEFAULT_BREADBOARD_FIELD_SETTINGS as unknown as Readonly<Record<string, unknown>>,
	validate: assertBreadboardFieldSettings,
});

/** BreadBoard status-line field choices, every field left unset at its default. */
export const cfgBreadboardFields = cfgStatusLineBreadboard.map((value): BreadboardFieldSettings => ({
	...DEFAULT_BREADBOARD_FIELD_SETTINGS,
	...(value as Partial<BreadboardFieldSettings>),
}));

const BREADBOARD_STATUS_LINE_PRESET_OPTIONS: readonly SubmenuOption[] = [
	{
		value: "bb-balanced",
		label: "BreadBoard Balanced",
		description: "Folder, session, model, compact context and available spend",
	},
	{
		value: "bb-quiet",
		label: "BreadBoard Quiet",
		description: "Folder and model, with activity and context pressure when needed",
	},
	{
		value: "bb-detailed",
		label: "BreadBoard Detailed",
		description: "Identity, harness, token counts, available spend and timing",
	},
];

function breadboardPanelOverrides(): Record<string, DefinitionOverride> {
	// `statusLine.preset` is a string setting, so its panel metadata is string-shaped.
	const presetUi = cfgStatusLinePreset.definition.ui as UiString;
	const stockPresetOptions = Array.isArray(presetUi.options) ? presetUi.options : [];
	const onBreadboardTab = (
		ui: NonNullable<DefinitionOverride["ui"]> | undefined,
		label: string,
		description: string,
	): DefinitionOverride => ({ ui: { ...ui!, tab: "breadboard", group: "Subagents", label, description } });
	return {
		[cfgStatusLinePreset.id]: {
			ui: { ...presetUi, options: [...BREADBOARD_STATUS_LINE_PRESET_OPTIONS, ...stockPresetOptions] },
		},
		[cfgTaskMaxConcurrency.id]: onBreadboardTab(
			cfgTaskMaxConcurrency.definition.ui,
			"BreadBoard concurrent agents",
			"BreadBoard product policy for the maximum number of subagents running concurrently",
		),
		[cfgTaskMaxRecursionDepth.id]: {
			ui: {
				...onBreadboardTab(
					cfgTaskMaxRecursionDepth.definition.ui,
					"BreadBoard recursion depth",
					"BreadBoard product policy for how many levels deep subagents may spawn",
				).ui!,
				options: [
					{ value: "-1", label: "Unlimited" },
					{ value: "0", label: "None" },
					{ value: "1", label: "1 deep" },
					{ value: "2", label: "2 deep" },
					{ value: "3", label: "3 deep" },
					{ value: "4", label: "4 deep" },
				],
			},
		},
		[cfgTaskMaxRuntimeMs.id]: onBreadboardTab(
			cfgTaskMaxRuntimeMs.definition.ui,
			"BreadBoard runtime limit",
			"BreadBoard product policy for each subagent's hard wall-clock limit (ms); 0 disables the limit.",
		),
	};
}

let unregister: (() => void) | undefined;

/** Install BreadBoard's panel metadata over shared settings; returns a handle that restores stock. */
export function registerBreadboardSettings(): () => void {
	if (unregister) return unregister;
	const restore = overrideDefinitions(breadboardPanelOverrides());
	unregister = () => {
		restore();
		unregister = undefined;
	};
	return unregister;
}
