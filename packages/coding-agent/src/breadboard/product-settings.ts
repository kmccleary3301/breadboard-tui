import type { SettingDefaultOverrides } from "../config/settings-schema";

export const BREADBOARD_SETTING_DEFAULTS = {
	"task.maxConcurrency": 4,
	"task.maxRecursionDepth": 1,
	"task.maxRuntimeMs": 30 * 60_000,
} satisfies SettingDefaultOverrides;

/** Establish BreadBoard identity and defaults before loading the shared CLI. */
export async function activateBreadboardProduct(): Promise<void> {
	process.env.BREADBOARD_PRODUCT = "1";
	const { setDistributionSettingDefaults } = await import("../config/settings-schema");
	setDistributionSettingDefaults(BREADBOARD_SETTING_DEFAULTS);
}
