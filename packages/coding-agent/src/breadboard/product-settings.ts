export const BREADBOARD_SETTING_DEFAULTS = {
	"statusLine.preset": "bb-balanced",
	"statusLine.separator": "pipe",
	"statusLine.contextLine": "off",
	"statusLine.sessionAccent": false,
	"composer.shape": "box",
	"task.maxConcurrency": 4,
	"task.maxRecursionDepth": 1,
	"task.maxRuntimeMs": 30 * 60_000,
} as const;

/** Establish BreadBoard identity and defaults before loading the shared CLI. */
export async function activateBreadboardProduct(): Promise<void> {
	process.env.BREADBOARD_PRODUCT = "1";
	// Every shared setting registers before its defaults are replaced.
	await import("../config/all-settings");
	const { overrideDefinitions } = await import("../config/registry");
	overrideDefinitions(
		Object.fromEntries(Object.entries(BREADBOARD_SETTING_DEFAULTS).map(([id, value]) => [id, { default: value }])),
	);
	(await import("./settings")).registerBreadboardSettings();
	(await import("../slash-commands/harness")).registerHarnessCommands();
	// The launcher requests the one-shot R39-to-native profile rewrite explicitly.
	if (process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION === "1") {
		const { registerNativeProfileMigration } = await import("./native-profile-migration");
		registerNativeProfileMigration();
	}
}
