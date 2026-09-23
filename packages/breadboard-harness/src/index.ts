import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EngineDataSnapshotFile {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly content: string;
}

export interface EngineDataSnapshot {
	readonly schemaVersion: "bb.harness_engine_data_snapshot.v1";
	readonly engineCommit: string;
	readonly engineTree: string;
	readonly files: readonly EngineDataSnapshotFile[];
}

const SNAPSHOT_SCHEMA_VERSION = "bb.harness_engine_data_snapshot.v1" as const;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_DATA_DIR = fileURLToPath(new URL("../engine-data/", import.meta.url));
const snapshotCache = new Map<string, EngineDataSnapshot>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(content: string): string {
	return new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(content)).digest("hex");
}

function validateSnapshot(value: unknown): EngineDataSnapshot {
	if (!isRecord(value)) throw new Error("engine data snapshot must be an object");
	if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new Error(`unsupported engine data snapshot schema: ${String(value.schemaVersion)}`);
	}
	assertString(value.engineCommit, "engineCommit");
	if (!SHA1.test(value.engineCommit)) throw new Error("engineCommit must be a 40-character lowercase SHA-1");
	assertString(value.engineTree, "engineTree");
	if (!SHA1.test(value.engineTree)) throw new Error("engineTree must be a 40-character lowercase SHA-1");
	if (!Array.isArray(value.files)) throw new Error("files must be an array");

	const files: EngineDataSnapshotFile[] = [];
	let previousPath = "";
	const paths = new Set<string>();
	for (const [index, rawFile] of value.files.entries()) {
		if (!isRecord(rawFile)) throw new Error(`files[${index}] must be an object`);
		assertString(rawFile.path, `files[${index}].path`);
		if (rawFile.path.startsWith("/") || rawFile.path.split("/").includes("..")) {
			throw new Error(`files[${index}].path must be relative: ${rawFile.path}`);
		}
		if (rawFile.path.endsWith("/")) throw new Error(`files[${index}].path must name a file`);
		if (paths.has(rawFile.path)) throw new Error(`files contains duplicate path: ${rawFile.path}`);
		if (compare(previousPath, rawFile.path) >= 0) throw new Error("files must be sorted by path");
		previousPath = rawFile.path;
		paths.add(rawFile.path);
		assertString(rawFile.sha256, `files[${index}].sha256`);
		if (!SHA256.test(rawFile.sha256)) throw new Error(`files[${index}].sha256 must be lowercase SHA-256`);
		if (!Number.isSafeInteger(rawFile.bytes) || (rawFile.bytes as number) < 0) {
			throw new Error(`files[${index}].bytes must be a non-negative safe integer`);
		}
		if (typeof rawFile.content !== "string") throw new Error(`files[${index}].content must be a string`);
		const actualBytes = new TextEncoder().encode(rawFile.content);
		if (actualBytes.byteLength !== rawFile.bytes) throw new Error(`files[${index}] bytes do not match content`);
		if (sha256(rawFile.content) !== rawFile.sha256) throw new Error(`files[${index}] sha256 does not match content`);
		files.push(
			Object.freeze({
				path: rawFile.path,
				sha256: rawFile.sha256,
				bytes: rawFile.bytes as number,
				content: rawFile.content,
			}),
		);
	}
	// Frozen: the cached snapshot is shared by every caller, so a consumer must not alter verified content.
	return Object.freeze({
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		engineCommit: value.engineCommit,
		engineTree: value.engineTree,
		files: Object.freeze(files),
	});
}

function snapshotPath(dataDir: string | URL): string {
	const root = typeof dataDir === "string" ? dataDir : fileURLToPath(dataDir);
	return join(root, "snapshot.json");
}

/** Read, validate, hash-check, and cache the generated engine-data bundle. */
export async function loadEngineDataSnapshot(dataDir: string | URL = DEFAULT_DATA_DIR): Promise<EngineDataSnapshot> {
	const path = snapshotPath(dataDir);
	const cached = snapshotCache.get(path);
	if (cached !== undefined) return cached;
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`unable to read engine data snapshot at ${path}`, { cause: error });
	}
	const snapshot = validateSnapshot(raw);
	snapshotCache.set(path, snapshot);
	return snapshot;
}

/** Return one bundled engine-data file, rejecting paths absent from the validated snapshot. */
export async function readEngineDataFile(path: string): Promise<string> {
	const snapshot = await loadEngineDataSnapshot();
	const file = snapshot.files.find(entry => entry.path === path);
	if (file === undefined) throw new Error(`unknown engine data file: ${path}`);
	return file.content;
}

export * from "./canonical-json";
