let readPersistedPreference: (() => boolean) | undefined;

/** Bind the host application's persisted preference without importing its settings graph. */
export function configureReducedMotionReader(reader: (() => boolean) | undefined): void {
	readPersistedPreference = reader;
}

/** Resolve an explicit override, then the host preference, then the default. */
export function isReducedMotionEnabled(override?: boolean): boolean {
	return override ?? readPersistedPreference?.() ?? false;
}
