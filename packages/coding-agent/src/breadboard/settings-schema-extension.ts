/**
 * BreadBoard-owned settings schema extensions.
 * Registers breadboard.* and statusLine.breadboard setting definitions,
 * BreadBoard UI overrides for task.* subagent settings, and the breadboard settings tab.
 */

import type { SettingSchemaDef, UiBoolean, UiNumber, UiString } from "../config/settings-schema";
import { registerSettingSchemas, type SettingTabDefinition } from "../config/settings-extensions";
import { DEFAULT_BREADBOARD_FIELD_SETTINGS, type BreadboardFieldSettings } from "./ui/status-line/breadboard-fields";

export interface BreadboardSettingSchema {
	"breadboard.sessionConfigPath": {
		type: "string";
		default: undefined;
		ui: UiString;
	};
	"breadboard.harness.default": {
		type: "string";
		default: string;
		ui: UiString;
	};
	"breadboard.harness.paletteHeader": {
		type: "boolean";
		default: boolean;
		ui: UiBoolean;
	};
	"breadboard.harness.unsupportedCommands": {
		type: "string";
		default: string;
		ui: UiString;
	};
	"breadboard.harness.max_concurrent_agents": {
		type: "number";
		default: undefined;
		ui: UiNumber;
	};
	"statusLine.breadboard": {
		type: "record";
		default: BreadboardFieldSettings;
	};
}

declare module "../config/settings-schema" {
	interface SettingSchemaRegistry extends BreadboardSettingSchema {}
}

declare module "@oh-my-pi/pi-coding-agent/config/settings-schema" {
	interface SettingSchemaRegistry extends BreadboardSettingSchema {}
}

export const BREADBOARD_SETTING_TABS: readonly SettingTabDefinition[] = [
	{
		id: "breadboard",
		label: "BreadBoard",
		icon: "tab.breadboard",
		sections: ["Harness", "Subagents"],
	},
];

export const BREADBOARD_SETTING_DEFINITIONS: Record<string, SettingSchemaDef> = {
	"breadboard.sessionConfigPath": {
		type: "string",
		default: undefined,
		ui: {
			tab: "breadboard",
			group: "Harness",
			label: "Session config path",
			description: "Path to the session configuration used by the selected harness",
		},
	},
	"breadboard.harness.default": {
		type: "string",
		default: "daily_driver",
		ui: {
			tab: "breadboard",
			group: "Harness",
			label: "Default harness",
			description: "Harness name or definition path selected when --harness is omitted",
		},
	},
	"breadboard.harness.paletteHeader": {
		type: "boolean",
		default: true,
		ui: {
			tab: "breadboard",
			group: "Harness",
			label: "Palette header",
			description: "Show the active harness identity in the command palette",
		},
	},
	"breadboard.harness.unsupportedCommands": {
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
	},
	"breadboard.harness.max_concurrent_agents": {
		type: "number",
		default: undefined,
		ui: {
			tab: "breadboard",
			group: "Subagents",
			label: "Harness max concurrent agents",
			description: "Effective lock limit for concurrent agents (read-only)",
			readonly: true,
		},
	},
	"statusLine.breadboard": {
		type: "record",
		default: DEFAULT_BREADBOARD_FIELD_SETTINGS,
	},
	"task.maxConcurrency": {
		type: "number",
		default: 32,
		ui: {
			tab: "breadboard",
			group: "Subagents",
			label: "BreadBoard concurrent agents",
			description: "BreadBoard product policy for the maximum number of subagents running concurrently",
			options: [
				{ value: "0", label: "Unlimited" },
				{ value: "1", label: "1 task" },
				{ value: "2", label: "2 tasks" },
				{ value: "4", label: "4 tasks" },
				{ value: "8", label: "8 tasks" },
				{ value: "16", label: "16 tasks" },
				{ value: "32", label: "32 tasks" },
				{ value: "64", label: "64 tasks" },
			],
		},
	},
	"task.maxRecursionDepth": {
		type: "number",
		default: 2,
		ui: {
			tab: "breadboard",
			group: "Subagents",
			label: "BreadBoard recursion depth",
			description: "BreadBoard product policy for how many levels deep subagents may spawn",
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
	"task.maxRuntimeMs": {
		type: "number",
		default: 0,
		ui: {
			tab: "breadboard",
			group: "Subagents",
			label: "BreadBoard runtime limit",
			description: "BreadBoard product policy for each subagent's hard wall-clock limit (ms); 0 disables the limit.",
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "300000", label: "5 minutes" },
				{ value: "900000", label: "15 minutes" },
				{ value: "1800000", label: "30 minutes" },
				{ value: "3600000", label: "1 hour" },
			],
		},
	},
};

let unregister: (() => void) | undefined;

export function registerBreadboardSettingsSchema(): () => void {
	if (unregister) return unregister;
	const rollback = registerSettingSchemas(BREADBOARD_SETTING_DEFINITIONS, BREADBOARD_SETTING_TABS);
	unregister = () => {
		rollback();
		unregister = undefined;
	};
	return unregister;
}
