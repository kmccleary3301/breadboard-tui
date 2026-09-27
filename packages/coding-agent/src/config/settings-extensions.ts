/**
 * Registration points that let a distribution validate its own setting values and
 * migrate its own global profile keys without editing the shared Settings class.
 */

/** Validates, and optionally completes, the resolved value of one setting path. */
export interface SettingValueNormalizer {
	/** Throw when `value` is not acceptable for the path. */
	validate(value: unknown): void;
	/** Map a validated value to the value callers read; defaults to identity. */
	resolve?(value: unknown): unknown;
}

/** Rewrites the loaded global settings object in place before it is merged. */
export interface GlobalSettingsMigration {
	/** Return true when the global settings file should be rewritten. */
	apply(global: Record<string, unknown>): boolean;
	/** Runs after the rewritten file is on disk. */
	afterWrite?(): Promise<void>;
}

const normalizers = new Map<string, SettingValueNormalizer>();
const migrations: GlobalSettingsMigration[] = [];

export function registerSettingValueNormalizer(path: string, normalizer: SettingValueNormalizer): () => void {
	normalizers.set(path, normalizer);
	return () => {
		if (normalizers.get(path) === normalizer) normalizers.delete(path);
	};
}

export function getSettingValueNormalizer(path: string): SettingValueNormalizer | undefined {
	return normalizers.get(path);
}

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
