import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export interface EngineDataManifestFile {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface EngineDataManifest {
	readonly schemaVersion: "bb.harness_engine_data_snapshot.v1";
	readonly engineCommit: string;
	readonly engineTree: string;
	readonly files: readonly EngineDataManifestFile[];
}

const MANIFEST_SCHEMA_VERSION = "bb.harness_engine_data_snapshot.v1" as const;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_ENGINE_DATA_DIR = fileURLToPath(new URL("../engine-data/", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function validateManifest(value: unknown): EngineDataManifest {
	if (!isRecord(value)) throw new Error("engine data manifest must be an object");
	if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
		throw new Error(`unsupported engine data manifest schema: ${String(value.schemaVersion)}`);
	}
	assertString(value.engineCommit, "engineCommit");
	if (!SHA1.test(value.engineCommit)) throw new Error("engineCommit must be a 40-character lowercase SHA-1");
	assertString(value.engineTree, "engineTree");
	if (!SHA1.test(value.engineTree)) throw new Error("engineTree must be a 40-character lowercase SHA-1");
	if (!Array.isArray(value.files)) throw new Error("files must be an array");

	const files: EngineDataManifestFile[] = [];
	let previousPath = "";
	const paths = new Set<string>();
	for (const [index, rawFile] of value.files.entries()) {
		if (!isRecord(rawFile)) throw new Error(`files[${index}] must be an object`);
		assertString(rawFile.path, `files[${index}].path`);
		if (rawFile.path.startsWith("/") || rawFile.path.split("/").includes("..")) {
			throw new Error(`files[${index}].path must be relative and stay within engine-data: ${rawFile.path}`);
		}
		if (rawFile.path.length === 0 || rawFile.path.endsWith("/")) {
			throw new Error(`files[${index}].path must name a file`);
		}
		if (paths.has(rawFile.path)) throw new Error(`files contains duplicate path: ${rawFile.path}`);
		if (compare(previousPath, rawFile.path) >= 0) throw new Error("files must be sorted by path");
		previousPath = rawFile.path;
		paths.add(rawFile.path);

		assertString(rawFile.sha256, `files[${index}].sha256`);
		if (!SHA256.test(rawFile.sha256)) throw new Error(`files[${index}].sha256 must be lowercase SHA-256`);
		if (!Number.isSafeInteger(rawFile.bytes) || (rawFile.bytes as number) < 0) {
			throw new Error(`files[${index}].bytes must be a non-negative safe integer`);
		}
		files.push({ path: rawFile.path, sha256: rawFile.sha256, bytes: rawFile.bytes as number });
	}

	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		engineCommit: value.engineCommit,
		engineTree: value.engineTree,
		files,
	};
}

/** Read and structurally validate the generated engine-data snapshot manifest. */
export async function loadEngineDataManifest(
	dataDir: string | URL = DEFAULT_ENGINE_DATA_DIR,
): Promise<EngineDataManifest> {
	const root = typeof dataDir === "string" ? dataDir : fileURLToPath(dataDir);
	const manifestPath = join(root, "snapshot.manifest.json");
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`unable to read engine data manifest at ${manifestPath}`, { cause: error });
	}
	return validateManifest(raw);
}
