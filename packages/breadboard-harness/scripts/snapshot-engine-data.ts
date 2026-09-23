#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const MANIFEST_NAME = "snapshot.manifest.json";
const MANIFEST_SCHEMA_VERSION = "bb.harness_engine_data_snapshot.v1" as const;
const DEFAULT_DATA_DIR = resolve(import.meta.dir, "..", "engine-data");
const TRACKED_PREFIXES = [
	"implementations/tools/defs",
	"implementations/system_prompts",
	"agent_configs",
	"config/e4_targets",
] as const;
const CONTRACT_SCHEMA_PATHS = [
	"contracts/kernel/schemas/bb.effective_config_graph.v1.schema.json",
	"contracts/kernel/schemas/bb.session_transcript.v2.schema.json",
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
};

type SnapshotManifest = {
	readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
	readonly engineCommit: string;
	readonly engineTree: string;
	readonly files: readonly SnapshotFile[];
};

type Snapshot = {
	readonly manifest: SnapshotManifest;
	readonly files: ReadonlyMap<string, Uint8Array>;
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

function trackedPaths(engine: string): string[] {
	const output = runGitText(engine, ["ls-files", "--cached", "-z", "--", ...TRACKED_PREFIXES, ...REQUIRED_PATHS]);
	return output.split("\0").filter(Boolean).sort();
}
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
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

function readGitFile(engine: string, commit: string, sourcePath: string): Uint8Array {
	return runGit(engine, ["show", `${commit}:${sourcePath}`]);
}

function createSnapshot(engine: string): Snapshot {
	const commit = runGitText(engine, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	const tree = runGitText(engine, ["rev-parse", "--verify", "HEAD^{tree}"]).trim();
	if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) {
		throw new Error(`engine identity is not a full SHA-1: commit=${commit} tree=${tree}`);
	}

	const files = new Map<string, Uint8Array>();
	for (const sourcePath of selectedPaths(engine)) {
		const bytes = readGitFile(engine, commit, sourcePath);
		files.set(sourcePath, bytes);
	}
	const manifestFiles = [...files.entries()]
		.map(([filePath, bytes]) => ({ path: filePath, sha256: sha256(bytes), bytes: bytes.byteLength }))
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return {
		manifest: {
			schemaVersion: MANIFEST_SCHEMA_VERSION,
			engineCommit: commit,
			engineTree: tree,
			files: manifestFiles,
		},
		files,
	};
}

function manifestText(manifest: SnapshotManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

function targetPath(dataDir: string, snapshotPath: string): string {
	return join(dataDir, ...snapshotPath.split("/"));
}

function writeSnapshot(dataDir: string, snapshot: Snapshot): void {
	rmSync(dataDir, { recursive: true, force: true });
	for (const [snapshotPath, bytes] of snapshot.files) {
		const path = targetPath(dataDir, snapshotPath);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, bytes);
	}
	writeFileSync(join(dataDir, MANIFEST_NAME), manifestText(snapshot.manifest));
}

function collectDataFiles(dataDir: string): string[] {
	const paths: string[] = [];
	if (!lstatSync(dataDir, { throwIfNoEntry: false })) return paths;
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolutePath = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(absolutePath);
				continue;
			}
			if (!entry.isFile()) throw new Error(`engine-data contains unsupported entry: ${absolutePath}`);
			const relativePath = relative(dataDir, absolutePath).split(sep).join("/");
			if (relativePath !== MANIFEST_NAME) paths.push(relativePath);
		}
	};
	visit(dataDir);
	return paths.sort();
}

function readManifest(dataDir: string): { text?: string; error?: string } {
	const path = join(dataDir, MANIFEST_NAME);
	try {
		return { text: readFileSync(path, "utf8") };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function checkSnapshot(dataDir: string, expected: Snapshot): string[] {
	const expectedPaths = new Set(expected.files.keys());
	const actualPaths = new Set(collectDataFiles(dataDir));
	const differences = new Set<string>();
	for (const path of expectedPaths) {
		if (!actualPaths.has(path)) {
			differences.add(`removed ${path}`);
			continue;
		}
		const bytes = readFileSync(targetPath(dataDir, path));
		const manifestFile = expected.manifest.files.find(file => file.path === path);
		if (manifestFile === undefined || bytes.byteLength !== manifestFile.bytes || sha256(bytes) !== manifestFile.sha256) {
			differences.add(`modified ${path}`);
		}
	}
	for (const path of actualPaths) if (!expectedPaths.has(path)) differences.add(`added ${path}`);

	const actualManifest = readManifest(dataDir);
	if (actualManifest.text !== manifestText(expected.manifest)) differences.add(`modified ${MANIFEST_NAME}`);
	return [...differences].sort();
}

function usage(): never {
	throw new Error(
		"usage: bun snapshot-engine-data.ts --engine <checkout> [--check] [--data-dir <directory>]",
	);
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
			dataDir = resolve(arg.slice("--data-dir=".length));
			if (dataDir.length === 0) usage();
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
				console.log(`engine-data is up to date (${snapshot.manifest.files.length} files)`);
			}
		} else {
			writeSnapshot(options.dataDir, snapshot);
			console.log(
				`wrote ${snapshot.manifest.files.length} files (${snapshot.manifest.engineCommit}, ${snapshot.manifest.engineTree})`,
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

export { checkSnapshot, createSnapshot, manifestText, parseArgs, writeSnapshot };
