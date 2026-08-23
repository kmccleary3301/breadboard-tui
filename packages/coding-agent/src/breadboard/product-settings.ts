import { type SettingDefaultOverrides, setDistributionSettingDefaults } from "../config/settings-schema";

export const BREADBOARD_SETTING_DEFAULTS = {
	"task.maxConcurrency": 4,
	"task.maxRecursionDepth": 1,
	"task.maxRuntimeMs": 30 * 60_000,
} satisfies SettingDefaultOverrides;

/** Install BreadBoard defaults before the shared CLI creates Settings. */
export function installBreadboardSettingDefaults(): void {
	setDistributionSettingDefaults(BREADBOARD_SETTING_DEFAULTS);
}
