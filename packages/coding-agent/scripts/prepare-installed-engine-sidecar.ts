import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	ENGINE_DISTRIBUTION_DIRECTORY,
	ENGINE_DISTRIBUTION_MANIFEST_FILENAME,
	ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES,
	type EngineDistributionManifest,
	type EngineDistributionTrustRoot,
	parseTrustedEngineDistributionManifest,
} from "../src/breadboard/lifecycle/installed-engine-manifest";

const DISTRIBUTION_NAME = /^[0-9a-f]{64}$/;
const TRUST_NAME = /^([0-9a-f]{64})\.trust\.json$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const IO_CHUNK_BYTES = 1024 * 1024;

export class InstalledEngineSidecarBuildError extends Error {
	override readonly name = "InstalledEngineSidecarBuildError";
}

export interface BuildEngineDistribution {
	readonly trustRoot: EngineDistributionTrustRoot;
	readonly manifest: EngineDistributionManifest;
	readonly manifestBytes: Buffer;
	readonly manifestPath: string;
	readonly bundlePath: string;
}

function fail(message: string, cause?: unknown): never {
	throw new InstalledEngineSidecarBuildError(message, cause === undefined ? undefined : { cause });
}

async function expectDirectory(path: string, mode: number): Promise<void> {
	const metadata = await lstat(path).catch(error => fail("engine distribution directory is unavailable", error));
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== mode) {
		fail("engine distribution directory identity is invalid");
	}
}

async function openSealedFile(path: string, expectedMode = 0o400) {
	const pathMetadata = await lstat(path).catch(error => fail("engine distribution file is unavailable", error));
	if (
		!pathMetadata.isFile() ||
		pathMetadata.isSymbolicLink() ||
		pathMetadata.nlink !== 1 ||
		(pathMetadata.mode & 0o777) !== expectedMode
	) {
		fail("engine distribution file identity is invalid");
	}
	const descriptor = await open(path, READ_FLAGS).catch(error =>
		fail("engine distribution file cannot be pinned", error),
	);
	try {
		const descriptorMetadata = await descriptor.stat();
		if (
			!descriptorMetadata.isFile() ||
			descriptorMetadata.nlink !== 1 ||
			(descriptorMetadata.mode & 0o777) !== expectedMode ||
			descriptorMetadata.dev !== pathMetadata.dev ||
			descriptorMetadata.ino !== pathMetadata.ino ||
			descriptorMetadata.size !== pathMetadata.size
		) {
			fail("engine distribution file identity changed");
		}
		return { descriptor, sizeBytes: descriptorMetadata.size };
	} catch (error) {
		await descriptor.close().catch(() => undefined);
		throw error;
	}
}

async function readSealedFile(path: string, maxBytes: number): Promise<Buffer> {
	const opened = await openSealedFile(path);
	try {
		if (opened.sizeBytes <= 0 || opened.sizeBytes > maxBytes) fail("engine distribution file size is invalid");
		return await opened.descriptor.readFile();
	} finally {
		await opened.descriptor.close().catch(() => undefined);
	}
}

async function verifySealedFileHash(input: {
	readonly path: string;
	readonly expectedSizeBytes: number;
	readonly expectedSha256: `sha256:${string}`;
}): Promise<void> {
	const opened = await openSealedFile(input.path);
	try {
		if (opened.sizeBytes !== input.expectedSizeBytes) fail("engine distribution file size changed");
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
		let offset = 0;
		while (offset < opened.sizeBytes) {
			const length = Math.min(buffer.byteLength, opened.sizeBytes - offset);
			const result = await opened.descriptor.read(buffer, 0, length, offset);
			if (result.bytesRead !== length) fail("engine distribution file was truncated");
			digest.update(buffer.subarray(0, length));
			offset += length;
		}
		if (`sha256:${digest.digest("hex")}` !== input.expectedSha256) fail("engine distribution digest changed");
	} finally {
		await opened.descriptor.close().catch(() => undefined);
	}
}

async function syncPath(path: string): Promise<void> {
	const descriptor = await open(path, constants.O_RDONLY);
	try {
		await descriptor.sync();
	} finally {
		await descriptor.close();
	}
}

export async function loadBuildEngineDistribution(rootPath: string): Promise<BuildEngineDistribution> {
	let root: string;
	try {
		root = await realpath(rootPath);
	} catch (error) {
		fail("engine distribution build root is unavailable", error);
	}
	await expectDirectory(root, 0o700);
	const entries = await readdir(root, { withFileTypes: true });
	if (entries.length !== 2) fail("engine distribution build root must contain one distribution and one trust root");
	const directory = entries.find(entry => entry.isDirectory() && DISTRIBUTION_NAME.test(entry.name));
	const trust = entries.find(entry => entry.isFile() && TRUST_NAME.test(entry.name));
	if (!directory || !trust) fail("engine distribution build root layout is invalid");
	const trustDistribution = TRUST_NAME.exec(trust.name)?.[1];
	if (trustDistribution !== directory.name) fail("engine distribution and trust identities differ");
	const distributionRoot = join(root, directory.name);
	await expectDirectory(distributionRoot, 0o500);
	const trustBytes = await readSealedFile(join(root, trust.name), ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES);
	let trustRoot: EngineDistributionTrustRoot;
	try {
		trustRoot = JSON.parse(trustBytes.toString("utf8")) as EngineDistributionTrustRoot;
	} catch (error) {
		fail("engine distribution trust root is invalid", error);
	}
	const manifestPath = join(distributionRoot, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
	const manifestBytes = await readSealedFile(manifestPath, ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES);
	const manifest = parseTrustedEngineDistributionManifest(manifestBytes, trustRoot);
	if (manifest.distributionId !== `sha256:${directory.name}`) fail("engine distribution directory is stale");
	if (dirname(manifest.engine.runtimeBundle.path) !== ".") {
		fail("engine distribution runtime bundle must be one adjacent file");
	}
	const bundlePath = join(distributionRoot, manifest.engine.runtimeBundle.path);
	await verifySealedFileHash({
		path: bundlePath,
		expectedSizeBytes: manifest.engine.runtimeBundle.sizeBytes,
		expectedSha256: manifest.engine.runtimeBundle.sha256,
	});
	return Object.freeze({ trustRoot, manifest, manifestBytes, manifestPath, bundlePath });
}

async function verifyStagedSidecar(
	root: string,
	distribution: BuildEngineDistribution,
	directoryMode = 0o500,
): Promise<void> {
	await expectDirectory(root, directoryMode);
	const manifestPath = join(root, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
	const manifestBytes = await readSealedFile(manifestPath, ENGINE_DISTRIBUTION_MAX_MANIFEST_BYTES);
	if (!manifestBytes.equals(distribution.manifestBytes)) fail("existing installed engine manifest differs");
	await verifySealedFileHash({
		path: join(root, distribution.manifest.engine.runtimeBundle.path),
		expectedSizeBytes: distribution.manifest.engine.runtimeBundle.sizeBytes,
		expectedSha256: distribution.manifest.engine.runtimeBundle.sha256,
	});
}

export async function stageInstalledEngineSidecar(
	productExecutablePath: string,
	distribution: BuildEngineDistribution,
): Promise<string> {
	const outputRoot = dirname(productExecutablePath);
	await mkdir(outputRoot, { recursive: true });
	const finalParent = join(outputRoot, ENGINE_DISTRIBUTION_DIRECTORY);
	await mkdir(finalParent, { recursive: true });
	const parentMetadata = await lstat(finalParent);
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
		fail("installed engine sidecar is unavailable");
	}
	await chmod(finalParent, 0o700);
	const finalRoot = join(finalParent, distribution.manifest.distributionId.slice("sha256:".length));
	const finalExists = await lstat(finalRoot).then(
		() => true,
		error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			fail("installed engine sidecar is unavailable", error);
		},
	);
	if (finalExists) {
		await verifyStagedSidecar(finalRoot, distribution);
		await chmod(finalParent, 0o500);
		return finalRoot;
	}
	const temporaryRoot = await mkdtemp(join(finalParent, ".engine-stage-"));
	try {
		await chmod(temporaryRoot, 0o700);
		const manifestPath = join(temporaryRoot, ENGINE_DISTRIBUTION_MANIFEST_FILENAME);
		const bundlePath = join(temporaryRoot, distribution.manifest.engine.runtimeBundle.path);
		await copyFile(distribution.manifestPath, manifestPath, constants.COPYFILE_EXCL);
		await copyFile(distribution.bundlePath, bundlePath, constants.COPYFILE_EXCL);
		await chmod(manifestPath, 0o400);
		await chmod(bundlePath, 0o400);
		await syncPath(manifestPath);
		await syncPath(bundlePath);
		await verifyStagedSidecar(temporaryRoot, distribution, 0o700);
		await chmod(temporaryRoot, 0o500);
		await syncPath(temporaryRoot);
		try {
			await rename(temporaryRoot, finalRoot);
		} catch (error) {
			await verifyStagedSidecar(finalRoot, distribution).catch(() => {
				throw error;
			});
		}
		await syncPath(finalParent);
		await chmod(finalParent, 0o500);
		await syncPath(outputRoot);
		await verifyStagedSidecar(finalRoot, distribution);
		return finalRoot;
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}
