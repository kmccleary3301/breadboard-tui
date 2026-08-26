#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { TOML } from "bun";
import { installEngineDistributionAtomically } from "../src/breadboard/lifecycle/engine-distribution-installer";
import {
	createEngineRuntimeBundle,
	ENGINE_RUNTIME_BUNDLE_SCHEMA,
	sha256File,
} from "../src/breadboard/lifecycle/engine-runtime-bundle";
import {
	canonicalEngineDistributionManifest,
	createEngineDistributionManifest,
	ENGINE_DISTRIBUTION_PATH_STRATEGY,
	ENGINE_DISTRIBUTION_TRUST_SCHEMA,
	type EngineDistributionSha256,
	type EngineDistributionTrustRoot,
} from "../src/breadboard/lifecycle/installed-engine-manifest";

const PYTHON_VERSION = "3.11.15";
const BUN_VERSION = "1.3.14";
const UV_VERSION = "0.11.21";
const PYINSTALLER_VERSION = "6.22.2";
const ENGINE_INTERFACE_VERSION = "0.3.0";
const ENGINE_INTERFACE_RANGE = ">=0.1.0 <0.4.0";
const ENGINE_BUNDLE_FILENAME = "breadboard-engine-runtime.v1.bundle";
const ENGINE_SELF_TEST_ARGUMENT = "--self-test-import-agent";
const ENGINE_SELF_TEST_OUTPUT = "breadboard-engine-import-ok";
const ENGINE_RAY_SELF_TEST_ARGUMENT = "--self-test-ray-runtime";
const ENGINE_RAY_SELF_TEST_OUTPUT = "breadboard-engine-ray-runtime-ok";
const ENGINE_ENTRY_SOURCE = `from multiprocessing import freeze_support
from pathlib import Path
import os
import runpy
import shutil
import tempfile
import sys


def _run_frozen_ray_child() -> bool:
    arguments = sys.argv[1:]
    while arguments[:1] and arguments[0] in {"-B", "-E", "-I", "-S", "-s", "-u"}:
        arguments = arguments[1:]
    if arguments[:1] == ["-m"] and len(arguments) >= 2:
        module_name = arguments[1]
        if module_name != "ray" and not module_name.startswith("ray."):
            return False
        sys.argv = [module_name, *arguments[2:]]
        runpy.run_module(module_name, run_name="__main__")
        return True
    if not arguments:
        return False
    extraction_root = getattr(sys, "_MEIPASS", None)
    script_path = Path(arguments[0])
    if extraction_root is None or not script_path.is_absolute():
        return False
    try:
        relative_script = script_path.resolve().relative_to((Path(extraction_root) / "ray").resolve())
    except (OSError, ValueError):
        return False
    if relative_script.suffix != ".py":
        return False
    module_parts = ["ray", *relative_script.with_suffix("").parts]
    if module_parts[-1] == "__init__":
        module_parts.pop()
    sys.argv = [str(script_path), *arguments[1:]]
    runpy.run_module(".".join(module_parts), run_name="__main__")
    return True


def _configure_ray_runtime() -> tuple[Path, bool]:
    configured_root = os.environ.get("RAY_TMPDIR")
    owns_root = not configured_root
    ray_runtime_root = (
        Path(configured_root)
        if configured_root
        else Path(tempfile.mkdtemp(prefix="bb-ray-", dir="/tmp"))
    )
    defaults = {
        "RAY_BACKEND_LOG_LEVEL": "error",
        "RAY_LOG_TO_DRIVER": "0",
        "RAY_LOGGER_LEVEL": "error",
        "RAY_LOG_TO_STDERR": "0",
        "RAY_ROTATION_BACKUP_COUNT": "1",
        "RAY_ROTATION_MAX_BYTES": "262144",
        "RAY_TMPDIR": str(ray_runtime_root),
    }
    for name, value in defaults.items():
        os.environ.setdefault(name, value)
    return ray_runtime_root, owns_root


def _main() -> None:
    ray_runtime_root, owns_ray_runtime_root = _configure_ray_runtime()
    try:
        if sys.argv[1:] == ["${ENGINE_SELF_TEST_ARGUMENT}"]:
            import breadboard_engine.agent

            print("${ENGINE_SELF_TEST_OUTPUT}")
            return
        if sys.argv[1:] == ["${ENGINE_RAY_SELF_TEST_ARGUMENT}"]:
            import ray

            try:
                ray.init(
                    address="local",
                    include_dashboard=False,
                    logging_level="ERROR",
                    log_to_driver=False,
                )

                @ray.remote
                def _worker_probe() -> str:
                    return "${ENGINE_RAY_SELF_TEST_OUTPUT}"

                if ray.get(_worker_probe.remote(), timeout=30) != "${ENGINE_RAY_SELF_TEST_OUTPUT}":
                    raise RuntimeError("frozen Ray worker returned an unexpected result")
                node = ray._private.worker._global_node
                if node is None or Path(node.get_temp_dir_path()).resolve() != (ray_runtime_root / "ray").resolve():
                    raise RuntimeError("frozen Ray runtime ignored its ephemeral temp root")
                print("${ENGINE_RAY_SELF_TEST_OUTPUT}")
            finally:
                if ray.is_initialized():
                    ray.shutdown()
            return
        if _run_frozen_ray_child():
            return
        from breadboard_engine.api.cli_bridge.server import main

        main()
    finally:
        if owns_ray_runtime_root:
            shutil.rmtree(ray_runtime_root, ignore_errors=True)


if __name__ == "__main__":
    freeze_support()
    _main()
`;
const COLLECT_PACKAGES = [
	"breadboard_engine",
	"breadboard",
	"breadboard_sdk",
	"agent_configs",
	"config",
	"conformance",
	"contracts",
	"implementations",
	"agentic_coder_prototype",
	"ray",
] as const;
const FREEZER_RUNTIME_REQUIREMENTS = ["colorama>=0.4.6", "psutil>=5.9"] as const;
const REQUIREMENTS_INPUT_PATH = join(import.meta.dir, "engine-build-requirements.in");
const REQUIREMENTS_LOCK_PATH = join(import.meta.dir, "engine-build-requirements.darwin-arm64-py311.txt");
const BUILD_RECIPE_SOURCE_PATHS = [
	["scripts/build-engine-distribution.ts", import.meta.path],
	[
		"src/breadboard/lifecycle/engine-distribution-installer.ts",
		join(import.meta.dir, "../src/breadboard/lifecycle/engine-distribution-installer.ts"),
	],
	[
		"src/breadboard/lifecycle/engine-runtime-bundle.ts",
		join(import.meta.dir, "../src/breadboard/lifecycle/engine-runtime-bundle.ts"),
	],
	[
		"src/breadboard/lifecycle/installed-engine-manifest.ts",
		join(import.meta.dir, "../src/breadboard/lifecycle/installed-engine-manifest.ts"),
	],
] as const;
const BUILD_PROVENANCE_FILENAME = "engine-build-provenance.v1.json";
const BUILD_PROVENANCE_SCHEMA = "bb.engine_build_provenance.v1";

interface BuildOptions {
	readonly backendRoot: string;
	readonly outputRoot: string;
	readonly productVersion: string;
	readonly keepWork: boolean;
}

interface RecipeInput {
	readonly label: string;
	readonly bytes: Uint8Array;
}

interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
}

interface BackendIdentity {
	readonly root: string;
	readonly commit: string;
	readonly tree: string;
	readonly repository: string;
}

interface ProfileIdentity {
	readonly profile_id: string;
	readonly definition_ref: string;
	readonly schema_version: string;
	readonly source_sha256: EngineDistributionSha256;
	readonly effective_lock_schema_version: string;
	readonly effective_lock_hash: EngineDistributionSha256;
}

function usage(): never {
	throw new Error(
		"Usage: bun scripts/build-engine-distribution.ts --backend-root <clean-checkout> --output-root <directory> --product-version <semver> [--keep-work]",
	);
}

export function parseBuildOptions(argv: readonly string[]): BuildOptions {
	const values: Record<string, string> = {};
	let keepWork = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--keep-work") {
			if (keepWork) return usage();
			keepWork = true;
			continue;
		}
		if (argument !== "--backend-root" && argument !== "--output-root" && argument !== "--product-version") {
			return usage();
		}
		const value = argv[++index];
		if (!value || value.includes("\0") || values[argument] !== undefined) return usage();
		values[argument] = value;
	}
	const backendRoot = values["--backend-root"];
	const outputRoot = values["--output-root"];
	const productVersion = values["--product-version"];
	if (!backendRoot || !outputRoot || !productVersion || !isAbsolute(backendRoot) || !isAbsolute(outputRoot))
		return usage();
	return Object.freeze({ backendRoot, outputRoot, productVersion, keepWork });
}

async function run(command: readonly string[], cwd: string): Promise<CommandResult> {
	const process = Bun.spawn([...command], {
		cwd,
		env: {
			...Bun.env,
			LC_ALL: "C",
			PIP_DISABLE_PIP_VERSION_CHECK: "1",
			PYTHONHASHSEED: "0",
			PYTHONNOUSERSITE: "1",
			SOURCE_DATE_EPOCH: "315532800",
			TZ: "UTC",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(
			`Command failed (${exitCode}): ${command.join(" ")}\n${stderr.slice(-16_384)}${stdout.slice(-16_384)}`,
		);
	}
	return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function expectGitObject(value: string, label: string): string {
	if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} is not one full SHA-1 object ID`);
	return value;
}

async function readBackendIdentity(root: string): Promise<BackendIdentity> {
	const canonicalRoot = await realpath(root);
	const metadata = await lstat(canonicalRoot);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("backend root is not one real directory");
	const status = await run(["git", "status", "--porcelain=v1", "--untracked-files=all"], canonicalRoot);
	if (status.stdout !== "") throw new Error("backend root must be clean, including untracked files");
	const commit = expectGitObject((await run(["git", "rev-parse", "HEAD"], canonicalRoot)).stdout, "backend commit");
	const tree = expectGitObject((await run(["git", "rev-parse", "HEAD^{tree}"], canonicalRoot)).stdout, "backend tree");
	const repository = (await run(["git", "remote", "get-url", "origin"], canonicalRoot)).stdout;
	let parsed: URL;
	try {
		parsed = new URL(repository);
	} catch {
		throw new Error("backend origin must be one HTTPS repository URL");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		parsed.pathname === "/"
	) {
		throw new Error("backend origin must be one credential-free HTTPS repository URL");
	}
	return Object.freeze({ root: canonicalRoot, commit, tree, repository });
}
async function materializeBackendSource(backend: BackendIdentity, destination: string, cwd: string): Promise<string> {
	await run(["git", "clone", "--shared", "--no-checkout", backend.root, destination], cwd);
	await run(["git", "checkout", "--detach", backend.commit], destination);
	const commit = expectGitObject((await run(["git", "rev-parse", "HEAD"], destination)).stdout, "build source commit");
	const tree = expectGitObject(
		(await run(["git", "rev-parse", "HEAD^{tree}"], destination)).stdout,
		"build source tree",
	);
	const status = await run(["git", "status", "--porcelain=v1", "--untracked-files=all"], destination);
	if (commit !== backend.commit || tree !== backend.tree || status.stdout !== "") {
		throw new Error("materialized backend source does not exactly match the approved build input");
	}
	return realpath(destination);
}

function parseRequirementsInput(input: string): readonly string[] {
	return Object.freeze(
		input
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line !== "" && !line.startsWith("#")),
	);
}

async function verifyDependencyInputs(backend: BackendIdentity): Promise<void> {
	const pyproject = TOML.parse(await Bun.file(join(backend.root, "pyproject.toml")).text()) as {
		readonly project?: { readonly dependencies?: unknown };
		readonly "build-system"?: { readonly requires?: unknown };
	};
	const runtimeRequirements = pyproject.project?.dependencies;
	if (!Array.isArray(runtimeRequirements) || runtimeRequirements.some(value => typeof value !== "string")) {
		throw new Error("backend pyproject runtime dependencies are invalid");
	}
	const buildRequirements = pyproject["build-system"]?.requires;
	if (JSON.stringify(buildRequirements) !== JSON.stringify(["setuptools==84.0.0"])) {
		throw new Error("backend build-system dependency is not exactly pinned");
	}
	const declared = parseRequirementsInput(await Bun.file(REQUIREMENTS_INPUT_PATH).text());
	const expected = [
		...(runtimeRequirements as string[]),
		...FREEZER_RUNTIME_REQUIREMENTS,
		`pyinstaller==${PYINSTALLER_VERSION}`,
		"setuptools==84.0.0",
	].sort((left, right) => left.localeCompare(right));
	if (JSON.stringify([...declared].sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expected)) {
		throw new Error(
			"engine build requirements do not exactly match backend runtime, build, and freezer support dependencies",
		);
	}
	const lock = await Bun.file(REQUIREMENTS_LOCK_PATH).text();
	if (!lock.includes("--hash=sha256:") || !lock.includes(`pyinstaller==${PYINSTALLER_VERSION}`)) {
		throw new Error("engine dependency lock is missing hashes or the exact freezer version");
	}
}
async function normalizeInstalledMetadata(sitePackages: string): Promise<void> {
	for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
		if (!entry.name.endsWith(".dist-info")) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`installed distribution metadata is not one directory: ${entry.name}`);
		}
		const metadataRoot = join(sitePackages, entry.name);
		const recordPath = join(metadataRoot, "RECORD");
		let record: string;
		try {
			record = await readFile(recordPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const normalized = record
			.split("\n")
			.flatMap(line => {
				const separator = line.indexOf(",");
				const path = separator === -1 ? line : line.slice(0, separator);
				if (path.endsWith("/direct_url.json") || path.endsWith("/uv_cache.json")) return [];
				if (path.startsWith("../../../bin/")) return [`${path},,`];
				return [line];
			})
			.join("\n");
		await Bun.write(recordPath, normalized);
		for (const volatileName of ["direct_url.json", "uv_cache.json"]) {
			await unlink(join(metadataRoot, volatileName)).catch(error => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
		}
	}
}

function recipeSha256(inputs: readonly RecipeInput[]): EngineDistributionSha256 {
	const digest = createHash("sha256");
	digest.update("breadboard-engine-build-recipe-v2\0");
	const count = Buffer.allocUnsafe(4);
	count.writeUInt32BE(inputs.length);
	digest.update(count);
	for (const input of inputs) {
		const label = Buffer.from(input.label, "utf8");
		for (const bytes of [label, input.bytes]) {
			const length = Buffer.allocUnsafe(8);
			length.writeBigUInt64BE(BigInt(bytes.byteLength));
			digest.update(length);
			digest.update(bytes);
		}
	}
	return `sha256:${digest.digest("hex")}`;
}

function parseExactJsonObject<T>(text: string, keys: readonly string[], label: string): T {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${label} is not JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} is not an object`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${label} has unknown or missing fields`);
	}
	return value as T;
}

async function verifyPinnedFile(path: string, expected: Buffer): Promise<void> {
	const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
		throw new Error(`existing pinned file identity is invalid: ${path}`, { cause: error });
	});
	try {
		const metadata = await input.stat();
		const currentUid = process.getuid?.();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			currentUid === undefined ||
			metadata.uid !== currentUid ||
			(metadata.mode & 0o777) !== 0o400 ||
			metadata.size !== expected.byteLength
		) {
			throw new Error(`existing pinned file identity is invalid: ${path}`);
		}
		if (!(await input.readFile()).equals(expected)) {
			throw new Error(`existing pinned file differs: ${path}`);
		}
	} finally {
		await input.close();
	}
}

export async function writePinnedFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const expected = Buffer.from(content, "utf8");
	const temporary = `${path}.tmp-${randomBytes(12).toString("hex")}`;
	const output = await open(temporary, "wx", 0o600);
	try {
		try {
			await output.writeFile(expected);
			await output.sync();
			await output.chmod(0o400);
		} finally {
			await output.close();
		}
		try {
			await link(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		await unlink(temporary);
	}
	const directory = await open(dirname(path), constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
	await verifyPinnedFile(path, expected);
}

async function main(options: BuildOptions): Promise<void> {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error(`D2 currently supports only darwin-arm64, not ${process.platform}-${process.arch}`);
	}
	if (Bun.version !== BUN_VERSION) throw new Error(`engine Bun changed: expected ${BUN_VERSION}, got ${Bun.version}`);
	const uvOutput = (await run(["uv", "--version"], options.backendRoot)).stdout;
	const actualUv = /^uv ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(uvOutput)?.[1];
	if (actualUv !== UV_VERSION) throw new Error(`engine uv changed: expected ${UV_VERSION}, got ${uvOutput}`);
	const backend = await readBackendIdentity(options.backendRoot);
	await verifyDependencyInputs(backend);
	await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
	const outputMetadata = await lstat(options.outputRoot);
	if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink() || (outputMetadata.mode & 0o777) !== 0o700) {
		throw new Error("engine distribution output root must be one private directory");
	}
	const outputRoot = await realpath(options.outputRoot);
	const workRoot = await mkdtemp(join(tmpdir(), "breadboard-engine-build-"));
	try {
		const sourceRoot = await materializeBackendSource(backend, join(workRoot, "backend-source"), workRoot);
		const wheelhouse = join(workRoot, "wheelhouse");
		const virtualEnvironment = join(workRoot, "venv");
		await mkdir(wheelhouse, { mode: 0o700 });
		await run(
			[
				"uv",
				"build",
				"--wheel",
				"--out-dir",
				wheelhouse,
				"--build-constraints",
				REQUIREMENTS_LOCK_PATH,
				"--require-hashes",
				"--python",
				PYTHON_VERSION,
				"--no-python-downloads",
				"--no-sources",
				sourceRoot,
			],
			sourceRoot,
		);
		const wheels = (await readdir(wheelhouse)).filter(name => name.endsWith(".whl"));
		if (wheels.length !== 1) throw new Error("backend build did not produce exactly one wheel");
		await run(
			["uv", "venv", "--python", PYTHON_VERSION, "--no-python-downloads", "--no-project", virtualEnvironment],
			workRoot,
		);
		const python = join(virtualEnvironment, "bin", "python");
		await run(
			["uv", "pip", "install", "--python", python, "--require-hashes", "--no-deps", "-r", REQUIREMENTS_LOCK_PATH],
			workRoot,
		);
		await run(
			["uv", "pip", "install", "--python", python, "--no-deps", join(wheelhouse, wheels[0] as string)],
			workRoot,
		);
		const sitePackages = (await run([python, "-c", "import site; print(site.getsitepackages()[0])"], workRoot))
			.stdout;
		await normalizeInstalledMetadata(sitePackages);
		const actualPyinstaller = (await run([python, "-m", "PyInstaller", "--version"], workRoot)).stdout;
		if (actualPyinstaller !== PYINSTALLER_VERSION) {
			throw new Error(`engine PyInstaller changed: expected ${PYINSTALLER_VERSION}, got ${actualPyinstaller}`);
		}
		const actualPython = (await run([python, "-c", "import platform; print(platform.python_version())"], workRoot))
			.stdout;
		if (actualPython !== PYTHON_VERSION)
			throw new Error(`engine Python changed: expected ${PYTHON_VERSION}, got ${actualPython}`);
		const packageRoot = (
			await run(
				[
					python,
					"-c",
					"from pathlib import Path; import breadboard_engine; print(Path(breadboard_engine.__file__).resolve().parent)",
				],
				workRoot,
			)
		).stdout;
		const engineSourceSha256 = (
			await run(
				[
					python,
					"-c",
					"from pathlib import Path; from breadboard_engine.api.cli_bridge.engine_identity_config import engine_source_artifact_sha256; import breadboard_engine; print(engine_source_artifact_sha256(Path(breadboard_engine.__file__).resolve().parent))",
				],
				workRoot,
			)
		).stdout as EngineDistributionSha256;
		if (!/^sha256:[0-9a-f]{64}$/.test(engineSourceSha256))
			throw new Error("installed engine source digest is invalid");
		const dependencyLockSha256 = await sha256File(REQUIREMENTS_LOCK_PATH);
		const recipeSources = await Promise.all(
			BUILD_RECIPE_SOURCE_PATHS.map(async ([label, path]) => ({
				label,
				bytes: new Uint8Array(await Bun.file(path).arrayBuffer()),
			})),
		);
		const buildRecipeSha256 = recipeSha256([
			...recipeSources,
			{
				label: "scripts/engine-build-requirements.in",
				bytes: new Uint8Array(await Bun.file(REQUIREMENTS_INPUT_PATH).arrayBuffer()),
			},
			{
				label: "scripts/engine-build-requirements.darwin-arm64-py311.txt",
				bytes: new Uint8Array(await Bun.file(REQUIREMENTS_LOCK_PATH).arrayBuffer()),
			},
			{ label: "engine_entry.py", bytes: Buffer.from(ENGINE_ENTRY_SOURCE, "utf8") },
		]);
		const buildProvenance = {
			schemaVersion: BUILD_PROVENANCE_SCHEMA,
			sourceRepository: backend.repository,
			sourceCommit: backend.commit,
			sourceTree: backend.tree,
			engineSourceSha256,
			dependencyLockSha256,
			buildRecipeSha256,
			target: { platform: "darwin", architecture: "arm64" },
		};
		const provenancePath = join(packageRoot, BUILD_PROVENANCE_FILENAME);
		await Bun.write(provenancePath, `${JSON.stringify(buildProvenance)}\n`);
		await chmod(provenancePath, 0o444);
		const profile = parseExactJsonObject<ProfileIdentity>(
			(
				await run(
					[
						python,
						"-c",
						"import json; from breadboard.product.cli.harness import default_profile_identity; print(json.dumps(default_profile_identity(), sort_keys=True, separators=(',', ':')))",
					],
					workRoot,
				)
			).stdout,
			[
				"profile_id",
				"definition_ref",
				"schema_version",
				"source_sha256",
				"effective_lock_schema_version",
				"effective_lock_hash",
				"resources",
			],
			"default profile identity",
		);
		if (profile.profile_id !== "daily_driver.v1") throw new Error("backend default profile is not daily_driver.v1");

		const entryPath = join(workRoot, "engine_entry.py");
		await Bun.write(entryPath, ENGINE_ENTRY_SOURCE);
		const distPath = join(workRoot, "dist");
		const pyinstaller = join(virtualEnvironment, "bin", "pyinstaller");
		const collectArguments = COLLECT_PACKAGES.flatMap(name => ["--collect-all", name]);
		await run(
			[
				pyinstaller,
				"--noconfirm",
				"--clean",
				"--name",
				"breadboard-engine",
				"--distpath",
				distPath,
				"--workpath",
				join(workRoot, "pyinstaller-work"),
				"--specpath",
				join(workRoot, "pyinstaller-spec"),
				...collectArguments,
				entryPath,
			],
			workRoot,
		);
		const runtimeRoot = join(distPath, "breadboard-engine");
		const rayThirdPartyRoot = join(runtimeRoot, "_internal", "ray", "thirdparty_files");
		for (const name of await readdir(rayThirdPartyRoot)) {
			if (name === "psutil" || (name.startsWith("psutil-") && name.endsWith(".dist-info"))) {
				await rm(join(rayThirdPartyRoot, name), { recursive: true, force: true });
			}
		}
		const runtimeExecutable = join(runtimeRoot, "breadboard-engine");
		await run(["codesign", "--verify", "--deep", "--strict", runtimeExecutable], workRoot);
		const selfTest = await run([runtimeExecutable, ENGINE_SELF_TEST_ARGUMENT], workRoot);
		if (selfTest.stdout !== ENGINE_SELF_TEST_OUTPUT || selfTest.stderr !== "") {
			throw new Error("frozen engine agent import self-test returned unexpected output");
		}
		const raySelfTest = await run([runtimeExecutable, ENGINE_RAY_SELF_TEST_ARGUMENT], workRoot);
		const raySelfTestStderrLines = raySelfTest.stderr.split("\n").filter(Boolean);
		if (
			raySelfTest.stdout !== ENGINE_RAY_SELF_TEST_OUTPUT ||
			raySelfTestStderrLines.length > 1 ||
			raySelfTestStderrLines.some(
				line => !line.endsWith("Set ray log level from environment variable RAY_BACKEND_LOG_LEVEL to 2"),
			)
		) {
			throw new Error("frozen engine Ray runtime self-test returned unexpected output");
		}
		const createdBundle = await createEngineRuntimeBundle({
			sourceRoot: runtimeRoot,
			executablePath: "breadboard-engine",
			outputPath: join(workRoot, ENGINE_BUNDLE_FILENAME),
		});
		const manifest = createEngineDistributionManifest({
			productVersion: options.productVersion,
			pathStrategy: ENGINE_DISTRIBUTION_PATH_STRATEGY,
			target: { platform: "darwin", architecture: "arm64" },
			engine: {
				runtimeBundle: {
					schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
					path: ENGINE_BUNDLE_FILENAME,
					sizeBytes: createdBundle.bundle.sizeBytes,
					sha256: createdBundle.bundle.sha256,
				},
				executablePath: createdBundle.executablePath,
				argv: [],
				executableSizeBytes: createdBundle.executableSizeBytes,
				executableSha256: createdBundle.executableSha256,
				engineSourceSha256,
				servedBackendCommit: backend.commit,
				servedBackendTree: backend.tree,
				interfaceVersion: ENGINE_INTERFACE_VERSION,
				interfaceRange: ENGINE_INTERFACE_RANGE,
			},
			profile: {
				profileId: profile.profile_id,
				definitionRef: profile.definition_ref,
				schemaVersion: profile.schema_version,
				sourceSha256: profile.source_sha256,
				effectiveLockSchemaVersion: profile.effective_lock_schema_version,
				effectiveLockSha256: profile.effective_lock_hash,
			},
			provenance: {
				sourceRepository: backend.repository,
				sourceCommit: backend.commit,
				sourceTree: backend.tree,
				buildRecipeSha256,
				dependencyLockSha256,
			},
			signature: { kind: "unsigned-development" },
		});
		const manifestBytes = Buffer.from(canonicalEngineDistributionManifest(manifest), "utf8");
		const trust: EngineDistributionTrustRoot = {
			schemaVersion: ENGINE_DISTRIBUTION_TRUST_SCHEMA,
			distributionId: manifest.distributionId,
			expectedManifestSha256: `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`,
			productVersion: options.productVersion,
			target: { platform: "darwin", architecture: "arm64" },
			interfaceRange: ENGINE_INTERFACE_RANGE,
			profile: {
				profileId: profile.profile_id,
				effectiveLockSha256: profile.effective_lock_hash,
			},
			signature: { kind: "unsigned-development" },
		};
		const distributionName = manifest.distributionId.slice("sha256:".length);
		const trustPath = join(outputRoot, `${distributionName}.trust.json`);
		// Publish and validate the detached verifier before exposing the content-addressed distribution.
		await writePinnedFile(trustPath, `${JSON.stringify(trust)}\n`);
		const installed = await installEngineDistributionAtomically({
			root: outputRoot,
			manifest,
			bundlePath: createdBundle.bundle.path,
		});
		const receipt = {
			schemaVersion: "bb.engine_distribution_build_receipt.v1",
			classification: "prepared_not_approved",
			distributionId: manifest.distributionId,
			manifestPath: installed.manifestPath,
			bundlePath: installed.bundlePath,
			trustPath,
			backendCommit: backend.commit,
			backendTree: backend.tree,
			pythonVersion: actualPython,
			bunVersion: BUN_VERSION,
			uvVersion: actualUv,
			pyinstallerVersion: PYINSTALLER_VERSION,
			engineSourceSha256,
			buildRecipeSha256,
			dependencyLockSha256,
			retainedDistributionPaths: installed.retainedDistributionPaths,
		};
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
	} finally {
		if (options.keepWork) process.stderr.write(`Retained engine build work root: ${workRoot}\n`);
		else await rm(workRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) await main(parseBuildOptions(Bun.argv.slice(2)));
