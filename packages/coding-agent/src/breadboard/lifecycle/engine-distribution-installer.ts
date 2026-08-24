import { dlopen, FFIType, type Library, ptr, read } from "bun:ffi";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
	canonicalEngineDistributionManifest,
	ENGINE_DISTRIBUTION_MANIFEST_FILENAME,
	type EngineDistributionManifest,
} from "./installed-engine-manifest";

const AT_FDCWD = -2;
const RENAME_EXCL = 0x00000004;
const EEXIST = 17;
const IO_CHUNK_BYTES = 1024 * 1024;
const DISTRIBUTION_DIRECTORY = /^[0-9a-f]{64}$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const SYSTEM_SYMBOLS = {
	renameatx_np: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	__error: { args: [], returns: FFIType.ptr },
} as const;

type SystemLibrary = Library<typeof SYSTEM_SYMBOLS>;
let systemLibrary: SystemLibrary | undefined;

export class EngineDistributionInstallError extends Error {
	override readonly name = "EngineDistributionInstallError";
}

export interface InstalledEngineDistribution {
	readonly distributionPath: string;
	readonly manifestPath: string;
	readonly bundlePath: string;
	readonly retainedDistributionPaths: readonly string[];
}

function fail(message: string, cause?: unknown): never {
	throw new EngineDistributionInstallError(message, cause === undefined ? undefined : { cause });
}

function system(): SystemLibrary {
	if (process.platform !== "darwin")
		return fail(`atomic engine distribution placement is unsupported on ${process.platform}`);
	systemLibrary ??= dlopen("/usr/lib/libSystem.B.dylib", SYSTEM_SYMBOLS);
	return systemLibrary;
}

function cString(value: string): Buffer {
	if (value.length === 0 || value.includes("\0")) return fail("atomic engine distribution path is invalid");
	return Buffer.from(`${value}\0`, "utf8");
}

function currentErrno(library: SystemLibrary): number {
	const address = library.symbols.__error();
	return address === null ? 0 : read.i32(address);
}

function renameExclusive(source: string, destination: string): "renamed" | "exists" {
	const library = system();
	const result = Number(
		library.symbols.renameatx_np(AT_FDCWD, ptr(cString(source)), AT_FDCWD, ptr(cString(destination)), RENAME_EXCL),
	);
	if (result === 0) return "renamed";
	const errno = currentErrno(library);
	if (errno === EEXIST) return "exists";
	return fail(`atomic engine distribution rename failed with errno ${errno}`);
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function writeExactFile(path: string, bytes: Uint8Array): Promise<void> {
	const output = await open(path, WRITE_FLAGS, 0o600);
	try {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const { bytesWritten } = await output.write(bytes, offset, bytes.byteLength - offset, offset);
			if (bytesWritten === 0) return fail("engine distribution manifest write made no progress");
			offset += bytesWritten;
		}
		await output.sync();
		await output.chmod(0o400);
	} finally {
		await output.close();
	}
}

async function copyVerifiedBundle(input: {
	readonly sourcePath: string;
	readonly destinationPath: string;
	readonly expectedSizeBytes: number;
	readonly expectedSha256: string;
}): Promise<void> {
	const source = await open(input.sourcePath, READ_FLAGS);
	let destination: FileHandle | undefined;
	try {
		const sourceMetadata = await source.stat();
		if (
			!sourceMetadata.isFile() ||
			sourceMetadata.nlink !== 1 ||
			sourceMetadata.mode & 0o022 ||
			sourceMetadata.size !== input.expectedSizeBytes
		) {
			return fail("engine runtime bundle source identity is invalid");
		}
		destination = await open(input.destinationPath, WRITE_FLAGS, 0o600);
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
		let position = 0;
		while (position < sourceMetadata.size) {
			const length = Math.min(buffer.byteLength, sourceMetadata.size - position);
			const { bytesRead } = await source.read(buffer, 0, length, position);
			if (bytesRead === 0) return fail("engine runtime bundle source ended unexpectedly");
			digest.update(buffer.subarray(0, bytesRead));
			let written = 0;
			while (written < bytesRead) {
				const result = await destination.write(buffer, written, bytesRead - written, position + written);
				if (result.bytesWritten === 0) return fail("engine runtime bundle copy made no progress");
				written += result.bytesWritten;
			}
			position += bytesRead;
		}
		if (`sha256:${digest.digest("hex")}` !== input.expectedSha256) {
			return fail("engine runtime bundle source digest changed");
		}
		await destination.sync();
		await destination.chmod(0o400);
		await destination.close();
		destination = undefined;
	} finally {
		await Promise.allSettled([source.close(), destination?.close()]);
	}
}

function containedChild(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function verifyExistingDistribution(input: {
	readonly root: string;
	readonly distributionPath: string;
	readonly manifestBytes: Buffer;
	readonly manifest: EngineDistributionManifest;
}): Promise<void> {
	const canonicalRoot = await realpath(input.root);
	const canonicalDistribution = await realpath(input.distributionPath).catch(error =>
		fail("existing content-addressed engine distribution is unavailable", error),
	);
	if (!containedChild(canonicalRoot, canonicalDistribution)) {
		return fail("existing content-addressed engine distribution escapes its root");
	}
	const distributionMetadata = await lstat(canonicalDistribution);
	if (
		!distributionMetadata.isDirectory() ||
		distributionMetadata.isSymbolicLink() ||
		(distributionMetadata.mode & 0o777) !== 0o500
	) {
		return fail("existing content-addressed engine distribution directory is invalid");
	}
	const expectedNames = [ENGINE_DISTRIBUTION_MANIFEST_FILENAME, input.manifest.engine.runtimeBundle.path].sort();
	const actualNames = (await readdir(canonicalDistribution)).sort();
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		return fail("existing content-addressed engine distribution is partial or contains unknown files");
	}
	const manifestPath = join(canonicalDistribution, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
	const manifestSource = await open(manifestPath, READ_FLAGS);
	try {
		const manifestMetadata = await manifestSource.stat();
		if (
			!manifestMetadata.isFile() ||
			manifestMetadata.nlink !== 1 ||
			(manifestMetadata.mode & 0o777) !== 0o400 ||
			manifestMetadata.size !== input.manifestBytes.byteLength
		) {
			return fail("existing content-addressed engine distribution manifest identity differs");
		}
		if (!(await manifestSource.readFile()).equals(input.manifestBytes)) {
			return fail("existing content-addressed engine distribution manifest differs");
		}
	} finally {
		await manifestSource.close();
	}
	const bundlePath = join(canonicalDistribution, input.manifest.engine.runtimeBundle.path);
	const source = await open(bundlePath, READ_FLAGS);
	try {
		const bundleMetadata = await source.stat();
		if (
			!bundleMetadata.isFile() ||
			bundleMetadata.nlink !== 1 ||
			(bundleMetadata.mode & 0o777) !== 0o400 ||
			bundleMetadata.size !== input.manifest.engine.runtimeBundle.sizeBytes
		) {
			return fail("existing content-addressed engine runtime bundle identity differs");
		}
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
		let position = 0;
		while (position < bundleMetadata.size) {
			const length = Math.min(buffer.byteLength, bundleMetadata.size - position);
			const { bytesRead } = await source.read(buffer, 0, length, position);
			if (bytesRead === 0) return fail("existing engine runtime bundle ended unexpectedly");
			digest.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		if (`sha256:${digest.digest("hex")}` !== input.manifest.engine.runtimeBundle.sha256) {
			return fail("existing content-addressed engine runtime bundle digest differs");
		}
	} finally {
		await source.close();
	}
}

export async function installEngineDistributionAtomically(input: {
	readonly root: string;
	readonly manifest: EngineDistributionManifest;
	readonly bundlePath: string;
}): Promise<InstalledEngineDistribution> {
	if (
		!isAbsolute(input.root) ||
		input.root.includes("\0") ||
		!isAbsolute(input.bundlePath) ||
		input.bundlePath.includes("\0")
	) {
		return fail("engine distribution installation paths must be absolute");
	}
	if (input.manifest.engine.runtimeBundle.path !== basename(input.manifest.engine.runtimeBundle.path)) {
		return fail("engine runtime bundle must be a direct child of its distribution directory");
	}
	const distributionName = input.manifest.distributionId.replace(/^sha256:/, "");
	if (!DISTRIBUTION_DIRECTORY.test(distributionName)) return fail("engine distribution ID is invalid");
	await mkdir(input.root, { recursive: true, mode: 0o700 });
	const rootMetadata = await lstat(input.root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o777) !== 0o700) {
		return fail("engine distribution root must be one private directory");
	}
	const canonicalRoot = await realpath(input.root);
	const manifestBytes = Buffer.from(canonicalEngineDistributionManifest(input.manifest), "utf8");
	const distributionPath = join(canonicalRoot, distributionName);
	let stagePath: string | undefined = join(
		canonicalRoot,
		`.stage-${distributionName.slice(0, 12)}-${randomBytes(12).toString("hex")}`,
	);
	try {
		await mkdir(stagePath, { mode: 0o700 });
		const manifestPath = join(stagePath, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
		const bundlePath = join(stagePath, input.manifest.engine.runtimeBundle.path);
		await writeExactFile(manifestPath, manifestBytes);
		await copyVerifiedBundle({
			sourcePath: input.bundlePath,
			destinationPath: bundlePath,
			expectedSizeBytes: input.manifest.engine.runtimeBundle.sizeBytes,
			expectedSha256: input.manifest.engine.runtimeBundle.sha256,
		});
		await syncDirectory(stagePath);
		await chmod(stagePath, 0o500);
		const publish = renameExclusive(stagePath, distributionPath);
		if (publish === "renamed") {
			stagePath = undefined;
			await syncDirectory(canonicalRoot);
		} else {
			await verifyExistingDistribution({
				root: canonicalRoot,
				distributionPath,
				manifestBytes,
				manifest: input.manifest,
			});
		}
		const retainedDistributionPaths: string[] = [];
		for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
			if (entry.name !== distributionName && entry.isDirectory() && DISTRIBUTION_DIRECTORY.test(entry.name)) {
				retainedDistributionPaths.push(join(canonicalRoot, entry.name));
			}
		}
		retainedDistributionPaths.sort();
		return Object.freeze({
			distributionPath,
			manifestPath: join(distributionPath, ENGINE_DISTRIBUTION_MANIFEST_FILENAME),
			bundlePath: join(distributionPath, input.manifest.engine.runtimeBundle.path),
			retainedDistributionPaths: Object.freeze(retainedDistributionPaths),
		});
	} catch (error) {
		if (error instanceof EngineDistributionInstallError) throw error;
		return fail("atomic engine distribution placement failed", error);
	} finally {
		if (stagePath !== undefined) {
			await chmod(stagePath, 0o700).catch(() => undefined);
			await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
