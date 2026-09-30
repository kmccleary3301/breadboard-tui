import type { SettingDefaultOverrides } from "../config/settings-schema";

export const BREADBOARD_SETTING_DEFAULTS = {
	"statusLine.preset": "bb-balanced",
	"statusLine.separator": "pipe",
	"statusLine.contextLine": "off",
	"statusLine.sessionAccent": false,
	"composer.shape": "box",
	"task.maxConcurrency": 4,
	"task.maxRecursionDepth": 1,
	"task.maxRuntimeMs": 30 * 60_000,
} satisfies SettingDefaultOverrides;

/** Establish BreadBoard identity and defaults before loading the shared CLI. */
export async function activateBreadboardProduct(): Promise<void> {
	process.env.BREADBOARD_PRODUCT = "1";
	const { setDistributionSettingDefaults } = await import("../config/settings-schema");
	setDistributionSettingDefaults(BREADBOARD_SETTING_DEFAULTS);
	const { registerBreadboardSettingsSchema } = await import("./settings-schema-extension");
	registerBreadboardSettingsSchema();
	(await import("../slash-commands/harness")).registerHarnessCommands();
	// The launcher requests the one-shot R39-to-native profile rewrite explicitly.
	if (process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION === "1") {
		const { registerNativeProfileMigration } = await import("./native-profile-migration");
		registerNativeProfileMigration();
	}
}
