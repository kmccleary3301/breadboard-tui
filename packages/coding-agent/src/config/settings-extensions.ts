import type { SettingSchemaDef } from "./settings-schema";
import { applyRegisteredSettingSchemas } from "./settings-schema";
import { registerSettingsTab } from "@oh-my-pi/pi-tui/overlays/settings-defs";

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
const registeredSchemas = new Map<string, SettingSchemaDef>();
const registeredTabs = new Map<string, SettingTabDefinition>();


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

/** Definition of a settings UI tab contributed by a distribution or extension. */
export interface SettingTabDefinition {
	id: string;
	label: string;
	icon: `tab.${string}`;
	sections: readonly string[];
}

/**
 * Register additional setting schema definitions and optional UI tabs.
 * Updates the live SETTINGS_SCHEMA and tab catalog immediately. Returns an unregister callback.
 */
export function registerSettingSchemas(
	definitions: Record<string, SettingSchemaDef>,
	tabs?: readonly SettingTabDefinition[],
): () => void {
	const rollbackSchema = applyRegisteredSettingSchemas(definitions);
	for (const [path, def] of Object.entries(definitions)) {
		registeredSchemas.set(path, def);
	}

	const unregisterTabs: (() => void)[] = [];
	if (tabs) {
		for (const tab of tabs) {
			registeredTabs.set(tab.id, tab);
			unregisterTabs.push(
				registerSettingsTab({
					id: tab.id,
					label: tab.label,
					icon: tab.icon,
					sections: tab.sections,
				}),
			);
		}
	}

	return () => {
		for (const unregisterTab of unregisterTabs.reverse()) {
			unregisterTab();
		}
		if (tabs) {
			for (const tab of tabs) {
				if (registeredTabs.get(tab.id) === tab) {
					registeredTabs.delete(tab.id);
				}
			}
		}
		rollbackSchema();
		for (const path of Object.keys(definitions)) {
			if (registeredSchemas.get(path) === definitions[path]) {
				registeredSchemas.delete(path);
			}
		}
	};
}

/** Register a single setting schema definition. */
export function registerSettingSchema(path: string, def: SettingSchemaDef): () => void {
	return registerSettingSchemas({ [path]: def });
}

/** Returns currently registered distribution setting schemas. */
export function getRegisteredSettingSchemas(): ReadonlyMap<string, SettingSchemaDef> {
	return registeredSchemas;
}

/** Returns currently registered distribution setting tabs. */
export function getRegisteredSettingTabs(): readonly SettingTabDefinition[] {
	return Array.from(registeredTabs.values());
}
