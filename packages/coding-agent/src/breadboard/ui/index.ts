import { registerComposerPreviewStatusFactory } from "@oh-my-pi/pi-tui/setup/scenes/composer";
import type { SetupSceneHost } from "@oh-my-pi/pi-tui/setup/wizard";
import { registerSetupScene } from "@oh-my-pi/pi-tui/setup/wizard";
import {
	createBreadboardPreviewStatusSource,
	informationLayoutSetupScene,
	previewSnapshot,
} from "./information-layout";
import { registerBreadboardSettingsTab } from "./settings-tab";
import { registerBreadboardStatusLine } from "./status-line";
import { isBreadboardPreset } from "./status-line/presets";
import { registerBreadboardSymbols } from "./symbols";
import { registerBreadboardThemes } from "./themes";

let unregister: (() => void) | undefined;

/** Register bb themes, symbol presets, status-line, settings tab and setup scene once; later calls return the same handle. */
export function registerBreadboardUi(): () => void {
	if (unregister) return unregister;
	const handles = [
		registerBreadboardThemes(),
		registerBreadboardSymbols(),
		registerBreadboardStatusLine(),
		registerBreadboardSettingsTab(),
		registerSetupScene(informationLayoutSetupScene, { after: "model", before: "glyph-mode" }),
		registerComposerPreviewStatusFactory((host: SetupSceneHost) => {
			const configuredPreset = host.ctx.settings.get<string | undefined>("statusLine.preset");
			if (isBreadboardPreset(configuredPreset) && configuredPreset) {
				return createBreadboardPreviewStatusSource(previewSnapshot(host), configuredPreset);
			}
			return undefined;
		}),
	];
	unregister = () => {
		for (const handle of handles.reverse()) handle();
		unregister = undefined;
	};
	return unregister;
}

export function unregisterBreadboardUi(): void {
	unregister?.();
}
