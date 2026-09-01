/** Dependency-free default shared with the persisted settings schema. */
export const DEFAULT_REDUCED_MOTION = false;

let readPersistedPreference: (() => boolean) | undefined;

/** Bind the late-loaded settings singleton without pulling it into the prepaint graph. */
export function configureReducedMotionReader(reader: (() => boolean) | undefined): void {
	readPersistedPreference = reader;
}

/** Resolve an explicit override, then the live preference, then the dependency-free default. */
export function isReducedMotionEnabled(override?: boolean): boolean {
	return override ?? readPersistedPreference?.() ?? DEFAULT_REDUCED_MOTION;
}
