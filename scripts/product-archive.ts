#!/usr/bin/env bun

import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export interface ProductReleaseTarget {
	readonly platform: "darwin";
	readonly architecture: "arm64";
}

export const PRODUCT_TARGET: ProductReleaseTarget = Object.freeze({
	platform: "darwin",
	architecture: "arm64",
});
import { BREADBOARD_DISTRIBUTION_POLICY } from "../packages/utils/src/product-distribution";
import { isRecord } from "../packages/utils/src/type-guards";

const INSTALL_SCHEMA = "bb.product_install_manifest.v1";
const ARCHIVE_SCHEMA = "bb.product_archive.v1";
const ROOT = /^bb-darwin-arm64-[0-9A-Za-z.-]+$/;
const HEX = /^[0-9a-f]{64}$/;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const PRODUCT_BINARY_PATH = "bb";
const PRODUCT_NATIVE_ADDON_PATH = "native/pi_natives.darwin-arm64.node";
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_CONTROL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_LISTING_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 512;
const SEMVER_PATTERN =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const DARWIN_SYMBOLS = {
	renameatx_np: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	__error: { args: [], returns: FFIType.ptr },
} as const;

type Digest = `sha256:${string}`;

export interface ProductArchiveTrustOptions {
	readonly allowUnsignedDevelopment?: boolean;
	readonly expectedArchiveSha256?: Digest;
}

interface VerifiedProductArchive extends VerifiedRoot {
	readonly target: string;
	readonly archiveSha256: Digest;
}

export interface ProductArchive extends VerifiedProductArchive {
	install(destinationRoot: string): Promise<string>;
}

interface VerifiedRoot {
	readonly rootName: string;
	readonly productVersion: string;
	readonly treeSha256: Digest;
	readonly manifest: Record<string, unknown>;
}

export function targetKey(target = PRODUCT_TARGET): string {
	return `${target.platform}-${target.architecture}`;
}
async function chmodTreeForRemoval(root: string): Promise<void> {
	await chmod(root, 0o700).catch(() => undefined);
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = join(root, entry.name);
		if (entry.isDirectory()) {
			await chmodTreeForRemoval(child);
		} else {
			await chmod(child, 0o600).catch(() => undefined);
		}
	}
	await chmod(root, 0o700).catch(() => undefined);
}

export async function removePinnedDirectoryTree(
	path: string,
	expected?: { readonly device: number | bigint; readonly inode: number | bigint },
): Promise<void> {
	if (expected !== undefined) {
		const stat = await lstat(path).catch(() => undefined);
		if (stat && (stat.dev !== Number(expected.device) || stat.ino !== Number(expected.inode))) {
			throw new Error("directory identity changed before removal");
		}
	}
	await chmodTreeForRemoval(path);
	await rm(path, { recursive: true, force: true });
}

function fail(message: string, cause?: unknown): never {
	throw new Error(message, cause === undefined ? undefined : { cause });
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function privateRegular(path: string, maxBytes = MAX_CONTROL_FILE_BYTES): Promise<Buffer> {
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

export function safeRelativePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.startsWith("/") &&
		value.split("/").every(component => component.length > 0 && component !== "." && component !== "..")
	);
}
export function isMissingError(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function manifestRecord(value: unknown, message: string): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) fail(message);
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

export function isSemver(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = SEMVER_PATTERN.exec(value);
	if (value.includes("+") || match === null) return false;
	return !(match[1]?.split(".").some(identifier => /^0\d+$/.test(identifier)) ?? false);
}
export async function verifyProductRoot(root: string, rootName: string): Promise<VerifiedRoot> {
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
	const legal = manifestRecord(manifest.legal, "install manifest legal posture is invalid");
	if (manifest.classification === "release-candidate") {
		if (
			legal.posture !== "release-ready" ||
			legal.inputsPresent !== true ||
			!files.includes("LICENSE") ||
			!files.includes("THIRD_PARTY_NOTICES.txt")
		)
			fail("release candidate is missing legal inputs");
	} else if (manifest.classification !== "development-evidence" || legal.posture !== "unsigned-development") {
		fail("archive classification is invalid");
	}
	return {
		rootName,
		productVersion: manifest.productVersion,
		manifest,
		treeSha256: `sha256:${sha256(checksumsBytes)}`,
	};
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
async function verifyExtracted(root: string): Promise<VerifiedRoot> {
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.length !== 1 || !entries[0]?.isDirectory() || !ROOT.test(entries[0].name))
		fail("archive must contain exactly one target-named root directory");
	const rootName = entries[0].name;
	return await verifyProductRoot(join(root, rootName), rootName);
}

export function renameNoReplace(source: string, destination: string): void {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product install is unsupported on ${process.platform}/${process.arch}`);
	const from = ptr(Buffer.from(`${source}\0`));
	const to = ptr(Buffer.from(`${destination}\0`));
	const lib = dlopen("/usr/lib/libSystem.B.dylib", DARWIN_SYMBOLS);
	try {
		const result = Number(lib.symbols.renameatx_np(-2, from, -2, to, 4));
		if (result !== 0) {
			const address = lib.symbols.__error();
			if (address === null) fail("atomic product install failed without errno");
			fail(`atomic product install failed with errno ${read.i32(address)}`);
		}
	} finally {
		lib.close();
	}
}

interface StagedArchive {
	readonly payloadRoot: string;
	readonly verified: VerifiedProductArchive;
}

async function stageAndVerify(
	parent: string,
	bytes: Buffer,
	options: ProductArchiveTrustOptions,
	validatePayload: boolean,
): Promise<StagedArchive> {
	if (validatePayload) await validateArchivePayload(bytes);
	const staged = await stageArchive(parent, bytes);
	await validateArchiveNames(staged.archivePath);
	await runTarExtract(staged.archivePath, staged.payloadRoot);
	const root = await verifyExtracted(staged.payloadRoot);
	const archiveSha256 = `sha256:${sha256(bytes)}` as `sha256:${string}`;
	requireInstallableTrust(root.manifest, options, archiveSha256);
	return {
		payloadRoot: staged.payloadRoot,
		verified: Object.freeze({
			...root,
			target: targetKey(),
			archiveSha256,
		}),
	};
}

export async function openProductArchive(
	archivePath: string,
	options: ProductArchiveTrustOptions = {},
): Promise<ProductArchive> {
	const bytes = await privateRegular(archivePath, MAX_ARCHIVE_BYTES);
	const root = await mkdtemp(join("/tmp", "bb-archive-"));
	try {
		const { verified } = await stageAndVerify(root, bytes, options, true);
		return Object.freeze({
			...verified,
			install: (destinationRoot: string) => installProductArchiveBytes(bytes, destinationRoot, true, options),
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
	const verified = await openProductArchive(archivePath, options);
	return Object.freeze({
		...verified.manifest,
		archiveSha256: verified.archiveSha256,
		rootSha256: verified.treeSha256,
	});
}

async function installProductArchiveBytes(
	bytes: Buffer,
	destinationRoot: string,
	payloadValidated: boolean,
	options: ProductArchiveTrustOptions = {},
): Promise<string> {
	const destinationPath = await ensureDestinationRoot(destinationRoot);
	const stage = await mkdtemp(join(destinationPath, ".bb-install-"));
	const stageIdentity = await lstat(stage);
	if (
		!stageIdentity.isDirectory() ||
		stageIdentity.isSymbolicLink() ||
		(typeof process.geteuid === "function" && stageIdentity.uid !== process.geteuid())
	)
		fail("product install staging root identity is invalid");
	try {
		const staged = await stageAndVerify(stage, bytes, options, !payloadValidated);
		const source = join(staged.payloadRoot, staged.verified.rootName);
		const destination = join(destinationPath, staged.verified.rootName);
		await chmod(join(source, PRODUCT_BINARY_PATH), 0o500);
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
export async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
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

async function inspectTrustedPathComponents(path: string, label: string, createMissing: boolean): Promise<void> {
	const effectiveUser = typeof process.geteuid === "function" ? process.geteuid() : undefined;
	if (effectiveUser === undefined) fail(`${label} ownership cannot be verified`);
	let current = "/";
	const components = resolve(path)
		.split("/")
		.filter(component => component.length > 0);
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		let created = false;
		const metadata = await lstat(current).catch(async error => {
			if (!createMissing || !isMissingError(error)) throw error;
			try {
				await mkdir(current, { mode: 0o700 });
				created = true;
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
			}
			return await lstat(current);
		});
		const isDestination = index === components.length - 1;
		if (metadata.uid !== 0 && metadata.uid !== effectiveUser)
			fail(`${label} has a path component owned by another user`);
		if (metadata.isSymbolicLink()) {
			if (createMissing) fail(`${label} has a symbolic-link path component`);
			continue;
		}
		if (!metadata.isDirectory()) fail(`${label} has a non-directory path component`);
		if ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0)
			fail(`${label} has non-sticky group- or world-writable path component`);
		if (createMissing && isDestination && (metadata.uid !== effectiveUser || (metadata.mode & 0o777) !== 0o700))
			fail(`${label} must be one private directory owned by the effective user`);
		if (created) {
			await syncDirectory(current);
			await syncDirectory(dirname(current));
		}
	}
}

export async function ensureDestinationRoot(destinationRoot: string): Promise<string> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product lifecycle is unsupported on ${process.platform}/${process.arch}`);
	const requested = resolve(destinationRoot);
	await inspectTrustedPathComponents(requested, "product install root", true);
	await inspectTrustedPathComponents(requested, "product install root", false);
	const canonical = await realpath(requested);
	await inspectTrustedPathComponents(canonical, "canonical product install root", false);
	await ensurePrivateDirectory(canonical, "canonical product install root");
	await syncDirectory(canonical);
	await syncDirectory(dirname(canonical));
	return canonical;
}

export async function syncDirectory(path: string): Promise<void> {
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
		if (entry.isDirectory() && !entry.isSymbolicLink()) await syncTree(path);
		else if (entry.isFile() && !entry.isSymbolicLink()) await syncRegularFile(path);
		else fail(`product tree contains an unsafe entry during durability sync: ${entry.name}`);
	}
	await syncDirectory(root);
}
