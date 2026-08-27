import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	chmod,
	constants,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const ENGINE_RUNTIME_BUNDLE_SCHEMA = "bb.engine_runtime_bundle.v1" as const;

const BUNDLE_MAGIC = Buffer.from("BBENGINEBUNDLE1\n", "ascii");
const LENGTH_BYTES = 8;
const HEADER_BYTES = BUNDLE_MAGIC.byteLength + LENGTH_BYTES;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_RELATIVE_PATH_BYTES = 4095;
const IO_CHUNK_BYTES = 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_COMPONENT = /^[A-Za-z0-9._+@-](?:[A-Za-z0-9._+@ -]*[A-Za-z0-9._+@-])?$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

type BundleFileMode = 0o400 | 0o500;

export interface EngineRuntimeBundleReference {
	readonly schemaVersion: typeof ENGINE_RUNTIME_BUNDLE_SCHEMA;
	readonly path: string;
	readonly sizeBytes: number;
	readonly sha256: `sha256:${string}`;
}

export interface EngineRuntimeBundleEntry {
	readonly path: string;
	readonly mode: BundleFileMode;
	readonly sizeBytes: number;
	readonly sha256: `sha256:${string}`;
}

export interface EngineRuntimeBundleIndex {
	readonly schemaVersion: typeof ENGINE_RUNTIME_BUNDLE_SCHEMA;
	readonly executablePath: string;
	readonly entries: readonly EngineRuntimeBundleEntry[];
}

export interface CreatedEngineRuntimeBundle {
	readonly bundle: EngineRuntimeBundleReference;
	readonly executablePath: string;
	readonly executableSizeBytes: number;
	readonly executableSha256: `sha256:${string}`;
	readonly index: EngineRuntimeBundleIndex;
}

export interface ExtractedEngineRuntimeBundle {
	readonly rootPath: string;
	readonly executablePath: string;
	readonly executableBytes: Buffer;
	readonly index: EngineRuntimeBundleIndex;
	cleanup(): Promise<void>;
}

export type EngineRuntimeBundleErrorCode =
	| "bundle_source_invalid"
	| "bundle_invalid"
	| "bundle_mismatch"
	| "bundle_extraction_failed";

export class EngineRuntimeBundleError extends Error {
	override readonly name = "EngineRuntimeBundleError";

	constructor(
		readonly code: EngineRuntimeBundleErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

function fail(code: EngineRuntimeBundleErrorCode, message: string, cause?: unknown): never {
	throw new EngineRuntimeBundleError(code, message, cause === undefined ? undefined : { cause });
}

function validateRelativePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		value.includes("\\") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES
	) {
		return fail("bundle_invalid", "engine bundle contains an invalid relative path");
	}
	const components = value.split("/");
	const unsafe = components.find(
		component => component === "" || component === "." || component === ".." || !SAFE_COMPONENT.test(component),
	);
	if (unsafe !== undefined) {
		return fail("bundle_invalid", `engine bundle contains an unsafe path component: ${JSON.stringify(unsafe)}`);
	}
	return value;
}
export function parseEngineRuntimeBundleRelativePath(value: unknown): string {
	return validateRelativePath(value);
}

function validateSha256(value: unknown): `sha256:${string}` {
	if (typeof value !== "string" || !SHA256.test(value)) {
		return fail("bundle_invalid", "engine bundle contains an invalid digest");
	}
	return value as `sha256:${string}`;
}

function expectExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fail("bundle_invalid", "engine bundle index must contain objects");
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		return fail("bundle_invalid", "engine bundle index contains unknown or missing fields");
	}
	return record;
}

function decodeIndex(value: unknown): EngineRuntimeBundleIndex {
	const record = expectExactRecord(value, ["schemaVersion", "executablePath", "entries"]);
	if (record.schemaVersion !== ENGINE_RUNTIME_BUNDLE_SCHEMA) {
		return fail("bundle_invalid", "engine bundle schema is unsupported");
	}
	const executablePath = validateRelativePath(record.executablePath);
	if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > MAX_ENTRIES) {
		return fail("bundle_invalid", "engine bundle entry count is invalid");
	}
	let previous = "";
	const caseFolded = new Set<string>();
	const entries = record.entries.map(raw => {
		const entry = expectExactRecord(raw, ["path", "mode", "sizeBytes", "sha256"]);
		const path = validateRelativePath(entry.path);
		if (path <= previous) return fail("bundle_invalid", "engine bundle entries are not strictly sorted");
		previous = path;
		const folded = path.toLowerCase();
		if (caseFolded.has(folded))
			return fail("bundle_invalid", "engine bundle paths collide on case-insensitive filesystems");
		caseFolded.add(folded);
		if (entry.mode !== 0o400 && entry.mode !== 0o500) {
			return fail("bundle_invalid", "engine bundle entry mode is invalid");
		}
		if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0) {
			return fail("bundle_invalid", "engine bundle entry size is invalid");
		}
		return Object.freeze({
			path,
			mode: entry.mode,
			sizeBytes: entry.sizeBytes as number,
			sha256: validateSha256(entry.sha256),
		});
	});
	for (let index = 0; index < entries.length - 1; index++) {
		const current = entries[index];
		const next = entries[index + 1];
		if (current && next?.path.startsWith(`${current.path}/`)) {
			return fail("bundle_invalid", "engine bundle contains a file/directory path collision");
		}
	}
	const executable = entries.find(entry => entry.path === executablePath);
	if (executable?.mode !== 0o500 || executable.sizeBytes === 0) {
		return fail("bundle_invalid", "engine bundle executable entry is missing or non-executable");
	}
	return Object.freeze({
		schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
		executablePath,
		entries: Object.freeze(entries),
	});
}

function canonicalIndex(index: EngineRuntimeBundleIndex): Buffer {
	return Buffer.from(JSON.stringify(decodeIndex(index)), "utf8");
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
	const result = Buffer.allocUnsafe(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(result, offset, length - offset, position + offset);
		if (bytesRead === 0) return fail("bundle_invalid", "engine bundle ended unexpectedly");
		offset += bytesRead;
	}
	return result;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<number> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
		if (bytesWritten === 0) return fail("bundle_extraction_failed", "engine bundle write made no progress");
		offset += bytesWritten;
	}
	return position + bytes.byteLength;
}

async function digestHandle(handle: FileHandle, sizeBytes: number, position = 0): Promise<`sha256:${string}`> {
	const digest = createHash("sha256");
	const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, Math.max(1, sizeBytes)));
	let remaining = sizeBytes;
	let cursor = position;
	while (remaining > 0) {
		const length = Math.min(buffer.byteLength, remaining);
		const { bytesRead } = await handle.read(buffer, 0, length, cursor);
		if (bytesRead === 0) return fail("bundle_invalid", "engine bundle ended unexpectedly while hashing");
		digest.update(buffer.subarray(0, bytesRead));
		remaining -= bytesRead;
		cursor += bytesRead;
	}
	return `sha256:${digest.digest("hex")}`;
}

export async function sha256File(path: string): Promise<`sha256:${string}`> {
	const handle = await open(path, READ_FLAGS);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.nlink !== 1 || !Number.isSafeInteger(metadata.size)) {
			return fail("bundle_source_invalid", "digest source is not one stable regular file");
		}
		return await digestHandle(handle, metadata.size);
	} finally {
		await handle.close();
	}
}

interface ScannedSourceEntry extends EngineRuntimeBundleEntry {
	readonly sourcePath: string;
	readonly dev: number;
	readonly ino: number;
}

async function scanSourceTree(root: string, directory: string, entries: ScannedSourceEntry[]): Promise<void> {
	const children = await readdir(directory, { withFileTypes: true });
	children.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "variant" }));
	for (const child of children) {
		const sourcePath = join(directory, child.name);
		const metadata = await lstat(sourcePath);
		if (metadata.isSymbolicLink()) return fail("bundle_source_invalid", "engine runtime source contains a symlink");
		if (metadata.isDirectory()) {
			await scanSourceTree(root, sourcePath, entries);
			continue;
		}
		if (!metadata.isFile() || metadata.nlink !== 1 || !Number.isSafeInteger(metadata.size)) {
			return fail("bundle_source_invalid", "engine runtime source contains a non-regular file");
		}
		const path = validateRelativePath(relative(root, sourcePath).split(sep).join("/"));
		const handle = await open(sourcePath, READ_FLAGS);
		let sha256: `sha256:${string}`;
		try {
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.nlink !== 1 ||
				opened.dev !== metadata.dev ||
				opened.ino !== metadata.ino ||
				opened.size !== metadata.size
			) {
				return fail("bundle_source_invalid", "engine runtime source changed during inspection");
			}
			sha256 = await digestHandle(handle, opened.size);
		} finally {
			await handle.close();
		}
		entries.push(
			Object.freeze({
				path,
				mode: metadata.mode & 0o111 ? 0o500 : 0o400,
				sizeBytes: metadata.size,
				sha256,
				sourcePath,
				dev: metadata.dev,
				ino: metadata.ino,
			}),
		);
	}
}

export async function createEngineRuntimeBundle(input: {
	readonly sourceRoot: string;
	readonly executablePath: string;
	readonly outputPath: string;
}): Promise<CreatedEngineRuntimeBundle> {
	if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.outputPath)) {
		return fail("bundle_source_invalid", "engine bundle source and output paths must be absolute");
	}
	const sourceMetadata = await lstat(input.sourceRoot);
	if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
		return fail("bundle_source_invalid", "engine bundle source root is not a real directory");
	}
	const sourceRoot = await realpath(input.sourceRoot);
	const executablePath = validateRelativePath(input.executablePath);
	const entries: ScannedSourceEntry[] = [];
	await scanSourceTree(sourceRoot, sourceRoot, entries);
	entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const index = decodeIndex({
		schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
		executablePath,
		entries: entries.map(({ path, mode, sizeBytes, sha256 }) => ({ path, mode, sizeBytes, sha256 })),
	});
	const indexBytes = canonicalIndex(index);
	if (indexBytes.byteLength === 0 || indexBytes.byteLength > MAX_INDEX_BYTES) {
		return fail("bundle_source_invalid", "engine bundle index is too large");
	}
	await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
	let output: FileHandle | undefined;
	try {
		output = await open(input.outputPath, WRITE_FLAGS, 0o600);
		let position = await writeAll(output, BUNDLE_MAGIC, 0);
		const length = Buffer.alloc(LENGTH_BYTES);
		length.writeBigUInt64BE(BigInt(indexBytes.byteLength));
		position = await writeAll(output, length, position);
		position = await writeAll(output, indexBytes, position);
		const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
		for (const entry of entries) {
			const source = await open(entry.sourcePath, READ_FLAGS);
			try {
				const metadata = await source.stat();
				if (
					!metadata.isFile() ||
					metadata.nlink !== 1 ||
					metadata.dev !== entry.dev ||
					metadata.ino !== entry.ino ||
					metadata.size !== entry.sizeBytes
				) {
					return fail("bundle_source_invalid", "engine runtime source changed before bundling");
				}
				const digest = createHash("sha256");
				let remaining = entry.sizeBytes;
				let sourcePosition = 0;
				while (remaining > 0) {
					const length = Math.min(buffer.byteLength, remaining);
					const { bytesRead } = await source.read(buffer, 0, length, sourcePosition);
					if (bytesRead === 0) return fail("bundle_source_invalid", "engine runtime source ended unexpectedly");
					digest.update(buffer.subarray(0, bytesRead));
					position = await writeAll(output, buffer.subarray(0, bytesRead), position);
					remaining -= bytesRead;
					sourcePosition += bytesRead;
				}
				if (`sha256:${digest.digest("hex")}` !== entry.sha256) {
					return fail("bundle_source_invalid", "engine runtime source changed while bundling");
				}
			} finally {
				await source.close();
			}
		}
		await output.sync();
		await output.chmod(0o400);
		await output.close();
		output = undefined;
		const bundleSha256 = await sha256File(input.outputPath);
		const bundleMetadata = await lstat(input.outputPath);
		const executable = index.entries.find(entry => entry.path === index.executablePath);
		if (!executable) return fail("bundle_source_invalid", "engine bundle executable vanished from its index");
		return Object.freeze({
			bundle: Object.freeze({
				schemaVersion: ENGINE_RUNTIME_BUNDLE_SCHEMA,
				path: input.outputPath,
				sizeBytes: bundleMetadata.size,
				sha256: bundleSha256,
			}),
			executablePath: index.executablePath,
			executableSizeBytes: executable.sizeBytes,
			executableSha256: executable.sha256,
			index,
		});
	} catch (error) {
		await output?.close().catch(() => undefined);
		await rm(input.outputPath, { force: true }).catch(() => undefined);
		if (error instanceof EngineRuntimeBundleError) throw error;
		return fail("bundle_source_invalid", "engine runtime bundle creation failed", error);
	}
}

async function parseBundleIndex(
	handle: FileHandle,
	bundleSizeBytes: number,
): Promise<{ readonly index: EngineRuntimeBundleIndex; readonly dataOffset: number }> {
	const header = await readExact(handle, HEADER_BYTES, 0);
	if (!header.subarray(0, BUNDLE_MAGIC.byteLength).equals(BUNDLE_MAGIC)) {
		return fail("bundle_invalid", "engine bundle magic is invalid");
	}
	const indexLength = header.readBigUInt64BE(BUNDLE_MAGIC.byteLength);
	if (indexLength === 0n || indexLength > BigInt(MAX_INDEX_BYTES) || indexLength > BigInt(Number.MAX_SAFE_INTEGER)) {
		return fail("bundle_invalid", "engine bundle index length is invalid");
	}
	const dataOffset = HEADER_BYTES + Number(indexLength);
	if (dataOffset > bundleSizeBytes) return fail("bundle_invalid", "engine bundle index exceeds the bundle size");
	const indexBytes = await readExact(handle, Number(indexLength), HEADER_BYTES);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes));
	} catch (error) {
		return fail("bundle_invalid", "engine bundle index is not strict UTF-8 JSON", error);
	}
	const index = decodeIndex(value);
	if (!indexBytes.equals(canonicalIndex(index))) {
		return fail("bundle_invalid", "engine bundle index is not canonical");
	}
	let payloadSize = 0;
	for (const entry of index.entries) {
		payloadSize += entry.sizeBytes;
		if (!Number.isSafeInteger(payloadSize)) return fail("bundle_invalid", "engine bundle payload is too large");
	}
	if (dataOffset + payloadSize !== bundleSizeBytes) {
		return fail("bundle_invalid", "engine bundle payload size does not match its index");
	}
	return { index, dataOffset };
}

function containedPath(root: string, path: string): string {
	const destination = resolve(root, ...path.split("/"));
	const child = relative(root, destination);
	if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		return fail("bundle_invalid", "engine bundle extraction escaped its private root");
	}
	return destination;
}

async function makeTreeWritable(path: string): Promise<void> {
	await chmod(path, 0o700).catch(() => undefined);
	let children: Dirent[];
	try {
		children = await readdir(path, { withFileTypes: true });
	} catch {
		return;
	}
	for (const child of children) {
		if (child.isDirectory() && !child.isSymbolicLink()) await makeTreeWritable(join(path, child.name));
	}
}

export async function removePrivateEngineRuntimeTree(path: string): Promise<void> {
	await makeTreeWritable(path);
	await rm(path, { recursive: true, force: true });
}

export async function extractVerifiedEngineRuntimeBundle(input: {
	readonly bundle: EngineRuntimeBundleReference;
	readonly executablePath: string;
	readonly executableSizeBytes: number;
	readonly executableSha256: `sha256:${string}`;
}): Promise<ExtractedEngineRuntimeBundle> {
	if (
		input.bundle.schemaVersion !== ENGINE_RUNTIME_BUNDLE_SCHEMA ||
		!isAbsolute(input.bundle.path) ||
		!Number.isSafeInteger(input.bundle.sizeBytes) ||
		input.bundle.sizeBytes <= HEADER_BYTES ||
		!SHA256.test(input.bundle.sha256) ||
		!Number.isSafeInteger(input.executableSizeBytes) ||
		input.executableSizeBytes <= 0 ||
		!SHA256.test(input.executableSha256)
	) {
		return fail("bundle_mismatch", "trusted engine bundle reference is invalid");
	}
	const expectedExecutablePath = validateRelativePath(input.executablePath);
	const bundle = await open(input.bundle.path, READ_FLAGS).catch(error =>
		fail("bundle_mismatch", "trusted engine bundle is unavailable", error),
	);
	let rootPath: string | undefined;
	try {
		const metadata = await bundle.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			metadata.mode & 0o022 ||
			metadata.size !== input.bundle.sizeBytes
		) {
			return fail("bundle_mismatch", "trusted engine bundle file identity is invalid");
		}
		const actualBundleSha256 = await digestHandle(bundle, metadata.size);
		if (actualBundleSha256 !== input.bundle.sha256) {
			return fail("bundle_mismatch", "trusted engine bundle digest changed");
		}
		const { index, dataOffset } = await parseBundleIndex(bundle, metadata.size);
		const executable = index.entries.find(entry => entry.path === expectedExecutablePath);
		if (
			index.executablePath !== expectedExecutablePath ||
			!executable ||
			executable.sizeBytes !== input.executableSizeBytes ||
			executable.sha256 !== input.executableSha256
		) {
			return fail("bundle_mismatch", "trusted engine executable identity differs from its bundle index");
		}

		rootPath = await mkdtemp(join(tmpdir(), "bb-engine-runtime-"));
		const directories = new Set<string>();
		let sourcePosition = dataOffset;
		const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
		for (const entry of index.entries) {
			const outputPath = containedPath(rootPath, entry.path);
			const parent = dirname(outputPath);
			await mkdir(parent, { recursive: true, mode: 0o700 });
			let cursor = parent;
			while (cursor !== rootPath) {
				directories.add(cursor);
				cursor = dirname(cursor);
			}
			const output = await open(outputPath, WRITE_FLAGS, 0o600);
			try {
				const digest = createHash("sha256");
				let remaining = entry.sizeBytes;
				let outputPosition = 0;
				while (remaining > 0) {
					const length = Math.min(buffer.byteLength, remaining);
					const { bytesRead } = await bundle.read(buffer, 0, length, sourcePosition);
					if (bytesRead === 0) return fail("bundle_invalid", "engine bundle entry ended unexpectedly");
					digest.update(buffer.subarray(0, bytesRead));
					outputPosition = await writeAll(output, buffer.subarray(0, bytesRead), outputPosition);
					sourcePosition += bytesRead;
					remaining -= bytesRead;
				}
				if (`sha256:${digest.digest("hex")}` !== entry.sha256) {
					return fail("bundle_mismatch", "engine bundle entry digest changed");
				}
				await output.sync();
				await output.chmod(entry.mode);
			} finally {
				await output.close();
			}
		}
		for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
			await chmod(directory, 0o500);
		}
		await chmod(rootPath, 0o500);
		const executablePath = containedPath(rootPath, expectedExecutablePath);
		const executableHandle = await open(executablePath, READ_FLAGS);
		let executableBytes: Buffer;
		try {
			const executableMetadata = await executableHandle.stat();
			if (
				!executableMetadata.isFile() ||
				executableMetadata.nlink !== 1 ||
				(executableMetadata.mode & 0o777) !== 0o500 ||
				executableMetadata.size !== input.executableSizeBytes
			) {
				return fail("bundle_mismatch", "extracted engine executable identity is invalid");
			}
			executableBytes = await executableHandle.readFile();
			if (`sha256:${createHash("sha256").update(executableBytes).digest("hex")}` !== input.executableSha256) {
				return fail("bundle_mismatch", "extracted engine executable digest changed");
			}
		} finally {
			await executableHandle.close();
		}
		const retainedRoot = rootPath;
		rootPath = undefined;
		let cleaned = false;
		return Object.freeze({
			rootPath: retainedRoot,
			executablePath,
			executableBytes,
			index,
			cleanup: async () => {
				if (cleaned) return;
				cleaned = true;
				await removePrivateEngineRuntimeTree(retainedRoot);
			},
		});
	} catch (error) {
		if (error instanceof EngineRuntimeBundleError) throw error;
		return fail("bundle_extraction_failed", "trusted engine bundle extraction failed", error);
	} finally {
		await bundle.close();
		if (rootPath !== undefined) await removePrivateEngineRuntimeTree(rootPath).catch(() => undefined);
	}
}
