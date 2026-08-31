import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";

/** Resolve the persisted motion preference without forcing settings initialization. */
export function isReducedMotionEnabled(override?: boolean): boolean {
	if (override !== undefined) return override;
	return isSettingsInitialized() ? settings.get("display.reduceMotion") : getDefault("display.reduceMotion");
}
