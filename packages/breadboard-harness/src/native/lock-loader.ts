import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { graphContentHash, parseCanonicalJson, type CanonicalJson } from "../canonical-json";
import type { LoadedNativeLock } from "./types";

const GRAPH_HASH = /^sha256:[0-9a-f]{64}$/u;
const LOCK_SCHEMA = "bb.effective_config_graph.v1";
const META_SCHEMA = "bb.harness_lock_metadata.v1";

type JsonRecord = Readonly<Record<string, CanonicalJson>>;

function record(value: CanonicalJson, label: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Object === false) {
		throw new Error(`native harness ${label} must be a JSON object`);
	}
	return value as JsonRecord;
}

function stringField(value: JsonRecord, key: string, label: string): string {
	const candidate = value[key];
	if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`native harness ${label}.${key} is required`);
	return candidate;
}

function metadataPath(lockPath: string): string {
	const name = basename(lockPath);
	return join(dirname(lockPath), `.${name}.meta.json`);
}

/** Load and cryptographically verify an effective config lock and its required sidecar. */
export async function loadNativeLock(lockPath: string): Promise<LoadedNativeLock> {
	const metaPath = metadataPath(lockPath);
	let lockText: string;
	let metaText: string;
	try {
		[lockText, metaText] = await Promise.all([readFile(lockPath, "utf8"), readFile(metaPath, "utf8")]);
	} catch (error) {
		throw new Error(`native harness lock and metadata sidecar are both required: ${lockPath}`, { cause: error });
	}
	let lock: JsonRecord;
	let meta: JsonRecord;
	try {
		lock = record(parseCanonicalJson(lockText), "lock");
		meta = record(parseCanonicalJson(metaText), "metadata");
	} catch (error) {
		throw new Error(`native harness lock is not valid canonical JSON: ${lockPath}`, { cause: error });
	}
	if (stringField(lock, "schema_version", "lock") !== LOCK_SCHEMA) {
		throw new Error(`native harness lock schema_version must be ${LOCK_SCHEMA}`);
	}
	if (stringField(meta, "schema_version", "metadata") !== META_SCHEMA) {
		throw new Error(`native harness metadata schema_version must be ${META_SCHEMA}`);
	}
	const lockHash = stringField(lock, "graph_hash", "lock");
	const metaHash = stringField(meta, "graph_hash", "metadata");
	if (!GRAPH_HASH.test(lockHash) || !GRAPH_HASH.test(metaHash)) {
		throw new Error("native harness graph_hash must be sha256:<64 lowercase hex digits>");
	}
	if (lockHash !== metaHash) throw new Error("native harness lock and metadata graph_hash values differ");
	const computed = graphContentHash(lock);
	if (computed !== lockHash) {
		throw new Error(`native harness lock graph_hash mismatch: expected ${lockHash}, computed ${computed}`);
	}
	return Object.freeze({ lockPath, metaPath, lock, meta, graphHash: computed });
}
