import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalJson, graphContentHash, isJsonRecord, type JsonRecord, parseCanonicalJson } from "../canonical-json";
import type { LoadedNativeLock } from "./types";

const GRAPH_HASH = /^sha256:[0-9a-f]{64}$/u;
const LOCK_SCHEMA = "bb.effective_config_graph.v1";
const META_SCHEMA = "bb.harness_lock_metadata.v1";

function stringField(value: JsonRecord, key: string, label: string): string {
	const candidate = value[key];
	if (typeof candidate !== "string" || candidate.length === 0)
		throw new Error(`native harness ${label}.${key} is required`);
	return candidate;
}

/** `<dir>/.<lock name>.meta.json`, the sidecar the product tooling writes beside every lock. */
export function nativeLockMetadataPath(lockPath: string): string {
	return join(dirname(lockPath), `.${basename(lockPath)}.meta.json`);
}

/** `<spec>.lock.json` beside a `.yaml`/`.yml` spec. */
export function nativeLockPathForSpec(specPath: string): string {
	const match = /\.ya?ml$/u.exec(specPath);
	if (match === null) throw new Error(`native harness spec must be a .yaml or .yml file: ${specPath}`);
	return `${specPath.slice(0, match.index)}.lock.json`;
}

/**
 * Load an effective config lock and its sidecar, and verify both carry the graph's own content
 * hash. The lock bytes must be exactly the canonical encoding, so a hand-edited lock is refused.
 */
export async function loadNativeLock(lockPath: string): Promise<LoadedNativeLock> {
	const metaPath = nativeLockMetadataPath(lockPath);
	let lockText: string;
	let metaText: string;
	try {
		[lockText, metaText] = await Promise.all([readFile(lockPath, "utf8"), readFile(metaPath, "utf8")]);
	} catch (error) {
		throw new Error(`native harness lock and metadata sidecar are both required: ${lockPath}`, { cause: error });
	}
	const lock = parseCanonicalJson(lockText);
	const meta = parseCanonicalJson(metaText);
	if (!isJsonRecord(lock) || !isJsonRecord(meta))
		throw new Error(`native harness lock and sidecar must be JSON objects: ${lockPath}`);
	if (stringField(lock, "schema_version", "lock") !== LOCK_SCHEMA) {
		throw new Error(`native harness lock schema_version must be ${LOCK_SCHEMA}`);
	}
	if (stringField(meta, "schema_version", "metadata") !== META_SCHEMA) {
		throw new Error(`native harness metadata schema_version must be ${META_SCHEMA}`);
	}
	const lockHash = stringField(lock, "graph_hash", "lock");
	if (!GRAPH_HASH.test(lockHash))
		throw new Error("native harness graph_hash must be sha256:<64 lowercase hex digits>");
	if (stringField(meta, "graph_hash", "metadata") !== lockHash) {
		throw new Error("native harness lock and metadata graph_hash values differ");
	}
	const computed = graphContentHash(lock);
	if (computed !== lockHash) {
		throw new Error(`native harness lock graph_hash mismatch: recorded ${lockHash}, computed ${computed}`);
	}
	if (canonicalJson(lock) !== lockText) throw new Error(`native harness lock is not canonical JSON: ${lockPath}`);
	return Object.freeze({ lockPath, metaPath, lock, meta, graphHash: computed });
}
