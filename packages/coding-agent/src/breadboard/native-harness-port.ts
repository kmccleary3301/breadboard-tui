import { isJsonRecord, type LoadedNativeHarness, nativeLockValue } from "@breadboard/harness";
import type { HarnessPort, HarnessProvenance, HarnessSnapshot } from "./harness-port";

/** `harness.explain`-shaped provenance from the lock itself: each effective value's source layer file. */
function lockProvenance(lock: LoadedNativeHarness["lock"]): Readonly<Record<string, HarnessProvenance>> {
	const layerSources = new Map<string, string>();
	const layers = lock.source_layers;
	for (const layer of Array.isArray(layers) ? layers : []) {
		if (!isJsonRecord(layer) || typeof layer.layer_id !== "string") continue;
		if (typeof layer.source_ref === "string" && layer.source_ref.length > 0)
			layerSources.set(layer.layer_id, layer.source_ref);
	}
	const provenance: Record<string, HarnessProvenance> = {};
	const values = lock.effective_values;
	for (const row of Array.isArray(values) ? values : []) {
		if (!isJsonRecord(row) || typeof row.path !== "string" || typeof row.source_layer_id !== "string") continue;
		provenance[row.path] = { source: layerSources.get(row.source_layer_id) ?? row.source_layer_id, line: null };
	}
	return provenance;
}

function harnessName(harness: LoadedNativeHarness): string {
	const profileName = nativeLockValue(harness.lock, "profile.name");
	if (typeof profileName === "string" && profileName.trim()) return profileName;
	const last = harness.harnessId.split("/").at(-1) ?? harness.harnessId;
	return last.replace(/\.(?:yaml|yml)$/u, "");
}

/**
 * The harness hub, palette and status in native mode: the session runs the lock it loaded, so the
 * snapshot is that lock, verified by its own `graph_hash`. No engine, no generation.
 */
export function createNativeHarnessPort(harness: LoadedNativeHarness, now: () => number = Date.now): HarnessPort {
	const harnessId = harness.harnessId;
	const snapshot: HarnessSnapshot = Object.freeze({
		harnessId,
		name: harnessName(harness),
		lockHash: harness.graphHash,
		verifiedIdentity: { harnessId, lockHash: harness.graphHash },
		generation: null,
		mode: harness.toolSurface.mode,
		lock: harness.lock,
		provenance: lockProvenance(harness.lock),
		loadedAt: now(),
	});
	return {
		current: () => snapshot,
		refresh: async () => snapshot,
		subscribe: () => () => {},
	};
}
