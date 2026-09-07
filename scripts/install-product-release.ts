#!/usr/bin/env bun

import { dlopen, FFIType, type Library, ptr, read } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openPinnedDirectory } from "../packages/coding-agent/src/breadboard/lifecycle/darwin-pinned-directory";
import {
	ENGINE_DISTRIBUTION_MANIFEST_FILENAME,
	type EngineDistributionManifest,
	type EngineDistributionTrustRoot,
	INSTALLED_ENGINE_SUPPORTED_TARGET,
	parseTrustedEngineDistributionManifest,
} from "../packages/coding-agent/src/breadboard/lifecycle/installed-engine-manifest";
import { BREADBOARD_DISTRIBUTION_POLICY } from "../packages/utils/src/product-distribution";

const INSTALL_SCHEMA = "bb.product_install_manifest.v1";
const ARCHIVE_SCHEMA = "bb.product_archive.v1";
const ROOT = /^bb-darwin-arm64-[0-9A-Za-z.-]+$/;
const HEX = /^[0-9a-f]{64}$/;
const PRODUCT_STATE_DIRECTORY = ".bb-product-state";
const LIFECYCLE_SCHEMA = "bb.product_lifecycle.v1";
const SEMVER_PATTERN =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const LOCK_TIMEOUT_MS = 30_000;
const RETIREMENT_NAME_PATTERN = /^\.bb-retire-[0-9a-f]+-[0-9a-f]+$/;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_CONTROL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_LISTING_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 512;
const MAX_LIFECYCLE_REVISIONS = 1_000;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const PRODUCT_TARGET = INSTALLED_ENGINE_SUPPORTED_TARGET;
const PRODUCT_BINARY_PATH = "bb";
const PRODUCT_NATIVE_ADDON_PATH = "native/pi_natives.darwin-arm64.node";

export interface ProductArchiveTrustOptions {
	readonly allowUnsignedDevelopment?: boolean;
	readonly expectedArchiveSha256?: `sha256:${string}`;
}

function targetKey(target = PRODUCT_TARGET): string {
	return `${target.platform}-${target.architecture}`;
}
async function removePinnedDirectoryTree(
	path: string,
	expected?: { readonly device: number | bigint; readonly inode: number | bigint },
): Promise<void> {
	const parent = await openPinnedDirectory(dirname(path));
	try {
		await parent.removeDirectoryTree(
			basename(path),
			expected === undefined ? undefined : { dev: BigInt(expected.device), ino: BigInt(expected.inode) },
		);
	} finally {
		await parent.close();
	}
}

const LOCK_SYMBOLS = {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;
const DARWIN_SYMBOLS = {
	renameatx_np: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	__error: { args: [], returns: FFIType.ptr },
} as const;

function fail(message: string, cause?: unknown): never {
	throw new Error(message, cause === undefined ? undefined : { cause });
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function privateRegular(path: string, maxBytes = MAX_CONTROL_FILE_BYTES): Promise<Buffer> {
	const stat = await lstat(path).catch(error => fail(`archive input unavailable: ${path}`, error));
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0)
		fail(`archive input is not a private regular file: ${path}`);
	const fd = await open(path, constants.O_RDONLY | O_NOFOLLOW);
	try {
		const current = await fd.stat();
		if (!current.isFile() || current.nlink !== 1 || current.dev !== stat.dev || current.ino !== stat.ino)
			fail(`archive input identity changed: ${path}`);
		if (current.size > maxBytes) fail(`archive input exceeds its byte limit: ${path}`);
		return await fd.readFile();
	} finally {
		await fd.close();
	}
}

async function hashPrivateRegular(path: string): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
	const pathname = await lstat(path).catch(error => fail(`archive input unavailable: ${path}`, error));
	if (
		!pathname.isFile() ||
		pathname.isSymbolicLink() ||
		pathname.nlink !== 1 ||
		(pathname.mode & 0o022) !== 0 ||
		pathname.size > MAX_ARCHIVE_FILE_BYTES
	) {
		fail(`archive input is not one bounded private regular file: ${path}`);
	}
	const file = await open(path, constants.O_RDONLY | O_NOFOLLOW);
	try {
		const opened = await file.stat();
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			opened.dev !== pathname.dev ||
			opened.ino !== pathname.ino ||
			opened.size !== pathname.size
		) {
			fail(`archive input identity changed: ${path}`);
		}
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let position = 0;
		for (;;) {
			const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
			if (bytesRead === 0) break;
			digest.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		const completed = await file.stat();
		if (
			position !== opened.size ||
			completed.size !== opened.size ||
			completed.dev !== opened.dev ||
			completed.ino !== opened.ino
		) {
			fail(`archive input changed while hashing: ${path}`);
		}
		return { sizeBytes: position, sha256: digest.digest("hex") };
	} finally {
		await file.close();
	}
}

async function validateArchivePayload(bytes: Buffer): Promise<void> {
	if (bytes.byteLength > MAX_ARCHIVE_BYTES) fail("product archive exceeds its compressed byte limit");
	const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
	let expandedBytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			expandedBytes += chunk.value.byteLength;
			if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
				await reader.cancel();
				fail("product archive exceeds its expanded byte limit");
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("product archive exceeds")) throw error;
		fail("product archive gzip payload is invalid", error);
	} finally {
		reader.releaseLock();
	}
}

async function boundedText(stream: ReadableStream<Uint8Array>, maxBytes: number, label: string): Promise<string> {
	const reader = stream.getReader();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				fail(`${label} exceeds its byte limit`);
			}
			chunks.push(Buffer.from(chunk.value));
		}
		return Buffer.concat(chunks, totalBytes).toString("utf8");
	} finally {
		reader.releaseLock();
	}
}
async function runTarExtract(archivePath: string, destination: string): Promise<void> {
	const child = Bun.spawn(
		["tar", "-xzf", archivePath, "--no-same-owner", "--no-same-permissions", "-C", destination],
		{
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let code: number;
	let stderr: string;
	try {
		[code, stderr] = await Promise.all([
			child.exited,
			boundedText(child.stderr, MAX_CONTROL_FILE_BYTES, "archive extraction stderr"),
		]);
	} catch (error) {
		child.kill();
		throw error;
	}
	if (code !== 0) fail(`archive extraction failed: ${stderr.trim()}`);
}

async function stageArchive(
	parent: string,
	bytes: Buffer,
): Promise<{ readonly archivePath: string; readonly payloadRoot: string }> {
	const archivePath = join(parent, "input.tar.gz");
	const payloadRoot = join(parent, "payload");
	await Bun.write(archivePath, bytes);
	await chmod(archivePath, 0o400);
	await mkdir(payloadRoot, { mode: 0o700 });
	return { archivePath, payloadRoot };
}
async function validateArchiveNames(archivePath: string): Promise<void> {
	const child = Bun.spawn(["tar", "-tzf", archivePath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let code: number;
	let stdout: string;
	let stderr: string;
	try {
		[code, stdout, stderr] = await Promise.all([
			child.exited,
			boundedText(child.stdout, MAX_ARCHIVE_LISTING_BYTES, "archive name listing"),
			boundedText(child.stderr, MAX_CONTROL_FILE_BYTES, "archive listing stderr"),
		]);
	} catch (error) {
		child.kill();
		throw error;
	}
	if (code !== 0) fail(`archive listing failed: ${stderr.trim()}`);
	const names = stdout
		.split("\n")
		.map(name => name.trim())
		.filter(Boolean);
	if (names.length === 0) fail("archive is empty");
	if (names.length > MAX_ARCHIVE_ENTRIES) fail("archive contains too many entries");
	if (new Set(names).size !== names.length) fail("archive contains duplicate entries");
	for (const name of names) {
		if (Buffer.byteLength(name, "utf8") > MAX_ARCHIVE_PATH_BYTES) fail(`archive contains an overlong path`);
		if (name.startsWith("/") || name.split("/").some(component => component === ".." || component === "."))
			fail(`archive contains an unsafe path: ${name}`);
	}
	const roots = new Set(names.map(name => name.split("/")[0]));
	if (roots.size !== 1 || !ROOT.test([...roots][0] as string)) fail("archive must contain one supported target root");
	const types = Bun.spawn(["tar", "-tvzf", archivePath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let typeCode: number;
	let typeOutput: string;
	let typeError: string;
	try {
		[typeCode, typeOutput, typeError] = await Promise.all([
			types.exited,
			boundedText(types.stdout, MAX_ARCHIVE_LISTING_BYTES, "archive type listing"),
			boundedText(types.stderr, MAX_CONTROL_FILE_BYTES, "archive type listing stderr"),
		]);
	} catch (error) {
		types.kill();
		throw error;
	}
	if (typeCode !== 0) fail(`archive type listing failed: ${typeError.trim()}`);
	if (typeOutput.split("\n").some(line => line.length > 0 && line[0] !== "-" && line[0] !== "d"))
		fail("archive contains a non-regular entry");
}

function safeRelativePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.startsWith("/") &&
		value.split("/").every(component => component.length > 0 && component !== "." && component !== "..")
	);
}
interface JsonRecord {
	readonly [key: string]: unknown;
}

function manifestRecord(value: unknown, message: string): JsonRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message);
	return value;
}

async function verifyTree(root: string, expectedRoot: string): Promise<readonly string[]> {
	const found: string[] = [];
	let totalBytes = 0;
	const visit = async (directory: string, prefix: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) fail(`archive contains a symlink: ${prefix}${entry.name}`);
			const relative = prefix + entry.name;
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(absolute, `${relative}/`);
				continue;
			}
			if (!entry.isFile()) fail(`archive contains a special file: ${relative}`);
			const metadata = await lstat(absolute);
			if (metadata.size > MAX_ARCHIVE_FILE_BYTES) fail(`archive file exceeds its byte limit: ${relative}`);
			totalBytes += metadata.size;
			if (totalBytes > MAX_ARCHIVE_EXPANDED_BYTES) fail("archive tree exceeds its expanded byte limit");
			found.push(relative);
			if (found.length > MAX_ARCHIVE_ENTRIES) fail("archive contains too many regular files");
		}
	};
	await visit(root, "");
	if (!found.includes("install-manifest.v1.json") || !found.includes("checksums.sha256"))
		fail("archive is missing its install manifest or checksums");
	if (!expectedRoot.startsWith("bb-")) fail("archive root is invalid");
	return found.sort();
}

function decodeChecksums(bytes: Buffer): ReadonlyMap<string, string> {
	const values = new Map<string, string>();
	for (const line of bytes.toString("utf8").trimEnd().split("\n")) {
		const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
		if (!match || !HEX.test(match[1] as string) || values.has(match[2] as string))
			fail("checksums manifest is malformed");
		values.set(match[2] as string, match[1] as string);
	}
	return values;
}

async function verifyProductRoot(
	root: string,
	rootName: string,
): Promise<{ readonly rootName: string; readonly manifest: Record<string, unknown>; readonly treeSha256: string }> {
	const files = await verifyTree(root, rootName);
	const manifestBytes = await privateRegular(join(root, "install-manifest.v1.json"));
	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch (error) {
		fail("install manifest is not JSON", error);
	}
	if (
		manifest.schemaVersion !== INSTALL_SCHEMA ||
		manifest.archiveSchemaVersion !== ARCHIVE_SCHEMA ||
		manifest.product !== BREADBOARD_DISTRIBUTION_POLICY.productName
	)
		fail("install manifest schema is invalid");
	const target = manifestRecord(manifest.target, "archive target is invalid");
	if (target.platform !== PRODUCT_TARGET.platform || target.architecture !== PRODUCT_TARGET.architecture)
		fail("archive target does not match this host");
	if (!isSemver(manifest.productVersion)) fail("install manifest product version is invalid");
	const expectedRoot = `${BREADBOARD_DISTRIBUTION_POLICY.productName}-${targetKey()}-${manifest.productVersion}`;
	if (rootName !== expectedRoot) fail("archive root does not match its target and product version");
	const checksumsBytes = await privateRegular(join(root, "checksums.sha256"));
	const checksums = decodeChecksums(checksumsBytes);
	const checkableFiles = files.filter(file => file !== "checksums.sha256");
	if (checksums.size !== checkableFiles.length || checkableFiles.some(file => !checksums.has(file)))
		fail("archive checksums are incomplete");
	for (const [relative, digest] of checksums) {
		if (!safeRelativePath(relative) || !files.includes(relative))
			fail(`checksum references missing archive entry: ${relative}`);
		const identity = await hashPrivateRegular(join(root, relative));
		if (identity.sha256 !== digest) fail(`archive digest mismatch: ${relative}`);
	}
	const binary = manifestRecord(manifest.binary, "install manifest binary identity is invalid");
	const addon = manifestRecord(manifest.nativeAddon, "install manifest native addon identity is invalid");
	if (binary.path !== PRODUCT_BINARY_PATH || addon.path !== PRODUCT_NATIVE_ADDON_PATH)
		fail("install manifest executable paths are invalid");
	for (const item of [binary, addon]) {
		if (
			!safeRelativePath(item.path) ||
			typeof item.sizeBytes !== "number" ||
			!Number.isSafeInteger(item.sizeBytes) ||
			item.sizeBytes < 0 ||
			typeof item.sha256 !== "string"
		) {
			fail("install manifest content identity is invalid");
		}
		const identity = await hashPrivateRegular(join(root, item.path));
		if (identity.sizeBytes !== item.sizeBytes || item.sha256 !== `sha256:${identity.sha256}`)
			fail("install manifest content identity mismatch");
	}
	const engine = manifestRecord(manifest.engine, "install manifest engine identity is invalid");
	if (typeof engine.distributionId !== "string" || !engine.distributionId.startsWith("sha256:")) {
		fail("install manifest engine identity is invalid");
	}
	const engineDirectory = `engine/${engine.distributionId.slice("sha256:".length)}`;
	if (
		!safeRelativePath(engine.manifestPath) ||
		!safeRelativePath(engine.bundlePath) ||
		engine.manifestPath !== `${engineDirectory}/${ENGINE_DISTRIBUTION_MANIFEST_FILENAME}`
	) {
		fail("install manifest engine paths are invalid");
	}
	const engineManifestBytes = await privateRegular(join(root, engine.manifestPath));
	const trustFiles = files.filter(file => file.startsWith("engine/") && file.endsWith(".trust.json"));
	const expectedTrustPath = `engine/${engine.distributionId.slice("sha256:".length)}.trust.json`;
	if (trustFiles.length !== 1 || trustFiles[0] !== expectedTrustPath)
		fail("archive must contain exactly one detached engine trust root");
	const trustFile = trustFiles[0];
	if (trustFile === undefined) fail("archive trust root is missing");
	let trustRoot: EngineDistributionTrustRoot;
	try {
		trustRoot = JSON.parse((await privateRegular(join(root, trustFile))).toString("utf8"));
	} catch (error) {
		fail("engine trust root is not JSON", error);
	}
	let engineManifest: EngineDistributionManifest;
	try {
		engineManifest = parseTrustedEngineDistributionManifest(engineManifestBytes, trustRoot);
	} catch (error) {
		fail("engine manifest trust verification failed", error);
	}
	if (
		engineManifest.productVersion !== manifest.productVersion ||
		engineManifest.target.platform !== PRODUCT_TARGET.platform ||
		engineManifest.target.architecture !== PRODUCT_TARGET.architecture ||
		engineManifest.distributionId !== engine.distributionId ||
		engine.bundlePath !== `${engineDirectory}/${engineManifest.engine.runtimeBundle.path}`
	) {
		fail("install manifest engine identity mismatch");
	}
	const bundleIdentity = await hashPrivateRegular(join(root, engine.bundlePath));
	if (
		bundleIdentity.sizeBytes !== engineManifest.engine.runtimeBundle.sizeBytes ||
		`sha256:${bundleIdentity.sha256}` !== engineManifest.engine.runtimeBundle.sha256
	) {
		fail("engine runtime bundle identity mismatch");
	}
	const legal = manifestRecord(manifest.legal, "install manifest legal posture is invalid");
	if (manifest.classification === "release-candidate") {
		if (engineManifest.signature.kind !== "release-envelope")
			fail("release candidate has no trusted engine release envelope");
		if (
			legal.posture !== "release-ready" ||
			legal.inputsPresent !== true ||
			!files.includes("LICENSE") ||
			!files.includes("THIRD_PARTY_NOTICES.txt")
		)
			fail("release candidate is missing legal inputs");
	} else if (
		manifest.classification !== "development-evidence" ||
		engineManifest.signature.kind !== "unsigned-development" ||
		legal.posture !== "unsigned-development"
	) {
		fail("archive classification is invalid");
	}
	return { rootName, manifest, treeSha256: `sha256:${sha256(checksumsBytes)}` };
}
export function requireInstallableTrust(
	manifest: Record<string, unknown>,
	options: ProductArchiveTrustOptions,
	archiveSha256: `sha256:${string}`,
): void {
	const expected = options.expectedArchiveSha256;
	if (expected !== undefined && (!/^sha256:[0-9a-f]{64}$/.test(expected) || expected !== archiveSha256)) {
		fail("product archive does not match its independently supplied digest");
	}
	const externallyPinned = expected === archiveSha256;
	if (manifest.classification === "development-evidence" && options.allowUnsignedDevelopment !== true) {
		fail("unsigned development archive requires explicit authorization");
	}
	if (manifest.classification === "release-candidate" && !externallyPinned) {
		fail("release candidate requires an independently supplied archive digest");
	}
}

async function verifyExtracted(
	root: string,
): Promise<{ readonly rootName: string; readonly manifest: Record<string, unknown>; readonly treeSha256: string }> {
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.length !== 1 || !entries[0]?.isDirectory() || !ROOT.test(entries[0].name))
		fail("archive must contain exactly one target-named root directory");
	const rootName = entries[0].name;
	return await verifyProductRoot(join(root, rootName), rootName);
}

function renameNoReplace(source: string, destination: string): void {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product install is unsupported on ${process.platform}/${process.arch}`);
	const from = ptr(Buffer.from(`${source}\0`));
	const to = ptr(Buffer.from(`${destination}\0`));
	const lib = dlopen("/usr/lib/libSystem.B.dylib", DARWIN_SYMBOLS);
	try {
		const result = Number(lib.symbols.renameatx_np(-2, from, -2, to, 4));
		if (result !== 0) fail(`atomic product install failed with errno ${read.i32(lib.symbols.__error())}`);
	} finally {
		lib.close();
	}
}

async function verifyProductArchiveBytes(
	bytes: Buffer,
	options: ProductArchiveTrustOptions = {},
): Promise<Record<string, unknown>> {
	await validateArchivePayload(bytes);
	const root = await mkdtemp(join("/tmp", "bb-archive-"));
	try {
		const staged = await stageArchive(root, bytes);
		await validateArchiveNames(staged.archivePath);
		await runTarExtract(staged.archivePath, staged.payloadRoot);
		const verified = await verifyExtracted(staged.payloadRoot);
		requireInstallableTrust(verified.manifest, options, `sha256:${sha256(bytes)}`);
		return Object.freeze({
			...verified.manifest,
			archiveSha256: `sha256:${sha256(bytes)}`,
			rootSha256: verified.treeSha256,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

export async function verifyProductArchive(
	archivePath: string,
	options: ProductArchiveTrustOptions = {},
): Promise<Record<string, unknown>> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product lifecycle is unsupported on ${process.platform}/${process.arch}`);
	return await verifyProductArchiveBytes(await privateRegular(archivePath, MAX_ARCHIVE_BYTES), options);
}

async function installProductArchiveBytes(
	bytes: Buffer,
	destinationRoot: string,
	payloadValidated: boolean,
	options: ProductArchiveTrustOptions = {},
): Promise<string> {
	if (!payloadValidated) await validateArchivePayload(bytes);
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	const stage = await mkdtemp(join(destinationPath, ".bb-install-"));
	const stageIdentity = await lstat(stage);
	if (
		!stageIdentity.isDirectory() ||
		stageIdentity.isSymbolicLink() ||
		(typeof process.geteuid === "function" && stageIdentity.uid !== process.geteuid())
	) {
		fail("product install staging root identity is invalid");
	}
	try {
		const staged = await stageArchive(stage, bytes);
		await validateArchiveNames(staged.archivePath);
		await runTarExtract(staged.archivePath, staged.payloadRoot);
		const verified = await verifyExtracted(staged.payloadRoot);
		requireInstallableTrust(verified.manifest, options, `sha256:${sha256(bytes)}`);
		const source = join(staged.payloadRoot, verified.rootName);
		const destination = join(destinationPath, verified.rootName);
		await chmod(join(source, "bb"), 0o500);
		const engine = manifestRecord(verified.manifest.engine, "install manifest engine identity is invalid");
		const engineDirectory = dirname(engine.manifestPath);
		await chmod(join(source, engineDirectory), 0o500);
		await chmod(join(source, "engine"), 0o500);
		await chmod(join(source, "native"), 0o500);
		await chmod(source, 0o700);
		await syncTree(source);
		renameNoReplace(source, destination);
		await syncDirectory(destinationPath);
		return destination;
	} finally {
		await removePinnedDirectoryTree(stage, { device: stageIdentity.dev, inode: stageIdentity.ino });
	}
}

export async function installProductArchive(
	archivePath: string,
	destinationRoot: string,
	options: ProductArchiveTrustOptions = {},
): Promise<string> {
	const bytes = await privateRegular(archivePath, MAX_ARCHIVE_BYTES);
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	return await installProductArchiveBytes(bytes, destinationPath, false, options);
}

export const PRODUCT_LIFECYCLE_STATE_DIRECTORY = PRODUCT_STATE_DIRECTORY;

export type ProductLifecycleAction = "install" | "update" | "rollback" | "uninstall" | "cleanup" | "status";

export interface ProductLifecycleRoot {
	readonly rootName: string;
	readonly target: string;
	readonly version: string;
	readonly archiveSha256: string;
	readonly treeSha256: string;
}

export interface ProductLifecycleRemoval {
	readonly rootName: string;
	readonly retirementName: string;
}

export interface ProductLifecycleRecord {
	readonly schema: typeof LIFECYCLE_SCHEMA;
	readonly revision: number;
	readonly action: ProductLifecycleAction;
	readonly allowDowngrade: boolean;
	readonly active: ProductLifecycleRoot | null;
	readonly retained: readonly ProductLifecycleRoot[];
	readonly removal: ProductLifecycleRemoval | null;
	readonly removed: readonly string[];
	readonly residue: readonly string[];
}

interface LifecycleState {
	readonly revision: number;
	readonly record: ProductLifecycleRecord | null;
	readonly previousRecord: ProductLifecycleRecord | null;
}

function isMissingError(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isSemver(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = SEMVER_PATTERN.exec(value);
	if (value.includes("+")) return false;
	if (match === null) return false;
	return !(match[1]?.split(".").some(identifier => /^0\d+$/.test(identifier)) ?? false);
}

function compareProductVersions(left: string, right: string): number {
	if (!isSemver(left) || !isSemver(right)) fail("product version is not valid semver");
	try {
		return Bun.semver.order(left, right);
	} catch (error) {
		fail("product version comparison failed", error);
	}
}

function expectedRootName(version: string): string {
	if (!isSemver(version)) fail(`invalid product version: ${version}`);
	return `bb-${targetKey()}-${version}`;
}

function validRootName(value: unknown): value is string {
	if (typeof value !== "string" || !ROOT.test(value)) return false;
	const prefix = `bb-${targetKey()}-`;
	return value.startsWith(prefix) && isSemver(value.slice(prefix.length));
}

function validArchiveDigest(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function lifecycleRoot(value: unknown): ProductLifecycleRoot {
	const record = manifestRecord(value, "product lifecycle root is invalid");
	const rootName = record.rootName;
	const target = record.target;
	const version = record.version;
	const archiveSha256 = record.archiveSha256;
	const treeSha256 = record.treeSha256;
	if (
		!validRootName(rootName) ||
		target !== targetKey() ||
		!isSemver(version) ||
		rootName !== expectedRootName(version) ||
		!validArchiveDigest(archiveSha256) ||
		!validArchiveDigest(treeSha256)
	) {
		fail("product lifecycle root identity is invalid");
	}
	return Object.freeze({ rootName, target, version, archiveSha256, treeSha256 });
}

function lifecycleArray(value: unknown, label: string): readonly ProductLifecycleRoot[] {
	if (!Array.isArray(value)) fail(`${label} is invalid`);
	const roots = value.map(item => lifecycleRoot(item));
	const names = new Set<string>();
	for (const root of roots) {
		if (names.has(root.rootName)) fail(`${label} contains a duplicate root`);
		names.add(root.rootName);
	}
	return Object.freeze(roots);
}

function rootNames(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value)) fail(`${label} is invalid`);
	const names: string[] = [];
	for (const item of value) {
		if (!validRootName(item)) fail(`${label} is invalid`);
		names.push(item);
	}
	if (new Set(names).size !== names.length) fail(`${label} contains a duplicate root`);
	return Object.freeze(names);
}

function residueNames(value: unknown): readonly string[] {
	if (!Array.isArray(value)) fail("product lifecycle residue is invalid");
	const names: string[] = [];
	for (const item of value) {
		if (!safeRelativePath(item)) fail("product lifecycle residue is invalid");
		names.push(item);
	}
	if (new Set(names).size !== names.length) fail("product lifecycle residue contains a duplicate path");
	return Object.freeze(names);
}

function lifecycleRemoval(value: unknown): ProductLifecycleRemoval | null {
	if (value === null) return null;
	const record = manifestRecord(value, "product lifecycle removal identity is invalid");
	if (!validRootName(record.rootName) || !RETIREMENT_NAME_PATTERN.test(String(record.retirementName)))
		fail("product lifecycle removal identity is invalid");
	return Object.freeze({
		rootName: record.rootName,
		retirementName: String(record.retirementName),
	});
}

function decodeLifecycleRecord(value: unknown, expectedRevision: number): ProductLifecycleRecord {
	const record = manifestRecord(value, "product lifecycle revision is not an object");
	if (record.schema !== LIFECYCLE_SCHEMA || record.revision !== expectedRevision)
		fail("product lifecycle revision schema is invalid");
	if (
		record.action !== "install" &&
		record.action !== "update" &&
		record.action !== "rollback" &&
		record.action !== "uninstall" &&
		record.action !== "cleanup"
	)
		fail("product lifecycle revision action is invalid");
	const allowDowngrade = record.allowDowngrade;
	if (typeof allowDowngrade !== "boolean") fail("product lifecycle downgrade authorization is invalid");
	const active = record.active === null ? null : lifecycleRoot(record.active);
	const retained = lifecycleArray(record.retained, "product lifecycle retained roots");
	const retainedNames = new Set(retained.map(root => root.rootName));
	if (active !== null && retainedNames.has(active.rootName)) fail("active product root is also retained");
	return Object.freeze({
		removal: lifecycleRemoval(record.removal),
		schema: LIFECYCLE_SCHEMA,
		revision: expectedRevision,
		action: record.action,
		allowDowngrade,
		active,
		retained,
		removed: rootNames(record.removed, "product lifecycle removed roots"),
		residue: residueNames(record.residue),
	});
}

function sameRoot(left: ProductLifecycleRoot, right: ProductLifecycleRoot): boolean {
	return (
		left.rootName === right.rootName &&
		left.target === right.target &&
		left.version === right.version &&
		left.archiveSha256 === right.archiveSha256 &&
		left.treeSha256 === right.treeSha256
	);
}

function sameRoots(left: readonly ProductLifecycleRoot[], right: readonly ProductLifecycleRoot[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const leftRoot = left[index];
		const rightRoot = right[index];
		if (leftRoot === undefined || rightRoot === undefined || !sameRoot(leftRoot, rightRoot)) return false;
	}
	return true;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateLifecycleTransition(previous: ProductLifecycleRecord | null, current: ProductLifecycleRecord): void {
	if (previous === null) {
		if (
			current.revision !== 1 ||
			current.action !== "install" ||
			current.allowDowngrade ||
			current.active === null ||
			current.retained.length !== 0 ||
			current.removal !== null ||
			current.removed.length !== 0
		) {
			fail("product lifecycle initial revision is invalid");
		}
		return;
	}
	if (current.action === "install") {
		if (
			previous.active !== null ||
			previous.removal !== null ||
			current.active === null ||
			current.allowDowngrade ||
			current.removal !== null
		)
			fail("product lifecycle install transition is invalid");
		const expected = previous.retained.filter(root => root.rootName !== current.active?.rootName);
		const expectedRemoved = previous.removed.filter(rootName => rootName !== current.active?.rootName);
		if (!sameRoots(current.retained, expected) || !sameNames(current.removed, expectedRemoved))
			fail("product lifecycle install transition is invalid");
		return;
	}
	if (current.action === "update") {
		if (previous.active === null || current.active === null || current.removal !== null)
			fail("product lifecycle update transition is invalid");
		const comparison = compareProductVersions(current.active.version, previous.active.version);
		if (comparison === 0 || current.allowDowngrade !== comparison < 0)
			fail("product lifecycle update authorization is invalid");
		const expected = [
			previous.active,
			...previous.retained.filter(root => root.rootName !== current.active?.rootName),
		];
		const expectedRemoved = previous.removed.filter(rootName => rootName !== current.active?.rootName);
		if (!sameRoots(current.retained, expected) || !sameNames(current.removed, expectedRemoved))
			fail("product lifecycle update transition is invalid");
		return;
	}
	if (current.action === "rollback") {
		const predecessor = previous.retained[0];
		if (
			previous.active === null ||
			predecessor === undefined ||
			current.active === null ||
			current.allowDowngrade ||
			current.removal !== null ||
			!sameRoot(current.active, predecessor)
		) {
			fail("product lifecycle rollback transition is invalid");
		}
		const expected = [previous.active, ...previous.retained.slice(1)];
		if (!sameRoots(current.retained, expected) || !sameNames(current.removed, previous.removed))
			fail("product lifecycle rollback transition is invalid");
		return;
	}
	if (current.action === "cleanup") {
		if (
			previous.action !== "uninstall" ||
			previous.active !== null ||
			previous.removal === null ||
			current.active !== null ||
			current.allowDowngrade ||
			current.removal !== null ||
			!sameRoots(current.retained, previous.retained) ||
			!sameNames(current.removed, previous.removed)
		) {
			fail("product lifecycle cleanup transition is invalid");
		}
		return;
	}
	const removedRoot = previous.active ?? previous.retained[0];
	const expectedRetained = previous.active === null ? previous.retained.slice(1) : previous.retained;
	if (
		removedRoot === undefined ||
		previous.removal !== null ||
		current.active !== null ||
		current.allowDowngrade ||
		current.removal === null ||
		current.removal.rootName !== removedRoot.rootName ||
		!sameRoots(current.retained, expectedRetained)
	)
		fail("product lifecycle uninstall transition is invalid");
	const expectedRemoved = [
		...previous.removed.filter(rootName => rootName !== removedRoot.rootName),
		removedRoot.rootName,
	];
	if (!sameNames(current.removed, expectedRemoved)) fail("product lifecycle uninstall transition is invalid");
}

async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
	const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
	const metadata = await lstat(path);
	const effectiveUser = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		(metadata.mode & 0o777) !== 0o700 ||
		(effectiveUser !== undefined && metadata.uid !== effectiveUser)
	)
		fail(`${label} must be one private directory owned by the effective user`);
	if (firstCreated !== undefined) {
		let current = path;
		for (;;) {
			await syncDirectory(current);
			const parent = dirname(current);
			await syncDirectory(parent);
			if (current === firstCreated) break;
			current = parent;
		}
	}
}

async function ensureTrustedDestinationDirectory(path: string, label: string): Promise<void> {
	const effectiveUser = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUser === undefined) fail(`${label} ownership cannot be verified`);
	const components = resolve(path)
		.split("/")
		.filter(component => component.length > 0);
	let current = "/";
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		let created = false;
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(current);
		} catch (error) {
			if (!isMissingError(error)) throw error;
			try {
				await mkdir(current, { mode: 0o700 });
				created = true;
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
			}
			metadata = await lstat(current);
		}
		const isDestination = index === components.length - 1;
		if (metadata.uid !== 0 && metadata.uid !== effectiveUser)
			fail(`${label} has a path component owned by another user`);
		if (metadata.isSymbolicLink()) fail(`${label} has a symbolic-link path component`);
		if (!metadata.isDirectory()) fail(`${label} has a non-directory path component`);
		if ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0)
			fail(`${label} has a non-sticky group- or world-writable path component`);
		if (isDestination && (metadata.uid !== effectiveUser || (metadata.mode & 0o777) !== 0o700))
			fail(`${label} must be one private directory owned by the effective user`);
		if (created) {
			await syncDirectory(current);
			await syncDirectory(dirname(current));
		}
	}
}

async function assertTrustedPathComponents(path: string, label: string): Promise<void> {
	const effectiveUser = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUser === undefined) fail(`${label} ownership cannot be verified`);
	const components = resolve(path)
		.split("/")
		.filter(component => component.length > 0);
	let current = "/";
	for (const component of components) {
		current = join(current, component);
		const metadata = await lstat(current);
		if (metadata.uid !== 0 && metadata.uid !== effectiveUser)
			fail(`${label} has a path component owned by another user`);
		if (metadata.isSymbolicLink()) continue;
		if (!metadata.isDirectory()) fail(`${label} has a non-directory path component`);
		if ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0)
			fail(`${label} has a non-sticky group- or world-writable path component`);
	}
}

async function ensureDestinationRoot(destinationRoot: string): Promise<string> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product lifecycle is unsupported on ${process.platform}/${process.arch}`);
	const requested = resolve(destinationRoot);
	await ensureTrustedDestinationDirectory(requested, "product install root");
	await assertTrustedPathComponents(requested, "product install root");
	const canonical = await realpath(requested);
	await assertTrustedPathComponents(canonical, "canonical product install root");
	await ensurePrivateDirectory(canonical, "canonical product install root");
	await syncDirectory(canonical);
	await syncDirectory(dirname(canonical));
	return canonical;
}

async function ensureLifecycleDirectories(
	destinationRoot: string,
): Promise<{ readonly stateRoot: string; readonly revisionsRoot: string }> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	const stateRoot = join(destinationPath, PRODUCT_STATE_DIRECTORY);
	const revisionsRoot = join(stateRoot, "revisions");
	await ensurePrivateDirectory(stateRoot, "product lifecycle state root");
	await ensurePrivateDirectory(revisionsRoot, "product lifecycle revisions root");
	await syncDirectory(revisionsRoot);
	await syncDirectory(stateRoot);
	await syncDirectory(destinationPath);
	return { stateRoot, revisionsRoot };
}

async function readLifecycleState(destinationRoot: string): Promise<LifecycleState> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	const stateRoot = join(destinationPath, PRODUCT_STATE_DIRECTORY);
	try {
		const metadata = await lstat(stateRoot);
		if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700)
			fail("product lifecycle state root must be one private directory");
	} catch (error) {
		if (isMissingError(error)) return { revision: 0, record: null, previousRecord: null };
		throw error;
	}
	const revisionsRoot = join(stateRoot, "revisions");
	await ensurePrivateDirectory(revisionsRoot, "product lifecycle revisions root");
	const entries = await readdir(revisionsRoot, { withFileTypes: true });
	const revisions = new Map<number, string>();
	for (const entry of entries) {
		if (entry.name.startsWith(".pending-")) {
			const pendingMetadata = await lstat(join(revisionsRoot, entry.name));
			if (
				!pendingMetadata.isFile() ||
				pendingMetadata.isSymbolicLink() ||
				pendingMetadata.nlink !== 1 ||
				(pendingMetadata.mode & 0o022) !== 0
			)
				fail("product lifecycle pending record is unsafe");
			continue;
		}
		const match = /^revision-(\d+)\.json$/.exec(entry.name);
		if (!match || !entry.isFile() || entry.isSymbolicLink()) fail("product lifecycle revision directory is invalid");
		const revision = Number(match[1]);
		if (
			!Number.isSafeInteger(revision) ||
			revision < 1 ||
			revision > MAX_LIFECYCLE_REVISIONS ||
			revisions.has(revision)
		)
			fail("product lifecycle revision number is invalid");
		revisions.set(revision, entry.name);
	}
	if (revisions.size === 0) return { revision: 0, record: null, previousRecord: null };
	const highest = Math.max(...revisions.keys());
	const records: ProductLifecycleRecord[] = [];
	for (let revision = 1; revision <= highest; revision += 1) {
		const name = revisions.get(revision);
		if (name === undefined) fail("product lifecycle revisions are not consecutive");
		const path = join(revisionsRoot, name);
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o400)
			fail("product lifecycle final revision is not immutable");
		const bytes = await privateRegular(path);
		let parsed: unknown;
		try {
			parsed = JSON.parse(bytes.toString("utf8"));
		} catch (error) {
			fail(`product lifecycle revision ${revision} is not JSON`, error);
		}
		const previous = records.at(-1) ?? null;
		const decoded = decodeLifecycleRecord(parsed, revision);
		validateLifecycleTransition(previous, decoded);
		records.push(decoded);
	}
	const record = records.at(-1);
	if (record === undefined) fail("product lifecycle has no highest revision");
	return { revision: highest, record, previousRecord: records.at(-2) ?? null };
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function syncRegularFile(path: string): Promise<void> {
	const file = await open(path, constants.O_RDONLY | O_NOFOLLOW);
	try {
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.nlink !== 1) fail(`durable product input is not one regular file: ${path}`);
		await file.sync();
	} finally {
		await file.close();
	}
}

async function syncTree(root: string): Promise<void> {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			await syncTree(path);
		} else if (entry.isFile() && !entry.isSymbolicLink()) {
			await syncRegularFile(path);
		} else {
			fail(`product tree contains an unsafe entry during durability sync: ${entry.name}`);
		}
	}
	await syncDirectory(root);
}

function lifecycleLockLibrary(): Library<typeof LOCK_SYMBOLS> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product lifecycle locking is unsupported on ${process.platform}/${process.arch}`);
	return dlopen("/usr/lib/libSystem.B.dylib", LOCK_SYMBOLS);
}

async function withLifecycleLock<T>(destinationRoot: string, operation: () => Promise<T>): Promise<T> {
	const { stateRoot } = await ensureLifecycleDirectories(destinationRoot);
	const lockPath = join(stateRoot, "operation.lock");
	const lockFile = await open(lockPath, constants.O_RDWR | constants.O_CREAT | O_NOFOLLOW, 0o600);
	const library = lifecycleLockLibrary();
	let acquired = false;
	try {
		const descriptor = await lockFile.stat();
		const pathname = await lstat(lockPath);
		if (
			!descriptor.isFile() ||
			descriptor.nlink !== 1 ||
			descriptor.dev !== pathname.dev ||
			descriptor.ino !== pathname.ino ||
			pathname.isSymbolicLink() ||
			(pathname.mode & 0o777) !== 0o600
		) {
			fail("product lifecycle lock is not one private regular file");
		}
		const started = performance.now();
		while (!acquired) {
			acquired = Number(library.symbols.flock(lockFile.fd, LOCK_EX | LOCK_NB)) === 0;
			if (acquired) break;
			if (performance.now() - started >= LOCK_TIMEOUT_MS) fail("product lifecycle lock acquisition timed out");
			await Bun.sleep(25);
		}
		return await operation();
	} finally {
		if (acquired) library.symbols.flock(lockFile.fd, LOCK_UN);
		library.close();
		await lockFile.close();
	}
}

async function withLifecycleMutationLock<T>(
	destinationRoot: string,
	operation: () => Promise<T>,
	requiredRevisions: number | ((state: LifecycleState) => number) = 1,
): Promise<T> {
	const expectedRevision = (await readLifecycleState(destinationRoot)).revision;
	return await withLifecycleLock(destinationRoot, async () => {
		const state = await readLifecycleState(destinationRoot);
		if (state.revision !== expectedRevision) fail("product lifecycle CAS lost before operation");
		const required = typeof requiredRevisions === "number" ? requiredRevisions : requiredRevisions(state);
		if (state.revision > MAX_LIFECYCLE_REVISIONS - required) fail("product lifecycle revision capacity is exhausted");
		return await operation();
	});
}

async function publishLifecycleRevision(
	destinationRoot: string,
	expectedRevision: number,
	record: Omit<ProductLifecycleRecord, "revision">,
): Promise<ProductLifecycleRecord> {
	const { revisionsRoot } = await ensureLifecycleDirectories(destinationRoot);
	const revision = expectedRevision + 1;
	if (expectedRevision >= MAX_LIFECYCLE_REVISIONS) fail("product lifecycle revision capacity is exhausted");
	const published = Object.freeze({ ...record, revision }) satisfies ProductLifecycleRecord;
	const pending = join(revisionsRoot, `.pending-${revision}-${randomUUID()}.json`);
	const finalPath = join(revisionsRoot, `revision-${revision}.json`);
	const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
	try {
		await file.writeFile(`${JSON.stringify(published)}\n`);
		await file.sync();
		await file.chmod(0o400);
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		try {
			renameNoReplace(pending, finalPath);
		} catch (error) {
			fail(`product lifecycle CAS lost for revision ${revision}`, error);
		}
		await syncDirectory(revisionsRoot);
		await syncDirectory(dirname(revisionsRoot));
		return published;
	} finally {
		await rm(pending, { force: true });
	}
}

function candidateFromManifest(manifest: Record<string, unknown>): ProductLifecycleRoot {
	if (
		!isSemver(manifest.productVersion) ||
		!validArchiveDigest(manifest.archiveSha256) ||
		!validArchiveDigest(manifest.rootSha256)
	) {
		fail("verified product archive has no valid product identity");
	}
	return Object.freeze({
		rootName: expectedRootName(manifest.productVersion),
		target: targetKey(),
		version: manifest.productVersion,
		archiveSha256: manifest.archiveSha256,
		treeSha256: manifest.rootSha256,
	});
}

async function rootMetadata(path: string, label: string): Promise<{ readonly device: number; readonly inode: number }> {
	const metadata = await lstat(path).catch(error => fail(`${label} is unavailable`, error));
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		!Number.isSafeInteger(metadata.dev) ||
		!Number.isSafeInteger(metadata.ino)
	)
		fail(`${label} must be one regular directory with a safe identity`);
	return { device: metadata.dev, inode: metadata.ino };
}

function sameDirectoryIdentity(
	left: { readonly device: number; readonly inode: number },
	right: { readonly device: number; readonly inode: number },
): boolean {
	return left.device === right.device && left.inode === right.inode;
}

async function installedTreeIdentity(root: string): Promise<ReadonlyMap<string, string>> {
	const effectiveUser = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUser === undefined) fail("installed product ownership cannot be verified");
	const identities = new Map<string, string>();
	const verify = async (path: string, relative: string, expectedMode: number): Promise<void> => {
		const metadata = await lstat(path).catch(error =>
			fail(`installed product entry is unavailable: ${relative}`, error),
		);
		if (
			metadata.isSymbolicLink() ||
			(!metadata.isDirectory() && !metadata.isFile()) ||
			metadata.uid !== effectiveUser ||
			(metadata.mode & 0o777) !== expectedMode
		)
			fail(`installed product entry has unsafe ownership or mode: ${relative}`);
		identities.set(
			relative,
			`${metadata.dev}:${metadata.ino}:${metadata.uid}:${metadata.mode & 0o777}:${metadata.size}:${metadata.ctimeMs}:${metadata.mtimeMs}:${metadata.isDirectory() ? "d" : "f"}`,
		);
		if (metadata.isDirectory()) {
			const entries = await readdir(path, { withFileTypes: true });
			entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
			for (const entry of entries) {
				await verify(join(path, entry.name), `${relative}/${entry.name}`, entry.isDirectory() ? 0o500 : 0o400);
			}
		}
	};
	const metadata = await lstat(root).catch(error => fail("installed product root is unavailable", error));
	if (
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		metadata.uid !== effectiveUser ||
		(metadata.mode & 0o777) !== 0o700
	)
		fail("installed product root has unsafe ownership or mode");
	identities.set(
		".",
		`${metadata.dev}:${metadata.ino}:${metadata.uid}:${metadata.mode & 0o777}:${metadata.size}:${metadata.ctimeMs}:${metadata.mtimeMs}:d`,
	);
	const entries = await readdir(root, { withFileTypes: true });
	entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
	for (const entry of entries) {
		const expectedMode = entry.name === "bb" ? 0o500 : entry.isDirectory() ? 0o500 : 0o400;
		await verify(join(root, entry.name), entry.name, expectedMode);
	}
	return identities;
}

function sameTreeIdentity(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
	return left.size === right.size && [...left].every(([path, identity]) => right.get(path) === identity);
}

function retirementName(identity: { readonly device: number; readonly inode: number }): string {
	return `.bb-retire-${BigInt.asUintN(64, BigInt(identity.device)).toString(16)}-${BigInt.asUintN(64, BigInt(identity.inode)).toString(16)}`;
}

async function verifyInstalledRoot(root: ProductLifecycleRoot, destinationRoot: string): Promise<void> {
	const path = join(destinationRoot, root.rootName);
	const before = await rootMetadata(path, `product root ${root.rootName}`);
	const beforeTree = await installedTreeIdentity(path);
	const verified = await verifyProductRoot(path, root.rootName);
	const afterTree = await installedTreeIdentity(path);
	const after = await rootMetadata(path, `product root ${root.rootName}`);
	if (!sameDirectoryIdentity(before, after) || !sameTreeIdentity(beforeTree, afterTree))
		fail(`product root ${root.rootName} changed during verification`);
	if (verified.manifest.productVersion !== root.version || verified.treeSha256 !== root.treeSha256)
		fail(`product root ${root.rootName} has a conflicting identity`);
}

async function collectResidue(
	destinationRoot: string,
	active: ProductLifecycleRoot | null,
	retained: readonly ProductLifecycleRoot[],
): Promise<readonly string[]> {
	const expected = new Set<string>();
	if (active !== null) expected.add(active.rootName);
	for (const root of retained) {
		expected.add(root.rootName);
		await verifyInstalledRoot(root, destinationRoot);
	}
	if (active !== null) await verifyInstalledRoot(active, destinationRoot);
	const residue: string[] = [];
	for (const entry of await readdir(destinationRoot, { withFileTypes: true })) {
		if (entry.name === PRODUCT_STATE_DIRECTORY) continue;
		if (!safeRelativePath(entry.name)) fail("product destination contains an unsafe path");
		const path = join(destinationRoot, entry.name);
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
			fail(`product destination contains unsafe entry: ${entry.name}`);
		if (entry.isDirectory() && ROOT.test(entry.name)) {
			await rootMetadata(path, `product root ${entry.name}`);
			await verifyProductRoot(path, entry.name);
			if (!expected.has(entry.name)) residue.push(entry.name);
			continue;
		}
		if (entry.name.startsWith("bb-") && !entry.isDirectory()) fail(`product root ${entry.name} is not a directory`);
		if (entry.isFile()) {
			const metadata = await lstat(path);
			if (metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0)
				fail(`product residue is not private: ${entry.name}`);
		}
		residue.push(entry.name);
	}
	return Object.freeze(residue.sort());
}

async function installOrRecoverCandidate(
	archiveBytes: Buffer,
	destinationRoot: string,
	candidate: ProductLifecycleRoot,
	known: ProductLifecycleRoot | undefined,
	options: ProductArchiveTrustOptions,
): Promise<void> {
	const path = join(destinationRoot, candidate.rootName);
	let existing = true;
	try {
		await lstat(path);
	} catch (error) {
		if (!isMissingError(error)) throw error;
		existing = false;
	}
	if (existing) {
		if (known === undefined) fail("unbound product root cannot be adopted");
		if (!sameRoot(known, candidate)) fail("archive conflicts with an immutable installed root");
		await verifyInstalledRoot(candidate, destinationRoot);
		return;
	}
	await installProductArchiveBytes(archiveBytes, destinationRoot, true, options);
}

function retainedAfterActivation(
	candidate: ProductLifecycleRoot,
	previous: readonly ProductLifecycleRoot[],
): readonly ProductLifecycleRoot[] {
	return Object.freeze(previous.filter(root => root.rootName !== candidate.rootName));
}

async function managedRecord(
	destinationRoot: string,
): Promise<{ readonly state: LifecycleState; readonly residue: readonly string[] }> {
	const state = await readLifecycleState(destinationRoot);
	if (state.record === null) return { state, residue: Object.freeze([]) };
	const residue = await collectResidue(destinationRoot, state.record.active, state.record.retained);
	return { state, residue };
}

function outputRecord(record: ProductLifecycleRecord, residue: readonly string[]): ProductLifecycleRecord {
	return Object.freeze({ ...record, residue: Object.freeze([...residue]) });
}

async function installManagedProductArchiveUnlocked(
	archivePath: string,
	destinationRoot: string,
	options: ProductArchiveTrustOptions,
): Promise<ProductLifecycleRecord> {
	const archiveBytes = await privateRegular(archivePath, MAX_ARCHIVE_BYTES);
	const candidate = candidateFromManifest(await verifyProductArchiveBytes(archiveBytes, options));
	const inspected = await managedRecord(destinationRoot);
	const pendingRemoval = inspected.state.record?.removal;
	if (pendingRemoval !== null && pendingRemoval !== undefined)
		fail("interrupted product uninstall cleanup must be resumed before install");
	if (inspected.state.record?.active !== null && inspected.state.record?.active !== undefined)
		fail("a product is already active; use update");
	const known = inspected.state.record?.retained.find(root => root.rootName === candidate.rootName);
	await installOrRecoverCandidate(archiveBytes, destinationRoot, candidate, known, options);
	const retained =
		inspected.state.record === null ? [] : retainedAfterActivation(candidate, inspected.state.record.retained);
	const residue = await collectResidue(destinationRoot, candidate, retained);
	const published = await publishLifecycleRevision(destinationRoot, inspected.state.revision, {
		schema: LIFECYCLE_SCHEMA,
		action: "install",
		allowDowngrade: false,
		active: candidate,
		retained,
		removal: null,
		removed: (inspected.state.record?.removed ?? []).filter(rootName => rootName !== candidate.rootName),
		residue,
	});
	return outputRecord(published, await collectResidue(destinationRoot, published.active, published.retained));
}

export interface ProductLifecycleUpdateOptions extends ProductArchiveTrustOptions {
	readonly allowDowngrade?: boolean;
}

async function updateManagedProductArchiveUnlocked(
	archivePath: string,
	destinationRoot: string,
	options: ProductLifecycleUpdateOptions = {},
): Promise<ProductLifecycleRecord> {
	const archiveBytes = await privateRegular(archivePath, MAX_ARCHIVE_BYTES);
	const candidate = candidateFromManifest(await verifyProductArchiveBytes(archiveBytes, options));
	const inspected = await managedRecord(destinationRoot);
	const previous = inspected.state.record;
	if (previous === null || previous.active === null) fail("cannot update without an active product");
	const comparison = compareProductVersions(candidate.version, previous.active.version);
	if (comparison === 0) {
		if (!sameRoot(previous.active, candidate)) fail("same-version product archive conflicts with the active release");
		await verifyInstalledRoot(previous.active, destinationRoot);
		return outputRecord(previous, await collectResidue(destinationRoot, previous.active, previous.retained));
	}
	if (comparison < 0 && options.allowDowngrade !== true) fail("product downgrade requires explicit authorization");
	if (inspected.state.revision >= MAX_LIFECYCLE_REVISIONS) fail("product lifecycle revision capacity is exhausted");
	const known = [...(previous.retained ?? []), previous.active].find(root => root.rootName === candidate.rootName);
	await installOrRecoverCandidate(archiveBytes, destinationRoot, candidate, known, options);
	const retained = Object.freeze([previous.active, ...retainedAfterActivation(candidate, previous.retained)]);
	const residue = await collectResidue(destinationRoot, candidate, retained);
	const published = await publishLifecycleRevision(destinationRoot, inspected.state.revision, {
		schema: LIFECYCLE_SCHEMA,
		action: "update",
		allowDowngrade: comparison < 0,
		active: candidate,
		retained,
		removal: null,
		removed: previous.removed.filter(rootName => rootName !== candidate.rootName),
		residue,
	});
	return outputRecord(published, await collectResidue(destinationRoot, published.active, published.retained));
}

async function rollbackManagedProductArchiveUnlocked(destinationRoot: string): Promise<ProductLifecycleRecord> {
	const inspected = await managedRecord(destinationRoot);
	const previous = inspected.state.record;
	if (previous === null || previous.active === null) fail("cannot roll back without an active product");
	const predecessor = previous.retained[0];
	if (predecessor === undefined) fail("cannot roll back without a retained predecessor");
	await verifyInstalledRoot(predecessor, destinationRoot);
	const retained = Object.freeze([previous.active, ...previous.retained.slice(1)]);
	const residue = await collectResidue(destinationRoot, predecessor, retained);
	const published = await publishLifecycleRevision(destinationRoot, inspected.state.revision, {
		schema: LIFECYCLE_SCHEMA,
		action: "rollback",
		allowDowngrade: false,
		active: predecessor,
		retained,
		removal: null,
		removed: previous.removed,
		residue,
	});
	return outputRecord(published, await collectResidue(destinationRoot, published.active, published.retained));
}

async function publishCompletedUninstall(
	destinationRoot: string,
	pending: ProductLifecycleRecord,
	residue: readonly string[],
): Promise<ProductLifecycleRecord> {
	return await publishLifecycleRevision(destinationRoot, pending.revision, {
		schema: LIFECYCLE_SCHEMA,
		action: "cleanup",
		allowDowngrade: false,
		active: null,
		retained: pending.retained,
		removal: null,
		removed: pending.removed,
		residue,
	});
}

async function completePendingRemoval(
	destinationRoot: string,
	pending: ProductLifecycleRecord,
	previous: ProductLifecycleRecord | null,
): Promise<ProductLifecycleRecord> {
	const removal = pending.removal;
	const removedRoot = previous?.active ?? previous?.retained.find(root => root.rootName === removal?.rootName);
	if (
		pending.action !== "uninstall" ||
		pending.active !== null ||
		removal === null ||
		removedRoot === undefined ||
		removal.rootName !== removedRoot.rootName ||
		!pending.removed.includes(removedRoot.rootName)
	)
		fail("interrupted product uninstall state is invalid");
	const activePath = join(destinationRoot, removedRoot.rootName);
	const retiredPath = join(destinationRoot, removal.retirementName);
	let cleanupPath: string | null = activePath;
	try {
		await lstat(activePath);
	} catch (error) {
		if (!isMissingError(error)) throw error;
		cleanupPath = retiredPath;
		try {
			await lstat(retiredPath);
		} catch (retiredError) {
			if (!isMissingError(retiredError)) throw retiredError;
			cleanupPath = null;
		}
	}
	if (cleanupPath !== null) {
		const identity = await rootMetadata(cleanupPath, `removed product root ${removedRoot.rootName}`);
		if (retirementName(identity) !== removal.retirementName)
			fail("interrupted product uninstall cleanup identity changed");
		if (cleanupPath === activePath) await verifyInstalledRoot(removedRoot, destinationRoot);
		await removePinnedDirectoryTree(cleanupPath, identity);
		await syncDirectory(destinationRoot);
	}
	const residue = await collectResidue(destinationRoot, null, pending.retained);
	if (residue.includes(removedRoot.rootName) || residue.includes(removal.retirementName))
		fail(`product uninstall left ${removedRoot.rootName} as residue`);
	return await publishCompletedUninstall(destinationRoot, pending, residue);
}

async function uninstallManagedProductArchiveUnlocked(destinationRoot: string): Promise<ProductLifecycleRecord> {
	let inspected = await managedRecord(destinationRoot);
	let current = inspected.state.record;
	if (current === null) fail("cannot uninstall without an active product");
	for (;;) {
		if (current.removal !== null) {
			current = await completePendingRemoval(destinationRoot, current, inspected.state.previousRecord);
			inspected = await managedRecord(destinationRoot);
			continue;
		}
		const removedRoot = current.active ?? current.retained[0];
		if (removedRoot === undefined) return outputRecord(current, await collectResidue(destinationRoot, null, []));
		await verifyInstalledRoot(removedRoot, destinationRoot);
		const path = join(destinationRoot, removedRoot.rootName);
		const identity = await rootMetadata(path, `installed product root ${removedRoot.rootName}`);
		const retained = current.active === null ? current.retained.slice(1) : current.retained;
		const residue = await collectResidue(destinationRoot, null, retained);
		const removal = Object.freeze({
			rootName: removedRoot.rootName,
			retirementName: retirementName(identity),
		});
		const pending = await publishLifecycleRevision(destinationRoot, current.revision, {
			schema: LIFECYCLE_SCHEMA,
			action: "uninstall",
			allowDowngrade: false,
			active: null,
			retained,
			removal,
			removed: Object.freeze([
				...current.removed.filter(rootName => rootName !== removedRoot.rootName),
				removedRoot.rootName,
			]),
			residue,
		});
		current = await completePendingRemoval(destinationRoot, pending, current);
		inspected = await managedRecord(destinationRoot);
	}
}

async function statusManagedProductArchiveUnlocked(destinationRoot: string): Promise<ProductLifecycleRecord> {
	const inspected = await managedRecord(destinationRoot);
	if (inspected.state.record === null) {
		const residue = await collectResidue(destinationRoot, null, []);
		return Object.freeze({
			schema: LIFECYCLE_SCHEMA,
			revision: 0,
			action: "status",
			allowDowngrade: false,
			active: null,
			retained: Object.freeze([]),
			removal: null,
			removed: Object.freeze([]),
			residue,
		});
	}
	return outputRecord(inspected.state.record, inspected.residue);
}

export async function installManagedProductArchive(
	archivePath: string,
	destinationRoot: string,
	options: ProductArchiveTrustOptions = {},
): Promise<ProductLifecycleRecord> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	return await withLifecycleMutationLock(destinationPath, () =>
		installManagedProductArchiveUnlocked(archivePath, destinationPath, options),
	);
}

export async function updateManagedProductArchive(
	archivePath: string,
	destinationRoot: string,
	options: ProductLifecycleUpdateOptions = {},
): Promise<ProductLifecycleRecord> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	return await withLifecycleMutationLock(
		destinationPath,
		() => updateManagedProductArchiveUnlocked(archivePath, destinationPath, options),
		0,
	);
}

export async function rollbackManagedProductArchive(destinationRoot: string): Promise<ProductLifecycleRecord> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	return await withLifecycleMutationLock(destinationPath, () =>
		rollbackManagedProductArchiveUnlocked(destinationPath),
	);
}

export async function uninstallManagedProductArchive(destinationRoot: string): Promise<ProductLifecycleRecord> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	return await withLifecycleMutationLock(
		destinationPath,
		() => uninstallManagedProductArchiveUnlocked(destinationPath),
		state => {
			const record = state.record;
			if (record === null) return 0;
			const pendingCleanup = record.removal === null ? 0 : 1;
			const remainingRoots = record.retained.length + (record.active === null ? 0 : 1);
			return pendingCleanup + remainingRoots * 2;
		},
	);
}

export async function statusManagedProductArchive(destinationRoot: string): Promise<ProductLifecycleRecord> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	return await withLifecycleLock(destinationPath, () => statusManagedProductArchiveUnlocked(destinationPath));
}

function parseArchiveTrustFlags(flags: readonly string[], allowDowngradeFlag: boolean): ProductLifecycleUpdateOptions {
	let allowDowngrade = false;
	let allowUnsignedDevelopment = false;
	let expectedArchiveSha256: `sha256:${string}` | undefined;
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--allow-downgrade" && allowDowngradeFlag && !allowDowngrade) {
			allowDowngrade = true;
			continue;
		}
		if (flag === "--allow-unsigned-development" && !allowUnsignedDevelopment) {
			allowUnsignedDevelopment = true;
			continue;
		}
		if (flag === "--expected-archive-sha256" && expectedArchiveSha256 === undefined) {
			const value = flags[++index];
			if (value !== undefined && /^sha256:[0-9a-f]{64}$/.test(value)) {
				expectedArchiveSha256 = value as `sha256:${string}`;
				continue;
			}
		}
		fail(`invalid or duplicate product lifecycle option: ${flag ?? "<missing>"}`);
	}
	return { allowDowngrade, allowUnsignedDevelopment, expectedArchiveSha256 };
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const action = args[0];
	if (action === "install") {
		if (args.length < 3)
			fail(
				"usage: bun scripts/install-product-release.ts install <archive.tar.gz> <destination> [--allow-unsigned-development] [--expected-archive-sha256 <sha256:...>]",
			);
		const options = parseArchiveTrustFlags(args.slice(3), false);
		process.stdout.write(
			`${JSON.stringify(await installManagedProductArchive(args[1] as string, args[2] as string, options))}\n`,
		);
	} else if (action === "update") {
		if (args.length < 3)
			fail(
				"usage: bun scripts/install-product-release.ts update <archive.tar.gz> <destination> [--allow-downgrade] [--allow-unsigned-development] [--expected-archive-sha256 <sha256:...>]",
			);
		const options = parseArchiveTrustFlags(args.slice(3), true);
		process.stdout.write(
			`${JSON.stringify(await updateManagedProductArchive(args[1] as string, args[2] as string, options))}\n`,
		);
	} else if (action === "rollback") {
		if (args.length !== 2) fail("usage: bun scripts/install-product-release.ts rollback <destination>");
		process.stdout.write(`${JSON.stringify(await rollbackManagedProductArchive(args[1] as string))}\n`);
	} else if (action === "uninstall") {
		if (args.length !== 2) fail("usage: bun scripts/install-product-release.ts uninstall <destination>");
		process.stdout.write(`${JSON.stringify(await uninstallManagedProductArchive(args[1] as string))}\n`);
	} else if (action === "status") {
		if (args.length !== 2) fail("usage: bun scripts/install-product-release.ts status <destination>");
		process.stdout.write(`${JSON.stringify(await statusManagedProductArchive(args[1] as string))}\n`);
	} else {
		if (!args[0] || !args[1])
			fail(
				"usage: bun scripts/install-product-release.ts <archive.tar.gz> <destination> [--allow-unsigned-development] [--expected-archive-sha256 <sha256:...>]",
			);
		const options = parseArchiveTrustFlags(args.slice(2), false);
		process.stdout.write(`${JSON.stringify(await installProductArchive(args[0], args[1], options))}\n`);
	}
}
