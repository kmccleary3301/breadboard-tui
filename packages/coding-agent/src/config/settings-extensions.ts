/**
 * Registration point that lets a distribution migrate its own global profile keys without
 * editing the shared Settings class. Settings, defaults and panel metadata go through
 * `register` and `overrideDefinitions` in `./registry`.
 */

/** Rewrites the loaded global settings object in place before it is merged. */
export interface GlobalSettingsMigration {
	/** Return true when the global settings file should be rewritten. */
	apply(global: Record<string, unknown>): boolean;
	/** Runs after the rewritten file is on disk. */
	afterWrite?(): Promise<void>;
}

const migrations: GlobalSettingsMigration[] = [];

export function registerGlobalSettingsMigration(migration: GlobalSettingsMigration): () => void {
	migrations.push(migration);
	return () => {
		const index = migrations.indexOf(migration);
		if (index >= 0) migrations.splice(index, 1);
	};
}

export function getGlobalSettingsMigrations(): readonly GlobalSettingsMigration[] {
	return migrations;
}
