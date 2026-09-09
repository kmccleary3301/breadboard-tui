#!/usr/bin/env bun

import { dlopen, FFIType, type Library } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	ensureDestinationRoot,
	ensurePrivateDirectory,
	installProductArchive,
	isMissingError,
	isSemver,
	manifestRecord,
	openProductArchive,
	type ProductArchive,
	type ProductArchiveTrustOptions,
	privateRegular,
	removePinnedDirectoryTree,
	renameNoReplace,
	safeRelativePath,
	syncDirectory,
	targetKey,
	verifyProductRoot,
} from "./product-archive";

export type { ProductArchiveTrustOptions } from "./product-archive";
export { installProductArchive, requireInstallableTrust, verifyProductArchive } from "./product-archive";

const PRODUCT_STATE_DIRECTORY = ".bb-product-state";
const ROOT = /^bb-darwin-arm64-[0-9A-Za-z.-]+$/;
const LIFECYCLE_SCHEMA = "bb.product_lifecycle.v1";
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const LOCK_TIMEOUT_MS = 30_000;
const RETIREMENT_NAME_PATTERN = /^\.bb-retire-[0-9a-f]+-[0-9a-f]+$/;
const MAX_LIFECYCLE_REVISIONS = 1_000;
const LOCK_SYMBOLS = {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const;

function fail(message: string, cause?: unknown): never {
	throw new Error(message, cause === undefined ? undefined : { cause });
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

function lifecycleLockLibrary(): Library<typeof LOCK_SYMBOLS> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		fail(`macOS arm64 product lifecycle locking is unsupported on ${process.platform}/${process.arch}`);
	return dlopen("/usr/lib/libSystem.B.dylib", LOCK_SYMBOLS);
}

async function withLifecycleLock<T>(destinationRoot: string, operation: () => Promise<T>): Promise<T> {
	const { stateRoot } = await ensureLifecycleDirectories(destinationRoot);
	const lockPath = join(stateRoot, "operation.lock");
	const lockFile = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
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
	const file = await open(
		pending,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
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

function candidateFromArchive(archive: ProductArchive): ProductLifecycleRoot {
	return Object.freeze({
		rootName: archive.rootName,
		target: archive.target,
		version: archive.productVersion,
		archiveSha256: archive.archiveSha256,
		treeSha256: archive.treeSha256,
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
	if (verified.productVersion !== root.version || verified.treeSha256 !== root.treeSha256)
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
	archive: ProductArchive,
	destinationRoot: string,
	candidate: ProductLifecycleRoot,
	known: ProductLifecycleRoot | undefined,
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
	await archive.install(destinationRoot);
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

export interface ProductLifecycleUpdateOptions extends ProductArchiveTrustOptions {
	readonly allowDowngrade?: boolean;
}

async function activateManagedProductArchiveUnlocked(
	action: "install" | "update",
	archivePath: string,
	destinationRoot: string,
	options: ProductLifecycleUpdateOptions,
): Promise<ProductLifecycleRecord> {
	const verified = await openProductArchive(archivePath, options);
	const candidate = candidateFromArchive(verified);
	const inspected = await managedRecord(destinationRoot);
	const previous = inspected.state.record;
	let displaced: ProductLifecycleRoot | null = null;
	let comparison = 0;
	if (action === "install") {
		const pendingRemoval = previous?.removal;
		if (pendingRemoval !== null && pendingRemoval !== undefined)
			fail("interrupted product uninstall cleanup must be resumed before install");
		if (previous?.active !== null && previous?.active !== undefined) fail("a product is already active; use update");
	} else {
		if (previous === null || previous.active === null) fail("cannot update without an active product");
		comparison = compareProductVersions(candidate.version, previous.active.version);
		if (comparison === 0) {
			if (!sameRoot(previous.active, candidate))
				fail("same-version product archive conflicts with the active release");
			await verifyInstalledRoot(previous.active, destinationRoot);
			return outputRecord(previous, await collectResidue(destinationRoot, previous.active, previous.retained));
		}
		if (comparison < 0 && options.allowDowngrade !== true) fail("product downgrade requires explicit authorization");
		if (inspected.state.revision >= MAX_LIFECYCLE_REVISIONS) fail("product lifecycle revision capacity is exhausted");
		displaced = previous.active;
	}
	const known =
		previous?.retained.find(root => root.rootName === candidate.rootName) ??
		(displaced && displaced.rootName === candidate.rootName ? displaced : undefined);
	await installOrRecoverCandidate(verified, destinationRoot, candidate, known);
	let retained = previous === null ? [] : retainedAfterActivation(candidate, previous.retained);
	if (displaced) retained = Object.freeze([displaced, ...retained]);
	const residue = await collectResidue(destinationRoot, candidate, retained);
	const published = await publishLifecycleRevision(destinationRoot, inspected.state.revision, {
		schema: LIFECYCLE_SCHEMA,
		action,
		allowDowngrade: comparison < 0,
		active: candidate,
		retained,
		removal: null,
		removed: (previous?.removed ?? []).filter(rootName => rootName !== candidate.rootName),
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
		activateManagedProductArchiveUnlocked("install", archivePath, destinationPath, options),
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
		() => activateManagedProductArchiveUnlocked("update", archivePath, destinationPath, options),
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
	if (action === "install" || action === "update") {
		const archivePath = args[1];
		const destination = args[2];
		if (archivePath === undefined || destination === undefined)
			fail(
				action === "install"
					? "usage: bun scripts/install-product-release.ts install <archive.tar.gz> <destination> [--allow-unsigned-development] [--expected-archive-sha256 <sha256:...>]"
					: "usage: bun scripts/install-product-release.ts update <archive.tar.gz> <destination> [--allow-downgrade] [--allow-unsigned-development] [--expected-archive-sha256 <sha256:...>]",
			);
		const options = parseArchiveTrustFlags(args.slice(3), action === "update");
		const activate = action === "install" ? installManagedProductArchive : updateManagedProductArchive;
		process.stdout.write(`${JSON.stringify(await activate(archivePath, destination, options))}\n`);
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
