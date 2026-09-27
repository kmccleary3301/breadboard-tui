import { ComposerShapePreview } from "@oh-my-pi/pi-tui/overlays/composer-shape-preview";
import {
	getAllSettingDefs,
	registerSettingCustomEditor,
	registerSettingsTab,
	type SettingDef,
	type SettingsDisplayEntry,
	type SettingsHost,
	type SubmenuSettingDef,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import type { StatusLinePreset } from "@oh-my-pi/pi-tui/status-line/types";
import { BreadboardCustomizeSubmenu } from "./customize-submenu";
import type { BreadboardFieldSettings } from "./status-line/breadboard-fields";
import { isBreadboardPreset } from "./status-line/presets";

export const BREADBOARD_SETTINGS_SECTIONS = ["Harness", "Subagents"] as const;

export function registerBreadboardSettingsTab(): () => void {
	const unregisterTab = registerSettingsTab({
		id: "breadboard",
		label: "BreadBoard",
		icon: "tab.breadboard",
		sections: BREADBOARD_SETTINGS_SECTIONS,
		itemProvider: (entries: readonly SettingsDisplayEntry[]): SettingDef[] => {
			return getAllSettingDefs(entries).filter(def => def.tab === "breadboard");
		},
	});

	const unregisterCustomEditor = registerSettingCustomEditor(
		"statusLine.preset",
		({ def, currentValue: _currentValue, done, context: rawContext, callbacks: rawCallbacks }) => {
			const context = rawContext as {
				settings: SettingsHost;
				requestRender?: () => void;
				composerPreviewStatus?: unknown;
			};
			const callbacks = rawCallbacks as {
				onChange: (path: string, value: unknown) => void;
				onStatusLinePreview?: (preview: Record<string, unknown>) => void;
			};

			const original = context.settings.get("statusLine.breadboard") as BreadboardFieldSettings;
			const originalPreset = context.settings.get("statusLine.preset") as StatusLinePreset;
			const preset = isBreadboardPreset(originalPreset) ? originalPreset : "bb-balanced";
			const preview = new ComposerShapePreview(String(context.settings.get("composer.shape")), {
				requestRender: context.requestRender,
				status: context.composerPreviewStatus,
			});
			const cancel = () => {
				callbacks.onStatusLinePreview?.({ preset: originalPreset, breadboard: original });
				done();
			};
			const customizer = new BreadboardCustomizeSubmenu(
				original,
				preset,
				fields => callbacks.onStatusLinePreview?.({ preset, breadboard: fields }),
				fields => {
					context.settings.set("statusLine.preset", preset);
					context.settings.set("statusLine.breadboard", fields);
					callbacks.onChange("statusLine.breadboard", fields);
					done();
				},
				cancel,
				preview,
				context.requestRender,
			);
			customizer.showPresets(
				originalPreset,
				value => {
					const selectedPreset = value as StatusLinePreset;
					context.settings.set("statusLine.preset", selectedPreset);
					callbacks.onChange("statusLine.preset", selectedPreset);
					done(selectedPreset);
				},
				value => callbacks.onStatusLinePreview?.({ preset: value as StatusLinePreset, breadboard: original }),
				cancel,
				(def as SubmenuSettingDef).options,
			);
			return customizer;
		},
	);

	return () => {
		unregisterCustomEditor();
		unregisterTab();
	};
}
