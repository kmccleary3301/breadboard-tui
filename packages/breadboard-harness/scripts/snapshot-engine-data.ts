#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const SNAPSHOT_NAME = "snapshot.json";
const SNAPSHOT_SCHEMA_VERSION = "bb.harness_engine_data_snapshot.v1" as const;
const DEFAULT_DATA_DIR = resolve(import.meta.dir, "..", "engine-data");
const TRACKED_PREFIXES = [
	"implementations/tools/defs",
	"implementations/system_prompts",
	"implementations/prompts/todos",
	"agent_configs",
	"config/e4_targets",
] as const;
const CONTRACT_SCHEMA_PATHS = [
	"contracts/kernel/schemas/bb.agent_config_surface.v2.schema.json",
	"contracts/kernel/schemas/bb.effective_config_graph.v1.schema.json",
	"contracts/kernel/schemas/bb.kernel.common.v1.schema.json",
	"contracts/kernel/schemas/bb.session_transcript.v2.schema.json",
	"contracts/kernel/schemas/payloads/bb.payload.message.assistant.v1.schema.json",
	"contracts/kernel/schemas/payloads/bb.payload.tool.called.v1.schema.json",
	"contracts/kernel/schemas/payloads/bb.payload.tool.completed.v1.schema.json",
	"contracts/public/schemas/bb.harness_definition.v1.schema.json",
	"contracts/public/schemas/bb.payload.product_session.annotation.v1.schema.json",
	"contracts/public/schemas/bb.payload.product_session.lifecycle.v1.schema.json",
	"contracts/public/schemas/bb.public_session_event.v1.schema.json",
] as const;
const CONTRACT_ID_BASE = "https://breadboard.dev/";
const OPENAPI_SOURCE_PATH = "sdk/ts/src/generated/openapi.v1.json";
const DERIVED_REQUEST_SCHEMAS = [
	{
		component: "SessionStartRequest",
		path: "contracts/public/schemas/bb.session_start_request.v1.schema.json",
	},
	{
		component: "SessionCancelRequest",
		path: "contracts/public/schemas/bb.session_cancel_request.v1.schema.json",
	},
] as const;
const GENERATED_TYPE_PATHS = [
	"sdk/ts-kernel-contracts/src/generated/types/bb.effective_config_graph.v1.ts",
	"sdk/ts-kernel-contracts/src/generated/types/bb.session_transcript.v2.ts",
] as const;
const REQUIRED_PATHS = [...CONTRACT_SCHEMA_PATHS, ...GENERATED_TYPE_PATHS] as const;

type SnapshotFile = {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly content: string;
};

type Snapshot = {
	readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	readonly engineCommit: string;
	readonly engineTree: string;
	readonly files: readonly SnapshotFile[];
};

type CliOptions = {
	readonly engine: string;
	readonly check: boolean;
	readonly dataDir: string;
};

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function runGit(engine: string, args: readonly string[]): Uint8Array {
	const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", engine, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const detail = decode(result.stderr).trim() || `exit code ${result.exitCode}`;
		throw new Error(`git ${args.join(" ")} failed in ${engine}: ${detail}`);
	}
	return result.stdout;
}

function runGitText(engine: string, args: readonly string[]): string {
	return decode(runGit(engine, args));
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}

function trackedPaths(engine: string): string[] {
	const output = runGitText(engine, ["ls-files", "--cached", "-z", "--", ...TRACKED_PREFIXES, ...REQUIRED_PATHS]);
	return output.split("\0").filter(Boolean).sort();
}

function hasPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

function selectedPaths(engine: string): string[] {
	const tracked = new Set(trackedPaths(engine));
	const selected = [...tracked].filter(path => TRACKED_PREFIXES.some(prefix => hasPrefix(path, prefix)));
	for (const path of REQUIRED_PATHS) {
		if (!tracked.has(path)) throw new Error(`required tracked engine path is missing: ${path}`);
		selected.push(path);
	}
	return [...new Set(selected)].sort();
}

function readGitUtf8(engine: string, commit: string, sourcePath: string): { bytes: Uint8Array; content: string } {
	const bytes = runGit(engine, ["show", `${commit}:${sourcePath}`]);
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error(`selected engine path is not valid UTF-8: ${sourcePath}`, { cause: error });
	}
	const roundTrip = new TextEncoder().encode(content);
	if (!bytesEqual(bytes, roundTrip)) throw new Error(`UTF-8 round-trip changed selected engine path: ${sourcePath}`);
	return { bytes, content };
}

/** Resolve a schema `$ref` to a repository path; `undefined` for same-document refs. */
function refTarget(schemaPath: string, ref: string): string | undefined {
	const documentRef = ref.split("#", 1)[0]!;
	if (documentRef === "") return undefined;
	if (documentRef.startsWith(CONTRACT_ID_BASE)) return documentRef.slice(CONTRACT_ID_BASE.length);
	if (/^[a-z][a-z0-9+.-]*:/i.test(documentRef)) throw new Error(`${schemaPath}: unsupported external $ref ${ref}`);
	return posix.normalize(posix.join(posix.dirname(schemaPath), documentRef));
}

function collectRefs(value: unknown, refs: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectRefs(item, refs);
	} else if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			if (key === "$ref" && typeof item === "string") refs.add(item);
			else collectRefs(item, refs);
		}
	}
}

/** Every bundled schema must resolve its `$ref`s inside the bundle, so offline validation needs no engine checkout. */
function assertSchemaRefClosure(files: readonly SnapshotFile[]): void {
	const bundled = new Set(files.map(file => file.path));
	for (const file of files) {
		if (!file.path.endsWith(".schema.json")) continue;

		const refs = new Set<string>();
		collectRefs(JSON.parse(file.content) as unknown, refs);
		for (const ref of refs) {
			const target = refTarget(file.path, ref);
			if (target !== undefined && !bundled.has(target)) {
				throw new Error(`${file.path}: $ref ${ref} resolves to unbundled ${target}`);
			}
		}
	}
}
/** Derive the two public request schemas from the pyref's generated OpenAPI contract. */
function derivedRequestSchemas(engine: string, commit: string): SnapshotFile[] {
	const { content } = readGitUtf8(engine, commit, OPENAPI_SOURCE_PATH);
	const openapi = JSON.parse(content) as {
		components?: { schemas?: Record<string, Record<string, unknown>> };
	};
	return DERIVED_REQUEST_SCHEMAS.map(({ component, path }) => {
		const definition = openapi.components?.schemas?.[component];
		if (definition === undefined) throw new Error(`OpenAPI component is missing: ${component}`);
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: `${CONTRACT_ID_BASE}${path}`,
			...definition,
		};
		const derived = `${JSON.stringify(schema, null, 2)}\n`;
		const bytes = new TextEncoder().encode(derived);
		return { path, sha256: sha256(bytes), bytes: bytes.byteLength, content: derived };
	});
}

function createSnapshot(engine: string): Snapshot {
	const commit = runGitText(engine, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	const tree = runGitText(engine, ["rev-parse", "--verify", "HEAD^{tree}"]).trim();
	if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) {
		throw new Error(`engine identity is not a full SHA-1: commit=${commit} tree=${tree}`);
	}

	const files: SnapshotFile[] = [];
	for (const sourcePath of selectedPaths(engine)) {
		const { bytes, content } = readGitUtf8(engine, commit, sourcePath);
		files.push({ path: sourcePath, sha256: sha256(bytes), bytes: bytes.byteLength, content });
	}
	files.push(...derivedRequestSchemas(engine, commit));
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	assertSchemaRefClosure(files);
	return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, engineCommit: commit, engineTree: tree, files };
}

function snapshotText(snapshot: Snapshot): string {
	return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function snapshotPath(dataDir: string): string {
	return join(dataDir, SNAPSHOT_NAME);
}

function writeSnapshot(dataDir: string, snapshot: Snapshot): void {
	rmSync(dataDir, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(snapshotPath(dataDir), snapshotText(snapshot), "utf8");
}

function checkSnapshot(dataDir: string, expected: Snapshot): string[] {
	const path = snapshotPath(dataDir);
	let actual: Uint8Array;
	try {
		actual = readFileSync(path);
	} catch {
		return [`removed ${SNAPSHOT_NAME}`];
	}
	const expectedBytes = new TextEncoder().encode(snapshotText(expected));
	return bytesEqual(actual, expectedBytes) ? [] : [`modified ${SNAPSHOT_NAME}`];
}

function usage(): never {
	throw new Error("usage: bun snapshot-engine-data.ts --engine <checkout> [--check] [--data-dir <directory>]");
}

function parseArgs(args: readonly string[]): CliOptions {
	let engine: string | undefined;
	let check = false;
	let dataDir = DEFAULT_DATA_DIR;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--check") {
			check = true;
			continue;
		}
		if (arg === "--engine" || arg === "--data-dir") {
			const value = args[++index];
			if (value === undefined || value.startsWith("--")) usage();
			if (arg === "--engine") engine = value;
			else dataDir = resolve(value);
			continue;
		}
		if (arg.startsWith("--engine=")) {
			engine = arg.slice("--engine=".length);
			if (engine.length === 0) usage();
			continue;
		}
		if (arg.startsWith("--data-dir=")) {
			const value = arg.slice("--data-dir=".length);
			if (value.length === 0) usage();
			dataDir = resolve(value);
			continue;
		}
		usage();
	}
	if (engine === undefined || engine.length === 0) usage();
	return { engine: resolve(engine), check, dataDir };
}

if (import.meta.main) {
	try {
		const options = parseArgs(Bun.argv.slice(2));
		const snapshot = createSnapshot(options.engine);
		if (options.check) {
			const differences = checkSnapshot(options.dataDir, snapshot);
			if (differences.length > 0) {
				console.error(`engine-data drift detected in ${options.dataDir}:`);
				for (const difference of differences) console.error(`- ${difference}`);
				process.exitCode = 1;
			} else {
				console.log(`engine-data is up to date (${snapshot.files.length} files)`);
			}
		} else {
			writeSnapshot(options.dataDir, snapshot);
			console.log(`wrote ${snapshot.files.length} files (${snapshot.engineCommit}, ${snapshot.engineTree})`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

export { checkSnapshot, createSnapshot, parseArgs, snapshotText, writeSnapshot };
