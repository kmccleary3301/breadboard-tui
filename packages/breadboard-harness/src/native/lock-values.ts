import { type CanonicalJson, isJsonRecord, type JsonRecord } from "../canonical-json";

/** The effective value a lock records at `path`, or undefined when the graph has none. */
export function nativeLockValue(lock: JsonRecord, path: string): CanonicalJson | undefined {
	const values = lock.effective_values;
	if (!Array.isArray(values)) return undefined;
	for (const row of values) {
		if (isJsonRecord(row) && row.path === path) return row.value;
	}
	return undefined;
}
